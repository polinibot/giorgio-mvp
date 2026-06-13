import logging
import os
import re
import signal
import uuid
import shutil
import shutil as _shutil
import json as _json
import asyncio
import base64
import hmac
import time
import traceback
import hashlib
import aiohttp
from contextlib import asynccontextmanager
from datetime import datetime, timezone, date
from enum import Enum
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Depends, HTTPException, Request, status, Header, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ValidationError as PydanticValidationError
from sqlalchemy.orm import Session
from sqlalchemy import or_, func, extract
from cryptography.fernet import Fernet, InvalidToken

try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded

    _SLOWAPI_AVAILABLE = True
except ModuleNotFoundError:  # pragma: no cover - fallback for dev/test environments without slowapi
    _SLOWAPI_AVAILABLE = False

    class RateLimitExceeded(Exception):
        pass

    def get_remote_address(request: Request):
        return request.client.host if request.client else "127.0.0.1"

    class Limiter:
        def __init__(self, *args, **kwargs):
            pass

        def limit(self, *args, **kwargs):
            def decorator(func):
                return func

            return decorator

    _rate_limit_exceeded_handler = None

from config import settings, DEBUG, ALLOWED_ORIGINS, LOCAL_DEV_ORIGIN_REGEX
from database_sqlite import (
    get_db, create_tables, Practice, PracticePhoto, PracticeSection, PracticePart, SystemSetting,
    SessionLocal,
)
from models import (
    PracticeStatus, PracticeType, CustomerType, Context,
    Practice as PracticeModel,
    PracticeCreate,
    PracticeUpdate,
    APIResponse,
    TelegramMiniAppData,
    ValidationError,
)
from security import SecurityService
from ocr_service import OCRService
from cloudinary_service import cloudinary_service
from telegram_utils import build_practice_summary
from yap_field_map import build_full_field_mapping

logger = logging.getLogger(__name__)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

if not _SLOWAPI_AVAILABLE:
    logger.warning(
        "slowapi is not installed: rate limiting is DISABLED (no-op limiter in use). "
        "Install slowapi for production rate limiting."
    )

# Create storage directory
os.makedirs("storage/photos", exist_ok=True)

# --- Rate Limiter ---
limiter = Limiter(key_func=get_remote_address)
YAP_RUN_LOCK: Optional[asyncio.Lock] = None
YAP_PRECHECK_CACHE_TTL_SECONDS = 30
YAP_CACHE_MAX_ENTRIES = 500
YAP_PRECHECK_CACHE: Dict[str, Dict[str, Any]] = {}
YAP_PREVIEW_CACHE: Dict[str, Dict[str, Any]] = {}


async def _yap_keepalive_loop():
    """Tiene viva la sessione YAP: ogni N minuti lancia yap-keepalive.mjs (via
    _run_yap_script, cosi' restaura/ripersiste la sessione cifrata nel DB) cosi' la
    sessione lato server non scade mai e i job non pagano il re-login.

    Config:
      YAP_KEEPALIVE_ENABLED  default "1"  (metti "0" per disattivare)
      YAP_KEEPALIVE_MINUTES  default "10" (intervallo; deve stare sotto il TTL sessione YAP)
    """
    # Default DISATTIVATO: i log hanno provato che la sessione YAP NON e' riattivabile
    # via sessionStorage (anche con session_storage_injected, YAP rifa' il login). Quindi
    # il keep-alive non evita il login -> e' inutile e consuma risorse. Riattivabile con
    # YAP_KEEPALIVE_ENABLED=1 se in futuro la sessione diventasse riusabile.
    if str(os.getenv("YAP_KEEPALIVE_ENABLED", "0")).strip() != "1":
        logger.info("YAP keep-alive disabilitato (default: sessione YAP non riusabile)")
        return
    try:
        interval_min = float(os.getenv("YAP_KEEPALIVE_MINUTES", "10"))
    except (TypeError, ValueError):
        interval_min = 10.0
    if interval_min <= 0:
        logger.info("YAP keep-alive disabilitato (intervallo <= 0)")
        return
    interval_s = interval_min * 60
    # Primo refresh dopo un breve ritardo per non rallentare lo startup.
    await asyncio.sleep(min(60, interval_s))
    while True:
        # NON deve MAI bloccare un'operazione utente: se il lock YAP e' gia' occupato
        # (sync/audit/delete in corso), salta del tutto questo ciclo e riprova dopo.
        if _get_yap_run_lock().locked():
            logger.info("YAP keep-alive: lock occupato, ciclo saltato")
            await asyncio.sleep(interval_s)
            continue
        state_db = SessionLocal()
        try:
            await _run_yap_script("yap-keepalive.mjs", [], timeout_seconds=120, db=state_db)
            logger.info("YAP keep-alive: sessione rinfrescata")
        except HTTPException as exc:
            # 429 = un job reale e' gia' in corso: la sessione e' comunque viva, skip.
            logger.info("YAP keep-alive saltato: %s", getattr(exc, "detail", exc))
        except asyncio.CancelledError:
            state_db.close()
            raise
        except Exception as exc:  # noqa: BLE001 - non deve mai abbattere il loop
            logger.warning("YAP keep-alive fallito: %s", exc)
        finally:
            try:
                state_db.close()
            except Exception:
                pass
        await asyncio.sleep(interval_s)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(_initialize_database)
    keepalive_task = asyncio.create_task(_yap_keepalive_loop())
    try:
        yield
    finally:
        keepalive_task.cancel()
        try:
            await keepalive_task
        except (asyncio.CancelledError, Exception):
            pass

app = FastAPI(
    title="Giorgio API",
    description="API per il sistema di inserimento pratiche meccanico",
    version="2.0.0",
    lifespan=lifespan,
)
app.state.limiter = limiter


def _initialize_database() -> None:
    if os.getenv("GIORGIO_SKIP_MIGRATIONS"):
        # Migrations were already run by the process supervisor; avoid concurrent DDL.
        logger.info("Skipping database initialization (GIORGIO_SKIP_MIGRATIONS set)")
        return
    try:
        create_tables()
        logger.info("Database initialization completed")
    except Exception as exc:
        # Fail fast: a broken schema/migration must not be masked behind a running
        # app that then serves 500s on every request.
        logger.exception("Database initialization failed: %s", exc)
        raise

# --- CORS ---
# Il regex localhost è abilitato in DEBUG o quando SMOKE_TEST_SECRET è configurato
# (i test Playwright prod-smoke girano su 127.0.0.1:34000 e puntano alla prod API).
# 127.0.0.1 non è raggiungibile dall'esterno, quindi questo non apre rischi CORS reali.
_allow_localhost_cors = DEBUG or bool(settings.smoke_test_secret)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=LOCAL_DEV_ORIGIN_REGEX if _allow_localhost_cors else None,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Telegram-Init-Data", "X-Telegram-User-Id", "X-Yap-Worker-Secret", "X-Smoke-Secret"],
)


# --- Exception Handlers ---

@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    logger.warning("Rate limit exceeded for %s on %s", get_remote_address(request), request.url.path)
    return JSONResponse(
        status_code=429,
        content={"detail": "Rate limit exceeded. Please try again later.", "code": "RATE_LIMIT_EXCEEDED"},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Custom handler for HTTPException with consistent error format."""
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": "HTTP_ERROR"},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Catch-all handler: log full details server-side, return generic message."""
    logger.error(
        "Unhandled exception on %s %s: %s",
        request.method, request.url.path, exc,
        exc_info=True,
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "code": "INTERNAL_ERROR"},
    )


# --- Serialization Utility ---

def serialize(obj) -> dict:
    """Unified serializer for any SQLAlchemy ORM instance.

    Converts enums to their value, datetimes to ISO strings, and handles
    special fields like description_rows (JSON text) and contexts (CSV).
    Known ORM models use explicit allow-lists so new internal/sensitive columns
    are not accidentally reflected into API responses.
    """
    allowed_fields = {
        Practice: (
            "id",
            "created_at",
            "updated_at",
            "status",
            "plate_detected",
            "plate_confirmed",
            "phone",
            "customer_name",
            "customer_type",
            "billing_to_complete",
            "appointment_date",
            "appointment_time",
            "practice_type",
            "contexts",
            "internal_notes",
            "management_external_id",
            "management_sync_status",
            "management_last_sync_at",
            "management_audit_result",
            "synced",
        ),
        PracticePhoto: (
            "id",
            "practice_id",
            "storage_path",
            "cloudinary_public_id",
            "ocr_result",
            "ocr_confidence",
            "created_at",
        ),
        PracticeSection: (
            "id",
            "practice_id",
            "context",
            "description_rows",
            "man_hours",
            "mac_hours",
            "materials_amount",
            "waste_apply",
            "waste_percentage",
            "notes",
        ),
        PracticePart: (
            "id",
            "practice_id",
            "context",
            "name",
            "quantity",
        ),
    }.get(type(obj))

    result = {}
    field_names = allowed_fields or [k for k in obj.__dict__ if not k.startswith("_")]
    for k in field_names:
        if not hasattr(obj, k):
            continue
        v = getattr(obj, k)
        if isinstance(v, Enum):
            result[k] = v.value
        elif isinstance(v, datetime):
            result[k] = v.isoformat()
        elif k == "description_rows" and isinstance(v, str):
            try:
                result[k] = _json.loads(v)
            except Exception:
                result[k] = [v]
        elif k == "contexts" and isinstance(v, str):
            result[k] = [c.strip() for c in v.split(",") if c.strip()]
        elif k == "management_audit_result" and isinstance(v, str):
            try:
                result[k] = _json.loads(v)
            except Exception:
                result[k] = v
        elif isinstance(v, bool):
            result[k] = v
        else:
            result[k] = v
    return result


# --- Authentication ---

def _mask_init_data(init_data: Optional[str]) -> Dict[str, Any]:
    raw = init_data or ""
    return {
        "present": bool(raw),
        "length": len(raw),
        "has_hash": "hash=" in raw,
    }


def _auth_debug_snapshot(
    request: Optional[Request],
    init_data: Optional[str],
    x_telegram_init_data: Optional[str],
    user_id: Optional[int],
    x_telegram_user_id: Optional[str],
) -> Dict[str, Any]:
    return {
        "path": str(request.url.path) if request else None,
        "query": str(request.url.query) if request else None,
        "client": request.client.host if request and request.client else None,
        "query_user_id": user_id,
        "header_user_id": x_telegram_user_id,
        "header_init_data": _mask_init_data(x_telegram_init_data),
        "query_init_data": _mask_init_data(init_data),
    }


def _log_auth_debug(stage: str, payload: Dict[str, Any], level: str = "warning") -> None:
    message = "Auth debug [%s]: %s"
    if level == "info":
        logger.info(message, stage, payload)
    elif level == "debug":
        logger.debug(message, stage, payload)
    else:
        logger.warning(message, stage, payload)


def _can_access_practice(practice: Practice, user_data: dict, access_token: Optional[str]) -> bool:
    if practice.created_by_telegram_id == user_data["id"]:
        return True
    return SecurityService.validate_practice_access_token(practice.id, user_data["id"], access_token)


def _supports_row_locks(db: Session) -> bool:
    try:
        return db.get_bind().dialect.name not in {"sqlite"}
    except Exception:
        return False


def _practice_by_id(db: Session, practice_id: int, *, for_update: bool = False) -> Optional[Practice]:
    query = db.query(Practice).filter(Practice.id == practice_id)
    if for_update and _supports_row_locks(db):
        query = query.with_for_update()
    return query.first()


def _owned_active_practice(
    db: Session,
    practice_id: int,
    user_id: int,
    *,
    for_update: bool = False,
) -> Optional[Practice]:
    query = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_id,
        Practice.status != PracticeStatus.DELETED,
    )
    if for_update and _supports_row_locks(db):
        query = query.with_for_update()
    return query.first()


def _get_yap_run_lock() -> asyncio.Lock:
    global YAP_RUN_LOCK
    if YAP_RUN_LOCK is None:
        YAP_RUN_LOCK = asyncio.Lock()
    return YAP_RUN_LOCK


class _WithAcquiredLock:
    """Context manager che rilascia un asyncio.Lock giÃ  acquisito esternamente."""
    def __init__(self, lock: asyncio.Lock):
        self._lock = lock

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        self._lock.release()


def _repair_practice_owner_if_needed(db: Session, practice: Practice, user_data: dict, access_token: Optional[str]) -> None:
    if practice.created_by_telegram_id == user_data["id"]:
        return
    if SecurityService.validate_practice_access_token(practice.id, user_data["id"], access_token):
        previous_owner = practice.created_by_telegram_id
        practice.created_by_telegram_id = user_data["id"]
        practice.updated_by_telegram_id = user_data["id"]
        db.commit()
        db.refresh(practice)
        logger.warning(
            "Practice owner repaired via access token for practice %d: %s -> %s",
            practice.id,
            previous_owner,
            user_data["id"],
        )


def validate_telegram_init_data(
    request: Request,
    init_data: str = None,
    x_telegram_init_data: str = Header(None, alias="X-Telegram-Init-Data"),
    user_id: Optional[int] = None,
    x_telegram_user_id: Optional[str] = Header(None, alias="X-Telegram-User-Id"),
    x_smoke_secret: Optional[str] = Header(None, alias="X-Smoke-Secret"),
):
    """Extract Telegram user from initData.

    In production (DEBUG=False), if HMAC validation fails, return 401.
    In debug mode, fall back to a test user.
    """
    # Smoke-test bypass: attivo solo se SMOKE_TEST_SECRET è impostato nel backend
    # e la richiesta porta l'header X-Smoke-Secret con il valore corretto.
    # Usato dai test Playwright/e2e su produzione senza sessione Telegram reale.
    if not isinstance(x_telegram_init_data, str):
        x_telegram_init_data = request.headers.get("X-Telegram-Init-Data")
    if not isinstance(x_telegram_user_id, str):
        x_telegram_user_id = request.headers.get("X-Telegram-User-Id")
    if not isinstance(x_smoke_secret, str):
        x_smoke_secret = request.headers.get("X-Smoke-Secret")

    _smoke_secret = settings.smoke_test_secret
    if _smoke_secret and x_smoke_secret and hmac.compare_digest(x_smoke_secret, _smoke_secret):
        uid = settings.smoke_test_user_id or 761118078
        logger.info("Smoke-test bypass auth for user %s", uid)
        return {"id": uid, "first_name": "Smoke", "last_name": "Test", "username": "smoketest"}

    raw_init_data = x_telegram_init_data or init_data
    auth_snapshot = _auth_debug_snapshot(request, init_data, x_telegram_init_data, user_id, x_telegram_user_id)
    _log_auth_debug("start", auth_snapshot, level="info")

    try:
        if raw_init_data:
            is_valid = SecurityService.validate_telegram_init_data(raw_init_data)
            if not is_valid and not DEBUG:
                _log_auth_debug("invalid_init_data", auth_snapshot)
                logger.warning("Auth failed: invalid Telegram initData signature")
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid Telegram initData",
                )

            user = SecurityService.extract_user_from_init_data(raw_init_data)
            if not user and DEBUG:
                logger.debug("DEBUG mode: falling back to dev user because initData could not be parsed")
                return {"id": 123456789, "first_name": "User", "last_name": "Test", "username": "dev_test"}

            if user and user.get("id") is not None:
                try:
                    user_id = int(user["id"])
                except (TypeError, ValueError):
                    user_id = None
                if user_id is not None:
                    _log_auth_debug("init_data_user_ok", {**auth_snapshot, "resolved_user_id": user_id}, level="info")
                    logger.debug("Authenticated Telegram user %d", user_id)
                    return {
                        "id": user_id,
                        "first_name": user.get("first_name", "") or "",
                        "last_name": user.get("last_name", "") or "",
                        "username": user.get("username", "") or "",
                    }
            if DEBUG:
                logger.debug("DEBUG mode: initData present but user extraction failed, using dev fallback user")
                return {"id": 123456789, "first_name": "User", "last_name": "Test", "username": "dev_test"}
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Failed to extract user from initData: %s", e)

    if not DEBUG:
        _log_auth_debug("auth_missing", auth_snapshot)
        logger.warning("Auth failed: no valid initData and DEBUG=False")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    fallback_uid = None
    if x_telegram_user_id and str(x_telegram_user_id).strip().lstrip("-").isdigit():
        fallback_uid = int(str(x_telegram_user_id).strip())
    elif user_id is not None:
        fallback_uid = int(user_id)

    if fallback_uid is not None:
        _log_auth_debug("debug_fallback_user_id_ok", {**auth_snapshot, "resolved_user_id": fallback_uid}, level="info")
        logger.warning("DEBUG auth fallback used without initData for Telegram user %s", fallback_uid)
        return {
            "id": fallback_uid,
            "first_name": "",
            "last_name": "",
            "username": "",
        }

    logger.debug("Using dev fallback user (DEBUG mode)")
    return {"id": 123456789, "first_name": "User", "last_name": "Test", "username": "dev_test"}


def _enforce_whitelist(user_data: dict) -> dict:
    """Enforce Telegram whitelist.

    If whitelist is empty (dev/test), allow all users through with a warning.
    """
    if DEBUG:
        return user_data

    whitelist = getattr(settings, "whitelist_telegram_ids", None) or []
    if not whitelist:
        # Fail closed in production: an empty/misconfigured whitelist must not
        # silently authorize every authenticated Telegram user.
        logger.error("Telegram whitelist is empty while DEBUG=False - denying access (fail closed)")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Servizio non configurato: whitelist utenti mancante",
        )
    uid = user_data.get("id")
    if uid not in whitelist:
        logger.warning("User %s not in whitelist, access denied", uid)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Utente non autorizzato",
        )
    return user_data


def require_whitelisted_user(
    user_data: dict = Depends(validate_telegram_init_data),
) -> dict:
    return _enforce_whitelist(user_data)


def _try_resolve_whitelisted_user(
    request: Request,
    init_data: Optional[str],
    x_telegram_init_data: Optional[str],
    user_id: Optional[int],
    x_telegram_user_id: Optional[str],
) -> Optional[dict]:
    try:
        user_data = validate_telegram_init_data(
            request=request,
            init_data=init_data,
            x_telegram_init_data=x_telegram_init_data,
            user_id=user_id,
            x_telegram_user_id=x_telegram_user_id,
        )
        return _enforce_whitelist(user_data)
    except HTTPException:
        return None


def require_yap_internal_auth(
    request: Request,
    init_data: Optional[str] = None,
    x_telegram_init_data: Optional[str] = Header(None, alias="X-Telegram-Init-Data"),
    user_id: Optional[int] = None,
    x_telegram_user_id: Optional[str] = Header(None, alias="X-Telegram-User-Id"),
    x_yap_worker_secret: Optional[str] = Header(None, alias="X-Yap-Worker-Secret"),
) -> dict:
    expected_secret = (settings.yap_worker_secret or settings.secret_key).strip()
    if not expected_secret:
        # No secret configured â€” internal endpoint cannot be safely authenticated.
        # Return 503 (not 401) to signal misconfiguration vs bad credentials,
        # and to block fallthrough to whitelisted-user auth on this destructive
        # non-scoped endpoint.
        logger.error("require_yap_internal_auth: no secret configured - rejecting request")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Endpoint interno non disponibile: secret non configurato",
        )

    if x_yap_worker_secret:
        if hmac.compare_digest(expected_secret, x_yap_worker_secret):
            return {"id": 0, "first_name": "YAP", "last_name": "Worker", "username": "yap_worker"}
        logger.warning("Rejected YAP internal request with invalid worker secret")

    user_data = _try_resolve_whitelisted_user(
        request=request,
        init_data=init_data,
        x_telegram_init_data=x_telegram_init_data,
        user_id=user_id,
        x_telegram_user_id=x_telegram_user_id,
    )
    if user_data:
        return user_data

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing or invalid worker secret",
    )


# --- Health Check ---

@app.get("/health")
async def health_check():
    """Health check endpoint - no auth required."""
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/")
async def root():
    """Root health check."""
    return {"status": "ok", "service": "giorgio-api"}


@app.get("/test-connection")
async def test_connection():
    """Test endpoint for Vercel connection check."""
    return {"status": "ok", "message": "Connection successful", "timestamp": datetime.now(timezone.utc).isoformat()}


class ClientDiagnosticsReport(BaseModel):
    source: str = "mini-app"
    severity: str = "error"
    message: str
    label: Optional[str] = None
    url: Optional[str] = None
    user_agent: Optional[str] = None
    telegram_user_id: Optional[str] = None
    api: Optional[Dict[str, Any]] = None
    context: Optional[Dict[str, Any]] = None
    snapshot: Optional[Dict[str, Any]] = None


_CLIENT_DIAGNOSTIC_SECRET_KEYS = (
    "authorization",
    "cookie",
    "initdata",
    "password",
    "secret",
    "tgwebappdata",
    "token",
)
_CLIENT_DIAGNOSTIC_SECRET_RE = re.compile(
    r"(?i)(access_token|authorization|hash|initData|secret|tgWebAppData|token)=([^&#\s]+)"
)


def _scrub_client_diagnostic_text(value: str) -> str:
    scrubbed = _CLIENT_DIAGNOSTIC_SECRET_RE.sub(r"\1=[redacted]", value)
    return scrubbed[:2000]


def _is_safe_client_diagnostic_metadata_key(key_norm: str) -> bool:
    is_auth_metadata = "initdata" in key_norm or "token" in key_norm
    return is_auth_metadata and (
        key_norm.endswith("present")
        or key_norm.endswith("length")
        or key_norm.endswith("hash")
    )


def _scrub_client_diagnostics(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "[truncated]"
    if isinstance(value, dict):
        scrubbed = {}
        for key, item in value.items():
            key_text = str(key)
            key_norm = key_text.lower().replace("_", "")
            if (
                not _is_safe_client_diagnostic_metadata_key(key_norm)
                and any(marker in key_norm for marker in _CLIENT_DIAGNOSTIC_SECRET_KEYS)
            ):
                scrubbed[key_text] = "[redacted]"
            else:
                scrubbed[key_text] = _scrub_client_diagnostics(item, depth + 1)
        return scrubbed
    if isinstance(value, list):
        return [_scrub_client_diagnostics(item, depth + 1) for item in value[:25]]
    if isinstance(value, str):
        return _scrub_client_diagnostic_text(value)
    return value


async def _notify_client_diagnostics(report: Dict[str, Any]) -> None:
    try:
        from error_notifier import get_error_notifier

        notifier = get_error_notifier()
        if not notifier.bot_token or not notifier.channel_id:
            return

        api = report.get("api") if isinstance(report.get("api"), dict) else {}
        await notifier.notify_error(
            error_message=f"Client diagnostics: {report.get('message') or 'errore mini-app'}",
            context={
                "source": report.get("source"),
                "label": report.get("label"),
                "severity": report.get("severity"),
                "telegram_user_id": report.get("telegram_user_id"),
                "api_status": api.get("status"),
                "api_url": api.get("url") or report.get("url"),
                "api_error": api.get("error"),
            },
        )
    except Exception:
        logger.warning("Unable to forward client diagnostics to Telegram error channel", exc_info=True)


@app.post("/client-diagnostics")
@limiter.limit("20/minute")
async def report_client_diagnostics(request: Request, body: ClientDiagnosticsReport):
    """Receive sanitized client-side diagnostics from the Telegram Mini App."""
    report = _scrub_client_diagnostics(body.model_dump())
    client_host = request.client.host if request.client else "unknown"
    logger.warning(
        "Client diagnostics report from %s: %s",
        client_host,
        _json.dumps(report, ensure_ascii=False)[:4000],
    )
    asyncio.create_task(_notify_client_diagnostics(report))
    return APIResponse(success=True, data={"received": True})


# --- Practice Dashboard Endpoints ---


class SyncToggleRequest(BaseModel):
    synced: bool


class YapSyncRequest(BaseModel):
    dry_run: bool = False
    debug: bool = False
    fresh_login: bool = False
    date: Optional[str] = None
    time: Optional[str] = None
    duration: Optional[int] = None


class YapDeleteAppointmentRequest(BaseModel):
    date: Optional[str] = None
    time: Optional[str] = None
    search: Optional[str] = None
    dry_run: bool = False
    debug: bool = False
    fresh_login: bool = False


class YapManualDeleteRequest(BaseModel):
    date: str
    time: Optional[str] = None
    search: str
    dry_run: bool = False
    debug: bool = False
    fresh_login: bool = False


class YapAuditRequest(BaseModel):
    date: Optional[str] = None
    time: Optional[str] = None
    duration: Optional[int] = None
    debug: bool = False
    fresh_login: bool = False
    persist: bool = True


class YapErrorNotificationRequest(BaseModel):
    error_message: str
    stack_trace: Optional[str] = None
    screenshot_path: Optional[str] = None
    practice_id: Optional[int] = None
    customer: Optional[dict] = None
    appointment: Optional[dict] = None
    worker: Optional[str] = None


class SectionPayload(BaseModel):
    context: Context
    description_rows: List[str]
    man_hours: Optional[float] = None
    mac_hours: Optional[float] = None
    materials_amount: Optional[float] = None
    waste_apply: Optional[bool] = None
    waste_percentage: Optional[float] = None
    notes: Optional[str] = None


class PartPayload(BaseModel):
    context: Context
    name: str
    quantity: Optional[str] = None


class PracticeFullSave(BaseModel):
    practice: PracticeCreate
    sections: List[SectionPayload]
    parts: List[PartPayload] = []


def _context_value(value: Any) -> str:
    return value.value if isinstance(value, Enum) else str(value)


def _contexts_csv(contexts: List[Context]) -> str:
    return ",".join(_context_value(context) for context in contexts)


def _normalize_slot_time(appointment_time: str) -> str:
    from appointment_time import normalize_appointment_time

    try:
        return normalize_appointment_time(appointment_time)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


def _clean_section_rows(rows: List[str], allow_empty: bool = False) -> List[str]:
    cleaned = [row.strip() for row in rows if isinstance(row, str) and row.strip()]
    if not cleaned and not allow_empty:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Almeno una riga descrittiva e obbligatoria per ogni contesto",
        )
    return cleaned


def _validate_full_payload(body: PracticeFullSave):
    selected_contexts = {_context_value(context) for context in body.practice.contexts}
    if not selected_contexts:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Almeno un contesto e obbligatorio")
    body.practice.appointment_time = _normalize_slot_time(body.practice.appointment_time)

    sections_by_context: Dict[str, SectionPayload] = {}
    for section in body.sections:
        ctx = _context_value(section.context)
        if ctx not in selected_contexts:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Sezione non coerente con i contesti: {ctx}")
        if ctx in sections_by_context:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Sezione duplicata: {ctx}")
        # La revisione non richiede righe descrittive (non vanno su YAP).
        _clean_section_rows(section.description_rows, allow_empty=(ctx == "revisione"))
        if section.man_hours is not None and section.man_hours < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="MAN deve essere >= 0")
        if section.mac_hours is not None and section.mac_hours < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="MAC deve essere >= 0")
        if section.waste_percentage is not None and not 0 <= section.waste_percentage <= 100:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Smaltimento deve essere tra 0 e 100")
        sections_by_context[ctx] = section

    # La revisione può non avere sezione/righe: la escludiamo dai contesti obbligatori.
    required_contexts = selected_contexts - {"revisione"}
    missing = required_contexts - set(sections_by_context)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Riga descrittiva mancante per: {', '.join(sorted(missing))}",
        )

    for part in body.parts:
        ctx = _context_value(part.context)
        if ctx not in selected_contexts:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Pezzo non coerente con i contesti: {ctx}")
        if not part.name.strip():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nome pezzo obbligatorio")


def _apply_practice_data(practice: Practice, data: PracticeCreate, user_id: int):
    practice.plate_confirmed = data.plate_confirmed
    practice.phone = data.phone
    practice.customer_name = data.customer_name
    practice.customer_type = data.customer_type
    practice.billing_to_complete = data.billing_to_complete
    for field in ("company_name", "vat_number", "fiscal_code", "billing_address", "billing_city", "billing_zip"):
        if hasattr(practice, field):
            setattr(practice, field, getattr(data, field, None))
    practice.appointment_date = data.appointment_date
    practice.appointment_time = _normalize_slot_time(data.appointment_time)
    practice.practice_type = data.practice_type
    practice.contexts = _contexts_csv(data.contexts)
    practice.internal_notes = data.internal_notes
    practice.status = PracticeStatus.CONFIRMED
    practice.updated_by_telegram_id = user_id


def _sanitize_section_for_context(section: SectionPayload) -> SectionPayload:
    """Campi ammessi per reparto (allineato a mini-app)."""
    ctx = _context_value(section.context)
    data = section.model_dump()
    if ctx == "officina":
        data["mac_hours"] = None
        data["materials_amount"] = None
        data["waste_apply"] = False
        data["waste_percentage"] = None
    elif ctx == "revisione":
        data["man_hours"] = None
        data["mac_hours"] = None
        data["materials_amount"] = None
        data["waste_apply"] = False
        data["waste_percentage"] = None
    elif ctx == "carrozzeria":
        data["man_hours"] = None
    return SectionPayload(**data)


def _replace_sections_and_parts(db: Session, practice_id: int, sections: List[SectionPayload], parts: List[PartPayload]):
    db.query(PracticeSection).filter(PracticeSection.practice_id == practice_id).delete()
    db.query(PracticePart).filter(PracticePart.practice_id == practice_id).delete()

    for section in sections:
        clean = _sanitize_section_for_context(section)
        clean_ctx = _context_value(clean.context)
        db.add(PracticeSection(
            practice_id=practice_id,
            context=clean.context,
            description_rows=_json.dumps(_clean_section_rows(clean.description_rows, allow_empty=(clean_ctx == "revisione"))),
            man_hours=clean.man_hours,
            mac_hours=clean.mac_hours,
            materials_amount=clean.materials_amount,
            waste_apply=clean.waste_apply,
            waste_percentage=clean.waste_percentage,
            notes=clean.notes,
        ))

    for part in parts:
        db.add(PracticePart(
            practice_id=practice_id,
            context=part.context,
            name=part.name.strip(),
            quantity=(part.quantity or "").strip() or None,
        ))


@app.get("/api/practices/stats")
@limiter.limit("60/minute")
async def get_practice_stats(
    request: Request,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Return statistics for the current user's practices."""
    telegram_id = user_data["id"]
    started_at = time.perf_counter()

    total_started = time.perf_counter()
    total = db.query(func.count(Practice.id)).filter(
        Practice.created_by_telegram_id == telegram_id,
        Practice.status != PracticeStatus.DELETED,
    ).scalar() or 0
    total_elapsed_ms = (time.perf_counter() - total_started) * 1000

    month_started = time.perf_counter()
    now = datetime.utcnow()
    first_of_month = datetime(now.year, now.month, 1)
    this_month = db.query(func.count(Practice.id)).filter(
        Practice.created_by_telegram_id == telegram_id,
        Practice.status != PracticeStatus.DELETED,
        Practice.created_at >= first_of_month,
    ).scalar() or 0
    month_elapsed_ms = (time.perf_counter() - month_started) * 1000

    sync_started = time.perf_counter()
    pending_sync = db.query(func.count(Practice.id)).filter(
        Practice.created_by_telegram_id == telegram_id,
        Practice.status != PracticeStatus.DELETED,
        Practice.synced == False,
    ).scalar() or 0
    sync_elapsed_ms = (time.perf_counter() - sync_started) * 1000

    logger.info("Stats retrieved for user %d: total=%d, this_month=%d, pending_sync=%d",
                telegram_id, total, this_month, pending_sync)
    logger.info(
        "Stats timing for user %d: total=%.1fms this_month=%.1fms pending_sync=%.1fms total=%.1fms",
        telegram_id,
        total_elapsed_ms,
        month_elapsed_ms,
        sync_elapsed_ms,
        (time.perf_counter() - started_at) * 1000,
    )

    return APIResponse(success=True, data={
        "total": total,
        "this_month": this_month,
        "pending_sync": pending_sync,
    })


@app.get("/api/practices")
@limiter.limit("60/minute")
async def list_practices(
    request: Request,
    search: Optional[str] = None,
    context: Optional[str] = None,
    synced: Optional[bool] = None,
    sort: Optional[str] = "newest",
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """List practices for the current user with filtering and sorting."""
    telegram_id = user_data["id"]
    started_at = time.perf_counter()

    query_started = time.perf_counter()
    query = db.query(Practice).filter(
        Practice.created_by_telegram_id == telegram_id,
        Practice.status != PracticeStatus.DELETED,
    )

    # Search filter (plate or customer_name)
    if search:
        search_term = f"%{search}%"
        query = query.filter(
            or_(
                Practice.plate_confirmed.ilike(search_term),
                Practice.customer_name.ilike(search_term),
            )
        )

    # Context filter
    if context:
        context_terms = [c.strip().lower() for c in context.split(",") if c.strip()]
        if context_terms:
            query = query.filter(or_(*[Practice.contexts.ilike(f"%{ctx}%") for ctx in context_terms]))

    # Synced filter
    if synced is not None:
        query = query.filter(Practice.synced == synced)

    # Sorting
    if sort in {"oldest", "date_asc"}:
        query = query.order_by(Practice.created_at.asc())
    elif sort == "alpha":
        query = query.order_by(Practice.customer_name.asc())
    else:  # newest/date_desc (default)
        query = query.order_by(Practice.created_at.desc())
    query_build_elapsed_ms = (time.perf_counter() - query_started) * 1000

    fetch_started = time.perf_counter()
    practices = query.with_entities(
        Practice.id,
        Practice.plate_confirmed,
        Practice.customer_name,
        Practice.phone,
        Practice.appointment_date,
        Practice.appointment_time,
        Practice.created_at,
        Practice.contexts,
        Practice.synced,
        Practice.management_sync_status,
        Practice.management_last_sync_at,
        Practice.internal_notes,
    ).all()
    fetch_elapsed_ms = (time.perf_counter() - fetch_started) * 1000

    serialize_started = time.perf_counter()
    results = []
    for p in practices:
        results.append({
            "id": p.id,
            "plate": p.plate_confirmed,
            "plate_confirmed": p.plate_confirmed,
            "customer_name": p.customer_name,
            "phone": p.phone or "",
            "appointment_date": p.appointment_date.isoformat() if p.appointment_date else None,
            "appointment_time": p.appointment_time or "",
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "contexts": [c.strip() for c in p.contexts.split(",") if c.strip()] if isinstance(p.contexts, str) else p.contexts,
            "synced": p.synced,
            "management_sync_status": p.management_sync_status,
            "management_last_sync_at": p.management_last_sync_at.isoformat() if p.management_last_sync_at else None,
            # Serve al client per identificare le pratiche test YAP batch (filtro su
            # internal_notes "TEST YAP BATCH"): senza, i bottoni "Sync tutte 6" / "Copia
            # log tutte" trovavano 0 pratiche perche' la lista non esponeva le note.
            "internal_notes": p.internal_notes or "",
        })
    serialize_elapsed_ms = (time.perf_counter() - serialize_started) * 1000

    logger.info("Listed %d practices for user %d", len(results), telegram_id)
    logger.info(
        "Dashboard timing for user %d: build=%.1fms fetch=%.1fms serialize=%.1fms total=%.1fms",
        telegram_id,
        query_build_elapsed_ms,
        fetch_elapsed_ms,
        serialize_elapsed_ms,
        (time.perf_counter() - started_at) * 1000,
    )
    return APIResponse(success=True, data=results)


@app.get("/api/practices/{practice_id}")
@limiter.limit("60/minute")
async def get_practice_detail(
    request: Request,
    practice_id: int,
    access_token: Optional[str] = None,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Get full practice details including photos, sections, parts, and synced status."""
    practice = _practice_by_id(db, practice_id)

    if not practice or not _can_access_practice(practice, user_data, access_token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    _repair_practice_owner_if_needed(db, practice, user_data, access_token)

    photos = db.query(PracticePhoto).filter(PracticePhoto.practice_id == practice_id).order_by(PracticePhoto.created_at.desc()).all()
    sections = db.query(PracticeSection).filter(PracticeSection.practice_id == practice_id).order_by(PracticeSection.id.asc()).all()
    parts = db.query(PracticePart).filter(PracticePart.practice_id == practice_id).order_by(PracticePart.id.asc()).all()

    logger.info("Practice %d detail retrieved by user %d", practice_id, user_data["id"])

    return APIResponse(
        success=True,
        data={
            "practice": serialize(practice),
            "photos": [_serialize_photo(ph) for ph in photos],
            "sections": [serialize(s) for s in sections],
            "parts": [serialize(p) for p in parts],
        },
    )


def _get_thumbnail_url(storage_path: str) -> str:
    """Generate a 400px thumbnail URL from a Cloudinary storage_path."""
    if storage_path and '/upload/' in storage_path:
        return storage_path.replace('/upload/', '/upload/c_scale,w_400/')
    return storage_path or ""


def _serialize_photo(photo) -> dict:
    """Serialize a PracticePhoto with url and thumbnail fields."""
    data = serialize(photo)
    data["url"] = data.get("storage_path", "")
    data["thumbnail"] = _get_thumbnail_url(data.get("storage_path", ""))
    return data


def _delete_cloudinary_asset_for_photo(photo: PracticePhoto) -> None:
    public_id = photo.cloudinary_public_id or cloudinary_service.extract_public_id_from_url(photo.storage_path)
    if not public_id:
        return
    deleted = cloudinary_service.delete_photo(public_id)
    if not deleted:
        logger.warning("Failed to delete Cloudinary photo for practice photo %s", photo.id)


def _project_root() -> str:
    # In container/runtime the backend code lives under /app.
    # Using dirname(__file__) keeps all derived paths writable and stable.
    root = os.path.abspath(os.path.dirname(__file__))
    # Fallback per sviluppo locale se 'automation' non Ã¨ nella stessa cartella ma Ã¨ nel parent
    if not os.path.exists(os.path.join(root, "automation")) and os.path.exists(os.path.join(os.path.dirname(root), "automation")):
        return os.path.dirname(root)
    return root


def _practice_date_iso(practice: Practice) -> str:
    value = practice.appointment_date
    if hasattr(value, "date"):
        return value.date().isoformat()
    return str(value or "")[:10]


def _safe_search_arg(value: Any) -> str:
    """Normalize a user-controlled YAP search value before passing it with the
    `--search=value` argv form, so leading dashes remain data instead of flags."""
    return str(value or "").strip()


def _safe_practice_yap_time_arg(practice: Practice) -> str:
    try:
        return _normalize_slot_time(practice.appointment_time)
    except Exception:
        return ""


def _practice_needs_yap_delete(practice: Any) -> bool:
    management_status = str(getattr(practice, "management_sync_status", "") or "").strip().lower()
    return bool(
        getattr(practice, "management_external_id", None)
        or getattr(practice, "synced", False)
        or getattr(practice, "management_last_sync_at", None)
        or management_status in {
            "synced",
            "duplicate",
            "agenda_synced",
            "partial_synced",
            "complete_synced",
            "sync_failed",
            "audit_failed",
            "deleted",
            "not_found",
            "unknown",
        }
    )


def _write_yap_delete_dump(payload: Dict[str, Any]) -> None:
    """Persiste l'esito dell'ultima delete YAP (worker log incluso) su file.

    La pratica sparisce dalla mini-app subito dopo la delete, quindi senza questo
    dump non resta NESSUNA traccia consultabile dell'esito lato YAP.
    """
    try:
        dump_dir = os.path.join(_project_root(), "automation", "artifacts", "yap", "crash-dumps")
        os.makedirs(dump_dir, exist_ok=True)
        payload = {"ts": _utc_now_iso(), **payload}
        with open(os.path.join(dump_dir, "last-delete.json"), "w", encoding="utf-8") as fh:
            _json.dump(payload, fh, ensure_ascii=False, indent=1)
    except Exception as exc:
        logger.warning("Failed to write YAP delete dump: %s", exc)


async def _notify_user_delete_result(
    telegram_user_id: Optional[int],
    practice_id: Optional[int],
    deleted: bool,
    failure_status: Optional[str],
    worker_phases: Optional[list],
    error: Optional[str],
) -> None:
    """Invia notifica Telegram all'utente sul risultato della delete YAP.

    Bypassa completamente il proxy Railway: Telegram API va diretto,
    non passa per il proxy HTTP. Cosi' l'utente sa se l'eliminazione
    e' riuscita anche se la connessione client-server e' caduta.
    """
    if not telegram_user_id:
        logger.debug("_notify_user_delete_result: skip (no telegram_user_id)")
        return
    try:
        bot_token = settings.telegram_bot_token
        if not bot_token:
            logger.warning("Cannot notify user %s: TELEGRAM_BOT_TOKEN not configured", telegram_user_id)
            return
        if deleted:
            icon = "✅"
            title = f"Appuntamento #{practice_id} eliminato da YAP"
            body = "L'eliminazione e' riuscita. Apri la Mini App per la sincronizzazione."
        elif failure_status == "blocked_by_odl":
            icon = "⚠️"
            title = f"Appuntamento #{practice_id}: eliminazione bloccata"
            body = "L'appuntamento e' collegato a un ordine di lavoro. Eliminalo prima su YAP, poi riprova."
        elif failure_status == "blocked_by_preventivo":
            icon = "⚠️"
            title = f"Appuntamento #{practice_id}: eliminazione bloccata"
            body = "Presente un preventivo. Eliminalo prima su YAP, poi riprova."
        elif failure_status in {"not_found", "unknown", None}:
            icon = "ℹ️"
            title = f"Appuntamento #{practice_id}: non trovato su YAP"
            body = "L'appuntamento non e' presente su YAP (forse gia' eliminato). La pratica e' stata rimossa."
        else:
            icon = "❌"
            title = f"Appuntamento #{practice_id}: eliminazione FALLITA"
            body = error or failure_status or "Errore sconosciuto durante l'eliminazione YAP."
        body = (body or "")[:400]

        phases_text = ""
        if worker_phases:
            last_phases = worker_phases[-3:]
            phases_text = "\n\nUltime fasi script:\n" + "\n".join(
                f"  - {p.get('phase','?')}: {p.get('status','?')} (+{p.get('elapsed_ms',0)/1000:.1f}s)"
                for p in last_phases
            )
        # Niente parse_mode: il body puo' contenere caratteri che rompono Markdown
        # (es. «V», apostrofi, parentesi, trattini). Plain text e' sempre sicuro.
        text = f"{icon} {title}\n\n{body}{phases_text}"
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        logger.info("Notifying user %s: practice=%s deleted=%s status=%s", telegram_user_id, practice_id, deleted, failure_status)
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
            async with session.post(url, json={
                "chat_id": telegram_user_id,
                "text": text,
                "disable_notification": False,
            }) as resp:
                resp_body = await resp.text()
                if resp.status == 200:
                    logger.info("Delete result notified to user %s for practice %s (HTTP 200)", telegram_user_id, practice_id)
                else:
                    logger.warning("Telegram API rejected notification (HTTP %s): %s", resp.status, resp_body[:300])
    except Exception as exc:
        logger.warning("Failed to notify user delete result: %s", exc, exc_info=True)


def _yap_session_fernet() -> Fernet:
    secret = settings.secret_key or settings.telegram_bot_token or "dev-yap-session-state-key"
    digest = hashlib.sha256(f"giorgio:yap-session-state:{secret}".encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def _encrypt_yap_session_state(raw_state: str) -> str:
    token = _yap_session_fernet().encrypt(raw_state.encode("utf-8")).decode("ascii")
    return f"fernet:{token}"


def _decrypt_yap_session_state(stored_state: str) -> str:
    value = str(stored_state or "")
    if not value.startswith("fernet:"):
        return value
    try:
        return _yap_session_fernet().decrypt(value[len("fernet:"):].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        logger.warning("Impossibile decifrare lo stato sessione YAP: %s", exc)
        return ""


def _chmod_owner_only(path: str) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        logger.debug("Unable to restrict permissions for %s", path, exc_info=True)


def _ensure_yap_credentials(action: str) -> None:
    missing = [
        name
        for name in ("YAP_USERNAME", "YAP_PASSWORD")
        if not os.getenv(name, "").strip()
    ]
    if missing:
        missing_label = " e ".join(missing)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "message": f"Configurazione YAP mancante: imposta {missing_label} prima di {action}.",
                "missing": missing,
            },
        )


def _build_yap_sync_scope(mapped: Dict[str, Any]) -> Dict[str, Any]:
    """Describe what the current YAP automation actually writes vs. what stays planned."""
    try:
        field_map = build_full_field_mapping(mapped)
    except Exception as exc:
        logger.warning("Impossibile costruire il sync scope YAP: %s", exc)
        field_map = {}

    summary = field_map.get("summary") or {}
    contexts = list(mapped.get("contexts") or [])
    agenda_worker = list(summary.get("agendaWorker") or ["popup.cosa", "popup.quando", "popup.dalle", "popup.alle", "popup.tag"])
    odl_planned = list(summary.get("odlWorkerPlanned") or ["MAN", "MAC", "materiali", "ricambi", "smaltimento"])

    return {
        "mode": "agenda_only",
        "complete": False,
        "summary": "Agenda sincronizzata. ODL/materiali/ricambi pianificati.",
        "agenda": {
            "written": ["Cosa", "Quando", "Dalle", "Alle", "Tag"],
            "used_contexts": contexts,
            "notes": ["Note interne", "Note reparto"],
        },
        "odl": {
            "planned": ["MAN", "MAC", "Materiali", "Ricambi", "Smaltimento"],
        },
        "mappingSummary": {
            "agendaWorker": agenda_worker,
            "odlWorkerPlanned": odl_planned,
        },
    }


def _practice_cache_stamp(
    practice: Practice,
    db: Session,
    sections=None,
    parts=None,
) -> str:
    # sections/parts possono essere passati pre-caricati per evitare query extra
    # nel caso batch (vedere _pre_sync_check_batch). Se None, vengono caricati qui.
    if sections is None:
        sections = db.query(PracticeSection).filter(PracticeSection.practice_id == practice.id).all()
    if parts is None:
        parts = db.query(PracticePart).filter(PracticePart.practice_id == practice.id).all()
    data = {
        "id": practice.id,
        "updated_at": practice.updated_at.isoformat() if practice.updated_at else "",
        "contexts": practice.contexts or "",
        "date": _practice_date_iso(practice),
        "time": practice.appointment_time or "",
        "sections": [
            {
                "ctx": str(s.context.value if hasattr(s.context, "value") else s.context),
                "rows": s.description_rows or "",
                "man": s.man_hours,
                "mac": s.mac_hours,
                "mat": s.materials_amount,
                "w_apply": s.waste_apply,
                "w_pct": s.waste_percentage,
                "notes": s.notes or "",
            }
            for s in sections
        ],
        "parts": [
            {
                "ctx": str(p.context.value if hasattr(p.context, "value") else p.context),
                "name": p.name or "",
                "qty": p.quantity or "",
            }
            for p in parts
        ],
    }
    raw = _json.dumps(data, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _cache_get(cache: Dict[str, Dict[str, Any]], key: str) -> Optional[Any]:
    entry = cache.get(key)
    if not entry:
        return None
    if entry.get("expires_at", 0) < time.time():
        cache.pop(key, None)
        return None
    return entry.get("value")


def _cache_set(cache: Dict[str, Dict[str, Any]], key: str, value: Any, ttl_seconds: int = YAP_PRECHECK_CACHE_TTL_SECONDS) -> None:
    now = time.time()
    # Bound memory: drop already-expired entries, then evict oldest if still over cap.
    if len(cache) >= YAP_CACHE_MAX_ENTRIES:
        for expired_key in [k for k, v in cache.items() if v.get("expires_at", 0) < now]:
            cache.pop(expired_key, None)
        while len(cache) >= YAP_CACHE_MAX_ENTRIES:
            oldest_key = min(cache, key=lambda k: cache[k].get("expires_at", 0))
            cache.pop(oldest_key, None)
    cache[key] = {
        "value": value,
        "expires_at": now + max(1, ttl_seconds),
    }


def _cache_invalidate_practice(practice_id: int) -> None:
    pid = str(practice_id)
    for store in (YAP_PRECHECK_CACHE, YAP_PREVIEW_CACHE):
        stale = [k for k in store.keys() if k.startswith(f"{pid}:")]
        for key in stale:
            store.pop(key, None)


def _build_yap_action_from_error(reason: str) -> Dict[str, Any]:
    msg = str(reason or "").lower()
    if "salvataggio yap non confermato" in msg or "save not confirmed" in msg:
        return {"error_code": "YAP_SAVE_NOT_CONFIRMED", "next_action": "Riprova sync", "action_target": "sync", "failed_phase": "save", "retryable": True}
    if "timeout" in msg:
        return {"error_code": "YAP_TIMEOUT", "next_action": "Riprova sync", "action_target": "sync", "failed_phase": "write_or_audit", "retryable": True}
    if "audit_not_completed" in msg or "audit yap non completato" in msg:
        return {"error_code": "YAP_AUDIT_INCOMPLETE", "next_action": "Verifica YAP", "action_target": "audit", "failed_phase": "audit", "retryable": True}
    if "appointment_not_verified" in msg:
        return {"error_code": "APPT_NOT_VERIFIED", "next_action": "Verifica YAP", "action_target": "audit", "failed_phase": "audit", "retryable": True}
    if "ordine di lavoro" in msg or "blocked_by_odl" in msg:
        return {"error_code": "BLOCKED_BY_ODL", "next_action": "Apri pratica-ODL e scollega prima l'ODL", "action_target": "open_odl", "failed_phase": "delete", "retryable": False}
    if "popup" in msg:
        return {"error_code": "POPUP_NOT_OPENED", "next_action": "Verifica YAP e poi Riprova sync", "action_target": "audit", "failed_phase": "agenda_popup", "retryable": True}
    if "appuntamento" in msg and "non verificato" in msg:
        return {"error_code": "APPT_NOT_VERIFIED", "next_action": "Verifica YAP", "action_target": "audit", "failed_phase": "audit", "retryable": True}
    return {"error_code": "YAP_GENERIC_ERROR", "next_action": "Riprova sync", "action_target": "sync", "failed_phase": None, "retryable": True}


def _infer_issue_labels_from_worker_phases(worker_phases: Any) -> List[str]:
    if not isinstance(worker_phases, list):
        return []
    issues: List[str] = []
    for phase in worker_phases:
        if not isinstance(phase, dict):
            continue
        phase_name = str(phase.get("phase") or "").strip().lower()
        phase_status = str(phase.get("status") or "").strip().lower()
        if phase_status not in {"failed", "ineffective"}:
            continue
        if phase_name in {"notes_fallback", "notes", "notes_write"} and "note" not in issues:
            issues.append("note")
        elif phase_name in {"odl", "odl_route", "odl_tab", "practice_odl"} and "ODL" not in issues:
            issues.append("ODL")
        elif phase_name in {"materials", "materials_write"} and "materiali" not in issues:
            issues.append("materiali")
        elif phase_name in {"parts", "parts_write"} and "ricambi" not in issues:
            issues.append("ricambi")
        elif phase_name in {"waste", "waste_write"} and "smaltimento" not in issues:
            issues.append("smaltimento")
    return issues


def _write_report_issue_labels(write_report: Optional[Dict[str, Any]], worker_phases: Any = None) -> List[str]:
    if not isinstance(write_report, dict):
        return _infer_issue_labels_from_worker_phases(worker_phases)
    labels = {
        "notes": "note",
        "odl": "ODL",
        "materials": "materiali",
        "parts": "ricambi",
        "waste": "smaltimento",
    }
    issues: List[str] = []
    for key, label in labels.items():
        value = write_report.get(key)
        if isinstance(value, dict) and value.get("error"):
            issues.append(label)
    if not issues and write_report.get("ok") is False:
        generic_error = str(write_report.get("error") or "").strip().lower()
        if "odl" in generic_error:
            issues.append("ODL")
        elif "note" in generic_error:
            issues.append("note")
        inferred_issues = _infer_issue_labels_from_worker_phases(worker_phases)
        for inferred_issue in inferred_issues:
            if inferred_issue not in issues:
                issues.append(inferred_issue)
        if not issues:
            issues.append("post-scrittura")
    elif not issues:
        issues.extend(_infer_issue_labels_from_worker_phases(worker_phases))
    return issues


def _build_incomplete_post_write_audit(audit_detail: Any, write_report: Optional[Dict[str, Any]], worker_phases: Any = None) -> Dict[str, Any]:
    detail = audit_detail if isinstance(audit_detail, dict) else {"message": str(audit_detail or "Audit YAP non completato.")}
    write_issues = _write_report_issue_labels(write_report, worker_phases)
    message = "Appuntamento YAP scritto, ma audit non completato."
    if write_issues:
        message += f" Da ricontrollare: {', '.join(write_issues)}."
    next_steps = ["Apri la tab YAP e premi Verifica YAP."]
    if write_issues:
        next_steps.append("Se i campi indicati sono davvero vuoti su YAP, rilancia Riprova sync.")
    return {
        "ok": False,
        "completed": False,
        "technical_failure": True,
        "status": "partial_synced",
        "status_reason": "audit_not_completed",
        "message": message,
        "error": detail,
        "error_code": "YAP_AUDIT_INCOMPLETE",
        "next_action": "Verifica YAP",
        "action_target": "audit",
        "retryable": True,
        "present": [],
        "missing": [],
        "mismatch": [],
        "feedback": {
            "summary": "Audit non completato: YAP ha ricevuto la scrittura, ma la verifica automatica non ha chiuso.",
            "nextSteps": next_steps,
        },
    }


def _build_post_write_review_audit(audit_detail: Any, write_report: Optional[Dict[str, Any]], worker_phases: Any = None) -> Dict[str, Any]:
    detail = audit_detail if isinstance(audit_detail, dict) else {"message": str(audit_detail or "Verifica automatica parziale.")}
    write_issues = _write_report_issue_labels(write_report, worker_phases)
    present = list(detail.get("present") or [])
    missing = list(detail.get("missing") or [])
    mismatch = list(detail.get("mismatch") or [])
    summary = detail.get("summary") if isinstance(detail.get("summary"), dict) else None

    message = "Appuntamento scritto su YAP. Verifica automatica parziale."
    if write_issues:
        message = f"Appuntamento scritto su YAP. Da ricontrollare: {', '.join(write_issues)}."

    next_steps = ["Apri la tab YAP e premi Verifica YAP per completare il controllo."]
    if write_issues:
        next_steps.append("Controlla prima i campi post-scrittura indicati e poi rilancia la verifica.")

    return {
        "ok": False,
        "completed": False,
        "technical_failure": False,
        "verified": False,
        "status": "partial_synced",
        "status_reason": "post_write_review_needed",
        "message": message,
        "error": detail,
        "error_code": None,
        "next_action": "Verifica YAP",
        "action_target": "audit",
        "retryable": True,
        "present": present,
        "missing": missing,
        "mismatch": mismatch,
        "summary": summary or {
            "present": len(present),
            "missing": len(missing),
            "mismatch": len(mismatch),
        },
        "feedback": {
            "summary": "La scrittura su YAP risulta avviata, ma alcuni campi post-scrittura sono da ricontrollare.",
            "nextSteps": next_steps,
        },
    }


def _build_inline_sync_audit_result(
    result_data: Dict[str, Any],
    write_report: Optional[Dict[str, Any]],
    worker_phases: Any = None,
) -> Optional[Dict[str, Any]]:
    inline_audit = result_data.get("inline_audit")
    if not isinstance(inline_audit, dict):
        return None
    write_issues = _write_report_issue_labels(write_report, worker_phases)
    wr = write_report if isinstance(write_report, dict) else {}

    if inline_audit.get("error"):
        if write_issues or wr.get("ok") is False or wr.get("error") or inline_audit.get("present") or inline_audit.get("missing") or inline_audit.get("mismatch"):
            return _build_post_write_review_audit(
                {
                    "message": str(inline_audit.get("error") or "Verifica automatica parziale."),
                    "summary": inline_audit.get("summary"),
                    "present": inline_audit.get("present"),
                    "missing": inline_audit.get("missing"),
                    "mismatch": inline_audit.get("mismatch"),
                },
                write_report,
                worker_phases,
            )
        return _build_incomplete_post_write_audit(
            {
                "message": str(inline_audit.get("error") or "Audit inline non completato."),
                "summary": inline_audit.get("summary"),
            },
            write_report,
            worker_phases,
        )

    present = list(inline_audit.get("present") or [])
    missing = list(inline_audit.get("missing") or [])
    mismatch = list(inline_audit.get("mismatch") or [])
    verified = bool(inline_audit.get("verified"))
    summary = inline_audit.get("summary") if isinstance(inline_audit.get("summary"), dict) else None
    if write_issues or wr.get("ok") is False or wr.get("error"):
        return _build_post_write_review_audit(
            {
                "message": str(inline_audit.get("error") or "Verifica automatica parziale."),
                "summary": summary,
                "present": present,
                "missing": missing,
                "mismatch": mismatch,
            },
            write_report,
            worker_phases,
        )

    # Safety net: se verified=false ma non ci sono campi mancanti/diversi,
    # l'audit ha comunque confermato tutti i campi comuni (agenda+tag+veicolo).
    # Non degradare a partial_synced senza evidenza di campi mancanti.
    if not verified and not missing and not mismatch:
        verified = True
    status_value = "complete_synced" if verified else ("partial_synced" if (present or missing or mismatch) else "agenda_synced")
    if status_value == "complete_synced":
        message = "Appuntamento YAP scritto e verificato automaticamente."
    elif status_value == "partial_synced":
        message = "Appuntamento scritto su YAP. Verifica automatica completata: alcuni campi sono da ricontrollare."
    else:
        message = "Appuntamento scritto su YAP. Verifica automatica non conclusa."

    return {
        "ok": verified,
        "completed": True,
        "technical_failure": False,
        "verified": verified,
        "status": status_value,
        "message": message,
        "present": present,
        "missing": missing,
        "mismatch": mismatch,
        "summary": summary or {
            "present": len(present),
            "missing": len(missing),
            "mismatch": len(mismatch),
        },
    }


def _audit_status_from_result(audit_result: Dict[str, Any]) -> str:
    status_value = str(audit_result.get("status") or "").strip()
    if status_value in {"complete_synced", "partial_synced", "agenda_synced", "sync_failed"}:
        return status_value
    missing = audit_result.get("missing") or []
    mismatch = audit_result.get("mismatch") or []
    present = audit_result.get("present") or []
    if mismatch or not present:
        return "sync_failed"
    if missing:
        return "partial_synced"
    return "complete_synced"


def _audit_message_for_status(status_value: str, audit_result: Dict[str, Any]) -> str:
    if audit_result.get("message"):
        return str(audit_result["message"])
    if status_value == "complete_synced":
        return "YAP completo: agenda, note, ODL, materiali e ricambi verificati."
    if status_value == "partial_synced":
        return "Agenda presente, mancano ODL/materiali/ricambi/note."
    if status_value == "agenda_synced":
        return "Agenda verificata."
    return "Appuntamento YAP non verificato."


def _audit_reason_for_status(status_value: str, audit_result: Dict[str, Any]) -> str:
    explicit_reason = str(audit_result.get("status_reason") or "").strip()
    if explicit_reason:
        return explicit_reason
    if status_value == "complete_synced":
        return "strict_match_complete"
    if status_value == "agenda_synced":
        return "audit_deferred"
    if status_value == "partial_synced":
        missing = len(audit_result.get("missing") or [])
        mismatch = len(audit_result.get("mismatch") or [])
        if missing or mismatch:
            return f"strict_mismatch_missing_{missing}_mismatch_{mismatch}"
        return "strict_partial"
    return "appointment_not_verified"


def _persist_yap_audit_result(
    db: Session,
    practice: Practice,
    audit_result: Dict[str, Any],
    user_id: int,
) -> str:
    status_value = _audit_status_from_result(audit_result)
    practice.management_sync_status = status_value
    practice.management_last_sync_at = datetime.now(timezone.utc)
    practice.management_audit_result = _json.dumps(audit_result, ensure_ascii=False)
    # Solo complete_synced Ã¨ considerato successo pieno.
    practice.synced = status_value == "complete_synced"
    practice.updated_by_telegram_id = user_id
    db.commit()
    _cache_invalidate_practice(practice.id)
    return status_value


def _extract_yap_phases(stderr_text: str) -> list:
    """Estrae gli eventi yap:phase emessi dal worker su stderr."""
    if not stderr_text:
        return []
    phases = []
    for line in stderr_text.splitlines():
        line = line.strip()
        if not line or '"event":"yap:phase"' not in line and '"event": "yap:phase"' not in line:
            continue
        try:
            obj = _json.loads(line)
            if obj.get("event") == "yap:phase":
                phases.append({
                    "phase": obj.get("phase", ""),
                    "status": obj.get("status", ""),
                    "elapsed_ms": obj.get("elapsed_ms", 0),
                    "ts": obj.get("ts", ""),
                    **{k: v for k, v in obj.items() if k not in ("event", "phase", "status", "elapsed_ms", "ts")},
                })
        except (_json.JSONDecodeError, ValueError):
            continue
    return phases


def _extract_yap_session_events(stderr_text: str) -> list:
    """Estrae gli eventi yap:session emessi dal worker su stderr (diagnostica interna)."""
    if not stderr_text:
        return []
    events = []
    for line in stderr_text.splitlines():
        line = line.strip()
        if not line or '"event":"yap:session"' not in line and '"event": "yap:session"' not in line:
            continue
        try:
            obj = _json.loads(line)
            if obj.get("event") == "yap:session":
                events.append({
                    "status": obj.get("status", ""),
                    "ts": obj.get("ts", ""),
                    **{k: v for k, v in obj.items() if k not in ("event", "status", "ts")},
                })
        except (_json.JSONDecodeError, ValueError):
            continue
    return events


def _yap_appointment_saved_from_detail(detail: Any) -> bool:
    """True se le fasi del worker indicano che l'appuntamento Ã¨ giÃ  stato scritto su YAP.

    Serve quando il worker viene interrotto (timeout/errore) DOPO aver salvato l'agenda
    ma DURANTE la scrittura dell'ODL: in quel caso l'appuntamento esiste giÃ  su YAP e la
    pratica non va declassata a 'sync_failed', ma lasciata 'agenda_synced' (verifica in attesa).
    """
    if not isinstance(detail, dict):
        return False
    phases = detail.get("worker_phases")
    if not phases and isinstance(detail.get("runner"), dict):
        phases = detail["runner"].get("worker_phases")
    if not isinstance(phases, list):
        return False
    for ph in phases:
        if isinstance(ph, dict) and str(ph.get("phase")) == "save" and str(ph.get("status")) == "done":
            return True
    return False


def _extract_yap_runtime_telemetry(payload: Any) -> Optional[dict]:
    if not isinstance(payload, dict):
        return None
    candidates = [
        payload.get("telemetry"),
        payload.get("result", {}).get("telemetry") if isinstance(payload.get("result"), dict) else None,
        payload.get("yap", {}).get("telemetry") if isinstance(payload.get("yap"), dict) else None,
        payload.get("yap", {}).get("result", {}).get("telemetry")
        if isinstance(payload.get("yap"), dict) and isinstance(payload.get("yap", {}).get("result"), dict)
        else None,
    ]
    for telemetry in candidates:
        if isinstance(telemetry, dict):
            return telemetry
    return None


def _extract_json_blob(text: str) -> Optional[dict]:
    if not text:
        return None
    raw = text.strip()
    if not raw:
        return None

    objects: List[dict] = []
    depth = 0
    start_idx = -1
    in_string = False
    escaped = False
    for idx, ch in enumerate(raw):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            if depth == 0:
                start_idx = idx
            depth += 1
            continue
        if ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start_idx >= 0:
                    candidate = raw[start_idx:idx + 1]
                    try:
                        parsed = _json.loads(candidate)
                        if isinstance(parsed, dict):
                            objects.append(parsed)
                    except Exception:
                        pass
                    start_idx = -1
            continue

    if objects:
        return objects[-1]

    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end >= start:
        candidate = raw[start:end + 1]
        try:
            parsed = _json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    try:
        parsed = _json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return None
    return None


def _build_yap_failure_detail(out: str, err: str) -> dict:
    parsed = _extract_json_blob(err) or _extract_json_blob(out) or {}
    message = (
        parsed.get("error")
        or parsed.get("message")
        or (err.splitlines()[-1].strip() if err else "")
        or (out.splitlines()[-1].strip() if out else "")
        or "Automazione YAP fallita"
    )
    detail = {
        "message": message,
        "error": parsed.get("error") or parsed.get("message") or message,
    }
    screenshot = parsed.get("screenshot") or parsed.get("screenshotPath")
    if screenshot:
        detail["screenshot"] = screenshot
    stack = parsed.get("stack")
    if stack:
        detail["stack"] = stack
    reason = parsed.get("status_reason") or parsed.get("reason") or message
    action = _build_yap_action_from_error(str(reason))
    detail.update(
        {
            "error_code": action["error_code"],
            "reason": str(reason),
            "failed_phase": action["failed_phase"],
            "retryable": action["retryable"],
            "next_action": action["next_action"],
            "action_target": action["action_target"],
            "debug_ref": {"screenshot": screenshot} if screenshot else None,
        }
    )
    return detail


class _YapScriptTimeout(Exception):
    def __init__(self, detail: Dict[str, Any]):
        super().__init__(str(detail.get("message") or "Timeout automazione YAP"))
        self.detail = detail


async def _run_yap_script(script_name: str, args: List[str], timeout_seconds: int = 180, db: Optional[Session] = None, allow_safe_retry: bool = True) -> Dict[str, Any]:
    queued_started_at = _utc_now_iso()
    queued_started_monotonic = time.perf_counter()

    lock = _get_yap_run_lock()
    # I sync durano ~70s (re-login). Con timeout 10s, un secondo sync lanciato mentre
    # il primo gira falliva subito (YAP_BUSY). Ora ASPETTIAMO che il primo finisca: il
    # secondo si mette in coda e parte dopo, invece di dare errore.
    try:
        _lock_wait_s = int(os.getenv("YAP_LOCK_WAIT_S", "100") or "100")
    except (TypeError, ValueError):
        _lock_wait_s = 100
    try:
        await asyncio.wait_for(lock.acquire(), timeout=_lock_wait_s)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "message": "Un sync YAP e ancora in corso. Attendi qualche secondo e riprova.",
                "error_code": "YAP_BUSY",
                "next_action": "retry",
            },
        )
    async with _WithAcquiredLock(lock):
        lock_acquired_at = _utc_now_iso()
        lock_acquired_monotonic = time.perf_counter()
        lock_wait_ms = int((lock_acquired_monotonic - queued_started_monotonic) * 1000)
        root = _project_root()
        script_path = os.path.join(root, "automation", "yap", script_name)
        logger.info(
            "YAP script lock acquired (%s) queued_at=%s acquired_at=%s lock_wait_ms=%d args=%s",
            script_name,
            queued_started_at,
            lock_acquired_at,
            lock_wait_ms,
            args,
        )

        # Serializziamo l'accesso al session-state condiviso.
        # NB: usiamo una sessione DB dedicata (non quella della request) cosÃ¬ che il
        # commit dello stato di sessione non persista per sbaglio modifiche ORM in sospeso.
        persist_session_state = db is not None
        session_file_path = os.path.join(root, "automation", "artifacts", "yap", "session-state.json")
        if persist_session_state:
            state_db = SessionLocal()
            try:
                setting = state_db.query(SystemSetting).filter(SystemSetting.key == "yap_session_state").first()
                if setting and setting.value:
                    restored_state = _decrypt_yap_session_state(setting.value)
                    os.makedirs(os.path.dirname(session_file_path), exist_ok=True)
                    with open(session_file_path, "w", encoding="utf-8") as f:
                        f.write(restored_state)
                    _chmod_owner_only(session_file_path)
                    logger.info("Session state YAP ripristinato dal database")
            except Exception as e:
                logger.warning("Impossibile ripristinare la sessione YAP dal database: %s", e)
            finally:
                state_db.close()

        async def _run_once(extra_env: Optional[Dict[str, str]] = None) -> tuple[int, str, str, Dict[str, Any]]:
            node_bin = os.getenv("NODE_BINARY") or (_shutil.which("node") or _shutil.which("nodejs") or "node")
            env = os.environ.copy()
            if extra_env:
                env.update(extra_env)
            attempt_name = "safe_mode_retry" if extra_env and extra_env.get("YAP_SAFE_MODE") == "1" else "primary"
            attempt_started_at = _utc_now_iso()
            attempt_started_monotonic = time.perf_counter()
            logger.info(
                "YAP script starting (%s) attempt=%s started_at=%s timeout_seconds=%d",
                script_name,
                attempt_name,
                attempt_started_at,
                timeout_seconds,
            )
            # Su Linux (Railway) il worker Playwright/Chromium gira sullo stesso
            # container dell'API e ne satura la CPU: con `nice` il worker cede
            # priorita' alle richieste HTTP (la mini-app non si "congela" piu').
            exec_argv = [node_bin, script_path, *args]
            if os.name == "posix" and _shutil.which("nice"):
                exec_argv = ["nice", "-n", "10", *exec_argv]
            process = await asyncio.create_subprocess_exec(
                *exec_argv,
                cwd=root,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                start_new_session=(os.name == "posix"),
            )
            _stdout_chunks: list = []
            _stderr_chunks: list = []

            async def _drain_stdout():
                assert process.stdout
                async for chunk in process.stdout:
                    _stdout_chunks.append(chunk)

            async def _drain_stderr():
                assert process.stderr
                async for chunk in process.stderr:
                    _stderr_chunks.append(chunk)

            _drain_task_out = asyncio.ensure_future(_drain_stdout())
            _drain_task_err = asyncio.ensure_future(_drain_stderr())

            async def _kill_worker_tree() -> None:
                if process.returncode is not None:
                    return
                try:
                    if os.name == "posix":
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()

            try:
                await asyncio.wait_for(process.wait(), timeout=timeout_seconds)
                # Node puo' terminare lasciando processi Chromium figli ancora vivi.
                # Il worker gira in una sessione POSIX dedicata: ripulisci sempre il
                # gruppo dopo l'uscita, non solo in caso di timeout.
                if os.name == "posix":
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                await asyncio.gather(_drain_task_out, _drain_task_err, return_exceptions=True)
                stdout = b"".join(_stdout_chunks)
                stderr = b"".join(_stderr_chunks)
            except asyncio.TimeoutError:
                await _kill_worker_tree()
                await asyncio.gather(_drain_task_out, _drain_task_err, return_exceptions=True)
                stdout = b"".join(_stdout_chunks)
                stderr = b"".join(_stderr_chunks)
                out_text = stdout.decode("utf-8", errors="replace").strip()
                err_text = stderr.decode("utf-8", errors="replace").strip()
                duration_ms = int((time.perf_counter() - attempt_started_monotonic) * 1000)
                worker_phases = _extract_yap_phases(err_text)
                last_phase = worker_phases[-1] if worker_phases else {}
                _phase_parts = []
                _prev_ms = 0
                for _p in worker_phases:
                    _cur = _p.get("elapsed_ms") or 0
                    _phase_parts.append(f"{_p['phase']}:{_p.get('status','')}({_cur}ms,+{_cur-_prev_ms}ms)")
                    _prev_ms = _cur
                logger.error(
                    "YAP script timeout (%s) attempt=%s timeout=%ds last_phase=%s phases=[%s] stderr_tail=%s",
                    script_name,
                    attempt_name,
                    timeout_seconds,
                    f"{last_phase.get('phase')}:{last_phase.get('status')}",
                    " -> ".join(_phase_parts) or "none",
                    err_text[-2000:],
                )
                try:
                    _dump_dir = os.path.join(_project_root(), "automation", "artifacts", "yap", "crash-dumps")
                    os.makedirs(_dump_dir, exist_ok=True)
                    _dump_path = os.path.join(_dump_dir, "last-timeout.json")
                    with open(_dump_path, "w", encoding="utf-8") as _fh:
                        _json.dump({
                            "script": script_name,
                            "attempt": attempt_name,
                            "timeout_seconds": timeout_seconds,
                            "ts": _utc_now_iso(),
                            "last_phase": f"{last_phase.get('phase')}:{last_phase.get('status')}",
                            "phases": worker_phases,
                            "phase_summary": " -> ".join(_phase_parts) or "none",
                            "stderr": err_text,
                            "stdout": out_text,
                        }, _fh, ensure_ascii=False, indent=2)
                except Exception as _dump_err:
                    logger.warning("Failed to write crash dump: %s", _dump_err)
                raise _YapScriptTimeout(
                    {
                        "message": "Timeout automazione YAP",
                        "error": "Timeout automazione YAP",
                        "reason": f"timeout during {last_phase.get('phase') or 'worker_execution'}",
                        "error_code": "YAP_TIMEOUT",
                        "failed_phase": last_phase.get("phase") or "write_or_audit",
                        "retryable": True,
                        "next_action": "Riprova sync",
                        "action_target": "sync",
                        "worker_phases": worker_phases,
                        "runner": {
                            "attempt": attempt_name,
                            "started_at": attempt_started_at,
                            "finished_at": _utc_now_iso(),
                            "duration_ms": duration_ms,
                            "returncode": None,
                            "timeout_seconds": timeout_seconds,
                        },
                        "stderr_tail": err_text[-3000:],
                        "stdout_tail": out_text[-2000:],
                    }
                )
            except asyncio.CancelledError:
                await _kill_worker_tree()
                await asyncio.gather(_drain_task_out, _drain_task_err, return_exceptions=True)
                raise
            attempt_finished_at = _utc_now_iso()
            duration_ms = int((time.perf_counter() - attempt_started_monotonic) * 1000)
            out_text = stdout.decode("utf-8", errors="replace").strip()
            err_text = stderr.decode("utf-8", errors="replace").strip()
            logger.info(
                "YAP script finished (%s) attempt=%s returncode=%d duration_ms=%d finished_at=%s",
                script_name,
                attempt_name,
                process.returncode,
                duration_ms,
                attempt_finished_at,
            )
            if err_text:
                logger.info("YAP script diagnostics (%s/%s):\n%s", script_name, attempt_name, err_text[-4000:])
            return process.returncode, out_text, err_text, {
                "attempt": attempt_name,
                "started_at": attempt_started_at,
                "finished_at": attempt_finished_at,
                "duration_ms": duration_ms,
                "returncode": process.returncode,
            }

        attempts: List[Dict[str, Any]] = []
        try:
            returncode, out, err, attempt_meta = await _run_once()
        except _YapScriptTimeout as timeout_exc:
            timeout_detail = dict(timeout_exc.detail or {})
            timeout_detail["runner"] = {
                "script": script_name,
                "queued_at": queued_started_at,
                "lock_acquired_at": lock_acquired_at,
                "lock_wait_ms": lock_wait_ms,
                "timeout_seconds": timeout_seconds,
                "attempts": [],
                "finished_at": _utc_now_iso(),
                "total_elapsed_ms": int((time.perf_counter() - queued_started_monotonic) * 1000),
                **(timeout_detail.get("runner") or {}),
            }
            raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=timeout_detail)
        attempts.append(attempt_meta)

        if persist_session_state and os.path.exists(session_file_path):
            state_db = SessionLocal()
            try:
                with open(session_file_path, "r", encoding="utf-8") as f:
                    session_data = f.read()
                if session_data.strip():
                    encrypted_session_data = _encrypt_yap_session_state(session_data)
                    setting = state_db.query(SystemSetting).filter(SystemSetting.key == "yap_session_state").first()
                    if not setting:
                        setting = SystemSetting(key="yap_session_state", value=encrypted_session_data)
                        state_db.add(setting)
                    else:
                        setting.value = encrypted_session_data
                    state_db.commit()
                    logger.info("Session state YAP salvato nel database (encrypted)")
            except Exception as e:
                state_db.rollback()
                logger.warning("Impossibile salvare la sessione YAP nel database: %s", e)
            finally:
                state_db.close()
                try:
                    os.remove(session_file_path)
                except FileNotFoundError:
                    pass
                except OSError as cleanup_exc:
                    logger.warning("Impossibile rimuovere session state YAP temporaneo: %s", cleanup_exc)

        if returncode != 0:
            failure_detail = _build_yap_failure_detail(out, err)
            recoverable_signals = (
                "target crashed",
                "target closed",
                "page crashed",
                "browser has been closed",
                "execution context was destroyed",
                "login_form_not_visible",
                "agenda_viewport_state_timeout",
                "agenda_event_population_timeout",
            )
            message_lc = str(failure_detail.get("message") or "").lower()
            # allow_safe_retry=False per le DELETE: il retry raddoppia la durata
            # (230s x 2) sforando ogni timeout client, e una delete non e' idempotente.
            is_recoverable = allow_safe_retry and any(signal in message_lc for signal in recoverable_signals)
            if is_recoverable:
                logger.warning("YAP script recoverable failure (%s), retrying once in safe mode", script_name)
                retry_code, retry_out, retry_err, retry_attempt_meta = await _run_once({"YAP_SAFE_MODE": "1"})
                attempts.append(retry_attempt_meta)
                if retry_code == 0:
                    out = retry_out
                    err = retry_err
                    returncode = 0
                else:
                    out = retry_out
                    err = retry_err

        runner_meta = {
            "script": script_name,
            "queued_at": queued_started_at,
            "lock_acquired_at": lock_acquired_at,
            "lock_wait_ms": lock_wait_ms,
            "timeout_seconds": timeout_seconds,
            "attempts": attempts,
            "finished_at": _utc_now_iso(),
            "total_elapsed_ms": int((time.perf_counter() - queued_started_monotonic) * 1000),
        }

        if returncode != 0:
            failure_detail = _build_yap_failure_detail(out, err)
            failure_detail["runner"] = runner_meta
            _worker_phases_fail = _extract_yap_phases(err)
            _phase_parts_fail = []
            _prev_ms_fail = 0
            for _p in _worker_phases_fail:
                _cur = _p.get("elapsed_ms") or 0
                _phase_parts_fail.append(f"{_p['phase']}:{_p.get('status','')}({_cur}ms,+{_cur-_prev_ms_fail}ms)")
                _prev_ms_fail = _cur
            if _worker_phases_fail:
                failure_detail["worker_phases"] = _worker_phases_fail
            if err:
                failure_detail["stderr_tail"] = err[-4000:]
            if out:
                failure_detail["stdout_tail"] = out[-2000:]
            logger.error(
                "YAP script failed (%s): %s phases=[%s]",
                script_name,
                failure_detail.get("message"),
                " -> ".join(_phase_parts_fail) or "none",
                extra={
                    "stdout_tail": out[-3000:],
                    "stderr_tail": err[-3000:],
                },
            )
            try:
                _dump_dir = os.path.join(_project_root(), "automation", "artifacts", "yap", "crash-dumps")
                os.makedirs(_dump_dir, exist_ok=True)
                with open(os.path.join(_dump_dir, "last-timeout.json"), "w", encoding="utf-8") as _fh:
                    _json.dump({
                        "script": script_name,
                        "attempt": "primary",
                        "timeout_seconds": timeout_seconds,
                        "ts": _utc_now_iso(),
                        "last_phase": f"{_worker_phases_fail[-1].get('phase') if _worker_phases_fail else 'None'}:{_worker_phases_fail[-1].get('status') if _worker_phases_fail else 'None'}",
                        "phases": _worker_phases_fail,
                        "phase_summary": " -> ".join(_phase_parts_fail) or "none",
                        "stderr": err,
                        "stdout": out,
                        "error_message": failure_detail.get("message"),
                        "returncode": returncode,
                    }, _fh, ensure_ascii=False, indent=2)
            except Exception as _dump_err:
                logger.warning("Failed to write crash dump (failure): %s", _dump_err)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=failure_detail,
            )

        worker_phases = _extract_yap_phases(err)
        session_events = _extract_yap_session_events(err)
        if worker_phases:
            runner_meta["worker_phases"] = worker_phases
            total_ms = runner_meta.get("total_elapsed_ms", 0)
            parts = []
            prev_ms = 0
            for p in worker_phases:
                cur_ms = p.get("elapsed_ms") or 0
                delta = cur_ms - prev_ms
                parts.append(f"{p['phase']}:{p.get('status', '')}({cur_ms}ms,+{delta}ms)")
                prev_ms = cur_ms
            phase_summary = " -> ".join(parts)
            logger.info("YAP phases (%s) total=%dms: %s", script_name, total_ms, phase_summary)
        if session_events:
            runner_meta["session_event_count"] = len(session_events)
            logger.info(
                "YAP session events (%s) count=%d: %s",
                script_name,
                len(session_events),
                " -> ".join(e.get("status", "?") for e in session_events),
            )

        parsed = _extract_json_blob(out)
        if parsed:
            telemetry = parsed.get("telemetry")
            if isinstance(telemetry, dict):
                telemetry.setdefault("runner", runner_meta)
            else:
                parsed["telemetry"] = {"runner": runner_meta}
            if worker_phases:
                parsed["worker_phases"] = worker_phases
            return parsed
        return {"ok": True, "raw": out, "telemetry": {"runner": runner_meta}, "worker_phases": worker_phases}


@app.patch("/api/practices/{practice_id}/sync")
@limiter.limit("60/minute")
async def toggle_practice_sync(
    request: Request,
    practice_id: int,
    body: SyncToggleRequest,
    access_token: Optional[str] = None,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Toggle the synced status of a practice."""
    practice = _practice_by_id(db, practice_id, for_update=True)

    if not practice or not _can_access_practice(practice, user_data, access_token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    _repair_practice_owner_if_needed(db, practice, user_data, access_token)

    try:
        practice.synced = body.synced
        practice.updated_by_telegram_id = user_data["id"]
        db.commit()
        db.refresh(practice)
        logger.info("Practice %d sync toggled to %s by user %d", practice_id, body.synced, user_data["id"])
        return APIResponse(success=True, data=serialize(practice))
    except Exception as e:
        db.rollback()
        logger.error("Error toggling sync for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore aggiornamento stato sync",
        )


# --- Photo Upload/Delete Endpoints ---

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB


@app.post("/api/practices/{practice_id}/photos")
@limiter.limit("10/minute")
async def upload_practice_photo(
    request: Request,
    practice_id: int,
    access_token: Optional[str] = None,
    file: UploadFile = File(...),
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Upload a photo for a practice via multipart form."""
    # Validate practice ownership
    practice = _practice_by_id(db, practice_id, for_update=True)
    if not practice or not _can_access_practice(practice, user_data, access_token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    _repair_practice_owner_if_needed(db, practice, user_data, access_token)

    # Validate content type
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Tipo file non valido. Ammessi: JPEG, PNG, WebP",
        )

    # Read file and validate size
    file_content = await file.read()
    if len(file_content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File troppo grande. Massimo 10MB",
        )

    # Generate unique file ID
    generated_file_id = str(uuid.uuid4())
    # Never trust the client filename for the on-disk extension: derive it from the
    # validated content type and whitelist it to avoid path traversal via filename.
    _CONTENT_TYPE_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
    ext = _CONTENT_TYPE_EXT.get(file.content_type, "jpg")
    temp_filename = f"{generated_file_id}.{ext}"
    temp_path = os.path.join("storage", "photos", temp_filename)

    try:
        # Save temporarily
        os.makedirs("storage/photos", exist_ok=True)
        with open(temp_path, "wb") as f:
            f.write(file_content)

        # Upload to Cloudinary
        secure_url, metadata = await asyncio.to_thread(
            cloudinary_service.upload_practice_photo,
            temp_path,
            practice_id,
            generated_file_id,
        )

        # Create DB record
        photo = PracticePhoto(
            practice_id=practice_id,
            telegram_file_id=generated_file_id,
            storage_path=secure_url,
            cloudinary_public_id=metadata.get("public_id"),
            ocr_result=None,
            ocr_confidence=None,
        )
        db.add(photo)
        db.commit()
        db.refresh(photo)

        logger.info("Photo %d uploaded for practice %d by user %d", photo.id, practice_id, user_data["id"])

        return APIResponse(success=True, data=_serialize_photo(photo))

    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        db.rollback()
        logger.error("Error uploading photo for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore upload foto",
        )
    finally:
        # Clean up temp file
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                logger.warning("Failed to remove temp file: %s", temp_path)


@app.delete("/api/practices/{practice_id}/photos/{photo_id}")
@limiter.limit("60/minute")
async def delete_practice_photo(
    request: Request,
    practice_id: int,
    photo_id: int,
    access_token: Optional[str] = None,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Delete a photo from a practice."""
    # Validate practice ownership
    practice = _practice_by_id(db, practice_id, for_update=True)
    if not practice or not _can_access_practice(practice, user_data, access_token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    _repair_practice_owner_if_needed(db, practice, user_data, access_token)

    # Validate photo belongs to practice
    photo = db.query(PracticePhoto).filter(
        PracticePhoto.id == photo_id,
        PracticePhoto.practice_id == practice_id,
    ).first()
    if not photo:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Foto non trovata")

    try:
        await asyncio.to_thread(_delete_cloudinary_asset_for_photo, photo)
        db.delete(photo)
        db.commit()
        logger.info("Photo %d deleted from practice %d by user %d", photo_id, practice_id, user_data["id"])
        return APIResponse(success=True, data={"message": "Foto eliminata"})
    except Exception as e:
        db.rollback()
        logger.error("Error deleting photo %d from practice %d: %s", photo_id, practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore eliminazione foto",
        )


# --- Practice Endpoints ---

@app.get("/mini-app/data")
@limiter.limit("60/minute")
async def get_mini_app_data(
    request: Request,
    practice_id: Optional[int] = None,
    access_token: Optional[str] = None,
    plate_confirmed: Optional[str] = None,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Return data for the Telegram Mini App."""
    if practice_id:
        practice = _practice_by_id(db, practice_id)

        if not practice:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

        # Access requires ownership or a valid signed access token. Plate-based
        # ownership "repair" was removed: plates are low-entropy and guessable,
        # so it allowed taking over another user's draft (IDOR).
        if _can_access_practice(practice, user_data, access_token):
            _repair_practice_owner_if_needed(db, practice, user_data, access_token)
        else:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

        photos = db.query(PracticePhoto).filter(PracticePhoto.practice_id == practice_id).all()
        sections = db.query(PracticeSection).filter(PracticeSection.practice_id == practice_id).all()
        parts = db.query(PracticePart).filter(PracticePart.practice_id == practice_id).all()

        return APIResponse(
            success=True,
            data={
                "practice": serialize(practice),
                "photos": [_serialize_photo(p) for p in photos],
                "sections": [serialize(s) for s in sections],
                "parts": [serialize(p) for p in parts],
            },
        )
    else:
        return APIResponse(success=True, data={"user": user_data})


@app.post("/practices/full")
@limiter.limit("20/minute")
async def create_practice_full(
    request: Request,
    body: PracticeFullSave,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Create a practice with sections and parts in one transaction."""
    _validate_full_payload(body)
    try:
        practice = Practice(created_by_telegram_id=user_data["id"])
        _apply_practice_data(practice, body.practice, user_data["id"])
        db.add(practice)
        db.flush()
        _replace_sections_and_parts(db, practice.id, body.sections, body.parts)
        db.commit()
        db.refresh(practice)

        logger.info("Full practice %d created by user %d", practice.id, user_data["id"])
        return APIResponse(success=True, data=serialize(practice))
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        logger.error("Error creating full practice: %s", e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Errore creazione pratica")


@app.put("/practices/{practice_id}/full")
@limiter.limit("60/minute")
async def update_practice_full(
    request: Request,
    practice_id: int,
    body: PracticeFullSave,
    access_token: Optional[str] = None,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Update a practice with sections and parts in one transaction."""
    _validate_full_payload(body)
    practice = _practice_by_id(db, practice_id, for_update=True)
    if not practice or not _can_access_practice(practice, user_data, access_token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    _repair_practice_owner_if_needed(db, practice, user_data, access_token)

    try:
        _apply_practice_data(practice, body.practice, user_data["id"])
        _replace_sections_and_parts(db, practice_id, body.sections, body.parts)
        db.commit()
        db.refresh(practice)

        logger.info("Full practice %d updated by user %d", practice_id, user_data["id"])
        return APIResponse(success=True, data=serialize(practice))
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        logger.error("Error updating full practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Errore aggiornamento pratica")


@app.post("/practices")
@limiter.limit("20/minute")
async def create_practice(
    request: Request,
    practice_data: PracticeCreate,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Create a new practice."""
    # Validation (Pydantic validators in PracticeCreate handle phone/plate/name)
    if not practice_data.contexts:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Almeno un contesto Ã¨ obbligatorio",
        )

    practice_data.appointment_time = _normalize_slot_time(practice_data.appointment_time)

    try:
        contexts_csv = ",".join([
            c.value if hasattr(c, "value") else str(c) for c in practice_data.contexts
        ])

        practice_kwargs = dict(
            created_by_telegram_id=user_data["id"],
            status=PracticeStatus.CONFIRMED,
            plate_confirmed=practice_data.plate_confirmed,
            phone=practice_data.phone,
            customer_name=practice_data.customer_name,
            customer_type=practice_data.customer_type,
            billing_to_complete=practice_data.billing_to_complete,
            appointment_date=practice_data.appointment_date,
            appointment_time=practice_data.appointment_time,
            practice_type=practice_data.practice_type,
            contexts=contexts_csv,
            internal_notes=practice_data.internal_notes,
        )
        optional_billing_fields = (
            "company_name",
            "vat_number",
            "fiscal_code",
            "billing_address",
            "billing_city",
            "billing_zip",
        )
        for field in optional_billing_fields:
            if hasattr(Practice, field):
                practice_kwargs[field] = getattr(practice_data, field, None)

        practice = Practice(**practice_kwargs)

        db.add(practice)
        db.commit()
        db.refresh(practice)

        logger.info("Practice %d created by user %d", practice.id, user_data["id"])

        return APIResponse(success=True, data=serialize(practice))

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error("Error creating practice: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore creazione pratica",
        )


@app.put("/practices/{practice_id}")
@limiter.limit("60/minute")
async def update_practice(
    request: Request,
    practice_id: int,
    practice_data: PracticeUpdate,
    access_token: Optional[str] = None,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Update an existing practice."""
    practice = _practice_by_id(db, practice_id, for_update=True)

    if not practice or not _can_access_practice(practice, user_data, access_token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    _repair_practice_owner_if_needed(db, practice, user_data, access_token)

    try:
        update_data = practice_data.dict(exclude_unset=True)

        if "contexts" in update_data and update_data["contexts"] is not None:
            update_data["contexts"] = ",".join([
                c.value if hasattr(c, "value") else str(c) for c in update_data["contexts"]
            ])

        for field, value in update_data.items():
            setattr(practice, field, value)

        practice.updated_by_telegram_id = user_data["id"]

        if "appointment_time" in update_data:
            practice.appointment_time = _normalize_slot_time(practice.appointment_time)

        db.commit()
        db.refresh(practice)
        logger.info("Practice %d updated by user %d", practice_id, user_data["id"])

        return APIResponse(success=True, data=serialize(practice))

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error("Error updating practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore aggiornamento pratica",
        )


@app.delete("/practices/{practice_id}")
@limiter.limit("60/minute")
async def delete_practice(
    request: Request,
    practice_id: int,
    access_token: Optional[str] = None,
    skip_yap: bool = False,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Soft-delete a practice."""
    practice = _practice_by_id(db, practice_id, for_update=True)

    if not practice or not _can_access_practice(practice, user_data, access_token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    _repair_practice_owner_if_needed(db, practice, user_data, access_token)

    needs_yap_delete = _practice_needs_yap_delete(practice)
    if skip_yap or not needs_yap_delete:
        practice.status = PracticeStatus.DELETED
        practice.updated_by_telegram_id = user_data["id"]
        db.commit()
        logger.info("Practice %d soft-deleted locally without YAP delete (never synced)", practice_id)
        return APIResponse(success=True, data={"message": "Pratica cancellata con successo"})

    try:
        _ensure_yap_credentials("eliminare l'appuntamento su YAP")
        date_iso = _practice_date_iso(practice)
        search = _safe_search_arg(practice.plate_confirmed or practice.plate_detected or practice.customer_name)

        if not date_iso or not search:
            # Senza data o targa non possiamo cercare su YAP: elimina solo in Giorgio.
            _write_yap_delete_dump({
                "practice_id": practice_id,
                "attempted": False,
                "reason": "missing_date_or_search",
                "date_iso": date_iso,
                "search": search,
            })
            logger.warning("Practice %d: YAP delete skipped (date_iso=%s search=%s)", practice_id, date_iso, search)
            practice.status = PracticeStatus.DELETED
            practice.updated_by_telegram_id = user_data["id"]
            db.commit()
            return APIResponse(success=True, data={
                "message": (
                    "Pratica eliminata localmente. ATTENZIONE: appuntamento YAP NON eliminato "
                    "(data o targa mancanti): rimuovilo a mano dall'agenda YAP."
                ),
                "yap": {"attempted": False},
            })

        time_arg = _safe_practice_yap_time_arg(practice)
        yap_args = ["--date", date_iso, f"--search={search}"]
        if time_arg:
            yap_args.extend(["--time", time_arg])

        # StreamingResponse: invia \n immediatamente (evita l'idle-timeout di Railway ~30s)
        # poi heartbeat ogni 8s mentre il worker gira, infine il JSON reale.
        # Giorgio viene segnato DELETED SOLO dopo la conferma YAP — 100% consistente.
        # JSON.parse() accetta whitespace/newline iniziali, quindi il client non cambia nulla.
        captured_pid = practice_id
        captured_uid = user_data["id"]
        captured_date_iso = date_iso
        captured_search = search

        # ============================================================================
        # FIX DEFINITIVO — "ogni volta che va male un'eliminazione, va in timeout TUTTO"
        # ----------------------------------------------------------------------------
        # CAUSA: questo handler carica la pratica con _practice_by_id(..., for_update=True)
        # (riga ~2755), cioe' un SELECT ... FOR UPDATE che su Postgres apre una transazione
        # e tiene un LOCK di riga + UNA connessione del pool occupata.
        # Subito dopo ritorniamo uno StreamingResponse che vive fino a ~200s (durata dello
        # script YAP). La dependency get_db NON chiude la sessione `db` finche' lo stream
        # non e' esaurito (il suo finally gira a fine response). Quindi per TUTTI i ~200s
        # della delete restava appesa una connessione "idle in transaction" col lock.
        # Con pool_size=10, poche delete consecutive/concorrenti esaurivano il pool: ogni
        # altra richiesta (es. GET /api/practices della dashboard) restava in attesa di una
        # connessione libera e andava in TIMEOUT — esattamente il sintomo del crash-dump.
        #
        # FIX: a questo punto abbiamo gia' estratto tutto cio' che serve in primitive
        # (yap_args, captured_*). Lo stream usa SOLO sessioni dedicate proprie
        # (gen_db / task_db, vedi sotto), MAI questa `db`. Quindi chiudiamo subito la
        # transazione e restituiamo la connessione al pool PRIMA di iniziare lo stream.
        # commit() termina la transazione e rilascia il lock FOR UPDATE; close() libera la
        # connessione. get_db richiamera' close() a fine response: e' idempotente, ok.
        # NON usare piu' `db` ne' l'oggetto `practice` dopo questa riga.
        # ============================================================================
        db.commit()
        db.close()

        async def _run_delete_and_dump(task_db):
            """Esegue lo script delete e scrive SEMPRE last-delete.json (successo o errore).

            Vive in un task separato dal generatore dello stream: se il client si
            disconnette (timeout axios/proxy) il generatore viene cancellato MA questo
            task continua e persiste comunque l'esito, cosi' il frontend lo recupera
            in polling da /yap/last-delete. Prima il dump era scritto DENTRO il
            generatore -> client morto = dump mai scritto = log sempre vuoto.
            """
            # Pending dump PRIMA dello script: se il client si disconnette e il
            # recovery poll trova questo dump, sa che la delete e' in corso.
            # Senza questo, il dump non esiste finche' lo script non finisce (230s)
            # e il recovery del client gira a vuoto mostrando log vuoto.
            _write_yap_delete_dump({
                "practice_id": captured_pid,
                "args": yap_args,
                "attempted": True,
                "deleted": False,
                "status": "pending",
                "error": "Delete YAP in corso sul server…",
            })
            try:
                # allow_safe_retry=False: il retry in safe-mode raddoppiava la durata
                # (230s x 2 ~= 460-500s), sforando OGNI timeout client. La delete e'
                # non-idempotente: meglio fallire in fretta con log che ritentare al buio.
                res = await _run_yap_script(
                    "yap-delete-appointment.mjs", yap_args, timeout_seconds=200, db=task_db,
                    allow_safe_retry=False,
                )
            except Exception as exc:
                _detail = getattr(exc, "detail", None)
                _err_payload = _detail if isinstance(_detail, dict) else {"detail": str(exc)}
                _wp = _err_payload.get("worker_phases") or []
                _last_phase = f"{_wp[-1].get('phase', '?')}:{_wp[-1].get('status', '?')}" if _wp else "no_phases"
                _parts = []
                _prev = 0
                for _p in _wp:
                    _cur = _p.get("elapsed_ms") or 0
                    _parts.append(f"{_p.get('phase','')}:{_p.get('status','')}({_cur}ms,+{_cur-_prev}ms)")
                    _prev = _cur
                _write_yap_delete_dump({
                    "practice_id": captured_pid,
                    "args": yap_args,
                    "attempted": True,
                    "deleted": False,
                    "status": "delete_failed",
                    "error": _err_payload.get("message") or _err_payload.get("detail"),
                    "last_phase": _last_phase,
                    "phase_summary": " -> ".join(_parts) or "none",
                    "worker_phases": _wp,
                    "stderr_tail": _err_payload.get("stderr_tail"),
                    "stdout_tail": _err_payload.get("stdout_tail"),
                    "runner": _err_payload.get("runner"),
                })
                # Notifica Telegram: bypassa proxy Railway.
                # Failure status: "delete_failed" (non mappato a ODL/preventivo da qui).
                await _notify_user_delete_result(
                    telegram_user_id=captured_uid,
                    practice_id=captured_pid,
                    deleted=False,
                    failure_status="delete_failed",
                    worker_phases=_wp,
                    error=_err_payload.get("message") or _err_payload.get("detail"),
                )
                raise
            _wp_ok = res.get("worker_phases") or []
            _parts_ok = []
            _prev_ok = 0
            for _p in _wp_ok:
                _cur = _p.get("elapsed_ms") or 0
                _parts_ok.append(f"{_p.get('phase','')}:{_p.get('status','')}({_cur}ms,+{_cur-_prev_ok}ms)")
                _prev_ok = _cur
            _fs_ok = res.get("deleteAction", {}).get("failureStatus") or res.get("status")
            _write_yap_delete_dump({
                "practice_id": captured_pid,
                "args": yap_args,
                "attempted": True,
                "deleted": bool(res.get("deleted")),
                "found": res.get("found"),
                "status": res.get("status"),
                "failure_status": _fs_ok,
                "deleteAction": res.get("deleteAction"),
                "last_phase": f"{_wp_ok[-1].get('phase', '?')}:{_wp_ok[-1].get('status', '?')}" if _wp_ok else "no_phases",
                "phase_summary": " -> ".join(_parts_ok) or "none",
                "worker_phases": _wp_ok,
            })
            # Notifica Telegram: successo o fallimento (ODL/preventivo).
            await _notify_user_delete_result(
                telegram_user_id=captured_uid,
                practice_id=captured_pid,
                deleted=bool(res.get("deleted")),
                failure_status=_fs_ok,
                worker_phases=_wp_ok,
                error=str(res.get("deleteAction", {}).get("message") or res.get("message") or ""),
            )

            # ================================================================
            # FIX DEFINITIVO — "cancellato su YAP ma RIMANE nel mini-app"
            # ----------------------------------------------------------------
            # CAUSA: il commit che segna la pratica DELETED su Giorgio viveva SOLO
            # dentro il generatore _delete_stream (vedi piu' sotto). Il generatore
            # viene CANCELLATO quando il client si disconnette. Quando lo script
            # supera il timeout axios del client (40s) — tipico col fix preventivo
            # che porta la delete a ~45s — il client molla, il generatore muore e
            # il commit DELETED non viene MAI eseguito. Intanto YAP ha gia'
            # cancellato e il dump/Telegram lo confermano: percio' la pratica
            # spariva da YAP ma restava ACTIVE nel DB -> ricompariva in lista.
            #
            # FIX: marchiamo il DELETED QUI, dentro _run_delete_and_dump, che gira
            # in asyncio.ensure_future e SOPRAVVIVE alla disconnessione del client.
            # Cosi' la cancellazione su Giorgio e' garantita anche a client morto.
            # Il commit nel generatore resta come ridondanza per il caso connesso
            # (idempotente: se e' gia' DELETED non cambia nulla).
            # Non marcare se bloccato da ODL/preventivo non risolto: la pratica NON
            # va eliminata in quei casi.
            # ================================================================
            _mark_deleted = (
                bool(res.get("deleted"))
                or res.get("found") is False
                or _fs_ok in {"not_found", "unknown", None}
            )
            if _mark_deleted and _fs_ok not in {"blocked_by_odl", "blocked_by_preventivo"}:
                try:
                    _p = task_db.query(Practice).filter(Practice.id == captured_pid).first()
                    if _p and _p.status != PracticeStatus.DELETED:
                        _p.status = PracticeStatus.DELETED
                        _p.updated_by_telegram_id = captured_uid
                        task_db.commit()
                        logger.info(
                            "Practice %d soft-deleted in delete task (status=%s, client-independent)",
                            captured_pid, _fs_ok or "deleted",
                        )
                except Exception as _db_exc:
                    task_db.rollback()
                    logger.error(
                        "DB commit DELETED failed in delete task practice %d: %s",
                        captured_pid, _db_exc,
                    )
            return res

        async def _delete_stream():
            import json as _json
            yield b"\n"  # apertura immediata stream — Railway non va in timeout
            gen_db = SessionLocal()
            try:
                delete_task = asyncio.ensure_future(_run_delete_and_dump(gen_db))
                # heartbeat ogni 8s mentre il task gira
                while not delete_task.done():
                    try:
                        await asyncio.wait_for(asyncio.shield(delete_task), timeout=8.0)
                    except asyncio.TimeoutError:
                        yield b"\n"
                result = await delete_task
            except Exception as exc:
                gen_db.close()
                logger.error("YAP delete stream exception practice %d: %s", captured_pid, exc)
                # Il dump e' gia' stato scritto dal task; qui serializziamo solo l'errore
                # strutturato (worker_phases, stderr/stdout, runner) per il banner.
                _detail = getattr(exc, "detail", None)
                _err_payload = _detail if isinstance(_detail, dict) else {"detail": str(exc)}
                yield _json.dumps({"success": False, "data": None, "errors": _err_payload}).encode()
                await asyncio.sleep(1.5)
                return

            failure_status = result.get("deleteAction", {}).get("failureStatus") or result.get("status")

            if not result.get("deleted"):
                gen_db.close()
                # Includi il worker log della delete cosi' il banner mostra il log GIUSTO
                # (non quello dell'ultimo sync) e si capisce dove si e' fermata.
                _wp = result.get("worker_phases")
                if failure_status == "blocked_by_odl":
                    yield _json.dumps({"success": False, "data": None, "errors": {
                        "code": "HTTP_ERROR",
                        "detail": "Impossibile cancellare la pratica: l'appuntamento YAP è collegato a un ordine di lavoro",
                        "failure_status": failure_status,
                        "worker_phases": _wp,
                    }}).encode()
                    await asyncio.sleep(1.5)
                    return
                if failure_status == "blocked_by_preventivo":
                    yield _json.dumps({"success": False, "data": None, "errors": {
                        "code": "HTTP_ERROR",
                        "detail": "Impossibile cancellare la pratica: l'appuntamento YAP è collegato a un preventivo. Elimina prima il preventivo su YAP, poi riprova.",
                        "failure_status": failure_status,
                        "worker_phases": _wp,
                    }}).encode()
                    await asyncio.sleep(1.5)
                    return
                if failure_status in {"not_found", "unknown", None} or result.get("found") is False:
                    # Non trovato su YAP = gia' rimosso; segniamo comunque deleted in Giorgio
                    msg = (
                        "Pratica eliminata. ATTENZIONE: l'appuntamento NON e' stato trovato su YAP "
                        "(forse gia' rimosso, o data/ora/targa non corrispondono): verifica l'agenda YAP."
                    )
                    logger.warning(
                        "Practice %d: YAP delete found no appointment (date=%s search=%s status=%s)",
                        captured_pid, captured_date_iso, captured_search, failure_status,
                    )
                else:
                    yield _json.dumps({"success": False, "data": None, "errors": {
                        "code": "HTTP_ERROR",
                        "detail": "Impossibile cancellare l'appuntamento su YAP",
                    }}).encode()
                    await asyncio.sleep(1.5)
                    return
            else:
                msg = "Pratica e appuntamento YAP eliminati."

            # YAP ha confermato (o non trovato): segna DELETED in Giorgio
            try:
                p = gen_db.query(Practice).filter(Practice.id == captured_pid).first()
                if p:
                    p.status = PracticeStatus.DELETED
                    p.updated_by_telegram_id = captured_uid
                    gen_db.commit()
                    logger.info("Practice %d soft-deleted after YAP confirmed (status=%s)", captured_pid, failure_status or "deleted")
            except Exception as db_exc:
                logger.error("DB commit failed after YAP delete practice %d: %s", captured_pid, db_exc)
            finally:
                gen_db.close()

            # not_found = arrivati al success SENZA deleted: gli unici altri casi
            # (blocked_by_odl/preventivo/errore) hanno gia' fatto return sopra. Quindi
            # qui "non deleted" significa "appuntamento non presente su YAP, gia' rimosso".
            # Esponiamo il flag cosi' il client lo tratta come SUCCESSO PULITO (rimuove la
            # pratica e torna in dashboard) invece che come errore rosso col log.
            _yap_not_found = not bool(result.get("deleted"))
            yield _json.dumps({
                "success": True,
                "data": {"message": msg, "yap": {
                    "deleted": bool(result.get("deleted")),
                    "status": result.get("status"),
                    "not_found": _yap_not_found,
                }},
                "errors": None,
            }).encode()
            # Piccolo delay prima di chiudere lo stream: Railway proxy (Nginx chunked)
            # a volte resetta la connessione TCP prima che il client legga il body
            # finale se lo stream si chiude troppo velocemente dopo l'ultimo chunk.
            await asyncio.sleep(1.5)

        return StreamingResponse(_delete_stream(), media_type="application/json")
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error("Error deleting practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore cancellazione pratica",
        )


# --- Summary Endpoint (N+1 fix) ---

@app.get("/practices/{practice_id}/summary")
@limiter.limit("60/minute")
async def get_practice_summary(
    request: Request,
    practice_id: int,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Generate practice summary for Telegram message. N+1 fixed with dict lookup."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
    ).first()

    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    summary = build_practice_summary(db, practice_id, user_data["id"])
    return APIResponse(success=True, data=summary.dict())



@app.get("/practices/{practice_id}/automation-payload")
@limiter.limit("30/minute")
async def get_automation_payload(
    request: Request,
    practice_id: int,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Export a practice payload ready for the future management automation."""
    practice = _owned_active_practice(db, practice_id, user_data["id"])
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    try:
        from automation_service import AutomationService

        payload = AutomationService.prepare_automation_payload(practice_id, db)
        readiness = AutomationService.validate_automation_readiness(payload)
        return APIResponse(success=True, data={"payload": payload, "readiness": readiness})
    except Exception as e:
        logger.error("Error exporting automation payload for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Errore export automation")


@app.get("/practices/{practice_id}/pre-sync-check")
@limiter.limit("30/minute")
async def pre_sync_check(
    request: Request,
    practice_id: int,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Controllo pre-sync con score/priorita errori per UI."""
    practice = _owned_active_practice(db, practice_id, user_data["id"], for_update=True)
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    try:
        from automation_service import AutomationService

        stamp = _practice_cache_stamp(practice, db)
        cache_key = f"{practice.id}:{stamp}"
        check = _cache_get(YAP_PRECHECK_CACHE, cache_key)
        if check is None:
            payload = AutomationService.prepare_automation_payload(practice_id, db)
            check = AutomationService.pre_sync_check(payload)
            _cache_set(YAP_PRECHECK_CACHE, cache_key, check)
        return APIResponse(success=True, data=check)
    except Exception as e:
        logger.error("Error running pre-sync-check for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Errore pre-sync-check")


@app.get("/practices/pre-sync-check-batch")
@limiter.limit("20/minute")
async def pre_sync_check_batch(
    request: Request,
    ids: str,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Controllo pre-sync batch con cache corta per dashboard."""
    raw_ids = [s.strip() for s in str(ids or "").split(",") if s.strip()]
    parsed_ids: List[int] = []
    for value in raw_ids:
        if value.isdigit():
            parsed_ids.append(int(value))
    parsed_ids = list(dict.fromkeys(parsed_ids))[:200]
    if not parsed_ids:
        return APIResponse(success=True, data={})

    try:
        from automation_service import AutomationService

        practices = db.query(Practice).filter(
            Practice.id.in_(parsed_ids),
            Practice.created_by_telegram_id == user_data["id"],
            Practice.status != PracticeStatus.DELETED,
        ).all()
        by_id = {p.id: p for p in practices}

        # Pre-carica sezioni e ricambi per tutte le pratiche trovate in 2 query
        # invece di 2N query dentro il loop (una per pratica).
        found_ids = list(by_id.keys())
        all_sections = db.query(PracticeSection).filter(PracticeSection.practice_id.in_(found_ids)).all()
        all_parts = db.query(PracticePart).filter(PracticePart.practice_id.in_(found_ids)).all()
        sections_by_practice: Dict[int, list] = {}
        for s in all_sections:
            sections_by_practice.setdefault(s.practice_id, []).append(s)
        parts_by_practice: Dict[int, list] = {}
        for p in all_parts:
            parts_by_practice.setdefault(p.practice_id, []).append(p)

        result: Dict[str, Any] = {}
        for pid in parsed_ids:
            practice = by_id.get(pid)
            if not practice:
                continue
            stamp = _practice_cache_stamp(
                practice, db,
                sections=sections_by_practice.get(practice.id, []),
                parts=parts_by_practice.get(practice.id, []),
            )
            cache_key = f"{practice.id}:{stamp}"
            check = _cache_get(YAP_PRECHECK_CACHE, cache_key)
            if check is None:
                payload = AutomationService.prepare_automation_payload(practice.id, db)
                check = AutomationService.pre_sync_check(payload)
                _cache_set(YAP_PRECHECK_CACHE, cache_key, check)
            result[str(practice.id)] = check
        return APIResponse(success=True, data=result)
    except Exception as e:
        logger.error("Error running pre-sync-check-batch for user %d: %s", user_data["id"], e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Errore pre-sync-check batch")


@app.get("/practices/{practice_id}/management-mapping")
@limiter.limit("30/minute")
async def get_management_mapping(
    request: Request,
    practice_id: int,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Restituisce mapping finale payload -> campi gestionali pronto all'uso."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
        Practice.status != PracticeStatus.DELETED,
    ).first()
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    try:
        from automation_service import AutomationService

        payload = AutomationService.prepare_automation_payload(practice_id, db)
        mapped = AutomationService.map_payload_to_management(payload)
        return APIResponse(success=True, data={"mapping": mapped})
    except Exception as e:
        logger.error("Error building management mapping for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Errore mapping gestionale")


@app.post("/practices/{practice_id}/yap/sync")
@limiter.limit("10/minute")
async def sync_practice_to_yap(
    request: Request,
    practice_id: int,
    body: YapSyncRequest,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
        Practice.status != PracticeStatus.DELETED,
    ).first()
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    _ensure_yap_credentials("sincronizzare con YAP")

    tmp_path = None
    phase_timeline: List[Dict[str, Any]] = []
    phase_started_at = time.perf_counter()

    def close_phase(name: str, status_value: str, message: Optional[str] = None) -> None:
        nonlocal phase_started_at
        now = time.perf_counter()
        phase: Dict[str, Any] = {
            "name": name,
            "status": status_value,
            "duration_ms": int((now - phase_started_at) * 1000),
        }
        if message:
            phase["message"] = message
        phase_timeline.append(phase)
        phase_started_at = now

    try:
        from automation_service import AutomationService

        payload = AutomationService.prepare_automation_payload(practice_id, db)
        check = AutomationService.pre_sync_check(payload)
        if check.get("ready") is False:
            close_phase("precheck", "failed", "Precheck non superato.")
            action_meta = _build_yap_action_from_error("precheck_not_ready")
            return APIResponse(
                success=False,
                data={
                    "status": "not_ready",
                    "status_reason": "precheck_not_ready",
                    "error_code": action_meta["error_code"],
                    "next_action": action_meta["next_action"],
                    "action_target": action_meta["action_target"],
                    "retryable": action_meta["retryable"],
                    "preSync": check,
                    "phase_timeline": phase_timeline,
                    "write_report": None,
                },
            )
        close_phase("precheck", "completed", "Precheck completato.")

        mapped = AutomationService.map_payload_to_management(payload)
        if body.date:
            mapped.setdefault("agenda", {})["data"] = body.date
        if body.time:
            mapped.setdefault("agenda", {})["ora"] = _normalize_slot_time(body.time)
        if body.duration:
            mapped.setdefault("agenda", {})["durata_minuti"] = body.duration

        artifacts = os.path.join(_project_root(), "automation", "artifacts", "yap", "payloads")
        os.makedirs(artifacts, exist_ok=True)
        tmp_path = os.path.join(artifacts, f"practice-{practice_id}-{uuid.uuid4().hex}.json")
        with open(tmp_path, "w", encoding="utf-8") as fh:
            _json.dump({"mapping": mapped}, fh, ensure_ascii=False)

        args = ["--payload-file", tmp_path]
        if not body.dry_run:
            args.append("--commit")
        if body.debug:
            args.append("--debug")
        if body.fresh_login:
            args.append("--fresh-login")

        # Budget hardening: timeout contenuto per evitare attese eccessive lato UI.
        try:
            sync_timeout_s = int(os.getenv("YAP_SYNC_TIMEOUT_S", "210") or "210")
            result = await _run_yap_script("yap-worker.mjs", args, timeout_seconds=sync_timeout_s, db=db)
        except HTTPException as worker_exc:
            detail = worker_exc.detail if isinstance(worker_exc.detail, dict) else {"message": str(worker_exc.detail)}
            runtime_telemetry = _extract_yap_runtime_telemetry(detail)
            # Se l'agenda Ã¨ giÃ  stata scritta su YAP (fase 'save'/'done') ma il worker Ã¨ stato
            # interrotto durante la scrittura ODL (es. timeout a budget esaurito), NON marcare la
            # pratica come fallita: l'appuntamento esiste. Stato 'agenda_synced' + Verifica YAP.
            if _yap_appointment_saved_from_detail(detail):
                close_phase("write", "partial", "Agenda salvata su YAP; ODL interrotto.")
                practice.synced = True
                practice.management_sync_status = "agenda_synced"
                practice.management_last_sync_at = datetime.now(timezone.utc)
                practice.updated_by_telegram_id = user_data["id"]
                db.commit()
                _cache_invalidate_practice(practice.id)
                close_phase("finalize", "completed", "Stato finale persistito.")
                return APIResponse(
                    success=True,
                    data={
                        "status": "agenda_synced",
                        "message": "Appuntamento scritto su YAP. La scrittura ODL si Ã¨ interrotta (timeout): premi Verifica YAP per completare i controlli.",
                        "status_reason": "audit_deferred",
                        "error_code": None,
                        "next_action": "Verifica YAP",
                        "action_target": "audit",
                        "retryable": True,
                        "failed_phase": detail.get("failed_phase"),
                        "debug_ref": detail.get("debug_ref"),
                        "worker_phases": detail.get("worker_phases") or [],
                        "runner": detail.get("runner"),
                        "stderr_tail": detail.get("stderr_tail"),
                        "audit": None,
                        "preSync": check,
                        "phase_timeline": phase_timeline,
                        "telemetry": runtime_telemetry,
                        "write_report": None,
                        "yap": {"ok": False, "partial": True, "error": detail},
                        "practice": {
                            "id": practice.id,
                            "synced": practice.synced,
                            "management_sync_status": practice.management_sync_status,
                            "management_last_sync_at": practice.management_last_sync_at.isoformat() if practice.management_last_sync_at else None,
                            "management_external_id": practice.management_external_id,
                            "management_audit_result": serialize(practice).get("management_audit_result"),
                        },
                    },
                )
            close_phase("write", "failed", "Scrittura YAP non riuscita.")
            action_meta = _build_yap_action_from_error(str(detail.get("reason") or detail.get("message") or ""))
            practice.synced = False
            practice.management_sync_status = "sync_failed"
            practice.management_last_sync_at = datetime.now(timezone.utc)
            practice.updated_by_telegram_id = user_data["id"]
            db.commit()
            _cache_invalidate_practice(practice.id)
            close_phase("finalize", "completed", "Stato finale persistito.")
            return APIResponse(
                success=True,
                data={
                    "status": "sync_failed",
                    "message": str(detail.get("message") or "Sync YAP non riuscita."),
                    "status_reason": str(detail.get("reason") or "worker_failed"),
                    "error_code": detail.get("error_code") or action_meta["error_code"],
                    "next_action": detail.get("next_action") or action_meta["next_action"],
                    "action_target": detail.get("action_target") or action_meta["action_target"],
                    "retryable": bool(detail.get("retryable", action_meta["retryable"])),
                    "failed_phase": detail.get("failed_phase") or action_meta["failed_phase"],
                    "debug_ref": detail.get("debug_ref"),
                    "worker_phases": detail.get("worker_phases") or [],
                    "runner": detail.get("runner"),
                    "stderr_tail": detail.get("stderr_tail"),
                    "audit": None,
                    "preSync": check,
                    "phase_timeline": phase_timeline,
                    "telemetry": runtime_telemetry,
                    "write_report": None,
                    "yap": {
                        "ok": False,
                        "error": detail,
                    },
                    "practice": {
                        "id": practice.id,
                        "synced": practice.synced,
                        "management_sync_status": practice.management_sync_status,
                        "management_last_sync_at": practice.management_last_sync_at.isoformat() if practice.management_last_sync_at else None,
                        "management_external_id": practice.management_external_id,
                        "management_audit_result": serialize(practice).get("management_audit_result"),
                    },
                },
            )
        close_phase("write", "completed", "Scrittura YAP completata.")
        result_data = result.get("result") or {}
        runtime_telemetry = _extract_yap_runtime_telemetry(result)
        write_report = (
            result_data.get("write_report")
            or result_data.get("managementWrite")
            or result.get("write_report")
            or result.get("managementWrite")
        )
        saved = bool(result_data.get("saved"))
        duplicate = result_data.get("mode") == "commit-blocked-duplicate"
        response_status = "dry_run"
        response_message = result_data.get("message") or result.get("message") or "Dry-run YAP completato: nessuna modifica eseguita."
        audit_result = None
        response_worker_phases = result.get("worker_phases") or []
        response_runner = runtime_telemetry.get("runner") if isinstance(runtime_telemetry, dict) else None

        if body.dry_run:
            response_status = "dry_run"
        elif saved or duplicate:
            external_id = result_data.get("externalId") or result_data.get("external_id")
            if external_id:
                practice.management_external_id = str(external_id)
            audit_result = _build_inline_sync_audit_result(result_data, write_report, response_worker_phases)
            if audit_result:
                # Persisti le fasi dettagliate del worker nell'audit, così il "Log worker"
                # resta visibile nel dettaglio anche dopo un reload (non solo a caldo).
                if isinstance(response_worker_phases, list) and response_worker_phases:
                    audit_result["worker_phases"] = response_worker_phases[-200:]
                response_status = _persist_yap_audit_result(db, practice, audit_result, user_data["id"])
                response_message = _audit_message_for_status(response_status, audit_result)
                close_phase("audit", "completed" if response_status == "complete_synced" else "partial", response_message)
                close_phase("finalize", "completed", "Stato finale persistito.")
            else:
                practice.synced = True
                practice.management_sync_status = "duplicate" if duplicate else "agenda_synced"
                practice.management_last_sync_at = datetime.now(timezone.utc)
                practice.updated_by_telegram_id = user_data["id"]
                db.commit()
                _cache_invalidate_practice(practice.id)
                response_status = "duplicate" if duplicate else "agenda_synced"
                response_message = result_data.get("message") or (
                    "Appuntamento già presente in YAP: nessuna modifica necessaria."
                    if duplicate else
                    "Appuntamento scritto su YAP. Verifica automatica non disponibile in questa esecuzione."
                )
                audit_result = None
                close_phase("audit", "skipped", "Audit inline non disponibile nel risultato worker.")
                close_phase("finalize", "completed", "Stato finale persistito.")
        else:
            practice.synced = False
            practice.management_sync_status = "sync_failed"
            practice.management_last_sync_at = datetime.now(timezone.utc)
            practice.updated_by_telegram_id = user_data["id"]
            db.commit()
            _cache_invalidate_practice(practice.id)
            response_status = "sync_failed"
            response_message = result_data.get("message") or result.get("message") or "Sync YAP non riuscita."
            close_phase("audit", "skipped", "Audit saltato: scrittura non confermata.")
            close_phase("finalize", "completed", "Stato finale persistito.")

        status_reason = _audit_reason_for_status(response_status, audit_result or {})
        action_meta = _build_yap_action_from_error(status_reason if response_status == "sync_failed" else response_status)
        response_error_code = None
        response_next_action = None
        response_action_target = None
        response_retryable = response_status in {"partial_synced", "not_ready", "dry_run"}
        if isinstance(audit_result, dict) and audit_result.get("error_code"):
            response_error_code = audit_result.get("error_code")
            response_next_action = audit_result.get("next_action")
            response_action_target = audit_result.get("action_target")
            response_retryable = bool(audit_result.get("retryable", True))
        elif response_status == "sync_failed":
            response_error_code = action_meta["error_code"]
            response_next_action = action_meta["next_action"]
            response_action_target = action_meta["action_target"]
            response_retryable = action_meta["retryable"]
        return APIResponse(
            success=True,
            data={
                "status": response_status,
                "message": response_message,
                "status_reason": status_reason,
                "error_code": response_error_code,
                "next_action": response_next_action,
                "action_target": response_action_target,
                "retryable": response_retryable,
                "audit": audit_result,
                "preSync": check,
                "phase_timeline": phase_timeline,
                "telemetry": runtime_telemetry,
                "write_report": write_report,
                "worker_phases": response_worker_phases,
                "runner": response_runner,
                "yap": result,
                "practice": {
                    "id": practice.id,
                    "synced": practice.synced,
                    "management_sync_status": practice.management_sync_status,
                    "management_last_sync_at": practice.management_last_sync_at.isoformat() if practice.management_last_sync_at else None,
                    "management_external_id": practice.management_external_id,
                    "management_audit_result": audit_result,
                },
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        close_phase("finalize", "failed", "Errore tecnico durante sync.")
        try:
            failed_practice = _owned_active_practice(db, practice_id, user_data["id"], for_update=True)
            if failed_practice:
                failed_practice.management_sync_status = "sync_failed"
                failed_practice.management_last_sync_at = datetime.now(timezone.utc)
                failed_practice.updated_by_telegram_id = user_data["id"]
                db.commit()
                _cache_invalidate_practice(failed_practice.id)
        except Exception:
            db.rollback()
        logger.error("Error syncing practice %d to YAP: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "message": "Errore sync YAP",
                "error": str(e),
                "phase_timeline": phase_timeline,
            },
        )
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@app.post("/practices/{practice_id}/yap/audit")
@limiter.limit("20/minute")
async def audit_practice_yap(
    request: Request,
    practice_id: int,
    body: YapAuditRequest,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    practice = _owned_active_practice(db, practice_id, user_data["id"], for_update=body.persist)
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    _ensure_yap_credentials("verificare l'appuntamento su YAP")

    tmp_path = None
    try:
        from automation_service import AutomationService

        payload = AutomationService.prepare_automation_payload(practice_id, db)
        mapped = AutomationService.map_payload_to_management(payload)
        if body.date:
            mapped.setdefault("agenda", {})["data"] = body.date
        if body.time:
            mapped.setdefault("agenda", {})["ora"] = _normalize_slot_time(body.time)
        if body.duration:
            mapped.setdefault("agenda", {})["durata_minuti"] = body.duration

        artifacts = os.path.join(_project_root(), "automation", "artifacts", "yap", "payloads")
        os.makedirs(artifacts, exist_ok=True)
        tmp_path = os.path.join(artifacts, f"practice-{practice_id}-audit-{uuid.uuid4().hex}.json")
        with open(tmp_path, "w", encoding="utf-8") as fh:
            _json.dump({"mapping": mapped}, fh, ensure_ascii=False)

        args = ["--payload-file", tmp_path]
        if body.debug:
            args.append("--debug")
        if body.fresh_login:
            args.append("--fresh-login")

        audit_timeout_s = int(os.getenv("YAP_AUDIT_TIMEOUT_S", "240") or "240")
        audit_result = await _run_yap_script("yap-audit-appointment.mjs", args, timeout_seconds=audit_timeout_s, db=db)
        runtime_telemetry = _extract_yap_runtime_telemetry(audit_result)
        audit_status = _audit_status_from_result(audit_result)
        if body.persist:
            audit_status = _persist_yap_audit_result(db, practice, audit_result, user_data["id"])
        status_reason = _audit_reason_for_status(audit_status, audit_result or {})
        action_meta = _build_yap_action_from_error(status_reason if audit_status == "sync_failed" else audit_status)

        return APIResponse(
            success=True,
            data={
                "status": audit_status,
                "message": _audit_message_for_status(audit_status, audit_result),
                "status_reason": status_reason,
                "error_code": action_meta["error_code"] if audit_status == "sync_failed" else None,
                "next_action": action_meta["next_action"] if audit_status == "sync_failed" else None,
                "action_target": action_meta["action_target"] if audit_status == "sync_failed" else None,
                "retryable": action_meta["retryable"] if audit_status == "sync_failed" else audit_status in {"partial_synced"},
                "audit": audit_result,
                "telemetry": runtime_telemetry,
                "worker_phases": audit_result.get("worker_phases") or [],
                "runner": runtime_telemetry.get("runner") if isinstance(runtime_telemetry, dict) else None,
                "practice": {
                    "id": practice.id,
                    "synced": practice.synced,
                    "management_sync_status": practice.management_sync_status,
                    "management_last_sync_at": practice.management_last_sync_at.isoformat() if practice.management_last_sync_at else None,
                    "management_external_id": practice.management_external_id,
                    "management_audit_result": audit_result if body.persist else serialize(practice).get("management_audit_result"),
                },
            },
        )
    except HTTPException as exc:
        # La Verifica (audit) che fallisce per timeout/errore transitorio NON deve declassare
        # la pratica: l'appuntamento resta scritto su YAP. Manteniamo lo stato precedente
        # (es. agenda_synced) e registriamo solo l'esito audit come "in attesa".
        if body.persist:
            try:
                exc_detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
                prev_status = practice.management_sync_status or "agenda_synced"
                deferred_audit = {
                    "ok": False,
                    "completed": False,
                    "status": prev_status,
                    "status_reason": "audit_deferred",
                    "message": "Verifica YAP non completata (timeout/errore transitorio). L'appuntamento resta su YAP: riprova la Verifica.",
                    "error": exc_detail,
                }
                practice.management_audit_result = _json.dumps(deferred_audit, ensure_ascii=False)
                practice.management_last_sync_at = datetime.now(timezone.utc)
                practice.updated_by_telegram_id = user_data["id"]
                db.commit()
                _cache_invalidate_practice(practice.id)
                runtime_telemetry = _extract_yap_runtime_telemetry(exc_detail)
                action_meta = _build_yap_action_from_error(str(exc_detail.get("reason") or exc_detail.get("message") or "audit_deferred"))
                return APIResponse(
                    success=True,
                    data={
                        "status": prev_status,
                        "message": deferred_audit["message"],
                        "status_reason": "audit_deferred",
                        "error_code": exc_detail.get("error_code") or action_meta["error_code"],
                        "next_action": "Verifica YAP",
                        "action_target": "audit",
                        "retryable": True,
                        "audit": deferred_audit,
                        "telemetry": runtime_telemetry,
                        "worker_phases": exc_detail.get("worker_phases") or [],
                        "runner": exc_detail.get("runner") or (runtime_telemetry.get("runner") if isinstance(runtime_telemetry, dict) else None),
                        "stderr_tail": exc_detail.get("stderr_tail"),
                        "stdout_tail": exc_detail.get("stdout_tail"),
                        "practice": {
                            "id": practice.id,
                            "synced": practice.synced,
                            "management_sync_status": practice.management_sync_status,
                            "management_last_sync_at": practice.management_last_sync_at.isoformat() if practice.management_last_sync_at else None,
                            "management_external_id": practice.management_external_id,
                            "management_audit_result": deferred_audit,
                        },
                    },
                )
            except Exception:
                db.rollback()
        raise
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


@app.delete("/practices/{practice_id}/yap/appointment")
@limiter.limit("10/minute")
async def delete_practice_yap_appointment(
    request: Request,
    practice_id: int,
    body: YapDeleteAppointmentRequest,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    practice = _owned_active_practice(db, practice_id, user_data["id"], for_update=True)
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    phase_timeline: List[Dict[str, Any]] = []
    phase_started_at = time.perf_counter()
    phase_started_wall = datetime.now(timezone.utc)
    request_started_at = phase_started_wall.isoformat()

    def close_phase(name: str, status_value: str, message: Optional[str] = None) -> None:
        nonlocal phase_started_at, phase_started_wall
        now = time.perf_counter()
        wall_now = datetime.now(timezone.utc)
        phase: Dict[str, Any] = {
            "name": name,
            "status": status_value,
            "started_at": phase_started_wall.isoformat(),
            "finished_at": wall_now.isoformat(),
            "duration_ms": int((now - phase_started_at) * 1000),
        }
        if message:
            phase["message"] = message
        phase_timeline.append(phase)
        phase_started_at = now
        phase_started_wall = wall_now

    if not _practice_needs_yap_delete(practice):
        close_phase("precheck", "completed", "Pratica mai sincronizzata: nessuna delete YAP necessaria.")
        practice.status = PracticeStatus.DELETED
        practice.synced = False
        practice.management_sync_status = "not_needed"
        practice.management_last_sync_at = datetime.now(timezone.utc)
        practice.management_audit_result = None
        practice.updated_by_telegram_id = user_data["id"]
        db.commit()
        _cache_invalidate_practice(practice.id)
        close_phase("finalize", "completed", "Pratica rimossa localmente senza ricerca su YAP.")
        return APIResponse(
            success=True,
            data={
                "status": "not_needed",
                "status_reason": "never_synced",
                "message": "Pratica mai sincronizzata: eliminazione locale immediata.",
                "error_code": None,
                "next_action": None,
                "action_target": None,
                "retryable": False,
                "phase_timeline": phase_timeline,
                "telemetry": {},
                "timing": {
                    "started_at": request_started_at,
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "total_elapsed_ms": sum(int(phase.get("duration_ms") or 0) for phase in phase_timeline),
                },
                "practice": {
                    "id": practice.id,
                    "status": practice.status.value if hasattr(practice.status, "value") else str(practice.status),
                    "synced": False,
                    "management_sync_status": practice.management_sync_status,
                    "management_last_sync_at": practice.management_last_sync_at.isoformat() if practice.management_last_sync_at else None,
                },
                "yap": {
                    "attempted": False,
                    "skipped": True,
                    "reason": "never_synced",
                },
            },
        )

    _ensure_yap_credentials("eliminare l'appuntamento su YAP")

    date_iso = body.date or _practice_date_iso(practice)
    search = _safe_search_arg(body.search or practice.plate_confirmed or practice.plate_detected or practice.customer_name)
    if not date_iso or not search:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Data o testo ricerca YAP mancante")
    close_phase("precheck", "completed", "Parametri eliminazione validati.")

    args = ["--date", str(date_iso), f"--search={search}"]
    time_source = body.time or practice.appointment_time
    if time_source:
        args.extend(["--time", _normalize_slot_time(time_source)])
    if body.dry_run:
        args.append("--dry-run")
    if body.debug:
        args.append("--debug")
    if body.fresh_login:
        args.append("--fresh-login")

    # Pending dump PRIMA dello script: il recovery del client trova subito
    # qualcosa invece di un file inesistente.
    _write_yap_delete_dump({
        "practice_id": practice_id,
        "endpoint": "yap_appointment_delete",
        "args": args,
        "attempted": True,
        "deleted": False,
        "status": "pending",
        "error": "Delete YAP in corso sul server\u2026",
    })

    try:
        result = await _run_yap_script("yap-delete-appointment.mjs", args, timeout_seconds=200, db=db, allow_safe_retry=False)
    except HTTPException as yap_exc:
        # Lo script ha fallito (502 returncode!=0 / 504 timeout): _run_yap_script solleva
        # PRIMA di poter scrivere il dump, quindi senza questo blocco l'ultima delete
        # fallita non lascia NESSUN log consultabile. Persistiamo l'esito di fallimento
        # (worker log + stdout/stderr) cosi' e' copiabile da get_yap_last_delete e dal banner.
        _fail_detail = yap_exc.detail if isinstance(yap_exc.detail, dict) else {"message": str(yap_exc.detail)}
        _write_yap_delete_dump({
            "practice_id": practice_id,
            "endpoint": "yap_appointment_delete",
            "args": args,
            "deleted": False,
            "found": None,
            "status": "delete_failed",
            "error": _fail_detail.get("message"),
            "worker_phases": _fail_detail.get("worker_phases"),
            "stderr_tail": _fail_detail.get("stderr_tail"),
            "stdout_tail": _fail_detail.get("stdout_tail"),
            "runner": _fail_detail.get("runner"),
        })
        # Notifica Telegram: bypassa proxy Railway.
        await _notify_user_delete_result(
            telegram_user_id=user_data["id"],
            practice_id=practice_id,
            deleted=False,
            failure_status="delete_failed",
            worker_phases=_fail_detail.get("worker_phases"),
            error=_fail_detail.get("message"),
        )
        raise
    _write_yap_delete_dump({
        "practice_id": practice_id,
        "endpoint": "yap_appointment_delete",
        "args": args,
        "deleted": bool(result.get("deleted")),
        "found": result.get("found"),
        "status": result.get("status"),
        "deleteAction": result.get("deleteAction"),
        "worker_phases": result.get("worker_phases"),
    })
    # Notifica Telegram: successo o fallimento (ODL/preventivo).
    _fs_std = (result.get("deleteAction") or {}).get("failureStatus") or result.get("status")
    await _notify_user_delete_result(
        telegram_user_id=user_data["id"],
        practice_id=practice_id,
        deleted=bool(result.get("deleted")),
        failure_status=_fs_std,
        worker_phases=result.get("worker_phases"),
        error=str((result.get("deleteAction") or {}).get("message") or result.get("message") or ""),
    )
    runtime_telemetry = _extract_yap_runtime_telemetry(result)
    status_value = result.get("status") or ("deleted" if result.get("deleted") else ("not_found" if result.get("found") is False else "not_deleted"))
    delete_succeeded = bool(result.get("deleted") or status_value == "not_found" or result.get("found") is False)
    close_phase("delete", "completed" if delete_succeeded else "failed", "Delete YAP eseguita.")
    if not body.dry_run and delete_succeeded:
        practice.status = PracticeStatus.DELETED
        practice.synced = False
        practice.management_sync_status = "deleted" if result.get("deleted") else "not_found"
        practice.management_last_sync_at = datetime.now(timezone.utc)
        practice.management_audit_result = None
        practice.updated_by_telegram_id = user_data["id"]
        db.commit()
        _cache_invalidate_practice(practice.id)
    close_phase("finalize", "completed", "Stato pratica aggiornato.")
    status_reason = "already_deleted_on_yap" if status_value == "not_found" else ("deleted_on_yap" if status_value == "deleted" else status_value)
    action_meta = _build_yap_action_from_error(status_reason if status_value in {"delete_failed", "blocked_by_odl"} else "delete_ok")
    return APIResponse(
        success=True,
        data={
            "status": status_value,
            "status_reason": status_reason,
            "error_code": action_meta["error_code"] if status_value in {"delete_failed", "blocked_by_odl"} else None,
            "next_action": action_meta["next_action"] if status_value in {"delete_failed", "blocked_by_odl"} else None,
            "action_target": action_meta["action_target"] if status_value in {"delete_failed", "blocked_by_odl"} else None,
            "retryable": action_meta["retryable"] if status_value in {"delete_failed", "blocked_by_odl"} else False,
            "phase_timeline": phase_timeline,
            "telemetry": runtime_telemetry,
            "timing": {
                "started_at": request_started_at,
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "total_elapsed_ms": sum(int(phase.get("duration_ms") or 0) for phase in phase_timeline),
            },
            "yap": result,
        },
    )


@app.post("/yap/appointment/manual-delete")
@limiter.limit("10/minute")
async def manual_delete_yap_appointment(
    request: Request,
    body: YapManualDeleteRequest,
    _auth: dict = Depends(require_yap_internal_auth),
    db: Session = Depends(get_db),
):
    # Restricted to the YAP worker / internal auth: this endpoint deletes an
    # arbitrary appointment by date+search and is not scoped to a single
    # practice, so it must not be reachable by any whitelisted end user.
    _ensure_yap_credentials("eliminare manualmente l'appuntamento su YAP")

    date_arg = str(body.date or "").strip()
    search_arg = _safe_search_arg(body.search)
    if not date_arg or not search_arg:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Date e search sono obbligatori")

    args = ["--date", date_arg, f"--search={search_arg}"]
    if body.time:
        args.extend(["--time", _normalize_slot_time(body.time)])
    if body.dry_run:
        args.append("--dry-run")
    if body.debug:
        args.append("--debug")
    if body.fresh_login:
        args.append("--fresh-login")

    result = await _run_yap_script("yap-delete-appointment.mjs", args, db=db)
    status_value = result.get("status") or ("deleted" if result.get("deleted") else "not_deleted")
    runtime_telemetry = _extract_yap_runtime_telemetry(result)
    return APIResponse(
        success=bool(result.get("deleted")),
        data={
            "status": status_value,
            "telemetry": runtime_telemetry,
            "yap": result,
        },
    )


@app.get("/practices/{practice_id}/yap-mapping-preview")
@limiter.limit("30/minute")
async def get_yap_mapping_preview(
    request: Request,
    practice_id: int,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Anteprima campi YAP agenda da pratica reale (nessuna scrittura su YAP)."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
        Practice.status != PracticeStatus.DELETED,
    ).first()
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    try:
        from automation_service import AutomationService
        from yap_mapping import build_yap_preview

        stamp = _practice_cache_stamp(practice, db)
        cache_key = f"{practice.id}:{stamp}"
        preview = _cache_get(YAP_PREVIEW_CACHE, cache_key)
        if preview is None:
            payload = AutomationService.prepare_automation_payload(practice_id, db)
            mapped = AutomationService.map_payload_to_management(payload)
            pre_sync = AutomationService.pre_sync_check(payload)
            preview = build_yap_preview(mapped, pre_sync)
            _cache_set(YAP_PREVIEW_CACHE, cache_key, preview)
        return APIResponse(success=True, data=preview)
    except Exception as e:
        logger.error("Error building YAP preview for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Errore anteprima YAP")


@app.post("/yap-mapping-preview/from-form")
@limiter.limit("60/minute")
async def get_yap_mapping_preview_from_form(
    request: Request,
    body: PracticeFullSave,
    user_data: dict = Depends(require_whitelisted_user),
):
    """Anteprima YAP da dati form (senza salvare). Contesti mini-app = fonte di veritÃ ."""
    try:
        from automation_service import AutomationService
        from yap_mapping import build_yap_preview

        _validate_full_payload(body)
        practice_dict = body.practice.model_dump()
        sections_list = [s.model_dump() for s in body.sections]
        parts_list = [p.model_dump() for p in body.parts]

        mapped = AutomationService.map_form_to_management(practice_dict, sections_list, parts_list)
        payload = AutomationService.payload_from_form(practice_dict, sections_list, parts_list)
        pre_sync = AutomationService.pre_sync_check(payload)
        preview = build_yap_preview(mapped, pre_sync)
        return APIResponse(success=True, data=preview)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error building YAP preview from form: %s", e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Errore anteprima YAP da form")


@app.get("/yap/last-crash")
@limiter.limit("30/minute")
async def get_yap_last_crash(
    request: Request,
    _auth: dict = Depends(require_yap_internal_auth),
):
    """Restituisce l'ultimo crash dump del worker YAP (timeout)."""
    _dump_path = os.path.join(_project_root(), "automation", "artifacts", "yap", "crash-dumps", "last-timeout.json")
    if not os.path.exists(_dump_path):
        return APIResponse(success=True, data={"found": False, "message": "Nessun crash dump disponibile."})
    try:
        with open(_dump_path, "r", encoding="utf-8") as _fh:
            dump = _json.load(_fh)
        return APIResponse(success=True, data={"found": True, **dump})
    except Exception as _e:
        raise HTTPException(status_code=500, detail=f"Errore lettura crash dump: {_e}")


@app.get("/yap/last-delete")
@limiter.limit("30/minute")
async def get_yap_last_delete(
    request: Request,
    _auth: dict = Depends(require_yap_internal_auth),
):
    """Restituisce l'esito (worker log incluso) dell'ultima delete YAP."""
    _dump_path = os.path.join(_project_root(), "automation", "artifacts", "yap", "crash-dumps", "last-delete.json")
    if not os.path.exists(_dump_path):
        return APIResponse(success=True, data={"has_dump": False, "message": "Nessuna delete YAP registrata."})
    try:
        with open(_dump_path, "r", encoding="utf-8") as _fh:
            dump = _json.load(_fh)
        # NB: "has_dump" (non "found") per evitare collisione con dump["found"]
        # che il worker imposta a None sui timeout, causando override a null.
        return APIResponse(success=True, data={"has_dump": True, **dump})
    except Exception as _e:
        raise HTTPException(status_code=500, detail=f"Errore lettura delete dump: {_e}")


@app.get("/yap/error-channel-status")
@limiter.limit("30/minute")
async def get_error_channel_status(
    request: Request,
    _auth: dict = Depends(require_yap_internal_auth),
):
    """Verifica lo stato della configurazione del canale errori."""
    from error_notifier import get_error_notifier

    notifier = get_error_notifier()

    is_configured = bool(
        notifier.bot_token and notifier.channel_id
    )

    # Do not leak any portion of the channel id; only booleans are returned.
    return APIResponse(
        success=True,
        data={
            "configured": is_configured,
            "has_bot_token": bool(notifier.bot_token),
            "has_channel_id": bool(notifier.channel_id),
        }
    )


@app.post("/yap/test-error-channel")
@limiter.limit("5/minute")
async def test_error_channel(
    request: Request,
    _auth: dict = Depends(require_yap_internal_auth),
):
    """Invia un messaggio di test al canale errori."""
    from error_notifier import get_error_notifier

    notifier = get_error_notifier()

    if not notifier.bot_token or not notifier.channel_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Canale errori non configurato. Imposta TELEGRAM_ERROR_CHANNEL_ID nel .env",
        )

    result = await notifier.notify_error(
        error_message="ðŸ§ª Questo Ã¨ un messaggio di test dal backend Giorgio",
        context={
            "practice_id": None,
            "worker": "test-endpoint",
        }
    )

    if result:
        return APIResponse(success=True, data={"sent": True, "message": "Messaggio di test inviato al canale"})
    else:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Impossibile inviare messaggio di test. Verifica che il bot sia amministratore del canale.",
        )


@app.post("/yap/notify-error")
@limiter.limit("30/minute")
async def notify_yap_error_endpoint(
    request: Request,
    body: YapErrorNotificationRequest,
    _auth: dict = Depends(require_yap_internal_auth),
):
    """Riceve notifiche errori dai worker YAP e le invia su canale Telegram."""
    try:
        from error_notifier import get_error_notifier

        context = {
            "practice_id": body.practice_id,
            "customer": body.customer,
            "appointment": body.appointment,
            "worker": body.worker,
        }

        notifier = get_error_notifier()
        success = await notifier.notify_error(
            error_message=body.error_message,
            stack_trace=body.stack_trace,
            screenshot_path=body.screenshot_path,
            context=context,
        )

        if success:
            logger.info("Notifica errore YAP inviata su Telegram (practice_id=%s)", body.practice_id)
            return APIResponse(success=True, data={"notified": True})
        else:
            logger.warning("Notifica errore YAP non inviata - canale non configurato")
            return APIResponse(success=True, data={"notified": False, "reason": "channel_not_configured"})
    except Exception as e:
        logger.error("Errore nell'invio notifica YAP: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore invio notifica",
        )


# --- Sections ---

@app.post("/practices/{practice_id}/sections")
@limiter.limit("60/minute")
async def create_section(
    request: Request,
    practice_id: int,
    section_data: dict,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Add a section to a practice."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
    ).first()

    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    try:
        context_value = _context_value(section_data["context"])
        rows = section_data.get("description_rows", [])
        if isinstance(rows, list):
            non_empty = [r for r in rows if isinstance(r, str) and r.strip()]
            # La revisione non richiede righe descrittive (non vanno su YAP).
            if not non_empty and context_value != "revisione":
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Almeno una riga descrittiva Ã¨ obbligatoria per contesto",
                )
            rows_json = _json.dumps(non_empty)
        else:
            rows_json = _json.dumps([str(rows)])

        try:
            Context(context_value)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Contesto non valido: {context_value}",
            )
        section = db.query(PracticeSection).filter(
            PracticeSection.practice_id == practice_id,
            PracticeSection.context == context_value,
        ).first()
        if not section:
            section = PracticeSection(practice_id=practice_id, context=context_value)
            db.add(section)

        section.description_rows = rows_json
        section.man_hours = section_data.get("man_hours")
        section.mac_hours = section_data.get("mac_hours")
        section.materials_amount = section_data.get("materials_amount")
        section.waste_apply = section_data.get("waste_apply")
        section.waste_percentage = section_data.get("waste_percentage")
        section.notes = section_data.get("notes")
        db.commit()
        db.refresh(section)
        logger.info("Section created for practice %d, context=%s", practice_id, section_data.get("context"))

        return APIResponse(success=True, data=serialize(section))

    except HTTPException:
        raise
    except KeyError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Campo obbligatorio mancante: {e}",
        )
    except Exception as e:
        db.rollback()
        logger.error("Error creating section for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore creazione sezione",
        )


# --- Parts ---

@app.post("/practices/{practice_id}/parts")
@limiter.limit("60/minute")
async def create_part(
    request: Request,
    practice_id: int,
    part_data: dict,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Add a part to a practice."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
    ).first()
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    try:
        name = (part_data.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Nome pezzo obbligatorio")
        context_value = part_data.get("context")
        if not context_value:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Campo 'context' obbligatorio")
        context_value = _context_value(context_value)
        try:
            Context(context_value)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Contesto non valido: {context_value}")

        part = PracticePart(
            practice_id=practice_id,
            context=context_value,
            name=name,
            quantity=part_data.get("quantity") or None,
        )
        db.add(part)
        db.commit()
        db.refresh(part)

        return APIResponse(success=True, data=serialize(part))

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error("Error creating part for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore creazione pezzo",
        )


class BulkPartsRequest(BaseModel):
    parts: List[dict]


@app.post("/practices/{practice_id}/parts/bulk")
@limiter.limit("10/minute")
async def bulk_create_parts(
    request: Request,
    practice_id: int,
    body: BulkPartsRequest,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Bulk replace parts for a practice: delete existing and create all new in one transaction."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
    ).first()
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    try:
        # Delete existing parts
        db.query(PracticePart).filter(PracticePart.practice_id == practice_id).delete()

        created_parts = []
        for idx, p in enumerate(body.parts):
            name = (p.get("name") or "").strip()
            if not name:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Part at index {idx}: name is required",
                )
            context_value = p.get("context")
            if not context_value:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Part at index {idx}: context is required",
                )

            part = PracticePart(
                practice_id=practice_id,
                context=context_value,
                name=name,
                quantity=p.get("quantity") or None,
            )
            db.add(part)
            created_parts.append(part)

        db.commit()
        for part in created_parts:
            db.refresh(part)

        logger.info("Bulk created %d parts for practice %d", len(created_parts), practice_id)
        return APIResponse(success=True, data=[serialize(p) for p in created_parts])

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error("Error in bulk parts for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore creazione pezzi in blocco",
        )


@app.delete("/practices/{practice_id}/parts")
@limiter.limit("60/minute")
async def delete_all_parts(
    request: Request,
    practice_id: int,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Delete all parts for a practice."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
    ).first()
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    try:
        db.query(PracticePart).filter(PracticePart.practice_id == practice_id).delete()
        db.commit()
        return APIResponse(success=True, data={"message": "Pezzi eliminati"})
    except Exception as e:
        db.rollback()
        logger.error("Error deleting parts for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Errore eliminazione pezzi",
        )


# --- Pydantic Validation Error Handler ---

@app.exception_handler(PydanticValidationError)
async def pydantic_validation_handler(request: Request, exc: PydanticValidationError):
    """Return structured validation errors."""
    errors = []
    for err in exc.errors():
        field = ".".join(str(loc) for loc in err.get("loc", []))
        errors.append({"field": field, "message": err.get("msg", "Invalid value")})
    return JSONResponse(
        status_code=422,
        content={"detail": "Validation failed", "errors": errors, "code": "VALIDATION_ERROR"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
