from datetime import datetime
from typing import Dict, List, Any, Optional
from sqlalchemy.orm import Session
from database_sqlite import Practice, PracticeSection, PracticePart, PracticePhoto
from models import PracticeModel
from telegram_utils import _parse_description_rows


class AutomationService:
    """Servizio per preparare dati per automation futura del gestionale"""
    
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
                "name": practice.customer_name,
                "phone": practice.phone,
                "type": practice.customer_type.value,
                "billing_complete": not practice.billing_to_complete,
                "plate": practice.plate_confirmed
            },
            
            # Dati appuntamento (per trovare slot agenda)
            "appointment": {
                "date": practice.appointment_date.strftime("%Y-%m-%d"),
                "time": practice.appointment_time,  # HH:MM con minuti 00 o 30
                "slot_duration": 30,  # minuti
                "practice_type": practice.practice_type.value
            },
            
            # Contesti operativi
            "contexts": [context.value for context in practice.contexts_list],
            
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
            
            payload["sections"][section.context.value] = {
                "context": section.context.value,
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
                "time_slots": ["00", "30"],  # minuti validi
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
                print(f"Errore preparazione pratica {practice.id}: {e}")
                continue
        
        return automation_payloads
    
    @staticmethod
    def validate_automation_readiness(payload: Dict[str, Any]) -> Dict[str, Any]:
        """Valida che una pratica sia pronta per automation"""
        
        validation = {
            "ready": True,
            "errors": [],
            "warnings": []
        }
        
        # Controlli obbligatori
        required_fields = ["customer", "appointment", "contexts", "sections"]
        for field in required_fields:
            if field not in payload or not payload[field]:
                validation["errors"].append(f"Campo obbligatorio mancante: {field}")
                validation["ready"] = False
        
        # Controlli specifici
        if payload.get("customer", {}).get("phone") == "":
            validation["errors"].append("Telefono cliente obbligatorio")
            validation["ready"] = False
        
        if not payload.get("sections"):
            validation["errors"].append("Almeno una sezione lavoro richiesta")
            validation["ready"] = False
        
        # Controlli avvisi
        if payload.get("customer", {}).get("billing_complete") == False:
            validation["warnings"].append("Dati fatturazione incompleti")
        
        if payload.get("internal_notes"):
            validation["warnings"].append("Presenti note interne da verificare")
        
        return validation
