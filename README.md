# Giorgio - MVP Telegram per Inserimento Pratiche Meccanico

Sistema interno per trasformare messaggi/foto disordinati in pratiche strutturate, modificabili e già pronte per essere inserite nel gestionale.

## Architettura

- **Bot Telegram**: riceve foto, OCR targa, avvia Mini App
- **Mini App React**: form strutturato precompilato
- **Backend FastAPI**: API, validazioni, database
- **Database PostgreSQL**: schema relazionale pratiche
- **OCR targa**: modulo isolato, fallback su bassa confidenza

## Metriche MVP

- Tempo medio creazione pratica: target < 90 secondi
- Percentuale OCR corretto al primo colpo
- Percentuale pratiche modificate dopo creazione

## Quick Start

```bash
# Backend
cd backend
python -m venv venv
source venv/bin/activate  # su Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload

# Mini App
cd mini-app
npm install
npm run dev

# Database
docker-compose up -d postgres
```

## Variabili d'ambiente

Creare `.env` in `backend/`:

```
TELEGRAM_BOT_TOKEN=your_token_here
DATABASE_URL=postgresql://postgres:password@localhost:5432/giorgio
WHITELIST_TELEGRAM_IDS=123456789,987654321
OCR_CONFIDENCE_THRESHOLD=0.6
```

## Struttura progetto

```
giorgio/
├── backend/          # FastAPI + PostgreSQL
├── mini-app/         # React Mini App
├── docker-compose.yml
└── README.md
```
