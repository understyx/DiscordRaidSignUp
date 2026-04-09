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

        if inspector.has_table("compositions"):
            comp_columns = {col["name"] for col in inspector.get_columns("compositions")}
            if "comp_number" not in comp_columns:
                conn.execute(text(
                    "ALTER TABLE compositions ADD COLUMN comp_number INT NOT NULL DEFAULT 1"
                ))
            if "placeholder_text" not in comp_columns:
                # placeholder slots have no character, so character_id must be nullable
                conn.execute(text(
                    "ALTER TABLE compositions MODIFY COLUMN character_id INT NULL"
                ))
                conn.execute(text(
                    "ALTER TABLE compositions ADD COLUMN placeholder_text VARCHAR(100) NULL AFTER character_id"
                ))
            if "updated_at" not in comp_columns:
                conn.execute(text(
                    "ALTER TABLE compositions ADD COLUMN updated_at DATETIME(3) NOT NULL"
                    " DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)"
                ))
                conn.execute(text(
                    "UPDATE compositions SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = 0"
                ))
            comp_unique_keys = {uc["name"] for uc in inspector.get_unique_constraints("compositions")}
            if "uq_comp_slot" not in comp_unique_keys:
                conn.execute(text(
                    "ALTER TABLE compositions ADD UNIQUE KEY uq_comp_slot (raid_id, comp_number, role_slot)"
                ))


_run_migrations()


def get_session():
    return SessionLocal()
