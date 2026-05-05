import logging
import os
import json as _json
import asyncio
import traceback
from datetime import datetime, timezone
from enum import Enum
from typing import List, Optional

from fastapi import FastAPI, Depends, HTTPException, Request, status, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError as PydanticValidationError
from sqlalchemy.orm import Session
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from config import settings, DEBUG, ALLOWED_ORIGINS
from aiogram import Bot
from aiogram.types import InlineKeyboardMarkup
from aiogram.enums import ParseMode
from database_sqlite import (
    get_db, Practice, PracticePhoto, PracticeSection, PracticePart,
)
from models import (
    PracticeStatus, PracticeType, CustomerType, Context,
    Practice as PracticeModel,
    PracticeCreate,
    PracticeUpdate,
    PracticeSummary,
    APIResponse,
    TelegramMiniAppData,
    ValidationError,
)
from security import SecurityService
from ocr_service import OCRService

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

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
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
        else:
            result[k] = v
    return result


# --- Authentication ---

def validate_telegram_init_data(
    init_data: str = None,
    x_telegram_init_data: str = Header(None, alias="X-Telegram-Init-Data"),
):
    """Extract Telegram user from initData.

    In production (DEBUG=False), if HMAC validation fails, return 401.
    In debug mode, fall back to a test user.
    """
    raw_init_data = x_telegram_init_data or init_data

    try:
        if raw_init_data:
            user = SecurityService.extract_user_from_init_data(raw_init_data)
            if user and user.get("id") is not None:
                try:
                    user_id = int(user["id"])
                except (TypeError, ValueError):
                    user_id = None
                if user_id is not None:
                    logger.debug("Authenticated Telegram user %d", user_id)
                    return {
                        "id": user_id,
                        "first_name": user.get("first_name", "") or "",
                        "last_name": user.get("last_name", "") or "",
                        "username": user.get("username", "") or "",
                    }
    except Exception as e:
        logger.warning("Failed to extract user from initData: %s", e)

    # In production, reject unauthenticated requests
    if not DEBUG:
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
    whitelist = getattr(settings, "whitelist_telegram_ids", None) or []
    if not whitelist:
        logger.warning("Telegram whitelist is empty — all users allowed")
        return user_data
    uid = user_data.get("id")
    if DEBUG and uid == 123456789:
        return user_data
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
    """Health check endpoint — no auth required."""
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/")
async def root():
    """Root health check."""
    return {"status": "ok", "service": "giorgio-api"}


@app.get("/test-connection")
async def test_connection():
    """Test endpoint for Vercel connection check."""
    return {"status": "ok", "message": "Connection successful", "timestamp": datetime.now(timezone.utc).isoformat()}


# --- Practice Endpoints ---

@app.get("/mini-app/data")
@limiter.limit("60/minute")
async def get_mini_app_data(
    request: Request,
    practice_id: Optional[int] = None,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Return data for the Telegram Mini App."""
    if practice_id:
        practice = db.query(Practice).filter(
            Practice.id == practice_id,
            Practice.created_by_telegram_id == user_data["id"],
        ).first()

        if not practice:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

        photos = db.query(PracticePhoto).filter(PracticePhoto.practice_id == practice_id).all()
        sections = db.query(PracticeSection).filter(PracticeSection.practice_id == practice_id).all()
        parts = db.query(PracticePart).filter(PracticePart.practice_id == practice_id).all()

        return APIResponse(
            success=True,
            data={
                "practice": serialize(practice),
                "photos": [serialize(p) for p in photos],
                "sections": [serialize(s) for s in sections],
                "parts": [serialize(p) for p in parts],
            },
        )
    else:
        return APIResponse(success=True, data={"user": user_data})


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

    if practice_data.appointment_time[3:] not in ["00", "30"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="L'ora deve avere minuti 00 o 30 (slot da 30 minuti)",
        )

    try:
        contexts_csv = ",".join([
            c.value if hasattr(c, "value") else str(c) for c in practice_data.contexts
        ])

        practice = Practice(
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

        db.add(practice)
        db.commit()
        db.refresh(practice)

        logger.info("Practice %d created by user %d", practice.id, user_data["id"])

        # Fire-and-forget Telegram notification
        _send_practice_telegram_notification(practice, user_data)

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


def _send_practice_telegram_notification(practice, user_data: dict):
    """Fire-and-forget Telegram summary. Errors are logged, never propagated."""
    try:
        from telegram_utils import TelegramFormatter

        summary_data = {
            "practice_id": practice.id,
            "plate": practice.plate_confirmed,
            "phone": practice.phone,
            "appointment": f"{practice.appointment_date.strftime('%d/%m/%Y')} {practice.appointment_time}",
            "practice_type": practice.practice_type.value,
            "contexts": [c.value for c in practice.contexts_list],
            "sections_summary": {},
            "billing_warning": "⚠ Dati fatturazione da completare" if practice.billing_to_complete else None,
            "internal_notes": practice.internal_notes,
        }

        summary = PracticeSummary(**summary_data)
        message_text = TelegramFormatter.format_practice_summary(summary)
        keyboard = TelegramFormatter.create_practice_keyboard(practice.id)

        async def _send():
            try:
                bot_instance = Bot(token=settings.telegram_bot_token)
                await bot_instance.send_message(
                    chat_id=user_data["id"],
                    text=message_text,
                    reply_markup=InlineKeyboardMarkup(**keyboard),
                    parse_mode=ParseMode.HTML,
                )
                logger.info("Telegram summary sent for practice %d", practice.id)
            except Exception as e:
                logger.error("Failed to send Telegram summary for practice %d: %s", practice.id, e)

        asyncio.create_task(_send())
    except Exception as e:
        logger.error("Failed to prepare Telegram notification for practice %d: %s", practice.id, e)


@app.put("/practices/{practice_id}")
@limiter.limit("60/minute")
async def update_practice(
    request: Request,
    practice_id: int,
    practice_data: PracticeUpdate,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Update an existing practice."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
    ).first()

    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

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
            if practice.appointment_time[3:] not in ["00", "30"]:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="L'ora deve avere minuti 00 o 30 (slot da 30 minuti)",
                )

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
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db),
):
    """Soft-delete a practice."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data["id"],
    ).first()

    if not practice:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pratica non trovata")

    try:
        practice.status = PracticeStatus.DELETED
        practice.updated_by_telegram_id = user_data["id"]
        db.commit()
        logger.info("Practice %d soft-deleted by user %d", practice_id, user_data["id"])
        return APIResponse(success=True, data={"message": "Pratica cancellata con successo"})
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

    sections = db.query(PracticeSection).filter(PracticeSection.practice_id == practice_id).all()
    parts = db.query(PracticePart).filter(PracticePart.practice_id == practice_id).all()

    # Build parts lookup dict keyed by context value (N+1 fix)
    parts_by_context: dict = {}
    for part in parts:
        ctx_val = part.context.value if isinstance(part.context, Enum) else str(part.context)
        parts_by_context.setdefault(ctx_val, []).append(part)

    sections_summary = {}
    for section in sections:
        ctx_val = section.context.value if isinstance(section.context, Enum) else str(section.context)
        section_parts = parts_by_context.get(ctx_val, [])
        sections_summary[ctx_val] = {
            "description_rows": section.description_rows,
            "man_hours": section.man_hours,
            "mac_hours": section.mac_hours,
            "materials_amount": section.materials_amount,
            "waste_apply": section.waste_apply,
            "waste_percentage": section.waste_percentage,
            "parts": [
                p.name + (f" ({p.quantity})" if p.quantity else "")
                for p in section_parts
            ],
        }

    billing_warning = None
    if practice.customer_type == CustomerType.AZIENDA and practice.billing_to_complete:
        billing_warning = "⚠ Dati fatturazione da completare"

    summary = PracticeSummary(
        practice_id=practice.id,
        plate=practice.plate_confirmed,
        phone=practice.phone,
        appointment=f"{practice.appointment_date.strftime('%d/%m/%Y')} {practice.appointment_time}",
        practice_type=practice.practice_type.value,
        contexts=[c.value for c in practice.contexts_list],
        sections_summary=sections_summary,
        billing_warning=billing_warning,
        internal_notes=practice.internal_notes,
    )

    return APIResponse(success=True, data=summary.dict())


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

        section = PracticeSection(
            practice_id=practice_id,
            context=section_data["context"],
            description_rows=rows_json,
            man_hours=section_data.get("man_hours"),
            mac_hours=section_data.get("mac_hours"),
            materials_amount=section_data.get("materials_amount"),
            waste_apply=section_data.get("waste_apply"),
            waste_percentage=section_data.get("waste_percentage"),
        )

        db.add(section)
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
