from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from bot.config import DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT, DB_USER

DATABASE_URL = f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)


def get_session():
    return SessionLocal()
