#!/usr/bin/env python3
"""Create or restore a compressed MariaDB/MySQL backup using project .env settings."""

from __future__ import annotations

import argparse
import contextlib
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO, Iterator

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV_FILE = PROJECT_ROOT / ".env"
DEFAULT_BACKUP_DIR = PROJECT_ROOT / "backups"
SAFE_DATABASE_NAME = re.compile(r"^[A-Za-z0-9_]+$")


class BackupError(RuntimeError):
    """Raised for configuration or backup/restore failures."""


@dataclass(frozen=True)
class DatabaseConfig:
    host: str
    port: int
    user: str
    password: str
    database: str


def read_env_file(path: Path) -> dict[str, str]:
    """Parse the simple KEY=VALUE syntax used by this project's .env file."""
    if not path.is_file():
        raise BackupError(f"Environment file not found: {path}")

    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise BackupError(f"Invalid .env line {line_number}: expected KEY=VALUE")

        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise BackupError(f"Invalid .env key on line {line_number}: {key!r}")

        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            quote = value[0]
            if quote == '"':
                try:
                    value = json.loads(value)
                except json.JSONDecodeError as error:
                    raise BackupError(f"Invalid quoted value on .env line {line_number}") from error
            else:
                value = value[1:-1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
        values[key] = value
    return values


def load_database_config(path: Path) -> DatabaseConfig:
    values = read_env_file(path)
    user = values.get("DB_USER", "raidbot")
    password = values.get("DB_PASSWORD", "")
    database = values.get("DB_NAME", "raidbot")
    host = values.get("DB_HOST", "localhost")

    if not user:
        raise BackupError("DB_USER must not be empty")
    if not SAFE_DATABASE_NAME.fullmatch(database):
        raise BackupError("DB_NAME may contain only letters, numbers, and underscores")
    if any("\n" in value or "\r" in value for value in (host, user, password)):
        raise BackupError("Database connection values must not contain newlines")

    try:
        port = int(values.get("DB_PORT", "3306"))
    except ValueError as error:
        raise BackupError("DB_PORT must be an integer") from error
    if not 1 <= port <= 65535:
        raise BackupError("DB_PORT must be between 1 and 65535")

    return DatabaseConfig(host=host, port=port, user=user, password=password, database=database)


def find_program(*names: str) -> str:
    for name in names:
        executable = shutil.which(name)
        if executable:
            return executable
    raise BackupError(f"Required program not found: install one of {', '.join(names)}")


def _option_file_value(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


@contextlib.contextmanager
def mysql_defaults_file(config: DatabaseConfig) -> Iterator[Path]:
    """Create a mode-0600 client file so the password never appears in argv."""
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix="raidbot-db-",
        suffix=".cnf",
        delete=False,
    )
    path = Path(handle.name)
    try:
        os.chmod(path, 0o600)
        with handle:
            handle.write("[client]\n")
            handle.write(f"host={_option_file_value(config.host)}\n")
            handle.write(f"port={config.port}\n")
            handle.write(f"user={_option_file_value(config.user)}\n")
            handle.write(f"password={_option_file_value(config.password)}\n")
            handle.write("default-character-set=utf8mb4\n")
        yield path
    finally:
        path.unlink(missing_ok=True)


def timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def default_backup_path(config: DatabaseConfig, directory: Path, prefix: str = "backup") -> Path:
    return directory / f"{prefix}-{config.database}-{timestamp()}.sql.gz"


def backup_database(config: DatabaseConfig, output: Path, *, overwrite: bool = False) -> Path:
    if output.exists() and not overwrite:
        raise BackupError(f"Backup already exists: {output} (use --force to replace it)")

    dump_program = find_program("mariadb-dump", "mysqldump")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_name(f".{output.name}.{os.getpid()}.tmp")

    with mysql_defaults_file(config) as defaults_file:
        command = [
            dump_program,
            f"--defaults-extra-file={defaults_file}",
            "--single-transaction",
            "--quick",
            "--routines",
            "--triggers",
            "--events",
            "--hex-blob",
            config.database,
        ]
        try:
            with gzip.open(temporary_output, "wb", compresslevel=6) as compressed:
                process = subprocess.Popen(command, stdout=subprocess.PIPE)
                assert process.stdout is not None
                shutil.copyfileobj(process.stdout, compressed)
                process.stdout.close()
                return_code = process.wait()
            if return_code != 0:
                raise BackupError(f"Database dump failed with exit code {return_code}")
            temporary_output.replace(output)
        except Exception:
            temporary_output.unlink(missing_ok=True)
            raise

    print(f"Backup created: {output}")
    return output


def _mysql_command(config: DatabaseConfig, defaults_file: Path) -> list[str]:
    client = find_program("mariadb", "mysql")
    return [client, f"--defaults-extra-file={defaults_file}"]


def database_exists(config: DatabaseConfig) -> bool:
    query = (
        f"SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '{config.database}'"
    )
    with mysql_defaults_file(config) as defaults_file:
        result = subprocess.run(
            [*_mysql_command(config, defaults_file), "--batch", "--skip-column-names", "-e", query],
            check=True,
            capture_output=True,
            text=True,
        )
    return result.stdout.strip() == "1"


def confirm_restore(config: DatabaseConfig, *, assume_yes: bool = False) -> None:
    if assume_yes:
        return
    if not sys.stdin.isatty():
        raise BackupError("Restore requires an interactive terminal or the --yes option")
    print(
        f"WARNING: restore will replace database '{config.database}' on {config.host}:{config.port}."
    )
    answer = input(f"Type the database name ({config.database}) to continue: ").strip()
    if answer != config.database:
        raise BackupError("Restore cancelled")


@contextlib.contextmanager
def open_backup(path: Path) -> Iterator[BinaryIO]:
    if path.suffix == ".gz":
        with gzip.open(path, "rb") as stream:
            yield stream
    else:
        with path.open("rb") as stream:
            yield stream


def restore_database(
    config: DatabaseConfig,
    backup: Path,
    backup_directory: Path,
    *,
    assume_yes: bool = False,
) -> Path | None:
    if not backup.is_file():
        raise BackupError(f"Backup file not found: {backup}")
    confirm_restore(config, assume_yes=assume_yes)

    safety_backup: Path | None = None
    exists = database_exists(config)
    if exists:
        safety_backup = default_backup_path(config, backup_directory, prefix="pre-restore")
        backup_database(config, safety_backup)
        print(f"Safety backup created before restore: {safety_backup}")

    create_sql = (
        f"DROP DATABASE IF EXISTS `{config.database}`; "
        f"CREATE DATABASE `{config.database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    )
    with mysql_defaults_file(config) as defaults_file:
        client_command = _mysql_command(config, defaults_file)
        subprocess.run([*client_command, "-e", create_sql], check=True)
        try:
            with open_backup(backup) as stream:
                subprocess.run([*client_command, config.database], stdin=stream, check=True)
        except Exception as error:
            recovery = f" Safety backup: {safety_backup}" if safety_backup else ""
            raise BackupError(
                f"Restore failed; the database may be partially restored.{recovery}"
            ) from error

    print(f"Database '{config.database}' restored from: {backup}")
    return safety_backup


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help=f"dotenv file containing DB_* settings (default: {DEFAULT_ENV_FILE})",
    )
    parser.add_argument(
        "--backup-dir",
        type=Path,
        default=DEFAULT_BACKUP_DIR,
        help=f"directory for generated backups (default: {DEFAULT_BACKUP_DIR})",
    )

    commands = parser.add_subparsers(dest="command", required=True)
    backup_parser = commands.add_parser("backup", help="create a compressed SQL backup")
    backup_parser.add_argument("output", nargs="?", type=Path)
    backup_parser.add_argument(
        "--force", action="store_true", help="replace an existing output file"
    )

    restore_parser = commands.add_parser(
        "restore", help="replace the configured database from a backup"
    )
    restore_parser.add_argument("backup", type=Path)
    restore_parser.add_argument(
        "--yes",
        action="store_true",
        help="skip the interactive database-name confirmation",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = load_database_config(args.env_file.resolve())
        backup_directory = args.backup_dir.resolve()
        if args.command == "backup":
            output = (
                args.output.resolve()
                if args.output
                else default_backup_path(config, backup_directory)
            )
            backup_database(config, output, overwrite=args.force)
        else:
            restore_database(
                config,
                args.backup.resolve(),
                backup_directory,
                assume_yes=args.yes,
            )
    except (BackupError, OSError, subprocess.SubprocessError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
