import contextlib
import gzip
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import database_backup


class DatabaseBackupTests(unittest.TestCase):
    COMMIT = "0123456789abcdef0123456789abcdef01234567"

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

    def test_get_git_commit_returns_exact_revision(self):
        completed = mock.Mock(stdout=f"{self.COMMIT}\n")
        with mock.patch.object(database_backup.subprocess, "run", return_value=completed) as run:
            commit = database_backup.get_git_commit()

        self.assertEqual(commit, self.COMMIT)
        run.assert_called_once_with(
            [
                "git",
                "-C",
                str(database_backup.PROJECT_ROOT),
                "rev-parse",
                "--verify",
                "HEAD",
            ],
            check=True,
            capture_output=True,
            text=True,
        )

    def test_default_backup_name_includes_short_git_commit(self):
        config = database_backup.DatabaseConfig("localhost", 3306, "user", "secret", "raidbot")

        path = database_backup.default_backup_path(
            config,
            Path("/backups"),
            git_commit=self.COMMIT,
        )

        self.assertRegex(
            path.name,
            rf"^backup-raidbot-\d{{8}}T\d{{6}}Z-{self.COMMIT[:12]}\.sql\.gz$",
        )

    def test_backup_embeds_full_git_commit_in_sql(self):
        config = database_backup.DatabaseConfig("localhost", 3306, "user", "secret", "raidbot")
        process = mock.Mock(stdout=io.BytesIO(b"CREATE TABLE example (id INT);\n"))
        process.wait.return_value = 0

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "custom-name.sql.gz"
            with (
                mock.patch.object(database_backup, "find_program", return_value="mariadb-dump"),
                mock.patch.object(
                    database_backup,
                    "mysql_defaults_file",
                    return_value=contextlib.nullcontext(root / "client.cnf"),
                ),
                mock.patch.object(database_backup.subprocess, "Popen", return_value=process),
            ):
                database_backup.backup_database(
                    config,
                    output,
                    git_commit=self.COMMIT,
                )

            with gzip.open(output, "rt", encoding="utf-8") as backup:
                contents = backup.read()

        self.assertTrue(contents.startswith("-- DiscordRaidSignUp database backup\n"))
        self.assertIn(f"-- Git commit: {self.COMMIT}\n", contents)
        self.assertIn("CREATE TABLE example", contents)

    def test_restore_creates_safety_backup_before_replacing_database(self):
        config = database_backup.DatabaseConfig("localhost", 3306, "user", "secret", "raidbot")
        events = []

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.sql"
            source.write_text("SELECT 1;", encoding="utf-8")

            with (
                mock.patch.object(database_backup, "database_exists", return_value=True),
                mock.patch.object(database_backup, "get_git_commit", return_value=self.COMMIT),
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
