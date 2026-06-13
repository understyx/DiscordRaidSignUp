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
    discord_user_id = Column(BigInteger, nullable=False)
    char_name = Column(String(50), nullable=False)
    realm = Column(String(50), default="Icecrown")
    role = Column(Enum(CharacterRole), nullable=True)
    char_class = Column(String(50), nullable=True)
    spec = Column(String(100), nullable=True)
    gearscore = Column(Float, default=0.0)
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


class GuildAdminRole(Base):
    __tablename__ = "guild_admin_roles"
    guild_id = Column(BigInteger, primary_key=True)
    role_id = Column(BigInteger, primary_key=True)


class SignupRestriction(str, enum.Enum):
    all = "all"
    guild_member = "guild_member"
    role = "role"


class GuildSettings(Base):
    __tablename__ = "guild_settings"
    guild_id = Column(BigInteger, primary_key=True)
    signup_restriction = Column(Enum(SignupRestriction), default=SignupRestriction.all, nullable=False)
    signup_role_id = Column(BigInteger, nullable=True)
    recruitment_category_open_id = Column(BigInteger, nullable=True)
    recruitment_category_closed_id = Column(BigInteger, nullable=True)


class RecruitmentForm(Base):
    __tablename__ = "recruitment_forms"
    id = Column(Integer, primary_key=True, autoincrement=True)
    guild_id = Column(BigInteger, nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    slug = Column(String(100), unique=True, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_by = Column(BigInteger, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    recruit_role_id = Column(BigInteger, nullable=True)
    invite_channel_id = Column(BigInteger, nullable=True)
    questions = relationship("RecruitmentQuestion", back_populates="form", cascade="all, delete-orphan")
    applications = relationship("RecruitmentApplication", back_populates="form", cascade="all, delete-orphan")


class QuestionType(str, enum.Enum):
    text = "text"
    textarea = "textarea"
    select = "select"
    radio = "radio"
    characters = "characters"
    checkbox = "checkbox"
    header = "header"
    separator = "separator"


class ColWidth(str, enum.Enum):
    full = "full"
    half = "half"
    third = "third"


class RecruitmentQuestion(Base):
    __tablename__ = "recruitment_questions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    form_id = Column(Integer, ForeignKey("recruitment_forms.id"), nullable=False)
    question_text = Column(Text, nullable=False)
    question_type = Column(Enum(QuestionType), default=QuestionType.text, nullable=False)
    options = Column(Text, nullable=True)  # JSON string
    is_required = Column(Boolean, default=False, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    default_value = Column(Text, nullable=True)
    group_key = Column(String(100), nullable=True)
    group_label = Column(String(255), nullable=True)
    is_group_repeatable = Column(Boolean, default=False, nullable=False)
    col_width = Column(Enum(ColWidth), default=ColWidth.full, nullable=False)
    form = relationship("RecruitmentForm", back_populates="questions")


class ApplicationStatus(str, enum.Enum):
    pending = "pending"
    accepted = "accepted"
    rejected = "rejected"


class RecruitmentApplication(Base):
    __tablename__ = "recruitment_applications"
    id = Column(Integer, primary_key=True, autoincrement=True)
    form_id = Column(Integer, ForeignKey("recruitment_forms.id"), nullable=False)
    guild_id = Column(BigInteger, nullable=False)
    applicant_discord_id = Column(BigInteger, nullable=False)
    applicant_username = Column(String(100), nullable=False)
    applicant_display_name = Column(String(100), nullable=False)
    status = Column(Enum(ApplicationStatus), default=ApplicationStatus.pending, nullable=False)
    wants_discord_notify = Column(Boolean, default=False, nullable=False)
    discord_invited = Column(Boolean, default=False, nullable=False)
    discord_channel_id = Column(BigInteger, nullable=True)
    submitted_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    reviewed_by = Column(BigInteger, nullable=True)
    reviewed_at = Column(DateTime, nullable=True)
    form = relationship("RecruitmentForm", back_populates="applications")
    answers = relationship("RecruitmentAnswer", back_populates="application", cascade="all, delete-orphan")


class RecruitmentAnswer(Base):
    __tablename__ = "recruitment_answers"
    id = Column(Integer, primary_key=True, autoincrement=True)
    application_id = Column(Integer, ForeignKey("recruitment_applications.id"), nullable=False)
    question_id = Column(Integer, ForeignKey("recruitment_questions.id"), nullable=False)
    answer_text = Column(Text, nullable=True)
    application = relationship("RecruitmentApplication", back_populates="answers")


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
