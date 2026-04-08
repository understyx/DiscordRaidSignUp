import datetime
import json
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from db.models import Character, Composition, Raid, RaidStatus, Signup, SignupStatus, SignupType
from web.db import get_session

router = APIRouter(prefix="/raids", tags=["raids"])
TEMPLATES_DIR = Path(__file__).parent.parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

OFFICER_ROLE_NAME = "Officer"


def _raid_url(raid_id: int, suffix: str = "") -> str:
    """Build a safe internal /raids/<id> URL. raid_id is always typed as int."""
    return f"/raids/{int(raid_id)}{suffix}"


def _require_login(request: Request):
    if not request.session.get("user_id"):
        return RedirectResponse("/auth/login", status_code=302)
    return None


def _pop_flash(request: Request) -> Optional[str]:
    msg = request.session.pop("flash", None)
    return msg


# ── GET /raids ─────────────────────────────────────────────────────────────
@router.get("", response_class=HTMLResponse)
async def raids_list(request: Request, db: Session = Depends(get_session)):
    redir = _require_login(request)
    if redir:
        return redir

    all_raids = (
        db.query(Raid)
        .order_by(
            (Raid.status == RaidStatus.open).desc(),
            Raid.date.asc(),
        )
        .all()
    )

    raid_data = []
    for r in all_raids:
        count = db.query(Signup).filter_by(raid_id=r.id).count()
        raid_data.append({"raid": r, "signup_count": count})

    return templates.TemplateResponse(
        "raids_list.html",
        {
            "request": request,
            "raids": raid_data,
            "flash": _pop_flash(request),
            "user": {"id": request.session.get("user_id"), "username": request.session.get("username")},
        },
    )


# ── GET /raids/create ──────────────────────────────────────────────────────
@router.get("/create", response_class=HTMLResponse)
async def create_raid_form(request: Request):
    redir = _require_login(request)
    if redir:
        return redir

    return templates.TemplateResponse(
        "create_raid.html",
        {
            "request": request,
            "flash": _pop_flash(request),
            "user": {"id": request.session.get("user_id"), "username": request.session.get("username")},
        },
    )


# ── POST /raids/create ─────────────────────────────────────────────────────
@router.post("/create")
async def create_raid(
    request: Request,
    name: str = Form(...),
    raid_instance: str = Form(...),
    date: str = Form(...),
    description: str = Form(""),
    max_size: int = Form(25),
    db: Session = Depends(get_session),
):
    redir = _require_login(request)
    if redir:
        return redir

    try:
        raid_dt = datetime.datetime.fromisoformat(date)
    except ValueError:
        request.session["flash"] = "❌ Invalid date format."
        return RedirectResponse("/raids/create", status_code=302)

    user_id = int(request.session["user_id"])
    raid = Raid(
        name=name,
        date=raid_dt,
        description=description,
        raid_instance=raid_instance,
        max_size=max_size,
        status=RaidStatus.open,
        created_by=user_id,
    )
    db.add(raid)
    db.commit()
    request.session["flash"] = f"✅ Raid '{name}' created!"
    return RedirectResponse(_raid_url(raid.id), status_code=302)


# ── GET /raids/{raid_id} ───────────────────────────────────────────────────
@router.get("/{raid_id}", response_class=HTMLResponse)
async def raid_detail(request: Request, raid_id: int, db: Session = Depends(get_session)):
    redir = _require_login(request)
    if redir:
        return redir

    raid = db.get(Raid, raid_id)
    if not raid:
        return RedirectResponse("/raids", status_code=302)

    user_id = int(request.session["user_id"])
    user_chars = db.query(Character).filter_by(discord_user_id=user_id).all()

    my_signup = db.query(Signup).filter_by(raid_id=raid_id, discord_user_id=user_id).first()

    all_signups = (
        db.query(Signup)
        .filter_by(raid_id=raid_id)
        .join(Character, Signup.character_id == Character.id)
        .all()
    )

    grouped: dict[str, list] = {"fill": [], "prio_role": [], "prio_character": []}
    for s in all_signups:
        key = s.signup_type.value if s.signup_type else "fill"
        grouped.setdefault(key, []).append(s)

    return templates.TemplateResponse(
        "raid_detail.html",
        {
            "request": request,
            "raid": raid,
            "user_chars": user_chars,
            "my_signup": my_signup,
            "grouped_signups": grouped,
            "signup_types": [e.value for e in SignupType],
            "flash": _pop_flash(request),
            "user": {"id": str(user_id), "username": request.session.get("username")},
        },
    )


# ── POST /raids/{raid_id}/signup ───────────────────────────────────────────
@router.post("/{raid_id}/signup")
async def signup_raid(
    request: Request,
    raid_id: int,
    character_id: int = Form(...),
    signup_type: str = Form("fill"),
    db: Session = Depends(get_session),
):
    redir = _require_login(request)
    if redir:
        return redir

    raid = db.get(Raid, raid_id)
    if not raid or raid.status != RaidStatus.open:
        request.session["flash"] = "❌ Raid is not open for sign-ups."
        return RedirectResponse(_raid_url(raid_id), status_code=302)

    user_id = int(request.session["user_id"])
    existing = db.query(Signup).filter_by(raid_id=raid_id, discord_user_id=user_id).first()

    try:
        stype = SignupType(signup_type)
    except ValueError:
        stype = SignupType.fill

    if existing:
        existing.character_id = character_id
        existing.signup_type = stype
        existing.status = SignupStatus.signed
    else:
        signup = Signup(
            raid_id=raid_id,
            discord_user_id=user_id,
            character_id=character_id,
            signup_type=stype,
            status=SignupStatus.signed,
        )
        db.add(signup)

    db.commit()
    request.session["flash"] = "✅ Signed up!"
    return RedirectResponse(_raid_url(raid_id), status_code=302)


# ── POST /raids/{raid_id}/withdraw ─────────────────────────────────────────
@router.post("/{raid_id}/withdraw")
async def withdraw_raid(
    request: Request,
    raid_id: int,
    db: Session = Depends(get_session),
):
    redir = _require_login(request)
    if redir:
        return redir

    user_id = int(request.session["user_id"])
    existing = db.query(Signup).filter_by(raid_id=raid_id, discord_user_id=user_id).first()
    if existing:
        db.delete(existing)
        db.commit()
        request.session["flash"] = "✅ Withdrawn from raid."
    else:
        request.session["flash"] = "You were not signed up."

    return RedirectResponse(_raid_url(raid_id), status_code=302)


# ── GET /raids/{raid_id}/manage ────────────────────────────────────────────
@router.get("/{raid_id}/manage", response_class=HTMLResponse)
async def raid_manage(request: Request, raid_id: int, db: Session = Depends(get_session)):
    redir = _require_login(request)
    if redir:
        return redir

    raid = db.get(Raid, raid_id)
    if not raid:
        return RedirectResponse("/raids", status_code=302)

    all_signups = (
        db.query(Signup)
        .filter_by(raid_id=raid_id)
        .join(Character, Signup.character_id == Character.id)
        .all()
    )

    existing_comp = db.query(Composition).filter_by(raid_id=raid_id).all()
    comp_map = {c.role_slot: str(c.character_id) for c in existing_comp}

    max_size = raid.max_size or 25
    tanks = max(2, max_size // 10)
    healers = max(4, max_size // 5)
    dps_slots = max_size - tanks - healers

    slots = (
        [f"tank_{i + 1}" for i in range(tanks)]
        + [f"healer_{i + 1}" for i in range(healers)]
        + [f"dps_{i + 1}" for i in range(dps_slots)]
    )

    return templates.TemplateResponse(
        "raid_manage.html",
        {
            "request": request,
            "raid": raid,
            "signups": all_signups,
            "slots": slots,
            "comp_map": comp_map,
            "flash": _pop_flash(request),
            "user": {"id": request.session.get("user_id"), "username": request.session.get("username")},
        },
    )


# ── POST /raids/{raid_id}/manage ───────────────────────────────────────────
@router.post("/{raid_id}/manage")
async def save_manage(request: Request, raid_id: int, db: Session = Depends(get_session)):
    redir = _require_login(request)
    if redir:
        return redir

    user_id = int(request.session["user_id"])
    body = await request.json()
    # body: list of {"character_id": int, "role_slot": str}

    db.query(Composition).filter_by(raid_id=raid_id).delete()

    for entry in body:
        c = Composition(
            raid_id=raid_id,
            character_id=int(entry["character_id"]),
            role_slot=entry["role_slot"],
            created_by=user_id,
            created_at=datetime.datetime.now(datetime.timezone.utc),
        )
        db.add(c)

    db.commit()
    return {"ok": True}


# ── GET /raids/{raid_id}/comp ──────────────────────────────────────────────
@router.get("/{raid_id}/comp", response_class=HTMLResponse)
async def raid_comp(request: Request, raid_id: int, db: Session = Depends(get_session)):
    redir = _require_login(request)
    if redir:
        return redir

    raid = db.get(Raid, raid_id)
    if not raid:
        return RedirectResponse("/raids", status_code=302)

    comps = (
        db.query(Composition)
        .filter_by(raid_id=raid_id)
        .join(Character, Composition.character_id == Character.id)
        .order_by(Composition.role_slot)
        .all()
    )

    groups: dict[str, list] = {"tank": [], "healer": [], "dps": []}
    for c in comps:
        prefix = c.role_slot.split("_")[0]
        groups.setdefault(prefix, []).append(c)

    return templates.TemplateResponse(
        "raid_comp.html",
        {
            "request": request,
            "raid": raid,
            "groups": groups,
            "flash": _pop_flash(request),
            "user": {"id": request.session.get("user_id"), "username": request.session.get("username")},
        },
    )


# ── POST /raids/{raid_id}/lock ─────────────────────────────────────────────
@router.post("/{raid_id}/lock")
async def lock_raid(request: Request, raid_id: int, db: Session = Depends(get_session)):
    redir = _require_login(request)
    if redir:
        return redir

    raid = db.get(Raid, raid_id)
    if raid:
        raid.status = RaidStatus.locked
        db.commit()
        request.session["flash"] = f"🔒 Raid '{raid.name}' locked."

    return RedirectResponse(_raid_url(raid_id, "/manage"), status_code=302)


# ── POST /raids/{raid_id}/post_comp ───────────────────────────────────────
@router.post("/{raid_id}/post_comp")
async def post_comp(request: Request, raid_id: int, db: Session = Depends(get_session)):
    redir = _require_login(request)
    if redir:
        return redir

    raid = db.get(Raid, raid_id)
    if raid:
        raid.status = RaidStatus.posted
        db.commit()
        request.session["flash"] = f"📋 Raid '{raid.name}' marked as posted."

    return RedirectResponse(_raid_url(raid_id, "/comp"), status_code=302)
