# 🔄 Guida Migrazione Railway - Account Cliente

## 🎯 Obiettivo
Spostare il backend da account Railway temporaneo al account definitivo del cliente con la sua carta.

## ⏰ Tempo Stimato: 15 minuti

---

## 📋 Checklist Pre-Migrazione
- [ ] Cliente ha creato account Railway
- [ ] Cliente ha aggiunto carta di credito
- [ ] Accesso al bot Telegram funzionante
- [ ] URL backend attuale: `https://polini-api.railway.app`

---

## 🚀 Passo 1: Export Database (Account Corrente)

### Metodo A: Via Railway Dashboard
1. Entra in Railway progetto attuale
2. Vai su PostgreSQL service
3. Tab "Data" → "Export"
4. Scarica file `.sql`

### Metodo B: Via Comando (se necessario)
```bash
# Se hai accesso diretto al database
pg_dump postgresql://user:password@host:5432/database > giorgio_backup.sql
```

**Salva il file come `giorgio_backup.sql` sul tuo computer**

---

## 🚀 Passo 2: Nuovo Progetto Railway (Account Cliente)

1. **Login Cliente**: Entra in [railway.app](https://railway.app) con account cliente
2. **New Project**: Clicca "New Project"
3. **Deploy from GitHub**: Seleziona il repository GitHub
4. **Add Variables**: Vai su Settings → Variables e aggiungi:

```
TELEGRAM_BOT_TOKEN=8508131785:AAEjUwy-qIlcCZVMc4wVWYHGK3XXHuROOjM
WHITELIST_TELEGRAM_IDS=[761118078]
OCR_CONFIDENCE_THRESHOLD=0.6
SECRET_KEY=polini_bot_secret_key_2024_secure_change_in_production
```

5. **Add PostgreSQL Service**:
   - Nel progetto, clicca "+ New Service"
   - Seleziona "PostgreSQL"
   - Aspetta deployment (2-3 minuti)

---

## 🚀 Passo 3: Import Database

1. **Ottieni DATABASE_URL**:
   - Nel nuovo progetto, vai su PostgreSQL service
   - Copia la "Connection URL" (DATABASE_URL)

2. **Importa il backup**:
   - Sempre nel PostgreSQL service
   - Tab "Data" → "Import"
   - Carica il file `giorgio_backup.sql`
   - Aspetta completamento (1-2 minuti)

3. **Aggiorna DATABASE_URL**:
   - Torna su Settings → Variables
   - Aggiungi la nuova DATABASE_URL copiata

---

## 🚀 Passo 4: Deploy e Test

1. **Redeploy**: Vai su progetto principale e clicca "Redeploy"
2. **Aspetta deployment**: 2-3 minuti
3. **Ottieni nuovo URL**: Copia il nuovo URL del backend

4. **Test API**:
   ```bash
   curl https://NUOVO_URL.railway.app
   # Dovresti vedere: {"status": "ok"}
   ```

---

## 🚀 Passo 5: Aggiorna Bot (SE NECESSARIO)

**Di solito NON serve cambiare nulla nel bot**, ma se vuoi aggiornare:

1. Vai su @BotFather → /mybots → Polini_OfficinaBot
2. Bot Settings → Menu Button
3. Verifica URL Mini App (di solito rimane uguale)

---

## 🚀 Passo 6: Test Finale

1. **Test Bot Telegram**:
   - Apri @Polini_OfficinaBot
   - Invia /start
   - Prova flusso completo

2. **Verifica Dati**:
   - Le pratiche esistenti dovrebbero essere presenti
   - Nuove pratiche dovrebbero salvarsi correttamente

---

## ✅ Migrazione Completata!

### Cosa Fare Dopo:
- [ ] Elimina progetto Railway vecchio (per non addebitare)
- [ ] Salva nuove credenziali Railway
- [ ] Documenta URL nuovo backend

### Costo Finale:
- **Solo account cliente**: ~$5/mese
- **Nessun costo sul vecchio account**

---

## 🆘 Troubleshooting

### Errore "Database connection failed"
- Verifica DATABASE_URL corretta
- Controlla che PostgreSQL sia attivo

### Errore "Bot non risponde"
- Verifica variabili ambiente
- Controlla logs Railway

### Dati mancanti
- Ripeti Passo 3 (import database)
- Verifica che il file .sql sia completo

### Aiuto
- Controlla logs Railway per errori dettagliati
- Verifica che tutte le variabili ambiente siano impostate

---

## 📞 Contatti

Per problemi durante migrazione:
- Controlla questa guida
- Verifica logs Railway
- Testa ogni passo prima di continuare
