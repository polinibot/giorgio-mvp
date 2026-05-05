from datetime import datetime
from typing import Dict, List, Any
from models import PracticeSummary


class TelegramFormatter:
    """Utilità per formattare messaggi e riepiloghi Telegram"""
    
    @staticmethod
    def format_practice_summary(summary: PracticeSummary) -> str:
        """Formatta riepilogo pratica per messaggio Telegram"""
        
        text = f"🔧 Pratica #{summary.practice_id} creata\n\n"
        text += f"📍 Targa: <b>{summary.plate}</b>\n"
        text += f"📞 Telefono: {summary.phone}\n"
        text += f"📅 Appuntamento: {summary.appointment}\n"
        text += f"📋 Tipo: <b>{summary.practice_type.upper()}</b>\n"
        text += f"🏢 Contesti: {', '.join([c.title() for c in summary.contexts])}\n\n"
        
        # Sezioni dettagliate
        for context, data in summary.sections_summary.items():
            text += f"🔹 <b>{context.title()}</b>:\n"
            
            # Righe descrittive
            if data.get('description_rows'):
                for row in data['description_rows']:
                    if row.strip():
                        text += f"• {row}\n"
            
            # Ore manodopera
            if data.get('man_hours'):
                text += f"⏱️ MAN: {data['man_hours']} ore\n"
            
            if data.get('mac_hours'):
                text += f"⏱️ MAC: {data['mac_hours']} ore\n"
            
            # Materiali carrozzeria
            if data.get('materials_amount'):
                text += f"💰 Materiali: €{data['materials_amount']:.2f}\n"
            
            # Smaltimento rifiuti
            if data.get('waste_apply'):
                percentage = data.get('waste_percentage', 2)
                text += f"♻️ Smaltimento: {percentage}%\n"
            
            # Pezzi
            if data.get('parts'):
                text += "🔩 Pezzi:\n"
                for part in data['parts']:
                    text += f"  • {part}\n"
            
            text += "\n"
        
        # Avviso fatturazione
        if summary.billing_warning:
            text += f"{summary.billing_warning}\n\n"
        
        # Note interne
        if summary.internal_notes:
            text += f"📝 Note: {summary.internal_notes}\n\n"
        
        return text
    
    @staticmethod
    def format_practice_modification_summary(summary: PracticeSummary) -> str:
        """Formatta riepilogo per pratica modificata"""
        
        text = f"✏️ Pratica #{summary.practice_id} aggiornata\n\n"
        text += f"📍 Targa: <b>{summary.plate}</b>\n"
        text += f"📅 Appuntamento: {summary.appointment}\n"
        text += f"📋 Tipo: <b>{summary.practice_type.upper()}</b>\n"
        text += f"🏢 Contesti: {', '.join([c.title() for c in summary.contexts])}\n\n"
        
        # Note se presenti
        if summary.internal_notes:
            text += f"📝 Note: {summary.internal_notes}\n\n"
        
        text += "💾 Tutte le modifiche sono state salvate."
        
        return text
    
    @staticmethod
    def create_practice_keyboard(practice_id: int) -> Dict[str, List[Dict[str, str]]]:
        """Crea tastiera inline per azioni pratica"""
        
        return {
            "inline_keyboard": [
                [
                    {"text": "✏️ Modifica pratica", "callback_data": f"edit_practice_{practice_id}"},
                    {"text": "📊 Apri riepilogo", "callback_data": f"summary_practice_{practice_id}"}
                ],
                [
                    {"text": "🆕 Nuova pratica", "callback_data": "new_practice"}
                ]
            ]
        }
    
    @staticmethod
    def format_error_message(error_type: str, details: str = "") -> str:
        """Formatta messaggi di errore per Telegram"""
        
        error_messages = {
            "ocr_failed": "❌ Non sono riuscito a leggere la targa dalla foto.\nRiprova con un'immagine più chiara o inseriscila manualmente.",
            "validation_failed": "❌ Dati non validi.\nControlla i campi obbligatori e riprova.",
            "database_error": "❌ Errore durante il salvataggio.\nRiprova tra poco.",
            "unauthorized": "⚠️ Non sei autorizzato a usare questo bot.",
            "practice_not_found": "❌ Pratica non trovata.",
            "generic": "❌ Si è verificato un errore.\nRiprova più tardi."
        }
        
        message = error_messages.get(error_type, error_messages["generic"])
        
        if details:
            message += f"\n\nDettagli: {details}"
        
        return message
    
    @staticmethod
    def format_success_message(action: str, practice_id: int = None) -> str:
        """Formatta messaggi di successo per Telegram"""
        
        success_messages = {
            "practice_created": f"✅ Pratica #{practice_id} creata con successo!",
            "practice_updated": f"✅ Pratica #{practice_id} aggiornata con successo!",
            "practice_deleted": f"🗑️ Pratica #{practice_id} cancellata con successo.",
            "photo_saved": "📸 Foto salvata correttamente.",
            "plate_confirmed": "✅ Targa confermata correttamente."
        }
        
        return success_messages.get(action, "✅ Operazione completata con successo!")
