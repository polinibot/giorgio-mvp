# Setup Guida - Giorgio MVP Telegram

Guida completa per installare e avviare il sistema Giorgio per inserimento pratiche meccanico.

## Prerequisiti

- Docker Desktop (Windows/Mac) o Docker (Linux)
- Python 3.9+
- Node.js 16+
- Account Telegram con Bot Token
- Tesseract OCR (installato nel sistema)

## Installazione Tesseract OCR

### Windows
```bash
# Scarica installer da: https://github.com/UB-Mannheim/tesseract/wiki
# Durante installazione, seleziona lingua italiana
```

### macOS
```bash
brew install tesseract
brew install tesseract-lang
```

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install tesseract-ocr tesseract-ocr-ita
```

## Setup Database

1. Copia file ambiente:
```bash
cd backend
cp .env.example .env
```

2. Configura le variabili in `.env`:
```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
DATABASE_URL=postgresql://postgres:password@localhost:5432/giorgio
WHITELIST_TELEGRAM_IDS=123456789,987654321  # ID Telegram autorizzati
OCR_CONFIDENCE_THRESHOLD=0.6
SECRET_KEY=your_super_secret_key_here
```

3. Avvia PostgreSQL:
```bash
docker-compose up -d postgres
```

4. Inizializza database (automatico con Docker):
```bash
# Lo script init.sql viene eseguito automaticamente al primo avvio
# Se necessario, esegui manualmente:
psql -h localhost -U postgres -d giorgio -f backend/init.sql
```

## Setup Backend

```bash
cd backend
python -m venv venv

# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
```

## Setup Mini App

```bash
cd mini-app
npm install
```

## Avvio Rapido

### Windows
```bash
# Doppio click su start.bat
# oppure da terminale:
start.bat
```

### macOS/Linux
```bash
chmod +x start.sh
./start.sh
```

## Avvio Manuale (per sviluppo)

### 1. Database
```bash
docker-compose up -d postgres
```

### 2. Backend API
```bash
cd backend
source venv/bin/activate  # Windows: venv\Scripts\activate
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Mini App
```bash
cd mini-app
npm run dev
```

### 4. Bot Telegram
```bash
cd backend
source venv/bin/activate  # Windows: venv\Scripts\activate
python bot.py
```

## Configurazione Bot Telegram

1. Crea un bot con @BotFather
2. Ottieni il Bot Token
3. Configura Mini App URL in BotFather:
   - `/mybots` → seleziona bot → `Bot Settings` → `Menu Button`
   - Imposta URL della tua Mini App (es. https://your-domain.com)

## Test del Sistema

1. **Test Bot**:
   - Avvia il bot in Telegram
   - Invia `/start`
   - Verifica whitelist funzionante

2. **Test OCR**:
   - Invia una foto di targa
   - Verifica rilevamento automatico
   - Test fallback manuale

3. **Test Mini App**:
   - Conferma targa dal bot
   - Compila form completo
   - Verifica salvataggio pratica

4. **Test API**:
   - Visita http://localhost:8000/docs
   - Test endpoints con initData valido

## Struttura File

```
giorgio/
├── backend/
│   ├── venv/                 # Virtual environment Python
│   ├── storage/              # Foto salvate
│   │   └── photos/
│   ├── main.py              # FastAPI server
│   ├── bot.py               # Telegram bot
│   ├── config.py            # Configurazione
│   ├── database_sqlite.py   # SQLAlchemy models attivi
│   ├── models.py            # Pydantic models
│   ├── ocr_service.py       # OCR targa
│   ├── security.py          # Validazioni sicurezza
│   ├── requirements.txt     # Dipendenze Python
│   ├── .env                 # Variabili ambiente
│   └── init.sql             # Schema database
├── mini-app/
│   ├── node_modules/        # Dipendenze Node.js
│   ├── build/               # Build produzione
│   ├── src/
│   │   ├── App.js          # Componente principale
│   │   ├── App.css         # Stili
│   │   └── index.js        # Entry point
│   ├── public/
│   │   └── index.html      # Template HTML
│   └── package.json        # Dipendenze React
├── docker-compose.yml      # PostgreSQL container
├── start.sh               # Script avvio Unix
├── start.bat              # Script avvio Windows
└── README.md              # Documentazione progetto
```

## Troubleshooting

### Bot non risponde
- Verifica Bot Token in `.env`
- Controlla whitelist Telegram IDs
- Controlla log bot nel terminale

### OCR non funziona
- Verifica installazione Tesseract
- Test con immagine targa pulita
- Controlla confidenza threshold

### Mini App non si apre
- Verifica URL Mini App in BotFather
- Controlla che backend sia attivo su porta 8000
- Verifica validazione initData

### Database non si connette
- Verifica Docker in esecuzione
- Controlla DATABASE_URL in `.env`
- Riavvia container PostgreSQL

### Foto non salvate
- Verifica permessi directory `storage/photos`
- Controlla spazio disco disponibile
- Test download file Telegram

## Metriche MVP

Il sistema raccoglie automaticamente:

- **Tempo creazione pratica**: misurato da invio foto a salvataggio
- **Percentuale OCR corretto**: confronto targa rilevata vs confermata
- **Percentuale pratiche modificate**: track modifiche post-creazione

Per monitorare queste metriche, consulta i log del backend e il database.

## Prossimi Passi

1. **Test con operatori reali**: raccogli feedback su usabilità
2. **Ottimizzazione OCR**: se necessario, cambia servizio OCR
3. **Preparazione automation**: raccogli screenshot gestionale
4. **Deployment**: configura dominio e HTTPS per Mini App

## Supporto

Per problemi o domande:
- Controlla i log dei servizi
- Verifica configurazione in `.env`
- Consulta documentazione API: http://localhost:8000/docs
