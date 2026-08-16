import os

from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN: str = os.environ["DISCORD_BOT_TOKEN"]
DB_HOST: str = os.environ.get("DB_HOST", "localhost")
DB_PORT: int = int(os.environ.get("DB_PORT", "3306"))
DB_USER: str = os.environ.get("DB_USER", "raidbot")
DB_PASSWORD: str = os.environ.get("DB_PASSWORD", "changeme")
DB_NAME: str = os.environ.get("DB_NAME", "raidbot")
OFFICER_ROLE_NAME: str = os.environ.get("OFFICER_ROLE_NAME", "Officer")
WEB_BASE_URL: str = os.environ.get("WEB_BASE_URL", "http://localhost:8000")
BASE_DOMAIN: str = os.environ.get("BASE_DOMAIN", "")
DEV_USER_ID: str = os.environ.get("DEV_USER_ID", "")
