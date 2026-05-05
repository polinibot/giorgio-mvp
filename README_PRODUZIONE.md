# 🚀 Giorgio MVP - Produzione

Sistema completo per inserimento pratiche meccanico via Telegram.

## 🌐 URLs Produzione
- **Mini App**: https://polini-bot.vercel.app
- **Backend API**: https://polini-api.railway.app  
- **Bot Telegram**: @Polini_OfficinaBot

## 🏗️ Architettura
- **Frontend**: React su Vercel (statico)
- **Backend**: FastAPI + PostgreSQL su Railway
- **OCR**: Tesseract integrato
- **Bot**: aiogram + Telegram Mini App

## 📊 Costi Mensili
- **Vercel**: $0 (hobby tier)
- **Railway**: $5 (Starter plan)
- **Telegram**: $0 (fino a 1M msg/mese)
- **Totale**: ~$5/mese

## 🔄 Migrazione Account Railway

### Passo 1: Backup Database (Account Corrente)
```bash
# Export database PostgreSQL
pg_dump postgresql://user:pass@host:5432/dbname > backup.sql
```

### Passo 2: Nuovo Account Railway
1. Il cliente crea account Railway
2. Aggiunge metodo di pagamento
3. Nuovo progetto → Import from GitHub

### Passo 3: Import Database
1. Nel nuovo progetto Railway, crea database PostgreSQL
2. Importa il file `backup.sql`
3. Copia nuova DATABASE_URL

### Passo 4: Aggiorna Variabili
Nel nuovo progetto Railway, imposta:
```
TELEGRAM_BOT_TOKEN=8508131785:AAEjUwy-qIlcCZVMc4wVWYHGK3XXHuROOjM
DATABASE_URL=postgresql://NUOVO_URL
WHITELIST_TELEGRAM_IDS=[761118078]
OCR_CONFIDENCE_THRESHOLD=0.6
SECRET_KEY=chiave_segreta_produzione
```

### Passo 5: Aggiorna BotFather
1. Vai su @BotFather → /mybots → Polini_OfficinaBot
2. Bot Settings → Menu Button
3. Aggiorna URL se necessario (di solito rimane uguale)

### Passo 6: Test Migrazione
1. Testa bot Telegram
2. Verifica API su nuovo URL
3. Controlla che i dati siano presenti

## 🛠️ Manutenzione
- **Backup Database**: Automatici su Railway
- **Logs**: Disponibili su Vercel/Railway  
- **Updates**: Push su GitHub → auto-deploy

## 📞 Supporto
Per problemi:
- Controlla logs Railway/Vercel
- Verifica variabili ambiente
- Testa API e bot separatamente
