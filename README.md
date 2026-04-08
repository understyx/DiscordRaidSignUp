# Discord Raid Sign-Up

A World of Warcraft raid management system consisting of three components:

- **Discord Bot** – slash commands for officers and players to manage raids and sign-ups
- **Web App** – FastAPI + Jinja2 web interface with Discord OAuth2 login
- **Database** – MariaDB with SQLAlchemy 2.0 ORM and Alembic migrations

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)
- [Node.js](https://nodejs.org/) v18+ (for local tooling / static file serving without Docker)
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

# Database (matches docker-compose defaults)
DB_HOST=db
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

> **Tip:** Generate a strong `WEB_SECRET_KEY` with Node.js:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## Running with Docker Compose (recommended)

```bash
docker compose up --build
```

This starts three containers:

| Container | Description                          | Port  |
|-----------|--------------------------------------|-------|
| `db`      | MariaDB database                     | –     |
| `bot`     | Discord bot                          | –     |
| `web`     | Web interface (FastAPI + uvicorn)    | 8000  |

The web app will be available at **http://localhost:8000**.

To run in detached (background) mode:

```bash
docker compose up --build -d
```

To stop everything:

```bash
docker compose down
```

To stop and remove the database volume (full reset):

```bash
docker compose down -v
```

---

## Database Migrations

Migrations are managed with [Alembic](https://alembic.sqlalchemy.org/). When the containers are running, apply pending migrations:

```bash
docker compose exec web alembic upgrade head
```

To create a new migration after changing `db/models.py`:

```bash
docker compose exec web alembic revision --autogenerate -m "describe your change"
```

---

## Local Development (without Docker)

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Start a local MariaDB / MySQL instance

Use Docker just for the database:

```bash
docker compose up -d db
```

Update `DB_HOST=localhost` in your `.env` when connecting from outside Docker.

### 3. Run the Discord bot

```bash
python -m bot.main
```

### 4. Serve the web application

Use [Node.js `http-server`](https://www.npmjs.com/package/http-server) via `npx` to preview static assets, or run the app directly through its ASGI runner:

```bash
# Serve the FastAPI app (requires uvicorn from requirements.txt)
uvicorn web.main:app --reload --host 0.0.0.0 --port 8000
```

> To quickly browse compiled or exported static files with Node.js:
> ```bash
> npx http-server ./web/static -p 8080
> ```

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
├── web/                  # Web interface (FastAPI + Jinja2 + Discord OAuth2)
│   ├── routers/
│   ├── templates/
│   └── main.py
├── .env.example          # Environment variable template
├── docker-compose.yml
├── Dockerfile.bot
├── Dockerfile.web
├── items.sql             # Initial item seed data
└── requirements.txt
```

---

## Environment Variables Reference

| Variable               | Description                                          | Default              |
|------------------------|------------------------------------------------------|----------------------|
| `DISCORD_BOT_TOKEN`    | Bot token from Discord Developer Portal             | –                    |
| `DISCORD_CLIENT_ID`    | OAuth2 Client ID                                     | –                    |
| `DISCORD_CLIENT_SECRET`| OAuth2 Client Secret                                 | –                    |
| `DB_HOST`              | Database host                                        | `db`                 |
| `DB_PORT`              | Database port                                        | `3306`               |
| `DB_USER`              | Database user                                        | `raidbot`            |
| `DB_PASSWORD`          | Database password                                    | `changeme`           |
| `DB_NAME`              | Database name                                        | `raidbot`            |
| `WEB_SECRET_KEY`       | Secret key for session cookies                       | –                    |
| `WEB_BASE_URL`         | Public base URL of the web app                       | `http://localhost:8000` |
| `DISCORD_REDIRECT_URI` | OAuth2 redirect URI (must match Discord app setting) | `http://localhost:8000/auth/callback` |
| `OFFICER_ROLE_NAME`    | Discord role name with officer permissions           | `Officer`            |
