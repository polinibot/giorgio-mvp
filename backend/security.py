import base64
import hashlib
import hmac
import json
import logging
import time
from typing import Dict, Optional
from urllib.parse import parse_qsl

from config import settings

logger = logging.getLogger(__name__)


class SecurityService:
    """Servizio per sicurezza Mini App, whitelist e token pratica."""

    @staticmethod
    def _practice_access_secret() -> bytes:
        if settings.secret_key:
            return settings.secret_key.encode("utf-8")
        if settings.debug:
            fallback = settings.telegram_bot_token or "dev-practice-access-secret"
            return fallback.encode("utf-8")
        raise ValueError("SECRET_KEY is required to issue or validate practice access tokens in production")

    @staticmethod
    def _parse_init_data_pairs(init_data: str) -> list[tuple[str, str]]:
        return parse_qsl(init_data, keep_blank_values=True)

    @staticmethod
    def _current_timestamp() -> int:
        return int(time.time())

    @staticmethod
    def _is_init_data_fresh(pairs: list[tuple[str, str]]) -> bool:
        auth_date_value = next((v for k, v in pairs if k == "auth_date"), None)
        if not auth_date_value:
            logger.warning("validate_telegram_init_data: auth_date missing from initData")
            return False
        try:
            auth_date = int(auth_date_value)
        except (TypeError, ValueError):
            logger.warning("validate_telegram_init_data: auth_date is invalid: %s", auth_date_value)
            return False

        age_seconds = SecurityService._current_timestamp() - auth_date
        if age_seconds < 0:
            logger.warning("validate_telegram_init_data: auth_date is in the future")
            return False
        if age_seconds > settings.telegram_init_data_max_age_seconds:
            logger.warning(
                "validate_telegram_init_data: initData expired (age=%ds, max=%ds)",
                age_seconds,
                settings.telegram_init_data_max_age_seconds,
            )
            return False
        return True

    @staticmethod
    def _urlsafe_b64encode(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    @staticmethod
    def _urlsafe_b64decode(raw: str) -> bytes:
        padding = "=" * (-len(raw) % 4)
        return base64.urlsafe_b64decode(raw + padding)

    @staticmethod
    def _generate_legacy_practice_access_token(practice_id: int, telegram_user_id: int) -> str:
        payload = f"{practice_id}:{telegram_user_id}".encode("utf-8")
        return hmac.new(
            SecurityService._practice_access_secret(),
            payload,
            hashlib.sha256,
        ).hexdigest()

    @staticmethod
    def is_user_whitelisted(telegram_user_id: int) -> bool:
        return telegram_user_id in settings.whitelist_telegram_ids

    @staticmethod
    def validate_telegram_init_data(init_data: str) -> bool:
        try:
            if not init_data:
                logger.warning("validate_telegram_init_data: initData is empty")
                return False

            pairs = SecurityService._parse_init_data_pairs(init_data)
            hash_value = next((v for k, v in pairs if k == "hash"), None)
            if not hash_value:
                logger.warning("validate_telegram_init_data: no hash in initData")
                return False

            if not SecurityService._is_init_data_fresh(pairs):
                return False

            auth_data = [(k, v) for k, v in pairs if k != "hash"]
            sorted_data = sorted(auth_data, key=lambda item: item[0])
            data_check_string = "\n".join(f"{k}={v}" for k, v in sorted_data)

            webapp_secret = hmac.new(
                b"WebAppData",
                settings.telegram_bot_token.encode("utf-8"),
                hashlib.sha256,
            ).digest()

            calculated_hash = hmac.new(
                webapp_secret,
                data_check_string.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()

            return hmac.compare_digest(calculated_hash, hash_value)
        except Exception as exc:
            logger.warning("Errore validazione initData: %s", exc)
            return False

    @staticmethod
    def extract_user_from_init_data(init_data: str) -> Optional[Dict]:
        try:
            pairs = SecurityService._parse_init_data_pairs(init_data)
            user_data = next((v for k, v in pairs if k == "user"), None)
            if user_data:
                return json.loads(user_data)
            return None
        except Exception:
            return None

    @staticmethod
    def generate_practice_access_token(
        practice_id: int,
        telegram_user_id: int,
        expires_in_seconds: Optional[int] = None,
        issued_at: Optional[int] = None,
    ) -> str:
        ttl_seconds = expires_in_seconds or settings.practice_access_token_ttl_seconds
        now = issued_at if issued_at is not None else SecurityService._current_timestamp()
        payload = {
            "practice_id": int(practice_id),
            "telegram_user_id": int(telegram_user_id),
            "iat": int(now),
            "exp": int(now + ttl_seconds),
        }
        payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        payload_token = SecurityService._urlsafe_b64encode(payload_bytes)
        signature = hmac.new(
            SecurityService._practice_access_secret(),
            payload_token.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"{payload_token}.{signature}"

    @staticmethod
    def validate_practice_access_token(practice_id: int, telegram_user_id: int, token: Optional[str]) -> bool:
        if not token:
            return False
        try:
            if "." not in token:
                if settings.debug:
                    expected = SecurityService._generate_legacy_practice_access_token(practice_id, telegram_user_id)
                    return hmac.compare_digest(expected, token)
                return False

            payload_token, signature = token.split(".", 1)
            expected_signature = hmac.new(
                SecurityService._practice_access_secret(),
                payload_token.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(expected_signature, signature):
                return False

            payload = json.loads(SecurityService._urlsafe_b64decode(payload_token).decode("utf-8"))
            if int(payload.get("practice_id", -1)) != int(practice_id):
                return False
            if int(payload.get("telegram_user_id", -1)) != int(telegram_user_id):
                return False
            if int(payload.get("exp", 0)) < SecurityService._current_timestamp():
                return False
            return True
        except Exception:
            return False
