import pytest
from bot.cogs.signup.services import RaidSignupService, SegmentSignupInput, CharacterAvailabilityInput

def test_service_basic():
    svc = RaidSignupService()
    assert svc is not None

    seg_input = SegmentSignupInput(
        raid_segment_id=1,
        attendance="attending",
        characters=[CharacterAvailabilityInput(character_id=10, is_preferred=True)]
    )
    assert seg_input.raid_segment_id == 1
    assert seg_input.attendance == "attending"
    assert len(seg_input.characters) == 1
    assert seg_input.characters[0].is_preferred is True

def test_application_modes():
    # just checking enums
    from db.models import SignupSegmentApplicationMode
    assert SignupSegmentApplicationMode.apply_all == "apply_all"
    assert SignupSegmentApplicationMode.customized == "customized"
