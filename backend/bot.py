import asyncio
import os
from datetime import datetime
from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command
from aiogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from aiogram.enums import ParseMode
from sqlalchemy.orm import Session

from config import settings
from database_sqlite import get_db, create_tables, Practice, PracticePhoto, PracticeStatus, PracticeType, CustomerType
from ocr_service import OCRService, OCRResult
from security import SecurityService
from models import PracticeDraft
from cloudinary_service import cloudinary_service


class TelegramBot:
    def __init__(self):
        self.bot = Bot(token=settings.telegram_bot_token)
        self.dp = Dispatcher()
        self.user_states = {}  # Stato per input manuale targa
        self.setup_handlers()
    
    def setup_handlers(self):
        """Configura tutti gli handler del bot"""
        
        @self.dp.message(Command("start"))
        async def cmd_start(message: Message):
            """Handler per il comando /start"""
            if not SecurityService.is_user_whitelisted(message.from_user.id):
                await message.answer("⚠️ Accesso non autorizzato")
                return
            
            keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text="🆕 Nuova pratica", callback_data="new_practice")]
            ])
            
            await message.answer(
                "👋 Benvenuto nel bot Giorgio!\n\n"
                "Invia una foto della targa o del veicolo per iniziare una nuova pratica.",
                reply_markup=keyboard
            )
        
        @self.dp.callback_query(F.data == "new_practice")
        async def callback_new_practice(callback: CallbackQuery):
            """Handler per il pulsante Nuova pratica"""
            if not SecurityService.is_user_whitelisted(callback.from_user.id):
                await callback.answer("⚠️ Accesso non autorizzato", show_alert=True)
                return
            
            await callback.message.answer(
                "📸 Invia una foto della targa o del veicolo:\n\n"
                "Il sistema rileverà automaticamente la targa.\n"
                "Se la confidenza è bassa, ti chiederò di inserirla manualmente."
            )
            await callback.answer()
        
        @self.dp.message(F.photo)
        async def handle_photo(message: Message):
            """Handler per la ricezione di foto"""
            if not SecurityService.is_user_whitelisted(message.from_user.id):
                await message.answer("⚠️ Accesso non autorizzato")
                return
            
            try:
                progress_message = await message.answer("🔄 Analizzo la foto, attendi un attimo...")
                # Scarica la foto
                photo = message.photo[-1]  # Prendi la risoluzione più alta
                file_info = await self.bot.get_file(photo.file_id)
                file_path = file_info.file_path
                
                # Crea directory se non esiste
                os.makedirs("storage/photos", exist_ok=True)
                
                # Scarica e salva localmente
                downloaded_file = await self.bot.download_file(file_path)
                local_path = f"storage/photos/{photo.file_id}.jpg"
                
                with open(local_path, 'wb') as f:
                    f.write(downloaded_file.getvalue())
                
                ocr_result = OCRService.extract_plate_from_image(local_path)
                
                db = next(get_db())
                try:
                    practice = Practice(
                        created_by_telegram_id=message.from_user.id,
                        status=PracticeStatus.DRAFT,
                        plate_detected=ocr_result.plate,
                        plate_confirmed=ocr_result.plate or "DA_COMPLETARE",
                        phone="DA_COMPLETARE",
                        customer_name="DA_COMPLETARE",
                        customer_type=CustomerType.PRIVATO,
                        appointment_date=datetime.utcnow(),
                        appointment_time="09:00",
                        practice_type=PracticeType.PREVENTIVO,
                        contexts="officina"
                    )
                    db.add(practice)
                    db.commit()
                    db.refresh(practice)
                    
                    try:
                        storage_path, _ = cloudinary_service.upload_practice_photo(
                            local_path,
                            practice.id,
                            photo.file_id
                        )
                    except Exception:
                        storage_path = local_path
                    
                    photo_record = PracticePhoto(
                        practice_id=practice.id,
                        telegram_file_id=photo.file_id,
                        storage_path=storage_path,
                        ocr_result=ocr_result.plate,
                        ocr_confidence=ocr_result.confidence
                    )
                    db.add(photo_record)
                    db.commit()
                    
                    await self.send_plate_confirmation(
                        message,
                        practice.id,
                        photo.file_id,
                        ocr_result,
                        local_path
                    )
                    await progress_message.delete()
                finally:
                    db.close()
                    
            except Exception as e:
                print(f"Errore gestione foto: {e}")
                await message.answer("❌ Errore durante l'elaborazione della foto. Riprova.")
        
        @self.dp.callback_query(F.data.startswith("plate_"))
        async def handle_plate_action(callback: CallbackQuery):
            """Handler per le azioni sulla targa"""
            if not SecurityService.is_user_whitelisted(callback.from_user.id):
                await callback.answer("⚠️ Accesso non autorizzato", show_alert=True)
                return
            
            action_data = callback.data.split("_")
            action = action_data[1]
            practice_id = int(action_data[2])
            
            if action == "confirm":
                await self.confirm_plate_and_open_form(callback, practice_id)
            elif action == "edit":
                await self.request_manual_plate(callback, practice_id)
            elif action == "retry":
                await self.request_new_photo(callback, practice_id)
            
            await callback.answer()
        
        @self.dp.callback_query(F.data.startswith("edit_practice_"))
        async def handle_edit_practice(callback: CallbackQuery):
            """Handler per modifica pratica esistente"""
            if not SecurityService.is_user_whitelisted(callback.from_user.id):
                await callback.answer("⚠️ Accesso non autorizzato", show_alert=True)
                return
            
            practice_id = int(callback.data.split("_")[2])
            
            # Crea Mini App URL per modifica
            mini_app_url = f"https://giorgio-mvp-nine.vercel.app?practice_id={practice_id}&user_id={callback.from_user.id}"
            
            keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(
                    text="📝 Modifica pratica", 
                    web_app=WebAppInfo(url=mini_app_url)
                )]
            ])
            
            await callback.message.answer(
                f"✏️ Modifica pratica #{practice_id}\n\n"
                f"Premi il pulsante sotto per modificare i dati:",
                reply_markup=keyboard,
                parse_mode=ParseMode.HTML
            )
            
            await callback.answer()
        
        @self.dp.callback_query(F.data.startswith("summary_practice_"))
        async def handle_summary_practice(callback: CallbackQuery):
            """Handler per riepilogo pratica"""
            if not SecurityService.is_user_whitelisted(callback.from_user.id):
                await callback.answer("⚠️ Accesso non autorizzato", show_alert=True)
                return
            
            practice_id = int(callback.data.split("_")[2])
            
            # Ottieni riepilogo dall'API
            try:
                import requests
                response = requests.get(
                    f"http://localhost:8000/practices/{practice_id}/summary",
                    params={"init_data": ""}  # In produzione, passare initData reale
                )
                
                if response.status_code == 200:
                    data = response.json()
                    if data["success"]:
                        from telegram_utils import TelegramFormatter
                        summary = data["data"]
                        
                        # Formatta riepilogo
                        from models import PracticeSummary
                        practice_summary = PracticeSummary(**summary)
                        text = TelegramFormatter.format_practice_summary(practice_summary)
                        
                        # Tastiera azioni
                        keyboard = TelegramFormatter.create_practice_keyboard(practice_id)
                        
                        await callback.message.answer(
                            text,
                            reply_markup=keyboard,
                            parse_mode=ParseMode.HTML
                        )
                    else:
                        await callback.message.answer("❌ Errore caricamento riepilogo")
                else:
                    await callback.message.answer("❌ Pratica non trovata")
                    
            except Exception as e:
                print(f"Errore riepilogo pratica: {e}")
                await callback.message.answer("❌ Errore caricamento riepilogo")
            
            await callback.answer()
        
        @self.dp.message(F.text)
        async def handle_text_input(message: Message):
            """Handler per input testuali (modifica manuale targa)"""
            if not SecurityService.is_user_whitelisted(message.from_user.id):
                await message.answer("⚠️ Accesso non autorizzato")
                return
            
            user_id = message.from_user.id
            text = message.text.strip().upper()
            
            # Controlla se utente è in stato di inserimento targa
            if user_id in self.user_states and self.user_states[user_id]['action'] == 'waiting_plate':
                practice_id = self.user_states[user_id]['practice_id']
                
                # Valida formato targa base
                if len(text) < 5 or len(text) > 10:
                    await message.answer("❌ Formato targa non valido. Riprova (es. AB123CD):")
                    return
                
                # Aggiorna pratica con la targa inserita manualmente
                db = next(get_db())
                try:
                    practice = db.query(Practice).filter(Practice.id == practice_id).first()
                    if practice:
                        practice.plate_confirmed = text
                        db.commit()
                        
                        # Rimuovi stato
                        del self.user_states[user_id]
                        
                        # Apri Mini App senza sovrascrivere la targa manuale
                        await self.confirm_plate_and_open_form(message, practice_id, override_from_detected=False)
                    else:
                        await message.answer("❌ Pratica non trovata")
                        
                finally:
                    db.close()
            else:
                # Messaggio non riconosciuto
                await message.answer("❌ Comando non riconosciuto. Usa /start per iniziare.")
    
    async def send_plate_confirmation(self, message: Message, practice_id: int, file_id: str, ocr_result: OCRResult, photo_path: str):
        """Invia messaggio di conferma targa con foto e opzioni"""
        
        # Costruisci il testo del messaggio
        if ocr_result.plate and ocr_result.confidence > 0:
            text = (
                f"📸 Foto ricevuta\n\n"
                f"🔍 Targa rilevata: <b>{ocr_result.plate}</b>\n"
                f"📊 Confidenza: {ocr_result.confidence:.1%}\n\n"
                f"La targa è corretta?"
            )
            
            # Se la confidenza è bassa, aggiungi avviso
            if OCRService.should_use_fallback(ocr_result):
                text += "\n⚠️ La confidenza è bassa, verifica attentamente."
        else:
            text = (
                f"📸 Foto ricevuta\n\n"
                f"❌ Non sono riuscito a rilevare una targa.\n\n"
                f"Vuoi inserirla manualmente o riprovare con un'altra foto?"
            )
        
        # Costruisci la tastiera inline
        if ocr_result.plate and ocr_result.confidence > 0:
            keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [
                    InlineKeyboardButton(text="✅ Conferma targa", callback_data=f"plate_confirm_{practice_id}"),
                    InlineKeyboardButton(text="✏️ Modifica targa", callback_data=f"plate_edit_{practice_id}")
                ],
                [
                    InlineKeyboardButton(text="🔄 Riprova con altra foto", callback_data=f"plate_retry_{practice_id}")
                ]
            ])
        else:
            keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [
                    InlineKeyboardButton(text="✏️ Inserisci targa manualmente", callback_data=f"plate_edit_{practice_id}"),
                    InlineKeyboardButton(text="🔄 Riprova con altra foto", callback_data=f"plate_retry_{practice_id}")
                ]
            ])
        
        # Invia foto con testo e tastiera
        await message.answer_photo(
            photo=file_id,
            caption=text,
            reply_markup=keyboard,
            parse_mode=ParseMode.HTML
        )
    
    async def confirm_plate_and_open_form(self, source: Message | CallbackQuery, practice_id: int, override_from_detected: bool = True):
        """Conferma (opzionale) la targa rilevata e apre la Mini App con form precompilato.

        Può essere chiamata sia da un CallbackQuery (conferma automatica) sia da un Message
        dopo inserimento manuale della targa.
        """
        db = next(get_db())
        try:
            practice = db.query(Practice).filter(Practice.id == practice_id).first()
            if not practice:
                # Determina dove rispondere
                if isinstance(source, CallbackQuery):
                    await source.message.answer("❌ Pratica non trovata")
                else:
                    await source.answer("❌ Pratica non trovata")
                return

            # Solo nel caso di conferma automatica sovrascriviamo da plate_detected
            if override_from_detected and practice.plate_detected:
                practice.plate_confirmed = practice.plate_detected
                db.commit()
            
            # Determina target messaggio e utente Telegram
            if isinstance(source, CallbackQuery):
                message_target = source.message
                from_user_id = source.from_user.id
            else:
                message_target = source
                from_user_id = source.from_user.id

            # Crea Mini App button con dati precompilati
            mini_app_url = f"https://giorgio-mvp-nine.vercel.app?practice_id={practice_id}&plate={practice.plate_confirmed}&user_id={from_user_id}"
            
            keyboard = InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(
                    text="📝 Compila dati pratica", 
                    web_app=WebAppInfo(url=mini_app_url)
                )]
            ])
            
            await message_target.answer(
                f"✅ Targa confermata: <b>{practice.plate_confirmed}</b>\n\n"
                f"Premi il pulsante sotto per compilare i dati della pratica:",
                reply_markup=keyboard,
                parse_mode=ParseMode.HTML
            )
            
        finally:
            db.close()
    
    async def request_manual_plate(self, callback: CallbackQuery, practice_id: int):
        """Richiede l'inserimento manuale della targa"""
        # Imposta stato utente per attendere input
        self.user_states[callback.from_user.id] = {
            'action': 'waiting_plate',
            'practice_id': practice_id
        }
        
        await callback.message.answer(
            "✏️ Inserisci la targa manualmente:\n\n"
            "Formato atteso: AB123CD\n"
            "Scrivila in chat e premi Invio."
        )
    
    async def request_new_photo(self, callback: CallbackQuery, practice_id: int):
        """Richiede una nuova foto"""
        # Imposta stato utente per attendere nuova foto
        self.user_states[callback.from_user.id] = {
            'action': 'waiting_photo',
            'practice_id': practice_id
        }
        
        await callback.message.answer(
            "📸 Invia una nuova foto della targa o del veicolo:"
        )
    
    async def start(self):
        """Avvia il bot"""
        await self.bot.delete_webhook(drop_pending_updates=True)
        await self.dp.start_polling(self.bot)


# Funzione per avviare il bot
async def start_bot():
    create_tables()
    bot_instance = TelegramBot()
    await bot_instance.start()


if __name__ == "__main__":
    asyncio.run(start_bot())
