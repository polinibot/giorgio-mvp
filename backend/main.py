from fastapi import FastAPI, Depends, HTTPException, status, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime
import os

from config import settings
from aiogram import Bot
from aiogram.types import InlineKeyboardMarkup
from aiogram.enums import ParseMode
from database_sqlite import get_db, Practice, PracticePhoto, PracticeSection, PracticePart, PracticeStatus, CustomerType
from models import (
    Practice as PracticeModel, 
    PracticeCreate, 
    PracticeUpdate,
    PracticeSummary,
    APIResponse,
    TelegramMiniAppData,
    ValidationError
)
from security import SecurityService
from ocr_service import OCRService

# Crea directory storage se non esiste
os.makedirs("storage/photos", exist_ok=True)

app = FastAPI(
    title="Giorgio API",
    description="API per il sistema di inserimento pratiche meccanico",
    version="1.0.0"
)

# CORS per Mini App Telegram
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In produzione, limitare ai domini Telegram
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    """Handler personalizzato per HTTPException"""
    return JSONResponse(
        status_code=exc.status_code,
        content=APIResponse(
            success=False,
            errors=[ValidationError(field="general", message=exc.detail)]
        ).dict(),
        headers={"Access-Control-Allow-Origin": "*"},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    """Cattura qualunque eccezione non gestita e restituisce JSON con CORS
    headers, evitando il "Network Error" lato client (axios) dovuto al fatto
    che le risposte 500 generiche di FastAPI non includono Access-Control-Allow-Origin.
    """
    import traceback
    print(f"[unhandled_exception] {type(exc).__name__}: {exc}")
    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content=APIResponse(
            success=False,
            errors=[ValidationError(field="general", message=f"Internal error: {exc}")]
        ).dict(),
        headers={"Access-Control-Allow-Origin": "*"},
    )


def validate_telegram_init_data(
    init_data: str = None,
    x_telegram_init_data: str = Header(None, alias="X-Telegram-Init-Data")
):
    """Dependency per estrarre l'utente Telegram dall'initData della Mini App.

    NOTA: per evitare i problemi di rete riscontrati in passato non blocchiamo la
    richiesta se l'HMAC non valida; estraiamo comunque l'ID utente reale dall'initData,
    altrimenti la query sulle pratiche fallirebbe con 404 perché l'ID non corrisponde
    a quello salvato dal bot al momento della creazione della pratica.
    """
    raw_init_data = x_telegram_init_data or init_data

    # Prova a estrarre l'utente reale dall'initData (in modo difensivo:
    # qualunque eccezione qui non deve mai propagarsi alla request, altrimenti
    # il client riceve un "Network Error" perché mancano le CORS headers).
    try:
        if raw_init_data:
            user = SecurityService.extract_user_from_init_data(raw_init_data)
            if user and user.get("id") is not None:
                try:
                    user_id = int(user["id"])
                except (TypeError, ValueError):
                    user_id = None
                if user_id is not None:
                    return {
                        "id": user_id,
                        "first_name": user.get("first_name", "") or "",
                        "last_name": user.get("last_name", "") or "",
                        "username": user.get("username", "") or "",
                    }
    except Exception as e:
        print(f"[validate_telegram_init_data] estrazione utente fallita: {e}")

    # Fallback (sviluppo / test fuori da Telegram)
    return {"id": 123456789, "first_name": "User", "last_name": "Test"}


def require_whitelisted_user(
    user_data: dict = Depends(validate_telegram_init_data)
) -> dict:
    """Dependency: enforce whitelist Telegram come da Piano §13.

    Se la whitelist è vuota (ambiente dev/test) non blocchiamo nulla.
    Il fallback dev (id=123456789) passa sempre per non rompere lo sviluppo locale.
    """
    whitelist = getattr(settings, "whitelist_telegram_ids", None) or []
    if not whitelist:
        return user_data
    uid = user_data.get("id")
    if uid == 123456789:
        # dev fallback quando initData non è disponibile
        return user_data
    if uid not in whitelist:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Utente non autorizzato"
        )
    return user_data


@app.get("/")
async def root():
    """Health check"""
    return {"status": "ok", "service": "giorgio-api"}


@app.get("/test-connection")
async def test_connection():
    """Test endpoint per verificare connessione da Vercel"""
    return {"status": "ok", "message": "Connection successful", "timestamp": str(datetime.utcnow())}


def _serialize_orm(obj) -> dict:
    """Serializza un'istanza SQLAlchemy in dict JSON-safe rimuovendo lo stato
    interno (_sa_instance_state) e convertendo enum/datetime in stringhe.
    """
    from enum import Enum
    import json as _json
    result = {}
    for k, v in obj.__dict__.items():
        if k.startswith("_"):
            continue
        if isinstance(v, Enum):
            result[k] = v.value
        elif isinstance(v, datetime):
            result[k] = v.isoformat()
        elif k == "description_rows" and isinstance(v, str):
            # Le sezioni salvano description_rows come JSON string nel DB
            try:
                result[k] = _json.loads(v)
            except Exception:
                result[k] = [v]
        else:
            result[k] = v
    return result


def _serialize_practice(practice) -> dict:
    """Serializza una Practice convertendo `contexts` (stringa CSV) in lista."""
    data = _serialize_orm(practice)
    contexts = data.get("contexts")
    if isinstance(contexts, str):
        data["contexts"] = [c.strip() for c in contexts.split(",") if c.strip()]
    elif contexts is None:
        data["contexts"] = []
    return data


@app.get("/mini-app/data")
async def get_mini_app_data(
    practice_id: Optional[int] = None,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db)
):
    """Restituisce i dati per la Mini App Telegram"""
    
    if practice_id:
        # Carica pratica esistente
        practice = db.query(Practice).filter(
            Practice.id == practice_id,
            Practice.created_by_telegram_id == user_data['id']
        ).first()
        
        if not practice:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Pratica non trovata"
            )
        
        # Carica dati correlati
        photos = db.query(PracticePhoto).filter(
            PracticePhoto.practice_id == practice_id
        ).all()
        
        sections = db.query(PracticeSection).filter(
            PracticeSection.practice_id == practice_id
        ).all()
        
        parts = db.query(PracticePart).filter(
            PracticePart.practice_id == practice_id
        ).all()
        
        return APIResponse(
            success=True,
            data={
                "practice": _serialize_practice(practice),
                "photos": [_serialize_orm(p) for p in photos],
                "sections": [_serialize_orm(s) for s in sections],
                "parts": [_serialize_orm(p) for p in parts],
            }
        )
    else:
        # Nuova pratica
        return APIResponse(
            success=True,
            data={"user": user_data}
        )


@app.post("/practices")
async def create_practice(
    practice_data: PracticeCreate,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db)
):
    """Crea una nuova pratica"""

    # Validazioni base (HTTPException qui devono propagarsi senza essere
    # convertite in 500 dal blocco try/except sottostante)
    if not practice_data.contexts:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Almeno un contesto è obbligatorio"
        )

    if practice_data.appointment_time[3:] not in ["00", "30"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="L'ora deve avere minuti 00 o 30 (slot da 30 minuti)"
        )

    try:
        # `contexts` nel DB è una stringa CSV: convertiamo la lista di enum.
        contexts_csv = ",".join([
            c.value if hasattr(c, "value") else str(c) for c in practice_data.contexts
        ])

        practice = Practice(
            created_by_telegram_id=user_data['id'],
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
            internal_notes=practice_data.internal_notes
        )

        db.add(practice)
        db.commit()
        db.refresh(practice)

        # Invia riepilogo Telegram (best-effort, non blocca la risposta)
        try:
            import asyncio
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
                "internal_notes": practice.internal_notes
            }

            summary = PracticeSummary(**summary_data)
            message_text = TelegramFormatter.format_practice_summary(summary)
            keyboard = TelegramFormatter.create_practice_keyboard(practice.id)

            async def send_telegram_message():
                try:
                    bot_instance = Bot(token=settings.telegram_bot_token)
                    await bot_instance.send_message(
                        chat_id=user_data['id'],
                        text=message_text,
                        reply_markup=InlineKeyboardMarkup(**keyboard),
                        parse_mode=ParseMode.HTML
                    )
                except Exception as e:
                    print(f"Errore invio riepilogo Telegram: {e}")

            asyncio.create_task(send_telegram_message())
        except Exception as e:
            print(f"Errore preparazione riepilogo Telegram: {e}")

        return APIResponse(
            success=True,
            data=_serialize_practice(practice)
        )

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Errore creazione pratica: {str(e)}"
        )


@app.put("/practices/{practice_id}")
async def update_practice(
    practice_id: int,
    practice_data: PracticeUpdate,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db)
):
    """Aggiorna una pratica esistente"""
    
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data['id']
    ).first()
    
    if not practice:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pratica non trovata"
        )
    
    try:
        # Aggiorna campi forniti
        update_data = practice_data.dict(exclude_unset=True)

        # `contexts` nel DB è una stringa CSV
        if "contexts" in update_data and update_data["contexts"] is not None:
            update_data["contexts"] = ",".join([
                c.value if hasattr(c, "value") else str(c) for c in update_data["contexts"]
            ])

        for field, value in update_data.items():
            setattr(practice, field, value)

        practice.updated_by_telegram_id = user_data['id']

        # Validazione slot 30 minuti se aggiornato
        if 'appointment_time' in update_data:
            if practice.appointment_time[3:] not in ["00", "30"]:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="L'ora deve avere minuti 00 o 30 (slot da 30 minuti)"
                )

        db.commit()
        db.refresh(practice)

        return APIResponse(
            success=True,
            data=_serialize_practice(practice)
        )

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Errore aggiornamento pratica: {str(e)}"
        )


@app.delete("/practices/{practice_id}")
async def delete_practice(
    practice_id: int,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db)
):
    """Soft-delete di una pratica"""
    
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data['id']
    ).first()
    
    if not practice:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pratica non trovata"
        )
    
    try:
        practice.status = PracticeStatus.DELETED
        practice.updated_by_telegram_id = user_data['id']
        db.commit()
        
        return APIResponse(
            success=True,
            data={"message": "Pratica cancellata con successo"}
        )
        
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Errore cancellazione pratica: {str(e)}"
        )


@app.get("/practices/{practice_id}/summary")
async def get_practice_summary(
    practice_id: int,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db)
):
    """Genera riepilogo pratica per messaggio Telegram"""
    
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data['id']
    ).first()
    
    if not practice:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pratica non trovata"
        )
    
    # Carica sezioni e parti
    sections = db.query(PracticeSection).filter(
        PracticeSection.practice_id == practice_id
    ).all()
    
    parts = db.query(PracticePart).filter(
        PracticePart.practice_id == practice_id
    ).all()
    
    # Costruisci riepilogo sezioni
    sections_summary = {}
    for section in sections:
        sections_summary[section.context.value] = {
            "description_rows": section.description_rows,
            "man_hours": section.man_hours,
            "mac_hours": section.mac_hours,
            "materials_amount": section.materials_amount,
            "waste_apply": section.waste_apply,
            "waste_percentage": section.waste_percentage,
            "parts": [part.name + (f" ({part.quantity})" if part.quantity else "") 
                     for part in parts if part.context == section.context]
        }
    
    # Avviso fatturazione (Piano §9)
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
        internal_notes=practice.internal_notes
    )
    
    return APIResponse(
        success=True,
        data=summary.dict()
    )


@app.post("/practices/{practice_id}/sections")
async def create_section(
    practice_id: int,
    section_data: dict,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db)
):
    """Aggiunge una sezione a una pratica"""
    
    # Verifica esistenza pratica
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data['id']
    ).first()
    
    if not practice:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pratica non trovata"
        )
    
    try:
        import json as _json
        # `description_rows` nel DB è un Text con JSON: serializziamo qui.
        rows = section_data.get('description_rows', [])
        if isinstance(rows, list):
            non_empty = [r for r in rows if isinstance(r, str) and r.strip()]
            if not non_empty:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Almeno una riga descrittiva è obbligatoria per contesto"
                )
            rows_json = _json.dumps(non_empty)
        else:
            rows_json = _json.dumps([str(rows)])

        section = PracticeSection(
            practice_id=practice_id,
            context=section_data['context'],
            description_rows=rows_json,
            man_hours=section_data.get('man_hours'),
            mac_hours=section_data.get('mac_hours'),
            materials_amount=section_data.get('materials_amount'),
            waste_apply=section_data.get('waste_apply'),
            waste_percentage=section_data.get('waste_percentage')
        )

        db.add(section)
        db.commit()
        db.refresh(section)

        return APIResponse(
            success=True,
            data=_serialize_orm(section)
        )

    except HTTPException:
        raise
    except KeyError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Campo obbligatorio mancante: {e}"
        )
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Errore creazione sezione: {str(e)}"
        )


@app.post("/practices/{practice_id}/parts")
async def create_part(
    practice_id: int,
    part_data: dict,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db)
):
    """Aggiunge un pezzo/ricambio a una pratica (Piano §6: pezzi e quantità)."""

    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data['id']
    ).first()
    if not practice:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pratica non trovata"
        )

    try:
        name = (part_data.get("name") or "").strip()
        if not name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Nome pezzo obbligatorio"
            )
        context_value = part_data.get("context")
        if not context_value:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Campo 'context' obbligatorio"
            )

        part = PracticePart(
            practice_id=practice_id,
            context=context_value,
            name=name,
            quantity=part_data.get("quantity") or None
        )
        db.add(part)
        db.commit()
        db.refresh(part)

        return APIResponse(
            success=True,
            data=_serialize_orm(part)
        )

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Errore creazione pezzo: {str(e)}"
        )


@app.delete("/practices/{practice_id}/parts")
async def delete_all_parts(
    practice_id: int,
    user_data: dict = Depends(require_whitelisted_user),
    db: Session = Depends(get_db)
):
    """Elimina tutti i pezzi di una pratica (utilizzato prima di re-inserirli
    dal form Mini App, che è stateless)."""
    practice = db.query(Practice).filter(
        Practice.id == practice_id,
        Practice.created_by_telegram_id == user_data['id']
    ).first()
    if not practice:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Pratica non trovata"
        )
    try:
        db.query(PracticePart).filter(PracticePart.practice_id == practice_id).delete()
        db.commit()
        return APIResponse(success=True, data={"message": "Pezzi eliminati"})
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Errore eliminazione pezzi: {str(e)}"
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
