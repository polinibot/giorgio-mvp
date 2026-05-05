import logging
import os
from pydantic_settings import BaseSettings
from typing import List

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    telegram_bot_token: str = ""
    database_url: str = "sqlite:///./giorgio.db"  # Default SQLite
    whitelist_telegram_ids: List[int] = []
    ocr_confidence_threshold: float = 0.6
    secret_key: str = ""

    # Cloudinary settings
    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""
    plate_recognizer_token: str = ""

    # Debug flag
    debug: bool = False

    # ALLOWED_ORIGINS for CORS
    allowed_origins: List[str] = [
        "https://web.telegram.org",
        "https://telegram.org",
        "https://giorgio-mvp-nine.vercel.app",
    ]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

    @property
    def webhook_url(self) -> str:
        return f"https://api.telegram.org/bot{self.telegram_bot_token}"


settings = Settings()

# --- Startup validation ---
DEBUG = settings.debug
ALLOWED_ORIGINS = settings.allowed_origins

_missing = []
if not settings.telegram_bot_token:
    _missing.append("TELEGRAM_BOT_TOKEN")
if not settings.database_url:
    _missing.append("DATABASE_URL")

if _missing:
    logger.warning(
        "Missing or empty critical env vars: %s. "
        "The application may not function correctly.",
        ", ".join(_missing),
    )
else:
    logger.info("All critical configuration validated successfully.")

if DEBUG:
    logger.info("Running in DEBUG mode.")
