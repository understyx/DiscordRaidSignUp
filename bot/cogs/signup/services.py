from dataclasses import dataclass
from typing import Optional, List
import logging
from bot.db import get_session
from db.models import Signup, RaidSegmentParticipation, RaidSegmentParticipationCharacter, SignupSegmentApplicationMode

logger = logging.getLogger(__name__)

@dataclass
class CharacterAvailabilityInput:
    character_id: int
    is_preferred: bool

@dataclass
class SegmentSignupInput:
    raid_segment_id: int
    attendance: str
    characters: List[CharacterAvailabilityInput]
    note: Optional[str] = None

class RaidSignupService:
    def create_or_update_signup(
        self,
        *,
        raid_id: int,
        user_id: int,
        general_note: Optional[str],
        application_mode: str,
        segments: List[SegmentSignupInput],
        source: str,
    ) -> Optional[Signup]:
        session = get_session()
        try:
            # Upsert canonical signup
            signup = session.query(Signup).filter_by(
                raid_id=raid_id,
                discord_user_id=user_id
            ).first()

            if not signup:
                signup = Signup(
                    raid_id=raid_id,
                    discord_user_id=user_id,
                    segment_application_mode=application_mode,
                    note=general_note
                )
                session.add(signup)
                session.flush()
            else:
                signup.segment_application_mode = application_mode
                signup.note = general_note
                session.flush()
                # Clear existing participations to replace them cleanly
                session.query(RaidSegmentParticipation).filter_by(signup_id=signup.id).delete()

            # Insert participations
            for seg in segments:
                part = RaidSegmentParticipation(
                    signup_id=signup.id,
                    raid_segment_id=seg.raid_segment_id,
                    attendance=seg.attendance,
                    note=seg.note
                )
                session.add(part)
                session.flush()

                for char in seg.characters:
                    char_assoc = RaidSegmentParticipationCharacter(
                        participation_id=part.id,
                        character_id=char.character_id,
                        is_preferred=char.is_preferred
                    )
                    session.add(char_assoc)

            session.commit()
            return signup
        except Exception as e:
            session.rollback()
            logger.exception(f"Failed to upsert signup for user {user_id} on raid {raid_id}")
            raise e
        finally:
            session.close()
