import logging
from datetime import datetime
from typing import Dict, List, Any, Optional
import re
from sqlalchemy.orm import Session
from database_sqlite import Practice, PracticeSection, PracticePart, PracticePhoto
from telegram_utils import _parse_description_rows
from appointment_time import validate_appointment_time, normalize_appointment_time, get_yap_slot_minutes

logger = logging.getLogger(__name__)


class AutomationService:
    """Servizio per preparare dati per automation futura del gestionale"""

    # Pesi dello score pre-sync (su base 100). Gli "infos" non penalizzano.
    SCORE_PENALTY_ERROR = 25
    SCORE_PENALTY_WARNING = 8

    @staticmethod
    def _ensure_str(value: Any) -> str:
        return str(value).strip() if value is not None else ""

    @staticmethod
    def _enum_value(value: Any) -> str:
        return value.value if hasattr(value, "value") else str(value)

    @staticmethod
    def _normalize_phone(phone: Any) -> str:
        raw = AutomationService._ensure_str(phone)
        if not raw:
            return ""
        cleaned = re.sub(r"[^\d+]", "", raw)
        if cleaned.startswith("00"):
            cleaned = f"+{cleaned[2:]}"
        # Italian mobile numbers are 10 digits starting with 3; only prefix +39 for those.
        if cleaned.startswith("3") and len(cleaned) == 10:
            cleaned = f"+39{cleaned}"
        return cleaned

    @staticmethod
    def _normalize_plate(plate: Any) -> str:
        raw = AutomationService._ensure_str(plate).upper()
        return re.sub(r"[^A-Z0-9]", "", raw)

    @staticmethod
    def _date_to_iso(value: Any) -> str:
        if not value:
            return ""
        if hasattr(value, "strftime"):
            return value.strftime("%Y-%m-%d")
        raw = str(value).strip()
        return raw[:10]
    
    @staticmethod
    def prepare_automation_payload(practice_id: int, db: Session) -> Dict[str, Any]:
        """
        Prepara payload completo per automation del gestionale.
        
        Questo payload contiene tutti i dati necessari per:
        1. Trovare lo slot agenda corretto
        2. Compilare il popup del gestionale
        3. Inserire tutte le righe descrittive
        4. Impostare ore e materiali
        """
        
        # Carica pratica con tutti i dati correlati
        practice = db.query(Practice).filter(Practice.id == practice_id).first()
        if not practice:
            raise ValueError(f"Pratica {practice_id} non trovata")
        
        photos = db.query(PracticePhoto).filter(PracticePhoto.practice_id == practice_id).all()
        sections = db.query(PracticeSection).filter(PracticeSection.practice_id == practice_id).all()
        parts = db.query(PracticePart).filter(PracticePart.practice_id == practice_id).all()
        
        # Payload base
        payload = {
            "practice_id": practice.id,
            "external_id": practice.management_external_id,
            "sync_status": practice.management_sync_status,
            "last_sync": practice.management_last_sync_at.isoformat() if practice.management_last_sync_at else None,
            
            # Dati cliente
            "customer": {
                "name": AutomationService._ensure_str(practice.customer_name),
                "phone": AutomationService._normalize_phone(practice.phone),
                "type": AutomationService._enum_value(practice.customer_type),
                "billing_complete": not practice.billing_to_complete,
                "plate": AutomationService._normalize_plate(practice.plate_confirmed)
            },
            
            # Dati appuntamento (per trovare slot agenda)
            "appointment": {
                "date": practice.appointment_date.strftime("%Y-%m-%d"),
                "time": normalize_appointment_time(practice.appointment_time),  # HH:MM canonical YAP slot
                "slot_duration": get_yap_slot_minutes(),  # minuti slot YAP
                "practice_type": AutomationService._enum_value(practice.practice_type)
            },
            
            # Contesti operativi
            "contexts": [AutomationService._enum_value(context) for context in practice.contexts_list],
            
            # Foto per riferimento
            "photos": [
                {
                    "id": photo.id,
                    "telegram_file_id": photo.telegram_file_id,
                    "storage_path": photo.storage_path,
                    "ocr_result": photo.ocr_result,
                    "ocr_confidence": photo.ocr_confidence
                }
                for photo in photos
            ],
            
            # Sezioni operative (il cuore del lavoro)
            "sections": {},
            
            # Note interne
            "internal_notes": practice.internal_notes,
            
            # Metadati per tracciamento
            "metadata": {
                "created_at": practice.created_at.isoformat(),
                "updated_at": practice.updated_at.isoformat(),
                "created_by": practice.created_by_telegram_id,
                "updated_by": practice.updated_by_telegram_id
            }
        }
        
        # Popola sezioni operative
        for section in sections:
            context_parts = [part for part in parts if part.context == section.context]
            
            section_context = AutomationService._enum_value(section.context)
            payload["sections"][section_context] = {
                "context": section_context,
                "description_rows": _parse_description_rows(section.description_rows),
                "man_hours": section.man_hours,
                "mac_hours": section.mac_hours,
                "materials_amount": section.materials_amount,
                "waste": {
                    "apply": section.waste_apply,
                    "percentage": section.waste_percentage
                },
                "parts": [
                    {
                        "name": part.name,
                        "quantity": part.quantity
                    }
                    for part in context_parts
                ]
            }
        
        # Aggiunge istruzioni specifiche per automation
        payload["automation_instructions"] = AutomationService._build_automation_instructions(payload)

        return payload

    @staticmethod
    def payload_from_form(practice_dict: Dict[str, Any], sections_list: List[Dict[str, Any]], parts_list: List[Dict[str, Any]]) -> Dict[str, Any]:
        practice_contexts = [
            AutomationService._enum_value(context)
            for context in (practice_dict.get("contexts") or [])
        ]
        parts_by_context: Dict[str, List[Dict[str, Any]]] = {}
        for part in parts_list:
            context_key = AutomationService._enum_value(part.get("context"))
            parts_by_context.setdefault(context_key, []).append(
                {
                    "name": AutomationService._ensure_str(part.get("name")),
                    "quantity": AutomationService._ensure_str(part.get("quantity")) or None,
                }
            )

        payload = {
            "practice_id": practice_dict.get("id"),
            "external_id": practice_dict.get("management_external_id"),
            "sync_status": practice_dict.get("management_sync_status"),
            "last_sync": practice_dict.get("management_last_sync_at"),
            "customer": {
                "name": AutomationService._ensure_str(practice_dict.get("customer_name")),
                "phone": AutomationService._normalize_phone(practice_dict.get("phone")),
                "type": AutomationService._enum_value(practice_dict.get("customer_type")),
                "billing_complete": not bool(practice_dict.get("billing_to_complete")),
                "plate": AutomationService._normalize_plate(practice_dict.get("plate_confirmed")),
            },
            "appointment": {
                "date": AutomationService._date_to_iso(practice_dict.get("appointment_date")),
                "time": normalize_appointment_time(AutomationService._ensure_str(practice_dict.get("appointment_time"))),
                "slot_duration": get_yap_slot_minutes(),
                "practice_type": AutomationService._enum_value(practice_dict.get("practice_type")),
            },
            "contexts": practice_contexts,
            "photos": [],
            "sections": {},
            "internal_notes": practice_dict.get("internal_notes"),
            "metadata": {
                "created_at": practice_dict.get("created_at"),
                "updated_at": practice_dict.get("updated_at"),
                "created_by": practice_dict.get("created_by_telegram_id"),
                "updated_by": practice_dict.get("updated_by_telegram_id"),
            },
        }

        for section in sections_list:
            context_key = AutomationService._enum_value(section.get("context"))
            payload["sections"][context_key] = {
                "context": context_key,
                "description_rows": [
                    AutomationService._ensure_str(row)
                    for row in (section.get("description_rows") or [])
                    if AutomationService._ensure_str(row)
                ],
                "man_hours": section.get("man_hours"),
                "mac_hours": section.get("mac_hours"),
                "materials_amount": section.get("materials_amount"),
                "waste": {
                    "apply": section.get("waste_apply"),
                    "percentage": section.get("waste_percentage"),
                },
                "parts": parts_by_context.get(context_key, []),
            }

        payload["automation_instructions"] = AutomationService._build_automation_instructions(payload)
        return payload

    @staticmethod
    def map_form_to_management(practice_dict: Dict[str, Any], sections_list: List[Dict[str, Any]], parts_list: List[Dict[str, Any]]) -> Dict[str, Any]:
        payload = AutomationService.payload_from_form(practice_dict, sections_list, parts_list)
        return AutomationService.map_payload_to_management(payload)

    @staticmethod
    def map_payload_to_management(payload: Dict[str, Any]) -> Dict[str, Any]:
        """Mapping finale payload -> campi gestionali (parte 2)."""
        customer = payload.get("customer") or {}
        appointment = payload.get("appointment") or {}
        sections = payload.get("sections") or {}

        management_sections = []
        for context_key, section_data in sections.items():
            management_sections.append({
                "reparto": context_key,
                "descrizioni": section_data.get("description_rows") or [],
                "ore_man": section_data.get("man_hours"),
                "ore_mac": section_data.get("mac_hours"),
                "materiali_euro": section_data.get("materials_amount"),
                "smaltimento_applica": (section_data.get("waste") or {}).get("apply"),
                "smaltimento_percentuale": (section_data.get("waste") or {}).get("percentage"),
                "ricambi": section_data.get("parts") or [],
                "notes": section_data.get("notes") or None,
            })

        return {
            "anagrafica": {
                "cliente_nome": customer.get("name", ""),
                "cliente_telefono": customer.get("phone", ""),
                "cliente_tipo": customer.get("type", ""),
                "targa": customer.get("plate", ""),
            },
            "agenda": {
                "data": appointment.get("date"),
                "ora": appointment.get("time"),
                "durata_minuti": appointment.get("slot_duration", get_yap_slot_minutes()),
                "tipo_pratica": appointment.get("practice_type"),
            },
            "lavorazioni": management_sections,
            "contexts": payload.get("contexts") or [],
            "note_interne": payload.get("internal_notes"),
            "meta": {
                "practice_id": payload.get("practice_id"),
                "external_id": payload.get("external_id"),
            },
        }
    
    @staticmethod
    def _build_automation_instructions(payload: Dict[str, Any]) -> Dict[str, Any]:
        """Costruisce istruzioni specifiche per l'automation del gestionale"""
        
        instructions = {
            "agenda": {
                "action": "find_and_click_slot",
                "date": payload["appointment"]["date"],
                "time": payload["appointment"]["time"],
                "duration_minutes": payload["appointment"]["slot_duration"],
                "fallback_strategy": "find_nearest_available_slot"
            },
            
            "popup_fields": {
                "customer_name": payload["customer"]["name"],
                "customer_phone": payload["customer"]["phone"],
                "plate": payload["customer"]["plate"],
                "practice_type": payload["appointment"]["practice_type"],
                "internal_notes": payload["internal_notes"]
            },
            
            "work_sections": [],
            
            "validation_rules": {
                "required_fields": ["customer_name", "plate", "appointment_date", "practice_type"],
                "time_format": "HH:MM",
                "plate_format": "italian_standard"
            }
        }
        
        # Costruisci istruzioni per ogni sezione
        for context_key, section_data in payload["sections"].items():
            section_instruction = {
                "context": context_key,
                "action": "add_work_section",
                "description_rows": section_data["description_rows"],
                "man_hours": section_data.get("man_hours"),
                "mac_hours": section_data.get("mac_hours"),
                "materials": section_data.get("materials_amount"),
                "parts": section_data["parts"],
                "waste_disposal": section_data["waste"]
            }
            
            instructions["work_sections"].append(section_instruction)
        
        # Istruzioni speciali per contesti
        if "officina" in payload["contexts"]:
            instructions["officina_specific"] = {
                "focus_on": "man_hours",
                "parts_priority": True,
                "description_detailed": True
            }
        
        if "carrozzeria" in payload["contexts"]:
            instructions["carrozzeria_specific"] = {
                "focus_on": "mac_hours",
                "materials_required": True,
                "waste_disposal_default": True,
                "waste_percentage_default": 2
            }
        
        if "revisione" in payload["contexts"]:
            instructions["revisione_specific"] = {
                "focus_on": "description_only",
                "no_parts_no_hours": True
            }
        
        return instructions
    
    @staticmethod
    def prepare_sync_status_update(practice_id: int, status: str, external_id: str = None, error_message: str = None) -> Dict[str, Any]:
        """Prepara payload per aggiornamento stato sincronizzazione"""
        
        payload = {
            "practice_id": practice_id,
            "sync_status": status,
            "timestamp": datetime.utcnow().isoformat()
        }
        
        if external_id:
            payload["external_id"] = external_id
        
        if error_message:
            payload["error_message"] = error_message
        
        return payload
    
    @staticmethod
    def export_practices_for_automation(db: Session, status_filter: str = "confirmed") -> List[Dict[str, Any]]:
        """Esporta pratiche pronte per automation"""
        
        practices = db.query(Practice).filter(Practice.status == status_filter).all()
        
        automation_payloads = []
        for practice in practices:
            try:
                payload = AutomationService.prepare_automation_payload(practice.id, db)
                automation_payloads.append(payload)
            except Exception as e:
                logger.warning("Errore preparazione pratica %s: %s", practice.id, e)
                continue
        
        return automation_payloads
    
    @staticmethod
    def validate_automation_readiness(payload: Dict[str, Any]) -> Dict[str, Any]:
        """Valida che una pratica sia pronta per automation"""
        
        validation = {
            "ready": True,
            "errors": [],
            "warnings": [],
            "infos": []
        }
        
        # Controlli obbligatori
        required_fields = ["customer", "appointment", "contexts", "sections"]
        for field in required_fields:
            if field not in payload or not payload[field]:
                validation["errors"].append(f"Campo obbligatorio mancante: {field}")
                validation["ready"] = False
        
        # Controlli specifici
        customer = payload.get("customer") or {}
        appointment = payload.get("appointment") or {}

        if not str(customer.get("phone", "")).strip():
            validation["errors"].append("Telefono cliente obbligatorio")
            validation["ready"] = False
        if not str(customer.get("name", "")).strip():
            validation["errors"].append("Nome cliente obbligatorio")
            validation["ready"] = False
        if not str(customer.get("plate", "")).strip():
            validation["errors"].append("Targa obbligatoria")
            validation["ready"] = False
        if not str(appointment.get("date", "")).strip() or not str(appointment.get("time", "")).strip():
            validation["errors"].append("Data e ora appuntamento obbligatorie")
            validation["ready"] = False

        time_value = str(appointment.get("time", "")).strip()
        if time_value:
            try:
                validate_appointment_time(time_value)
            except ValueError as exc:
                validation["errors"].append(str(exc))
                validation["ready"] = False

        if not payload.get("sections"):
            validation["errors"].append("Almeno una sezione lavoro richiesta")
            validation["ready"] = False
        else:
            for context, section in payload["sections"].items():
                rows = section.get("description_rows") or []
                if not isinstance(rows, list) or not any(str(row).strip() for row in rows):
                    validation["errors"].append(f"Sezione '{context}' senza righe descrittive")
                    validation["ready"] = False

        # Controlli avvisi
        if customer.get("billing_complete") is False:
            validation["warnings"].append("Dati fatturazione incompleti")
        
        if payload.get("internal_notes"):
            validation["infos"].append("Presenti note interne da verificare")

        return validation

    @staticmethod
    def pre_sync_check(payload: Dict[str, Any]) -> Dict[str, Any]:
        """Controllo pre-sync con score e priorita errori per UI."""
        readiness = AutomationService.validate_automation_readiness(payload)

        issues: List[Dict[str, Any]] = []
        for msg in readiness["errors"]:
            issues.append({
                "type": "error",
                "priority": 1,
                "blocking": True,
                "message": msg,
            })
        for msg in readiness["warnings"]:
            issues.append({
                "type": "warning",
                "priority": 2,
                "blocking": False,
                "message": msg,
            })
        for msg in readiness.get("infos", []):
            issues.append({
                "type": "info",
                "priority": 3,
                "blocking": False,
                "message": msg,
            })

        total_penalty = (
            len(readiness["errors"]) * AutomationService.SCORE_PENALTY_ERROR
            + len(readiness["warnings"]) * AutomationService.SCORE_PENALTY_WARNING
        )
        score = max(0, 100 - total_penalty)

        return {
            "ready": readiness["ready"],
            "score": score,
            "issues": sorted(issues, key=lambda i: (i["priority"], i["type"])),
        }
