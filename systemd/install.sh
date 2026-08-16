#!/usr/bin/env bash
# install.sh — install and enable the Discord Raid Sign-Up systemd services
#
# Usage:
#   sudo bash systemd/install.sh [--app-dir /opt/DiscordRaidSignUp] [--user raidbot]
#
# The script will:
#   1. Copy both .service files to /etc/systemd/system/
#   2. Replace placeholder paths/users with the actual values you supply
#   3. Apply database migrations
#   4. Reload systemd, enable and restart the services

set -euo pipefail

APP_DIR="/opt/DiscordRaidSignUp"
APP_USER="raidbot"

# Parse optional arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)  APP_DIR="$2";  shift 2 ;;
    --user)     APP_USER="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing services"
echo "    App directory : $APP_DIR"
echo "    Service user  : $APP_USER"
echo ""

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: This script must be run as root (sudo)." >&2
  exit 1
fi

for svc in discord-raid-bot discord-raid-web; do
  SRC="$SCRIPT_DIR/${svc}.service"
  DST="/etc/systemd/system/${svc}.service"

  # Substitute placeholder values
  sed \
    -e "s|/opt/DiscordRaidSignUp|${APP_DIR}|g" \
    -e "s|User=raidbot|User=${APP_USER}|g" \
    -e "s|Group=raidbot|Group=${APP_USER}|g" \
    "$SRC" > "$DST"

  echo "    Installed $DST"
done

echo ""
echo "==> Applying database migrations"
(
  cd "$APP_DIR/web"
  runuser -u "$APP_USER" -- npm run migrate
)

echo ""
echo "==> Reloading systemd daemon"
systemctl daemon-reload

echo "==> Enabling services (start at boot)"
systemctl enable discord-raid-bot.service discord-raid-web.service

echo ""
echo "==> Restarting services"
systemctl restart discord-raid-bot.service discord-raid-web.service

echo ""
echo "Done!  Check status with:"
echo "  systemctl status discord-raid-bot"
echo "  systemctl status discord-raid-web"
echo ""
echo "View logs with:"
echo "  journalctl -u discord-raid-bot -f"
echo "  journalctl -u discord-raid-web -f"
