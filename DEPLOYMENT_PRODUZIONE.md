# 🚀 Deployment Produzione - Giorgio MVP

## Struttura Produzione
- **Mini App**: Vercel (statico)
- **Backend API**: Railway (Python/PostgreSQL)
- **Database**: PostgreSQL su Railway
- **Bot**: Telegram (già configurato)

## Passo 1: Deploy Mini App su Vercel

### Metodo A: GitHub (Raccomandato)
1. Crea repository GitHub con il codice
2. Vai su [vercel.com](https://vercel.com)
3. Importa repository GitHub
4. Seleziona solo la cartella `mini-app/`
5. Deploy automatico

### Metodo B: Vercel CLI
```bash
# Installa Vercel CLI
npm i -g vercel

# Dalla cartella mini-app
cd mini-app
vercel --prod
```

**URL Mini App**: `https://polini-bot.vercel.app` (o quello che Vercel ti assegna)

## Passo 2: Deploy Backend su Railway

### Prepara il repository
1. Crea repository GitHub con tutto il codice
2. Assicurati che `railway.toml` e `Dockerfile` sono nella root

### Deploy su Railway
1. Vai su [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Seleziona il repository
4. Railway rileverà automaticamente il Python app

### Configura variabili ambiente su Railway
Nel progetto Railway, vai su Settings → Variables:
```
TELEGRAM_BOT_TOKEN=8508131785:AAEjUwy-qIlcCZVMc4wVWYHGK3XXHuROOjM
DATABASE_URL=postgresql://postgres:password@host:5432/railway
WHITELIST_TELEGRAM_IDS=[761118078]
OCR_CONFIDENCE_THRESHOLD=0.6
SECRET_KEY=chiave_segreta_produzione
```

**URL Backend**: `https://polini-api.railway.app` (o quello che Railway ti assegna)

## Passo 3: Configura BotFather

1. Vai su `@BotFather` in Telegram
2. `/mybots` → seleziona `Polini_OfficinaBot`
3. `Bot Settings` → `Menu Button`
4. Scegli `Open Mini App`
5. Inserisci URL: `https://polini-bot.vercel.app`

## Passo 4: Aggiorna Mini App con URL reali

Nel file `mini-app/src/App.js`:
```javascript
const API_BASE_URL = 'https://polini-api.railway.app';
```

Nel file `backend/bot.py`:
```python
mini_app_url = f"https://polini-bot.vercel.app?practice_id={practice_id}&user_id={user_id}"
```

## Passo 5: Test Produzione

1. **Test API**: Visita `https://polini-api.railway.app`
2. **Test Mini App**: Visita `https://polini-bot.vercel.app`
3. **Test Bot**: Apri `@Polini_OfficinaBot` su Telegram
4. **Flusso completo**: Foto → OCR → Mini App → Salva

## Costi Stimati (Mensili)
- **Vercel**: $0 (pro tier per hobby projects)
- **Railway**: ~$5-10 (database + server)
- **Telegram**: $0 (fino a 1M messaggi/mese)
- **Totale**: ~$5-10/mese

## Dominio Personalizzato (Opzionale)
Se vuoi dominio proprio:
1. Compra dominio (es. `polini-bot.com`)
2. Configura su Vercel e Railway
3. Aggiorna BotFather con nuovo URL

## Backup e Manutenzione
- **Database**: Railway fa backup automatici
- **Codice**: Versionato su GitHub
- **Logs**: Disponibili su Vercel e Railway

## Monitoraggio
- **Vercel Analytics**: Traffico Mini App
- **Railway Logs**: Errori backend
- **BotFather Messages**: Statistiche bot

## Troubleshooting Produzione
- **Bot non risponde**: Controlla logs Railway
- **Mini App bianca**: Controlla console browser
- **API errori**: Controlla variabili ambiente Railway

## Prossimi Passi
1. Deploy Mini App su Vercel
2. Deploy Backend su Railway
3. Configura BotFather
4. Test completo flusso
5. Racogli feedback utenti
