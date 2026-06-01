import logging
import os
import json
import sys
from pathlib import Path
from pydantic_settings import BaseSettings
from pydantic import field_validator
from typing import Any, List

if not logging.getLogger().handlers:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(levelname)s:%(name)s:%(message)s",
    )

logger = logging.getLogger(__name__)
_BASE_DIR = Path(__file__).resolve().parent


def _is_unresolved_placeholder(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    raw = value.strip()
    return raw.startswith("${") and raw.endswith("}")


def _emit_startup_fatal(message: str) -> None:
    logger.critical(message)
    print(message, file=sys.stderr, flush=True)


class Settings(BaseSettings):
    telegram_bot_token: str = ""
    telegram_error_channel_id: str = ""  # Channel ID for error notifications (with -100 prefix)
    database_url: str = "sqlite:///./giorgio.db"  # Default SQLite
    whitelist_telegram_ids: Any = []
    ocr_confidence_threshold: float = 0.6
    secret_key: str = ""
    practice_access_token_ttl_seconds: int = 86400
    telegram_init_data_max_age_seconds: int = 3600  # 1h: limit initData replay window
    yap_worker_secret: str = ""

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
        env_file = str(_BASE_DIR / ".env")
        env_file_encoding = "utf-8"
        extra = "ignore"

    @field_validator(
        "telegram_bot_token",
        "telegram_error_channel_id",
        "database_url",
        "secret_key",
        "cloudinary_cloud_name",
        "cloudinary_api_key",
        "cloudinary_api_secret",
        "plate_recognizer_token",
        "yap_worker_secret",
        mode="before",
    )
    @classmethod
    def reject_unresolved_placeholders(cls, value, info):
        if _is_unresolved_placeholder(value):
            logger.warning("%s unresolved placeholder detected: %s", info.field_name.upper(), value)
            return ""
        return value

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

            if _is_unresolved_placeholder(raw):
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

# Error channel configuration
ERROR_CHANNEL_ID = settings.telegram_error_channel_id

# --- Startup validation ---
DEBUG = settings.debug
ALLOWED_ORIGINS = settings.allowed_origins
LOCAL_DEV_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
RUNNING_IN_PRODUCTION = any(
    os.getenv(name)
    for name in (
        "RAILWAY_ENVIRONMENT",
        "RAILWAY_SERVICE_NAME",
        "RAILWAY_PROJECT_ID",
        "RENDER",
        "FLY_APP_NAME",
    )
) or os.getenv("APP_ENV", "").lower() == "production"

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

if DEBUG and RUNNING_IN_PRODUCTION:
    message = "DEBUG=True is not allowed in production environments"
    _emit_startup_fatal(message)
    raise RuntimeError(message)

if DEBUG:
    logger.info("Running in DEBUG mode.")
else:
    # Fail fast in production: missing critical secrets must stop startup rather
    # than surface as request-time 500s or insecure fallbacks.
    _fatal = []
    if not settings.secret_key:
        _fatal.append("SECRET_KEY")
    if not settings.telegram_bot_token:
        _fatal.append("TELEGRAM_BOT_TOKEN")
    if RUNNING_IN_PRODUCTION and (
        not settings.database_url or settings.database_url.startswith("sqlite")
    ):
        _fatal.append("DATABASE_URL (must be non-SQLite in production)")
    if RUNNING_IN_PRODUCTION and not settings.whitelist_telegram_ids:
        _fatal.append("WHITELIST_TELEGRAM_IDS")
    if _fatal:
        message = (
            "Missing required configuration in production (DEBUG=False): "
            + ", ".join(_fatal)
        )
        _emit_startup_fatal(message)
        raise RuntimeError(message)
