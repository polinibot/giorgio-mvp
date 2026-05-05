# 🚀 Giorgio - Bot Telegram Pratiche Meccanico

Sistema completo per inserimento pratiche meccanico via Telegram con OCR targhe e Mini App React.

## 🌐 URLs Produzione
- **Mini App**: https://polini-bot.vercel.app
- **Backend API**: https://polini-api.railway.app  
- **Bot Telegram**: @Polini_OfficinaBot

## 🏗️ Architettura
- **Frontend**: React + Vite su Vercel
- **Backend**: FastAPI + PostgreSQL su Railway
- **Storage**: Cloudinary (compressione foto)
- **Bot**: aiogram + Telegram WebApp
- **OCR**: Tesseract con validazione targhe

## 💰 Costi Mensili
- **Vercel**: $0 (hobby tier)
- **Railway**: $5 (Starter plan)
- **Cloudinary**: $0 (free tier 25GB)
- **Telegram**: $0 (fino a 1M msg/mese)
- **TOTALE**: ~$5/mese

## 🚀 Deploy Istruzioni

### Mini App (Vercel)
1. Connetti GitHub a Vercel
2. Seleziona solo cartella `mini-app/`
3. Deploy automatico

### Backend (Railway)
1. Connetti GitHub a Railway
2. Seleziona repository completo
3. Configura variabili ambiente
4. Deploy automatico

### Variabili Ambiente Railway
```
TELEGRAM_BOT_TOKEN=8508131785:AAEjUwy-qIlcCZVMc4wVWYHGK3XXHuROOjM
DATABASE_URL=postgresql://postgres:password@host:5432/railway
WHITELIST_TELEGRAM_IDS=[761118078]
OCR_CONFIDENCE_THRESHOLD=0.6
SECRET_KEY=polini_bot_secret_key_2024_secure_change_in_production
CLOUDINARY_CLOUD_NAME=ddkgev5ui
CLOUDINARY_API_KEY=861438236345898
CLOUDINARY_API_SECRET=YyekpPln63QnAU6rBFfXTCRZDi0
```

## 📱 Flusso Utente
1. Utente invia `/start` al bot
2. Bot chiede foto targa
3. OCR rileva targa automaticamente
4. Utente conferma/modifica targa
5. Si apre Mini App con form precompilato
6. Utente compila pratica e salva
7. Bot invia riepilogo con pulsanti

## 🔧 Sviluppo Locale
```bash
# Backend
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload

# Mini App
cd mini-app
npm install
npm run dev

# Bot
cd backend
python bot.py
```

## 📊 Struttura Database
- `practices` - Dati principali pratiche
- `practice_photos` - Foto e OCR results
- `practice_sections` - Sezioni lavoro per contesto
- `practice_parts` - Pezzi di ricambio

## 🖼️ Storage Foto
Le foto vengono:
1. Comprese al 95% (5MB → 200KB)
2. Convertite in WebP
3. Salvate su Cloudinary
4. Servite via CDN globale

## 🔒 Sicurezza
- Whitelist Telegram user IDs
- HMAC validation per Mini App
- Variabili ambiente sensibili
- Soft-delete per pratiche

## 📞 Supporto
Per problemi:
- Controlla logs Railway/Vercel
- Verifica variabili ambiente
- Testa API e bot separatamente
