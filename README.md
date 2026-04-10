# Discord Raid Sign-Up

A World of Warcraft raid management system consisting of three components:

- **Discord Bot** – slash commands for officers and players to manage raids and sign-ups
- **Web App** – Node.js / Express web interface with Discord OAuth2 login
- **Database** – MariaDB with SQLAlchemy 2.0 ORM and Alembic migrations

---

## Prerequisites

- [Python](https://www.python.org/downloads/) 3.11+
- [Node.js](https://nodejs.org/) v18+
- [MariaDB](https://mariadb.org/download/) 10.6+ (or MySQL 8+) running locally
- A [Discord Application](https://discord.com/developers/applications) with a bot token

---

## Discord Application Setup

1. Go to https://discord.com/developers/applications and create a new application.
2. Under **Bot**, create a bot and copy the **Token**.
3. Under **OAuth2 → General**, copy the **Client ID** and **Client Secret**.
4. Add the redirect URI `http://localhost:8000/auth/callback` under **OAuth2 → Redirects**.
5. Under **Bot → Privileged Gateway Intents**, enable:
   - **Server Members Intent**
   - **Message Content Intent**
6. Invite the bot to your server using the OAuth2 URL Generator with the `bot` and `applications.commands` scopes and at minimum **Send Messages** / **Manage Roles** permissions.

---

## Configuration

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Discord Bot
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret

# Database – point to your local MariaDB/MySQL instance
DB_HOST=localhost
DB_PORT=3306
DB_USER=raidbot
DB_PASSWORD=changeme
DB_NAME=raidbot

# Web
WEB_SECRET_KEY=change_this_to_a_long_random_string
WEB_BASE_URL=http://localhost:8000
DISCORD_REDIRECT_URI=http://localhost:8000/auth/callback

# Discord role that can manage raids
OFFICER_ROLE_NAME=Officer
```

> **Tip:** Generate a strong `WEB_SECRET_KEY`:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## Running Locally (without Docker)

### 1. Set up the database

Log in to MariaDB/MySQL as root and create the database and user:

```sql
CREATE DATABASE raidbot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'raidbot'@'localhost' IDENTIFIED BY 'changeme';
GRANT ALL PRIVILEGES ON raidbot.* TO 'raidbot'@'localhost';
FLUSH PRIVILEGES;
```

Then import the item seed data:

```bash
mysql -u raidbot -p raidbot < items.sql
```

### 2. Install Python dependencies

```bash
pip install -r requirements.txt
```

### 3. Apply database migrations

Run Alembic from the project root to create all tables:

```bash
alembic upgrade head
```

To create a new migration after changing `db/models.py`:

```bash
alembic revision --autogenerate -m "describe your change"
```

### 4. Run the Discord bot

```bash
python -m bot.main
```

### 5. Install and run the web server

```bash
cd web
npm install
npm start
```

The web app will be available at **http://localhost:8000**.

---

## Running as systemd Services (recommended for servers)

The `systemd/` directory contains service unit files and an install script so
both the bot and web server are managed by systemd — they will start at boot,
restart automatically on failure, and log to the journal.

### Prerequisites

- The app files must be deployed somewhere on the host (e.g. `/opt/DiscordRaidSignUp`).
- A dedicated system user should own the files (default: `raidbot`).
  ```bash
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin raidbot
  sudo chown -R raidbot:raidbot /opt/DiscordRaidSignUp
  ```
- Python virtual environment must exist at `<APP_DIR>/venv`:
  ```bash
  python3 -m venv /opt/DiscordRaidSignUp/venv
  /opt/DiscordRaidSignUp/venv/bin/pip install -r /opt/DiscordRaidSignUp/requirements.txt
  ```
- Node.js dependencies must be installed:
  ```bash
  cd /opt/DiscordRaidSignUp/web && npm install --production
  ```
- The `.env` file must be present at `<APP_DIR>/.env`.

### Install

Run the install script as root (or via `sudo`):

```bash
sudo bash /opt/DiscordRaidSignUp/systemd/install.sh \
  --app-dir /opt/DiscordRaidSignUp \
  --user raidbot
```

This copies both service files to `/etc/systemd/system/`, enables them to
start at boot, and starts them immediately.

### Common management commands

```bash
# Check status
systemctl status discord-raid-bot
systemctl status discord-raid-web

# Start / stop / restart
sudo systemctl start  discord-raid-bot discord-raid-web
sudo systemctl stop   discord-raid-bot discord-raid-web
sudo systemctl restart discord-raid-bot discord-raid-web

# Follow live logs
journalctl -u discord-raid-bot -f
journalctl -u discord-raid-web -f
```

---

## Running with Docker Compose

If you prefer containers, Docker Compose is also supported:

```bash
docker compose up --build
```

| Container | Description        | Port  |
|-----------|--------------------|-------|
| `db`      | MariaDB database   | –     |
| `bot`     | Discord bot        | –     |
| `web`     | Web interface      | 8000  |

> When using Docker Compose, set `DB_HOST=db` in your `.env` (the compose service name).

Apply migrations inside the running container:

```bash
docker compose exec bot alembic upgrade head
```

---

## Project Structure

```
.
├── bot/                  # Discord bot (discord.py 2.x slash commands)
│   ├── cogs/
│   │   ├── character.py  # Character management commands
│   │   ├── raid.py       # Raid creation/management (officers only)
│   │   └── signup.py     # Sign-up / persistent button views
│   ├── config.py
│   └── main.py
├── db/                   # Database layer
│   ├── migrations/       # Alembic migration scripts
│   └── models.py         # SQLAlchemy 2.0 ORM models
├── web/                  # Web interface (Node.js / Express + Nunjucks)
│   ├── routes/
│   ├── templates/
│   ├── db.js
│   └── server.js
├── systemd/              # systemd service files + install script
│   ├── discord-raid-bot.service
│   ├── discord-raid-web.service
│   └── install.sh
├── .env.example          # Environment variable template
├── docker-compose.yml
├── Dockerfile.bot
├── Dockerfile.web
├── items.sql             # Initial item seed data
└── requirements.txt
```

---

## Environment Variables Reference

| Variable                 | Description                                          | Default                               |
|--------------------------|------------------------------------------------------|---------------------------------------|
| `DISCORD_BOT_TOKEN`      | Bot token from Discord Developer Portal             | –                                     |
| `DISCORD_CLIENT_ID`      | OAuth2 Client ID                                     | –                                     |
| `DISCORD_CLIENT_SECRET`  | OAuth2 Client Secret                                 | –                                     |
| `DB_HOST`                | Database host                                        | `localhost`                           |
| `DB_PORT`                | Database port                                        | `3306`                                |
| `DB_USER`                | Database user                                        | `raidbot`                             |
| `DB_PASSWORD`            | Database password                                    | `changeme`                            |
| `DB_NAME`                | Database name                                        | `raidbot`                             |
| `WEB_SECRET_KEY`         | Secret key for session cookies                       | –                                     |
| `WEB_BASE_URL`           | Public base URL of the web app                       | `http://localhost:8000`               |
| `DISCORD_REDIRECT_URI`   | OAuth2 redirect URI (must match Discord app setting) | `http://localhost:8000/auth/callback` |
| `OFFICER_ROLE_NAME`      | Discord role name with officer permissions           | `Officer`                             |
