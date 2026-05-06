import json
import logging
from enum import Enum
from typing import Any, Dict, List, Optional

from models import PracticeSummary

logger = logging.getLogger(__name__)


def _enum_value(value: Any) -> Any:
    return value.value if isinstance(value, Enum) else value


def _parse_description_rows(rows: Any) -> List[str]:
    if rows is None:
        return []
    if isinstance(rows, list):
        return [str(row) for row in rows if str(row).strip()]
    if isinstance(rows, str):
        try:
            parsed = json.loads(rows)
            if isinstance(parsed, list):
                return [str(row) for row in parsed if str(row).strip()]
        except Exception:
            pass
        return [row for row in rows.splitlines() if row.strip()] or ([rows] if rows.strip() else [])
    return [str(rows)]


def build_practice_summary(db, practice_id: int, telegram_user_id: Optional[int] = None) -> PracticeSummary:
    """Build a Telegram-ready summary directly from the current database models."""
    from database_sqlite import Practice, PracticeSection, PracticePart
    from models import CustomerType

    query = db.query(Practice).filter(Practice.id == practice_id)
    if telegram_user_id is not None:
        query = query.filter(Practice.created_by_telegram_id == telegram_user_id)
    practice = query.first()
    if not practice:
        raise ValueError("Pratica non trovata")

    sections = db.query(PracticeSection).filter(PracticeSection.practice_id == practice_id).all()
    parts = db.query(PracticePart).filter(PracticePart.practice_id == practice_id).all()

    parts_by_context: Dict[str, List[Any]] = {}
    for part in parts:
        ctx_val = _enum_value(part.context)
        parts_by_context.setdefault(ctx_val, []).append(part)

    sections_summary: Dict[str, Dict[str, Any]] = {}
    for section in sections:
        ctx_val = _enum_value(section.context)
        section_parts = parts_by_context.get(ctx_val, [])
        sections_summary[ctx_val] = {
            "description_rows": _parse_description_rows(section.description_rows),
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

    customer_type = _enum_value(practice.customer_type)
    billing_warning = None
    if customer_type == CustomerType.AZIENDA.value and practice.billing_to_complete:
        billing_warning = "Attenzione: dati fatturazione da completare"

    return PracticeSummary(
        practice_id=practice.id,
        plate=practice.plate_confirmed or "",
        phone=practice.phone or "",
        appointment=f"{practice.appointment_date.strftime('%d/%m/%Y')} {practice.appointment_time}",
        practice_type=_enum_value(practice.practice_type),
        contexts=[_enum_value(c) for c in practice.contexts_list],
        sections_summary=sections_summary,
        billing_warning=billing_warning,
        internal_notes=practice.internal_notes,
    )


class TelegramFormatter:
    """Utility per formattare messaggi e riepiloghi Telegram."""

    @staticmethod
    def format_practice_summary(summary: PracticeSummary) -> str:
        contexts = ", ".join([c.title() for c in summary.contexts]) if summary.contexts else "N/D"
        return (
            f"✅ Pratica #{summary.practice_id} creata\n"
            f"Targa: <b>{summary.plate or 'N/D'}</b>\n"
            f"Contesti: {contexts}\n"
            "Apri la Mini App per gestire tutti i dettagli."
        )

    @staticmethod
    def format_practice_modification_summary(summary: PracticeSummary) -> str:
        contexts = ", ".join([c.title() for c in summary.contexts]) if summary.contexts else "N/D"
        return (
            f"✏️ Pratica #{summary.practice_id} aggiornata\n"
            f"Targa: <b>{summary.plate or 'N/D'}</b>\n"
            f"Contesti: {contexts}\n"
            "Apri la Mini App per vedere il riepilogo completo."
        )

    @staticmethod
    def create_practice_keyboard(practice_id: int) -> Dict[str, List[Dict[str, str]]]:
        return {
            "inline_keyboard": [
                [
                    {"text": "Modifica pratica", "callback_data": f"edit_practice_{practice_id}"},
                    {"text": "Apri riepilogo", "callback_data": f"summary_practice_{practice_id}"},
                ],
                [{"text": "Nuova pratica", "callback_data": "new_practice"}],
            ]
        }

    @staticmethod
    def format_error_message(error_type: str, details: str = "") -> str:
        error_messages = {
            "ocr_failed": "Non sono riuscito a leggere la targa dalla foto. Riprova con un'immagine piu chiara o inseriscila manualmente.",
            "validation_failed": "Dati non validi. Controlla i campi obbligatori e riprova.",
            "database_error": "Errore durante il salvataggio. Riprova tra poco.",
            "unauthorized": "Non sei autorizzato a usare questo bot.",
            "practice_not_found": "Pratica non trovata.",
            "generic": "Si e verificato un errore. Riprova piu tardi.",
        }
        message = error_messages.get(error_type, error_messages["generic"])
        if details:
            message += f"\n\nDettagli: {details}"
        return message

    @staticmethod
    def format_success_message(action: str, practice_id: int = None) -> str:
        success_messages = {
            "practice_created": f"Pratica #{practice_id} creata con successo!",
            "practice_updated": f"Pratica #{practice_id} aggiornata con successo!",
            "practice_deleted": f"Pratica #{practice_id} cancellata con successo.",
            "photo_saved": "Foto salvata correttamente.",
            "plate_confirmed": "Targa confermata correttamente.",
        }
        return success_messages.get(action, "Operazione completata con successo!")
