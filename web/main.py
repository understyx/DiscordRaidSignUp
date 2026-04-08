import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

load_dotenv()

from web.routers import auth, characters, raids  # noqa: E402

WEB_SECRET_KEY = os.environ.get("WEB_SECRET_KEY", "change_this_to_a_random_string")

app = FastAPI(title="WoW Raid Sign-Up")

app.add_middleware(SessionMiddleware, secret_key=WEB_SECRET_KEY)

app.include_router(auth.router)
app.include_router(raids.router)
app.include_router(characters.router)

TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@app.get("/")
async def root(request: Request):
    if request.session.get("user_id"):
        return RedirectResponse("/raids", status_code=302)
    return RedirectResponse("/auth/login", status_code=302)
