import logging
import os
import uuid
import shutil
import shutil as _shutil
import json as _json
import asyncio
import traceback
from datetime import datetime, timezone, date
from enum import Enum
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Depends, HTTPException, Request, status, Header, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError as PydanticValidationError
from sqlalchemy.orm import Session
from sqlalchemy import or_, func, extract

try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
except ModuleNotFoundError:  # pragma: no cover - fallback for dev/test environments without slowapi
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

logger = logging.getLogger(__name__)

# Create storage directory
os.makedirs("storage/photos", exist_ok=True)

# --- Rate Limiter ---
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="Giorgio API",
    description="API per il sistema di inserimento pratiche meccanico",
    version="2.0.0",
)
app.state.limiter = limiter


def _initialize_database() -> None:
    try:
        create_tables()
        logger.info("Database initialization completed")
    except Exception as exc:
        logger.exception("Database initialization failed: %s", exc)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(asyncio.to_thread(_initialize_database))

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=LOCAL_DEV_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
    Includes the synced field for Practice objects.
    """
    result = {}
    for k, v in obj.__dict__.items():
        if k.startswith("_"):
            continue
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
        "preview": f"{raw[:80]}..." if len(raw) > 80 else raw,
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


def _can_access_draft_via_plate_compat(practice: Practice, plate_confirmed: Optional[str]) -> bool:
    if practice.status != PracticeStatus.DRAFT:
        return False
    if not plate_confirmed or not practice.plate_confirmed:
        return False
    return practice.plate_confirmed.strip().upper() == plate_confirmed.strip().upper()


def _repair_practice_owner_via_plate_compat(db: Session, practice: Practice, user_data: dict) -> None:
    previous_owner = practice.created_by_telegram_id
    practice.created_by_telegram_id = user_data["id"]
    practice.updated_by_telegram_id = user_data["id"]
    db.commit()
    db.refresh(practice)
    logger.warning(
        "Practice owner repaired via draft+plate compatibility for practice %d: %s -> %s",
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
):
    """Extract Telegram user from initData.

    In production (DEBUG=False), if HMAC validation fails, return 401.
    In debug mode, fall back to a test user.
    """
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

    # Fallback for Telegram clients/entry points where initData can be empty.
    # We only accept a numeric user_id and the request remains subject to whitelist checks.
    fallback_uid = None
    if x_telegram_user_id and str(x_telegram_user_id).strip().lstrip("-").isdigit():
        fallback_uid = int(str(x_telegram_user_id).strip())
    elif user_id is not None:
        fallback_uid = int(user_id)

    if fallback_uid is not None:
        _log_auth_debug("fallback_user_id_ok", {**auth_snapshot, "resolved_user_id": fallback_uid}, level="info")
        logger.warning("Auth fallback used without initData for Telegram user %s", fallback_uid)
        return {
            "id": fallback_uid,
            "first_name": "",
            "last_name": "",
            "username": "",
        }

    # In production, reject unauthenticated requests
    if not DEBUG:
        _log_auth_debug("auth_missing", auth_snapshot)
        logger.warning("Auth failed: no valid initData and DEBUG=False")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    # Dev fallback
    logger.debug("Using dev fallback user (DEBUG mode)")
    return {"id": 123456789, "first_name": "User", "last_name": "Test", "username": "dev_test"}


def require_whitelisted_user(
    user_data: dict = Depends(validate_telegram_init_data),
) -> dict:
    """Enforce Telegram whitelist.

    If whitelist is empty (dev/test), allow all users through with a warning.
    """
    if DEBUG:
        return user_data

    whitelist = getattr(settings, "whitelist_telegram_ids", None) or []
    if not whitelist:
        logger.warning("Telegram whitelist is empty - all users allowed")
        return user_data
    uid = user_data.get("id")
    if uid not in whitelist:
        logger.warning("User %s not in whitelist, access denied", uid)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Utente non autorizzato",
        )
    return user_data


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
    search: Optional[str] = None
    dry_run: bool = False
    debug: bool = False
    fresh_login: bool = False


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


def _clean_section_rows(rows: List[str]) -> List[str]:
    cleaned = [row.strip() for row in rows if isinstance(row, str) and row.strip()]
    if not cleaned:
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
        _clean_section_rows(section.description_rows)
        if section.man_hours is not None and section.man_hours < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="MAN deve essere >= 0")
        if section.mac_hours is not None and section.mac_hours < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="MAC deve essere >= 0")
        if section.waste_percentage is not None and not 0 <= section.waste_percentage <= 100:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Smaltimento deve essere tra 0 e 100")
        sections_by_context[ctx] = section

    missing = selected_contexts - set(sections_by_context)
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
        db.add(PracticeSection(
            practice_id=practice_id,
            context=clean.context,
            description_rows=_json.dumps(_clean_section_rows(clean.description_rows)),
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

    total = db.query(func.count(Practice.id)).filter(
        Practice.created_by_telegram_id == telegram_id,
        Practice.status != PracticeStatus.DELETED,
    ).scalar() or 0

    now = datetime.utcnow()
    first_of_month = datetime(now.year, now.month, 1)
    this_month = db.query(func.count(Practice.id)).filter(
        Practice.created_by_telegram_id == telegram_id,
        Practice.status != PracticeStatus.DELETED,
        Practice.created_at >= first_of_month,
    ).scalar() or 0

    pending_sync = db.query(func.count(Practice.id)).filter(
        Practice.created_by_telegram_id == telegram_id,
        Practice.status != PracticeStatus.DELETED,
        Practice.synced == False,
    ).scalar() or 0

    logger.info("Stats retrieved for user %d: total=%d, this_month=%d, pending_sync=%d",
                telegram_id, total, this_month, pending_sync)

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

    practices = query.with_entities(
        Practice.id,
        Practice.plate_confirmed,
        Practice.customer_name,
        Practice.created_at,
        Practice.contexts,
        Practice.synced,
    ).all()

    results = []
    for p in practices:
        results.append({
            "id": p.id,
            "plate": p.plate_confirmed,
            "customer_name": p.customer_name,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "contexts": [c.strip() for c in p.contexts.split(",") if c.strip()] if isinstance(p.contexts, str) else p.contexts,
            "synced": p.synced,
        })

    logger.info("Listed %d practices for user %d", len(results), telegram_id)
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
    practice = db.query(Practice).filter(Practice.id == practice_id).first()

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


def _project_root() -> str:
    # In container/runtime the backend code lives under /app.
    # Using dirname(__file__) keeps all derived paths writable and stable.
    root = os.path.abspath(os.path.dirname(__file__))
    # Fallback per sviluppo locale se 'automation' non è nella stessa cartella ma è nel parent
    if not os.path.exists(os.path.join(root, "automation")) and os.path.exists(os.path.join(os.path.dirname(root), "automation")):
        return os.path.dirname(root)
    return root


def _practice_date_iso(practice: Practice) -> str:
    value = practice.appointment_date
    if hasattr(value, "date"):
        return value.date().isoformat()
    return str(value or "")[:10]


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


def _extract_json_blob(text: str) -> Optional[dict]:
    if not text:
        return None
    raw = text.strip()
    if not raw:
        return None
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
    return detail


async def _run_yap_script(script_name: str, args: List[str], timeout_seconds: int = 180, db: Optional[Session] = None) -> Dict[str, Any]:
    root = _project_root()
    script_path = os.path.join(root, "automation", "yap", script_name)

    # Gestione Session State da Database
    session_file_path = os.path.join(root, "automation", "artifacts", "yap", "session-state.json")
    if db:
        try:
            setting = db.query(SystemSetting).filter(SystemSetting.key == "yap_session_state").first()
            if setting and setting.value:
                os.makedirs(os.path.dirname(session_file_path), exist_ok=True)
                with open(session_file_path, "w", encoding="utf-8") as f:
                    f.write(setting.value)
                logger.info("Session state YAP ripristinato dal database")
        except Exception as e:
            logger.warning("Impossibile ripristinare la sessione YAP dal database: %s", e)

    node_bin = os.getenv("NODE_BINARY") or (_shutil.which("node") or _shutil.which("nodejs") or "node")
    process = await asyncio.create_subprocess_exec(
        node_bin,
        script_path,
        *args,
        cwd=root,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=os.environ.copy(),
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        process.kill()
        await process.communicate()
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Timeout automazione YAP")

    out = stdout.decode("utf-8", errors="replace").strip()
    err = stderr.decode("utf-8", errors="replace").strip()

    # Salva Session State nel Database dopo l'esecuzione, anche in caso di fallimento
    if db and os.path.exists(session_file_path):
        try:
            with open(session_file_path, "r", encoding="utf-8") as f:
                session_data = f.read()
            if session_data.strip():
                setting = db.query(SystemSetting).filter(SystemSetting.key == "yap_session_state").first()
                if not setting:
                    setting = SystemSetting(key="yap_session_state", value=session_data)
                    db.add(setting)
                else:
                    setting.value = session_data
                db.commit()
                logger.info("Session state YAP salvato nel database")
        except Exception as e:
            db.rollback()
            logger.warning("Impossibile salvare la sessione YAP nel database: %s", e)

    if process.returncode != 0:
        failure_detail = _build_yap_failure_detail(out, err)
        logger.error(
            "YAP script failed (%s): %s",
            script_name,
            failure_detail.get("message"),
            extra={
                "stdout_tail": out[-3000:],
                "stderr_tail": err[-3000:],
            },
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=failure_detail,
        )

    start = out.find("{")
    end = out.rfind("}")
    if start >= 0 and end >= start:
        try:
            return _json.loads(out[start:end + 1])
        except Exception:
            pass
    return {"ok": True, "raw": out}


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
    practice = db.query(Practice).filter(Practice.id == practice_id).first()

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
    practice = db.query(Practice).filter(Practice.id == practice_id).first()
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
    ext = file.filename.rsplit(".", 1)[-1] if file.filename and "." in file.filename else "jpg"
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
    practice = db.query(Practice).filter(Practice.id == practice_id).first()
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
        practice = db.query(Practice).filter(Practice.id == practice_id).first()

        if not practice:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

        if _can_access_practice(practice, user_data, access_token):
            _repair_practice_owner_if_needed(db, practice, user_data, access_token)
        elif _can_access_draft_via_plate_compat(practice, plate_confirmed):
            _repair_practice_owner_via_plate_compat(db, practice, user_data)
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
    practice = db.query(Practice).filter(Practice.id == practice_id).first()
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
            detail="Almeno un contesto è obbligatorio",
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
    practice = db.query(Practice).filter(Practice.id == practice_id).first()

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
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Soft-delete a practice."""
    practice = db.query(Practice).filter(Practice.id == practice_id).first()

    if not practice or not _can_access_practice(practice, user_data, access_token):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    _repair_practice_owner_if_needed(db, practice, user_data, access_token)

    try:
        _ensure_yap_credentials("eliminare l'appuntamento su YAP")
        date_iso = _practice_date_iso(practice)
        search = practice.plate_confirmed or practice.customer_name
        if date_iso and search:
            result = await _run_yap_script(
                "yap-delete-appointment.mjs",
                ["--date", date_iso, "--search", str(search)],
                db=db,
            )
            if result.get("found") and not result.get("deleted"):
                failure_status = result.get("deleteAction", {}).get("failureStatus") or result.get("status")
                if failure_status == "blocked_by_odl":
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Impossibile cancellare la pratica: l'appuntamento YAP è collegato a un ordine di lavoro",
                    )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="Impossibile cancellare l'appuntamento su YAP",
                )

        practice.status = PracticeStatus.DELETED
        practice.updated_by_telegram_id = user_data["id"]
        db.commit()
        logger.info("Practice %d soft-deleted by user %d", practice_id, user_data["id"])
        return APIResponse(success=True, data={"message": "Pratica cancellata con successo"})
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
        check = AutomationService.pre_sync_check(payload)
        return APIResponse(success=True, data=check)
    except Exception as e:
        logger.error("Error running pre-sync-check for practice %d: %s", practice_id, e, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Errore pre-sync-check")


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
    try:
        from automation_service import AutomationService

        payload = AutomationService.prepare_automation_payload(practice_id, db)
        check = AutomationService.pre_sync_check(payload)
        if check.get("ready") is False:
            return APIResponse(success=False, data={"status": "not_ready", "preSync": check})

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

        result = await _run_yap_script("yap-worker.mjs", args, timeout_seconds=420, db=db)
        result_data = result.get("result") or {}
        saved = bool(result_data.get("saved"))
        duplicate = result_data.get("mode") == "commit-blocked-duplicate"
        response_status = "synced" if saved else ("duplicate" if duplicate else "dry_run")

        if not body.dry_run and (saved or duplicate):
            practice.synced = True
            practice.management_sync_status = "synced"
            practice.management_last_sync_at = datetime.now(timezone.utc)
            practice.updated_by_telegram_id = user_data["id"]
            external_id = result_data.get("externalId") or result_data.get("external_id")
            if external_id:
                practice.management_external_id = str(external_id)
            db.commit()

        return APIResponse(
            success=True,
            data={
                "status": response_status,
                "preSync": check,
                "yap": result,
                "practice": {
                    "id": practice.id,
                    "synced": practice.synced,
                    "management_sync_status": practice.management_sync_status,
                    "management_last_sync_at": practice.management_last_sync_at.isoformat() if practice.management_last_sync_at else None,
                    "management_external_id": practice.management_external_id,
                },
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        try:
            failed_practice = db.query(Practice).filter(
                Practice.id == practice_id,
                Practice.created_by_telegram_id == user_data["id"],
                Practice.status != PracticeStatus.DELETED,
            ).first()
            if failed_practice:
                failed_practice.management_sync_status = "sync_failed"
                failed_practice.management_last_sync_at = datetime.now(timezone.utc)
                failed_practice.updated_by_telegram_id = user_data["id"]
                db.commit()
        except Exception:
            db.rollback()
        logger.error("Error syncing practice %d to YAP: %s", practice_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "message": "Errore sync YAP",
                "error": str(e),
            },
        )
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
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
        Practice.status != PracticeStatus.DELETED,
    ).first()
    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")
    _ensure_yap_credentials("eliminare l'appuntamento su YAP")

    date_iso = body.date or _practice_date_iso(practice)
    search = body.search or practice.plate_confirmed or practice.customer_name
    if not date_iso or not search:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Data o testo ricerca YAP mancante")

    args = ["--date", date_iso, "--search", str(search)]
    if body.dry_run:
        args.append("--dry-run")
    if body.debug:
        args.append("--debug")
    if body.fresh_login:
        args.append("--fresh-login")

    result = await _run_yap_script("yap-delete-appointment.mjs", args, db=db)
    if not body.dry_run and result.get("deleted"):
        practice.synced = False
        practice.management_sync_status = "deleted"
        practice.management_last_sync_at = datetime.now(timezone.utc)
        practice.updated_by_telegram_id = user_data["id"]
        db.commit()
    return APIResponse(
        success=True,
        data={
            "status": result.get("status") or ("deleted" if result.get("deleted") else "not_deleted"),
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

        payload = AutomationService.prepare_automation_payload(practice_id, db)
        mapped = AutomationService.map_payload_to_management(payload)
        pre_sync = AutomationService.pre_sync_check(payload)
        preview = build_yap_preview(mapped, pre_sync)
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
    """Anteprima YAP da dati form (senza salvare). Contesti mini-app = fonte di verità."""
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


@app.get("/yap/error-channel-status")
@limiter.limit("30/minute")
async def get_error_channel_status(request: Request):
    """Verifica lo stato della configurazione del canale errori."""
    from error_notifier import get_error_notifier

    notifier = get_error_notifier()

    is_configured = bool(
        notifier.bot_token and notifier.channel_id
    )

    return APIResponse(
        success=True,
        data={
            "configured": is_configured,
            "has_bot_token": bool(notifier.bot_token),
            "has_channel_id": bool(notifier.channel_id),
            "channel_id_preview": notifier.channel_id[:15] + "..." if notifier.channel_id and len(notifier.channel_id) > 15 else notifier.channel_id,
        }
    )


@app.post("/yap/test-error-channel")
@limiter.limit("5/minute")
async def test_error_channel(request: Request):
    """Invia un messaggio di test al canale errori."""
    from error_notifier import get_error_notifier

    notifier = get_error_notifier()

    if not notifier.bot_token or not notifier.channel_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Canale errori non configurato. Imposta TELEGRAM_ERROR_CHANNEL_ID nel .env",
        )

    result = await notifier.notify_error(
        error_message="🧪 Questo è un messaggio di test dal backend Giorgio",
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
        rows = section_data.get("description_rows", [])
        if isinstance(rows, list):
            non_empty = [r for r in rows if isinstance(r, str) and r.strip()]
            if not non_empty:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Almeno una riga descrittiva è obbligatoria per contesto",
                )
            rows_json = _json.dumps(non_empty)
        else:
            rows_json = _json.dumps([str(rows)])

        context_value = section_data["context"]
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

