# Discord Raid Sign-Up

A World of Warcraft raid management system consisting of three components:

- **Discord Bot** – slash commands for officers and players to manage raids and sign-ups
- **Web App** – Node.js / Express web interface with Discord OAuth2 login
- **Database** – MariaDB with SQLAlchemy 2.0 models and ordered SQL migrations

---

## Prerequisites

- [Python](https://www.python.org/downloads/) 3.11+
- [Node.js](https://nodejs.org/) v18.18+
- [MariaDB](https://mariadb.org/download/) 10.6+ (or MySQL 8+) running locally
- A [Discord Application](https://discord.com/developers/applications) with a bot token

---

## Discord Application Setup

1. Go to https://discord.com/developers/applications and create a new application.
2. Under **Bot**, create a bot and copy the **Token**.
3. Under **OAuth2 → General**, copy the **Client ID** and **Client Secret**.
4. Add the redirect URIs under **OAuth2 → Redirects**:
   - `http://localhost:8000/auth/callback` (main login)
   - `http://localhost:8000/recruitment/oauth-callback` (recruitment applicants)
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

## Running Locally

### 1. Set up the database

Log in to MariaDB/MySQL as root and create the database and user:

```sql
CREATE DATABASE raidbot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'raidbot'@'localhost' IDENTIFIED BY 'changeme';
GRANT ALL PRIVILEGES ON raidbot.* TO 'raidbot'@'localhost';
FLUSH PRIVILEGES;
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
cd web
npm ci
cd ..
```

For development tools, install `requirements-dev.txt` instead of `requirements.txt`.

### 3. Initialize the database

Apply the ordered SQL migrations, then import the item seed data:

```bash
cd web
npm run migrate
cd ..
mysql -u raidbot -p raidbot < items.sql
```

Migrations are never run as an application import or web-server side effect. Add schema changes as the next numbered file in `db/migrations/` and run `npm run migrate` before starting or restarting services.

### 4. Run the Discord bot

```bash
python -m bot.main
```

### 5. Install and run the web server

```bash
cd web
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
  cd /opt/DiscordRaidSignUp/web && npm ci --omit=dev
  ```
- The `.env` file must be present at `<APP_DIR>/.env`.

### Install

Run the install script as root (or via `sudo`):

```bash
sudo bash /opt/DiscordRaidSignUp/systemd/install.sh \
  --app-dir /opt/DiscordRaidSignUp \
  --user raidbot
```

This copies both service files to `/etc/systemd/system/`, runs the database
migrations as the service user, enables the services at boot, and restarts them.

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

### Updating an installed server

Use the update script to stop both services, back up the database, fast-forward
the Git checkout, restore file ownership, apply database migrations, and restart
the services:

```bash
sudo bash /opt/DiscordRaidSignUp/systemd/update.sh \
  --app-dir /opt/DiscordRaidSignUp \
  --user raidbot
```

The application user must have permission to pull from the configured Git
remote. If any update step fails after the services are stopped, the script
attempts to start both services again before exiting with an error.

---

## Development Checks

Install the pinned development tools and web dependencies:

```bash
pip install -r requirements-dev.txt
cd web && npm ci && cd ..
```

The root `Makefile` exposes the standard workflow:

```bash
make test      # Python and JavaScript tests
make lint      # Ruff and ESLint
make format    # Ruff formatter and Prettier
make check     # all tests, lint, and format checks
make migrate   # apply pending SQL migrations
make db-backup # create a timestamped compressed database backup
make lock      # regenerate Python and Node dependency locks (requires uv)
```

---

## Database Backups

The database utility reads `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and
`DB_NAME` from the project `.env`. It requires the MariaDB command-line tools
(`mariadb-dump` and `mariadb`) or their MySQL equivalents.

Create a timestamped, compressed backup in the git-ignored `backups/` directory:

```bash
python scripts/database_backup.py backup
```

Generated filenames include the short Git commit (for example,
`backup-raidbot-20260817T120000Z-0123456789ab.sql.gz`). The full commit is also
stored as a SQL comment inside every backup, including backups written to an
explicit output path, so the compatible application version remains identifiable
if a backup is renamed.

An explicit output path can be supplied when backups belong on separate storage:

```bash
python scripts/database_backup.py backup /secure/backups/raidbot.sql.gz
```

Restore a compressed or plain SQL backup:

```bash
python scripts/database_backup.py restore backups/backup-raidbot-TIMESTAMP-COMMIT.sql.gz
```

Restore replaces the database configured by `DB_NAME`. The command requires you
to type that database name before proceeding and, when the database already
exists, creates a timestamped `pre-restore-...sql.gz` safety backup first. Use
`--yes` only for a deliberate non-interactive restore.

To use another environment file or backup directory, put those global options
before the command:

```bash
python scripts/database_backup.py \
  --env-file /path/to/database.env \
  --backup-dir /secure/backups \
  backup
```

Database passwords are passed to the client through a private temporary
configuration file rather than command-line arguments.

---

## Discord Bot Commands

### Player Commands

| Command | Description |
|---------|-------------|
| `/addcharacter` | Register a character with class, spec(s), and gearscore(s) (up to 6 specs) |
| `/remove_character` | Remove a registered character (optionally by spec) |
| `/my_characters` | Browse a paginated character list and edit name, class, specs, and gearscores |
| `/saves view` | Show all raid-save (lockout) states for your characters |
| `/saves set` | Mark a character as saved or not saved for a raid instance |
| `/saves toggle` | Toggle the save state for a character on a raid instance |
| `/savecharacter` | Shortcut to toggle a character's save state |

### Officer Commands

| Command | Description |
|---------|-------------|
| `/create_raid` | Create a new raid via a modal dialog (Officer only) |
| `/edit_raid` | Edit a posted raid and refresh its original Discord message (Officer only) |
| `/helpraidbot` | Open a private help launcher; officers can post it in a channel, and officers/developers can DM it to a user |
| `/saves clear_all` | Clear all raid saves — equivalent to a weekly Warmane reset (Officer only) |

### Server Manager Commands

| Command | Description |
|---------|-------------|
| `/raidadmin add` | Grant a Discord role raid-admin access on the website |
| `/raidadmin remove` | Revoke raid-admin access from a Discord role |
| `/raidadmin list` | List all Discord roles with raid-admin access |

### Sign-Up Methods (via Discord)

Players can sign up for raids directly in Discord using three methods:

1. **Button** – Click ✅ **Sign Up** (or ❓ **Tentative**) on the raid embed message, then select characters.
2. **Text message** – Post character lines in the format `CharName / Class / Spec / GS` in the raid channel. The bot registers the character and signs you up automatically.
3. **Bot DM** – DM the bot with character lines to register a character (does not auto-sign-up for a raid).

### Manual verification: per-user log message upsert

Use this quick check to validate that rapid status changes mutate a single log-thread post per user:

1. Open an active raid and its sign-up log thread.
2. With one test user, perform this sequence quickly: **Sign Up** → **Tentative** → **Withdraw** → **Sign Up**.
3. Verify that the thread still has only one bot log message for that user (same message edited repeatedly, not new posts each time).
4. Repeat with another user in parallel to confirm each user keeps exactly one mutable message.

---

## Project Structure

```
.
├── bot/                  # Discord bot (discord.py 2.x slash commands)
│   ├── cogs/
│   │   ├── character/    # Character commands
│   │   ├── raid/         # Raid creation commands
│   │   ├── saves/        # Lockout management
│   │   └── signup/       # Discord sign-up workflow and views
│   ├── class_utils.py    # WoW class/spec normalisation helpers
│   ├── config.py
│   ├── db.py
│   ├── main.py
│   └── wow.py             # Shared WoW data loader
├── db/                   # Database layer
│   ├── migrations/       # Ordered SQL migration history
│   └── models.py         # SQLAlchemy 2.0 ORM models
├── shared/
│   └── wow.json          # Canonical class/spec/role/realm data
├── scripts/
│   └── database_backup.py # .env-driven database backup and restore utility
├── web/                  # Web interface (Node.js / Express + Nunjucks)
│   ├── repositories/     # Database access boundaries
│   ├── routes/           # Small route modules grouped by feature
│   ├── services/         # Domain and access policy
│   ├── templates/        # Nunjucks HTML templates
│   ├── test/             # Node test suite
│   ├── db.js
│   ├── migrate-cli.js
│   ├── migrate.js
│   ├── server.js
│   └── wotlk_buffs.json  # WotLK raid-buff definitions
├── tests/                 # Python unit tests
├── systemd/              # systemd service files + install script
│   ├── discord-raid-bot.service
│   ├── discord-raid-web.service
│   ├── install.sh
│   └── update.sh
├── .env.example          # Environment variable template
├── Makefile
├── pyproject.toml
├── items.sql             # Initial item seed data
├── requirements-dev.txt
├── requirements-dev.in
├── requirements.in
└── requirements.txt
```

---

## Environment Variables Reference

| Variable                          | Description                                                                 | Default                               |
|-----------------------------------|-----------------------------------------------------------------------------|---------------------------------------|
| `DISCORD_BOT_TOKEN`               | Bot token from Discord Developer Portal                                     | –                                     |
| `DISCORD_CLIENT_ID`               | OAuth2 Client ID                                                            | –                                     |
| `DISCORD_CLIENT_SECRET`           | OAuth2 Client Secret                                                        | –                                     |
| `DB_HOST`                         | Database host                                                               | `localhost`                           |
| `DB_PORT`                         | Database port                                                               | `3306`                                |
| `DB_USER`                         | Database user                                                               | `raidbot`                             |
| `DB_PASSWORD`                     | Database password                                                           | `changeme`                            |
| `DB_NAME`                         | Database name                                                               | `raidbot`                             |
| `WEB_SECRET_KEY`                  | Secret key for session cookies                                              | –                                     |
| `WEB_BASE_URL`                    | Public base URL of the web app                                              | `http://localhost:8000`               |
| `DISCORD_REDIRECT_URI`            | OAuth2 redirect URI for the main login flow (must match Discord app setting) | `http://localhost:8000/auth/callback` |
| `RECRUITMENT_DISCORD_REDIRECT_URI`| OAuth2 redirect URI for the recruitment applicant flow                      | `http://localhost:8000/recruitment/oauth-callback` |
| `OFFICER_ROLE_NAME`               | Discord role name with officer permissions                                  | `Officer`                             |
| `BASE_DOMAIN`                     | Root domain for per-guild subdomains (e.g. `example.com`). Leave blank if not using subdomains. | – |
| `COOKIE_DOMAIN`                   | Dot-prefixed root domain so the session cookie is shared across subdomains (e.g. `.example.com`). Required together with `BASE_DOMAIN`. | – |
| `DEMO_GUILD_ENABLED`              | Enables the disposable guild at `demo.<BASE_DOMAIN>`                         | `true`                                |
| `DEMO_GUILD_ID`                   | Synthetic negative guild ID used only for demo data                          | `-1`                                  |
| `DEMO_GUILD_NAME`                 | Display name for the demo guild                                              | `Demo Guild`                          |
| `DEMO_RESET_INTERVAL_MINUTES`     | How often the demo guild is regenerated                                      | `30`                                  |
| `DEV_USER_ID`                     | Discord user ID of the developer/admin account — grants access to developer tools such as spec aliases and the read-only signup preset peek | – |
| `DEV_FULL_ADMIN`                  | Set to `true` to treat `DEV_USER_ID` as raid-admin in every guild/server on the website (also toggleable live from Dev Tools) | `false` |
| `DEV_MODE`                        | Set to `true` to enable fake-data seeding buttons for UI testing            | `false`                               |

When `BASE_DOMAIN=raiding.site`, the web service reserves the following public
hosts: `raiding.site` and `www.raiding.site` (landing page). `demo.raiding.site`
uses the normal guild interface with disposable sample data that is regenerated
on startup and at the configured interval. Other one-level subdomains continue
to resolve as guild sites. `armory.raiding.site` is linked from the landing page
but is expected to be routed to the separate armory project.
