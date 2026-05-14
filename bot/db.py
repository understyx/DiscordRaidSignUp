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

            # Migration 005: absolute slot system
            # Add slot_role column, convert role_slot to "slot_N" format,
            # and deduplicate any double-booked slot numbers.
            if "slot_role" not in comp_columns:
                conn.execute(text(
                    "ALTER TABLE compositions"
                    " ADD COLUMN slot_role VARCHAR(20) NOT NULL DEFAULT 'dps' AFTER role_slot"
                ))
                # Populate slot_role from the role prefix in the existing role_slot values.
                # All rows have slot_role='dps' (the column default) at this point,
                # so the WHERE clause matches everything and every row is correctly set.
                conn.execute(text(
                    "UPDATE compositions"
                    " SET slot_role = SUBSTRING_INDEX(role_slot, '_', 1)"
                    " WHERE role_slot NOT LIKE 'slot\\_%'"
                ))
                # Remove duplicate slot numbers: keep the row with the lowest id
                # for each (raid_id, comp_number, slot_number).
                conn.execute(text(
                    "DELETE c1 FROM compositions c1"
                    " JOIN compositions c2"
                    "   ON  c2.raid_id     = c1.raid_id"
                    "   AND c2.comp_number = c1.comp_number"
                    "   AND SUBSTRING_INDEX(c2.role_slot, '_', -1)"
                    "     = SUBSTRING_INDEX(c1.role_slot, '_', -1)"
                    "   AND c2.id < c1.id"
                ))
                # Convert role_slot values from "role_N" to "slot_N" format
                conn.execute(text(
                    "UPDATE compositions"
                    " SET role_slot = CONCAT('slot_', SUBSTRING_INDEX(role_slot, '_', -1))"
                    " WHERE role_slot NOT LIKE 'slot\\_%'"
                ))


        if inspector.has_table("characters"):
            char_columns = {col["name"] for col in inspector.get_columns("characters")}
            if "is_deleted" not in char_columns:
                conn.execute(text(
                    "ALTER TABLE characters ADD COLUMN is_deleted TINYINT(1) NOT NULL DEFAULT 0"
                ))


_run_migrations()

# Ensure guild_admin_roles table exists (not covered by create_all for pre-existing DBs)
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


def get_session():
    return SessionLocal()
