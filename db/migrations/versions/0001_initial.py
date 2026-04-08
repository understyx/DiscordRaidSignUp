"""Initial schema: raids, characters, signups, compositions

Revision ID: 0001
Revises:
Create Date: 2024-01-01 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "raids",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("date", sa.DateTime(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("raid_instance", sa.String(100), nullable=False),
        sa.Column("max_size", sa.Integer(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("open", "locked", "posted", name="raidstatus"),
            nullable=True,
        ),
        sa.Column("created_by", sa.BigInteger(), nullable=False),
        sa.Column("discord_message_id", sa.BigInteger(), nullable=True),
        sa.Column("discord_channel_id", sa.BigInteger(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "characters",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("discord_user_id", sa.BigInteger(), nullable=False),
        sa.Column("char_name", sa.String(50), nullable=False),
        sa.Column("realm", sa.String(50), nullable=True),
        sa.Column(
            "role",
            sa.Enum("tank", "healer", "dps", name="characterrole"),
            nullable=True,
        ),
        sa.Column("char_class", sa.String(50), nullable=True),
        sa.Column("spec", sa.String(100), nullable=True),
        sa.Column("gearscore", sa.Float(), nullable=True),
        sa.Column("last_updated", sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "signups",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("raid_id", sa.Integer(), nullable=False),
        sa.Column("discord_user_id", sa.BigInteger(), nullable=False),
        sa.Column("character_id", sa.Integer(), nullable=False),
        sa.Column(
            "signup_type",
            sa.Enum("fill", "prio_role", "prio_character", name="signuptype"),
            nullable=True,
        ),
        sa.Column(
            "status",
            sa.Enum("signed", "tentative", "declined", name="signupstatus"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["character_id"], ["characters.id"]),
        sa.ForeignKeyConstraint(["raid_id"], ["raids.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "compositions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("raid_id", sa.Integer(), nullable=False),
        sa.Column("character_id", sa.Integer(), nullable=False),
        sa.Column("role_slot", sa.String(50), nullable=False),
        sa.Column("created_by", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["character_id"], ["characters.id"]),
        sa.ForeignKeyConstraint(["raid_id"], ["raids.id"]),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("compositions")
    op.drop_table("signups")
    op.drop_table("characters")
    op.drop_table("raids")
