from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Dict, Set, List, Any

@dataclass
class SegmentDraftState:
    attendance: str = "attending"
    selected_character_ids: Set[int] = field(default_factory=set)
    preferred_character_ids: Set[int] = field(default_factory=set)
    note: str | None = None

@dataclass
class MultiRaidSignupDraft:
    raid_id: int
    user_id: int
    selected_character_ids: Set[int] = field(default_factory=set)
    preferred_character_ids: Set[int] = field(default_factory=set)
    general_note: str | None = None
    segment_states: Dict[int, SegmentDraftState] = field(default_factory=dict)
    current_segment_index: int = 0
    expires_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc) + timedelta(minutes=15))
    segment_data: List[Dict[str, Any]] = field(default_factory=list)

DRAFTS: Dict[str, MultiRaidSignupDraft] = {}

def get_draft_key(raid_id: int, user_id: int) -> str:
    return f"{raid_id}_{user_id}"

def get_draft(raid_id: int, user_id: int) -> MultiRaidSignupDraft | None:
    key = get_draft_key(raid_id, user_id)
    draft = DRAFTS.get(key)
    if draft:
        if datetime.now(timezone.utc) > draft.expires_at:
            del DRAFTS[key]
            return None
        return draft
    return None

def set_draft(draft: MultiRaidSignupDraft):
    key = get_draft_key(draft.raid_id, draft.user_id)
    DRAFTS[key] = draft
