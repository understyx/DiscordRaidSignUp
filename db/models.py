from sqlalchemy import Boolean, Column, Integer, String, DateTime, Enum, Text, BigInteger, ForeignKey, Float
from sqlalchemy.orm import DeclarativeBase, relationship
import enum
import datetime


class Base(DeclarativeBase):
    pass


class RaidStatus(str, enum.Enum):
    open = "open"
    locked = "locked"


class SignupType(str, enum.Enum):
    fill = "fill"
    prio_role = "prio_role"
    prio_character = "prio_character"


class SignupStatus(str, enum.Enum):
    signed = "signed"
    tentative = "tentative"
    declined = "declined"


class CharacterRole(str, enum.Enum):
    tank = "tank"
    healer = "healer"
    dps = "dps"


class BotGuild(Base):
    __tablename__ = "bot_guilds"
    guild_id = Column(BigInteger, primary_key=True)
    guild_name = Column(String(200), nullable=False)
    icon = Column(String(200), nullable=True)
    subdomain = Column(String(63), nullable=True)


class Raid(Base):
    __tablename__ = "raids"
    id = Column(Integer, primary_key=True, autoincrement=True)
    guild_id = Column(BigInteger, nullable=True)
    guild_raid_number = Column(Integer, nullable=False, default=0)
    name = Column(String(100), nullable=False)
    date = Column(DateTime, nullable=False)
    description = Column(Text, default="")
    raid_instance = Column(String(100), nullable=False)
    max_size = Column(Integer, default=25)
    status = Column(Enum(RaidStatus), default=RaidStatus.open)
    created_by = Column(BigInteger, nullable=False)  # Discord user ID
    discord_message_id = Column(BigInteger, nullable=True)
    discord_channel_id = Column(BigInteger, nullable=True)
    discord_log_thread_id = Column(BigInteger, nullable=True)
    signups = relationship("Signup", back_populates="raid", cascade="all, delete-orphan")
    compositions = relationship("Composition", back_populates="raid", cascade="all, delete-orphan")


class Character(Base):
    __tablename__ = "characters"
    id = Column(Integer, primary_key=True, autoincrement=True)
    guild_id = Column(BigInteger, nullable=False)
    discord_user_id = Column(BigInteger, nullable=False)
    char_name = Column(String(50), nullable=False)
    realm = Column(String(50), default="Icecrown")
    role = Column(Enum(CharacterRole), nullable=True)
    char_class = Column(String(50), nullable=True)
    spec = Column(String(100), nullable=True)
    gearscore = Column(Float, default=0.0)
    prof_1 = Column(String(50), nullable=True)
    prof_2 = Column(String(50), nullable=True)
    sfs_count = Column(Integer, nullable=True)
    val_count = Column(Integer, nullable=True)
    last_updated = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    is_deleted = Column(Boolean, default=False, nullable=False)
    signups = relationship("Signup", back_populates="character")


class Signup(Base):
    __tablename__ = "signups"
    id = Column(Integer, primary_key=True, autoincrement=True)
    raid_id = Column(Integer, ForeignKey("raids.id"), nullable=False)
    discord_user_id = Column(BigInteger, nullable=False)
    character_id = Column(Integer, ForeignKey("characters.id"), nullable=False)
    signup_type = Column(Enum(SignupType), default=SignupType.fill)
    status = Column(Enum(SignupStatus), default=SignupStatus.signed)
    is_saved = Column(Boolean, default=False)  # character is ID-locked / already saved this lockout
    note = Column(String(500), nullable=True)  # optional free-text note from the sign-up line
    created_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    raid = relationship("Raid", back_populates="signups")
    character = relationship("Character", back_populates="signups")


class RaidLogMessage(Base):
    __tablename__ = "raid_log_messages"
    raid_id = Column(Integer, ForeignKey("raids.id"), primary_key=True)
    discord_user_id = Column(BigInteger, primary_key=True)
    discord_thread_id = Column(BigInteger, nullable=False)
    discord_message_id = Column(BigInteger, nullable=False)
    updated_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.datetime.now(datetime.timezone.utc),
                        onupdate=lambda: datetime.datetime.now(datetime.timezone.utc))
    raid = relationship("Raid")


class SpecAlias(Base):
    __tablename__ = "spec_aliases"
    id = Column(Integer, primary_key=True, autoincrement=True)
    guild_id = Column(BigInteger, nullable=False)
    char_class = Column(String(50), nullable=False)
    alias = Column(String(100), nullable=False)
    canonical = Column(String(100), nullable=False)


class Composition(Base):
    __tablename__ = "compositions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    raid_id = Column(Integer, ForeignKey("raids.id"), nullable=False)
    character_id = Column(Integer, ForeignKey("characters.id"), nullable=True)  # NULL for placeholder slots
    placeholder_text = Column(String(100), nullable=True)  # e.g. "🛡️ Prot Paladin" when character_id is NULL
    role_slot = Column(String(50), nullable=False)  # e.g. "slot_1", "slot_3", "slot_10"
    slot_role = Column(String(20), nullable=False, default="dps")  # "tank", "healer", or "dps"
    comp_number = Column(Integer, default=1, nullable=False)  # which sub-comp within the raid (1, 2, 3…)
    is_sfs_collector = Column(Boolean, nullable=False, default=False)
    is_val_collector = Column(Boolean, nullable=False, default=False)
    created_by = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    updated_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.datetime.now(datetime.timezone.utc),
                        onupdate=lambda: datetime.datetime.now(datetime.timezone.utc))
    raid = relationship("Raid", back_populates="compositions")
    character = relationship("Character")


class DiscordUser(Base):
    __tablename__ = "discord_users"
    discord_user_id = Column(BigInteger, primary_key=True)
    username = Column(String(100), nullable=False)
    display_name = Column(String(100), nullable=True)
    updated_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))


class GuildAdminRole(Base):
    __tablename__ = "guild_admin_roles"
    guild_id = Column(BigInteger, primary_key=True)
    role_id = Column(BigInteger, primary_key=True)


class SuggestionStatus(str, enum.Enum):
    pending = "pending"
    accepted = "accepted"
    denied = "denied"


class CharacterSuggestion(Base):
    __tablename__ = "character_suggestions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    character_id = Column(Integer, ForeignKey("characters.id"), nullable=False)
    suggested_by = Column(BigInteger, nullable=False)
    new_char_class = Column(String(50), nullable=True)
    new_spec = Column(String(100), nullable=True)
    new_gearscore = Column(Float, nullable=True)
    status = Column(Enum(SuggestionStatus), default=SuggestionStatus.pending)
    created_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    resolved_at = Column(DateTime, nullable=True)
    character = relationship("Character")


class GuildPlayerNote(Base):
    __tablename__ = "guild_player_notes"
    guild_id = Column(BigInteger, primary_key=True)
    discord_user_id = Column(BigInteger, primary_key=True)
    note = Column(Text, nullable=False)
    updated_at = Column(DateTime, nullable=False,
                        default=lambda: datetime.datetime.now(datetime.timezone.utc),
                        onupdate=lambda: datetime.datetime.now(datetime.timezone.utc))
