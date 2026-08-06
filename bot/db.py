import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker
from bot.config import DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
from db.models import Base

DATABASE_URL = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)

def _run_migrations():
    """Apply any schema changes not handled by create_all (existing tables)."""
    pass

try:
    Base.metadata.create_all(engine)
except Exception:
    pass

_run_migrations()

try:
    with engine.begin() as _conn:
        _conn.execute(text(
            """
            CREATE TABLE IF NOT EXISTS guild_admin_roles (
                guild_id BIGINT NOT NULL,
                role_id  BIGINT NOT NULL,
                PRIMARY KEY (guild_id, role_id)
            )
            """
        ))
except Exception:
    pass

try:
    with engine.begin() as _conn:
        _conn.execute(text(
            """
            CREATE TABLE IF NOT EXISTS raid_log_messages (
                raid_id            INT NOT NULL,
                discord_user_id    BIGINT NOT NULL,
                discord_thread_id  BIGINT NOT NULL,
                discord_message_id BIGINT NOT NULL,
                updated_at         DATETIME(3) NOT NULL
                                   DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
                PRIMARY KEY (raid_id, discord_user_id),
                CONSTRAINT fk_raid_log_messages_raid
                  FOREIGN KEY (raid_id) REFERENCES raids(id) ON DELETE CASCADE
            )
            """
        ))
except Exception:
    pass

def get_session():
    return SessionLocal()
