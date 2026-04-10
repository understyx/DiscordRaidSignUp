from sqlalchemy import Boolean, Column, Integer, String, DateTime, Enum, Text, BigInteger, ForeignKey, Float
from sqlalchemy.orm import DeclarativeBase, relationship
import enum
import datetime


class Base(DeclarativeBase):
    pass


class RaidStatus(str, enum.Enum):
    open = "open"
    locked = "locked"
    posted = "posted"


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


class Raid(Base):
    __tablename__ = "raids"
    id = Column(Integer, primary_key=True, autoincrement=True)
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
    discord_user_id = Column(BigInteger, nullable=False)
    char_name = Column(String(50), nullable=False)
    realm = Column(String(50), default="Icecrown")
    role = Column(Enum(CharacterRole), nullable=True)
    char_class = Column(String(50), nullable=True)
    spec = Column(String(100), nullable=True)
    gearscore = Column(Float, default=0.0)
    last_updated = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
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
    created_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    raid = relationship("Raid", back_populates="signups")
    character = relationship("Character", back_populates="signups")


class Composition(Base):
    __tablename__ = "compositions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    raid_id = Column(Integer, ForeignKey("raids.id"), nullable=False)
    character_id = Column(Integer, ForeignKey("characters.id"), nullable=True)  # NULL for placeholder slots
    placeholder_text = Column(String(100), nullable=True)  # e.g. "🛡️ Prot Paladin" when character_id is NULL
    role_slot = Column(String(50), nullable=False)  # e.g. "slot_1", "slot_3", "slot_10"
    slot_role = Column(String(20), nullable=False, default="dps")  # "tank", "healer", or "dps"
    comp_number = Column(Integer, default=1, nullable=False)  # which sub-comp within the raid (1, 2, 3…)
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
