import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from bot.warmane import (
    getHTML,
    check_for_error,
    extract_class_race_level_from_profile,
    extract_specializations_from_profile,
    clean_data,
)
from db.models import Character, CharacterRole
from web.db import get_session

router = APIRouter(tags=["characters"])
TEMPLATES_DIR = Path(__file__).parent.parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

_WOW_TWO_WORD_CLASSES = {"Death Knight"}


def _require_login(request: Request):
    if not request.session.get("user_id"):
        return RedirectResponse("/auth/login", status_code=302)
    return None


def _pop_flash(request: Request) -> Optional[str]:
    return request.session.pop("flash", None)


def _fetch_armory(char_name: str, realm: str) -> dict:
    """Attempt to fetch class/spec from Warmane. Returns empty dict on failure."""
    try:
        html = getHTML(char_name, realm, "summary")
        if html is None or check_for_error(html):
            return {}

        class_race_level = extract_class_race_level_from_profile(html)
        parts = [p.strip() for p in class_race_level.split() if p.strip()]
        char_class = parts[-1] if parts else None
        if len(parts) >= 2 and f"{parts[-2]} {parts[-1]}" in _WOW_TWO_WORD_CLASSES:
            char_class = f"{parts[-2]} {parts[-1]}"

        raw_specs = extract_specializations_from_profile(html)
        spec = clean_data(raw_specs)

        return {"char_class": char_class, "spec": spec, "gearscore": 0.0}
    except Exception:
        return {}


# ── GET /profile ───────────────────────────────────────────────────────────
@router.get("/profile", response_class=HTMLResponse)
async def profile(request: Request, db: Session = Depends(get_session)):
    redir = _require_login(request)
    if redir:
        return redir

    user_id = int(request.session["user_id"])
    chars = db.query(Character).filter_by(discord_user_id=user_id).all()

    return templates.TemplateResponse(
        "profile.html",
        {
            "request": request,
            "chars": chars,
            "roles": [r.value for r in CharacterRole],
            "flash": _pop_flash(request),
            "user": {"id": str(user_id), "username": request.session.get("username")},
        },
    )


# ── GET /characters ────────────────────────────────────────────────────────
@router.get("/characters", response_class=HTMLResponse)
async def characters_redirect(request: Request):
    return RedirectResponse("/profile", status_code=302)


# ── POST /characters/register ──────────────────────────────────────────────
@router.post("/characters/register")
async def register_character(
    request: Request,
    char_name: str = Form(...),
    realm: str = Form("Icecrown"),
    db: Session = Depends(get_session),
):
    redir = _require_login(request)
    if redir:
        return redir

    user_id = int(request.session["user_id"])
    armory = _fetch_armory(char_name.strip(), realm.strip())

    char = (
        db.query(Character)
        .filter_by(
            discord_user_id=user_id,
            char_name=char_name.capitalize(),
            realm=realm.capitalize(),
        )
        .first()
    )

    if char is None:
        char = Character(
            discord_user_id=user_id,
            char_name=char_name.capitalize(),
            realm=realm.capitalize(),
        )
        db.add(char)

    if armory:
        char.char_class = armory.get("char_class")
        char.spec = armory.get("spec")
        char.gearscore = armory.get("gearscore", 0.0)
    char.last_updated = datetime.datetime.now(datetime.timezone.utc)
    db.commit()

    request.session["flash"] = f"✅ Character {char_name.capitalize()} registered!"
    return RedirectResponse("/profile", status_code=302)


# ── POST /characters/{char_id}/delete ─────────────────────────────────────
@router.post("/characters/{char_id}/delete")
async def delete_character(
    request: Request,
    char_id: int,
    db: Session = Depends(get_session),
):
    redir = _require_login(request)
    if redir:
        return redir

    user_id = int(request.session["user_id"])
    char = db.query(Character).filter_by(id=char_id, discord_user_id=user_id).first()
    if char:
        db.delete(char)
        db.commit()
        request.session["flash"] = f"✅ Character '{char.char_name}' deleted."
    else:
        request.session["flash"] = "❌ Character not found."

    return RedirectResponse("/profile", status_code=302)


# ── POST /characters/{char_id}/role ───────────────────────────────────────
@router.post("/characters/{char_id}/role")
async def update_role(
    request: Request,
    char_id: int,
    role: str = Form(...),
    db: Session = Depends(get_session),
):
    redir = _require_login(request)
    if redir:
        return redir

    user_id = int(request.session["user_id"])
    char = db.query(Character).filter_by(id=char_id, discord_user_id=user_id).first()
    if char:
        try:
            char.role = CharacterRole(role)
            db.commit()
            request.session["flash"] = f"✅ Role updated for {char.char_name}."
        except ValueError:
            request.session["flash"] = "❌ Invalid role."
    else:
        request.session["flash"] = "❌ Character not found."

    return RedirectResponse("/profile", status_code=302)
