import logging
import os
import json
from pydantic_settings import BaseSettings
from pydantic import field_validator
from typing import Any, List

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    telegram_bot_token: str = ""
    database_url: str = "sqlite:///./giorgio.db"  # Default SQLite
    whitelist_telegram_ids: Any = []
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

    @field_validator("whitelist_telegram_ids", mode="before")
    @classmethod
    def parse_whitelist_ids(cls, value):
        if isinstance(value, list):
            parsed = []
            for item in value:
                item_str = str(item).strip()
                if item_str.lstrip("-").isdigit():
                    parsed.append(int(item_str))
            return parsed

        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return []

            if raw.startswith("${") and raw.endswith("}"):
                logger.warning("WHITELIST_TELEGRAM_IDS unresolved placeholder detected: %s", raw)
                return []

            if raw.startswith("["):
                try:
                    parsed_json = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Invalid JSON for WHITELIST_TELEGRAM_IDS: %s", raw)
                    return []

                if isinstance(parsed_json, list):
                    parsed = []
                    for item in parsed_json:
                        item_str = str(item).strip()
                        if item_str.lstrip("-").isdigit():
                            parsed.append(int(item_str))
                    return parsed

                logger.warning("WHITELIST_TELEGRAM_IDS JSON is not a list: %s", raw)
                return []

            parsed = []
            for item in raw.split(","):
                item_str = item.strip()
                if not item_str:
                    continue
                if item_str.lstrip("-").isdigit():
                    parsed.append(int(item_str))
                else:
                    logger.warning("Skipping invalid whitelist telegram id: %s", item_str)
            return parsed

        return []

    @property
    def webhook_url(self) -> str:
        return f"https://api.telegram.org/bot{self.telegram_bot_token}"


settings = Settings()

# --- Startup validation ---
DEBUG = settings.debug
ALLOWED_ORIGINS = settings.allowed_origins
LOCAL_DEV_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"

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
