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

Base.metadata.create_all(engine)


def _run_migrations():
    """Apply any schema changes not handled by create_all (existing tables)."""
    inspector = inspect(engine)
    if not inspector.has_table("raids"):
        return
    with engine.begin() as conn:
        raids_columns = {col["name"] for col in inspector.get_columns("raids")}
        if "discord_log_thread_id" not in raids_columns:
            conn.execute(text(
                "ALTER TABLE raids ADD COLUMN discord_log_thread_id BIGINT NULL"
            ))


_run_migrations()


def get_session():
    return SessionLocal()
