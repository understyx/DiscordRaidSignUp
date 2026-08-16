import contextlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import database_backup


class DatabaseBackupTests(unittest.TestCase):
    def test_loads_database_configuration_from_dotenv(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(
                "\n".join(
                    [
                        "DB_HOST=db.internal",
                        "DB_PORT=3307",
                        "DB_USER=raid_user",
                        'DB_PASSWORD="p#ss word"',
                        "DB_NAME=raid_test # local test database",
                    ]
                ),
                encoding="utf-8",
            )

            config = database_backup.load_database_config(env_file)

        self.assertEqual(config.host, "db.internal")
        self.assertEqual(config.port, 3307)
        self.assertEqual(config.user, "raid_user")
        self.assertEqual(config.password, "p#ss word")
        self.assertEqual(config.database, "raid_test")

    def test_rejects_unsafe_database_names(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text("DB_NAME=raidbot;DROP DATABASE raidbot\n", encoding="utf-8")
            with self.assertRaisesRegex(database_backup.BackupError, "letters, numbers"):
                database_backup.load_database_config(env_file)

    def test_credentials_file_is_private_and_removed(self):
        config = database_backup.DatabaseConfig("localhost", 3306, "user", "secret", "raidbot")
        with database_backup.mysql_defaults_file(config) as defaults_file:
            self.assertEqual(os.stat(defaults_file).st_mode & 0o777, 0o600)
            contents = defaults_file.read_text(encoding="utf-8")
            self.assertIn('password="secret"', contents)
        self.assertFalse(defaults_file.exists())

    def test_restore_creates_safety_backup_before_replacing_database(self):
        config = database_backup.DatabaseConfig("localhost", 3306, "user", "secret", "raidbot")
        events = []

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.sql"
            source.write_text("SELECT 1;", encoding="utf-8")

            with (
                mock.patch.object(database_backup, "database_exists", return_value=True),
                mock.patch.object(
                    database_backup,
                    "backup_database",
                    side_effect=lambda *_args, **_kwargs: events.append("safety-backup"),
                ),
                mock.patch.object(
                    database_backup,
                    "mysql_defaults_file",
                    return_value=contextlib.nullcontext(root / "client.cnf"),
                ),
                mock.patch.object(database_backup, "_mysql_command", return_value=["mysql"]),
                mock.patch.object(
                    database_backup.subprocess,
                    "run",
                    side_effect=lambda *_args, **_kwargs: events.append("database-write"),
                ),
            ):
                safety_backup = database_backup.restore_database(
                    config,
                    source,
                    root,
                    assume_yes=True,
                )

        self.assertIsNotNone(safety_backup)
        self.assertEqual(events[0], "safety-backup")
        self.assertEqual(events[1:], ["database-write", "database-write"])

    def test_noninteractive_restore_requires_yes(self):
        config = database_backup.DatabaseConfig("localhost", 3306, "user", "secret", "raidbot")
        with mock.patch.object(database_backup.sys.stdin, "isatty", return_value=False):
            with self.assertRaisesRegex(database_backup.BackupError, "--yes"):
                database_backup.confirm_restore(config)


if __name__ == "__main__":
    unittest.main()
