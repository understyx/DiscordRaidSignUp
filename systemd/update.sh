#!/usr/bin/env bash
# Safely update an installed Discord Raid Sign-Up deployment.
#
# Usage:
#   sudo bash systemd/update.sh [--app-dir /opt/DiscordRaidSignUp] [--user raidbot]

set -euo pipefail

APP_DIR="/opt/DiscordRaidSignUp"
APP_USER="raidbot"
SERVICES=(discord-raid-bot.service discord-raid-web.service)
SERVICES_STOPPED=false

usage() {
  cat <<'EOF'
Usage: update.sh [--app-dir PATH] [--user USER]

Options:
  --app-dir PATH  Installed application directory (default: /opt/DiscordRaidSignUp)
  --user USER     Account that owns and runs the application (default: raidbot)
  -h, --help      Show this help
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)
      [[ $# -ge 2 ]] || fail "--app-dir requires a value"
      APP_DIR="$2"
      shift 2
      ;;
    --user)
      [[ $# -ge 2 ]] || fail "--user requires a value"
      APP_USER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

[[ "$EUID" -eq 0 ]] || fail "This script must be run as root (sudo)."
command -v systemctl >/dev/null || fail "systemctl is not installed."
command -v runuser >/dev/null || fail "runuser is not installed."
command -v git >/dev/null || fail "git is not installed."
command -v npm >/dev/null || fail "npm is not installed."
command -v realpath >/dev/null || fail "realpath is not installed."
id "$APP_USER" >/dev/null 2>&1 || fail "User does not exist: $APP_USER"

[[ -d "$APP_DIR" ]] || fail "Application directory does not exist: $APP_DIR"
APP_DIR="$(realpath -e -- "$APP_DIR")"
[[ "$APP_DIR" != "/" ]] || fail "Refusing to use the filesystem root as the application directory."
[[ -d "$APP_DIR/.git" ]] || fail "Not a Git checkout: $APP_DIR"
[[ -x "$APP_DIR/venv/bin/python" ]] || fail "Python virtual environment not found at $APP_DIR/venv"
[[ -f "$APP_DIR/scripts/database_backup.py" ]] || fail "Database backup script is missing."
[[ -f "$APP_DIR/web/package.json" ]] || fail "Web package.json is missing."

restore_services_on_failure() {
  local status=$?

  if [[ "$SERVICES_STOPPED" == true ]]; then
    echo
    echo "==> Update failed; attempting to start the services again" >&2
    systemctl start "${SERVICES[@]}" || \
      echo "ERROR: The services could not be restarted; inspect them with systemctl status." >&2
  fi

  exit "$status"
}
trap restore_services_on_failure EXIT

echo "==> Stopping bot and web services"
SERVICES_STOPPED=true
systemctl stop "${SERVICES[@]}"

echo
echo "==> Backing up the database"
runuser -u "$APP_USER" -- \
  "$APP_DIR/venv/bin/python" "$APP_DIR/scripts/database_backup.py" backup

echo
echo "==> Pulling the latest code"
runuser -u "$APP_USER" -- \
  env GIT_TERMINAL_PROMPT=0 git -C "$APP_DIR" pull --ff-only

echo
echo "==> Restoring application ownership"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo
echo "==> Applying database migrations"
(
  cd "$APP_DIR/web"
  runuser -u "$APP_USER" -- npm run migrate
)

echo
echo "==> Restarting bot and web services"
systemctl restart "${SERVICES[@]}"
SERVICES_STOPPED=false

trap - EXIT
echo
echo "Update completed successfully."
