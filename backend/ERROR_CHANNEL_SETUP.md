# Configurazione Canale Errori Telegram - Guida Rapida

## 🎯 Obiettivo
Ricevere notifiche automatiche su Telegram quando le automazioni YAP falliscono.

## ⚡ Metodo Rapido (Automatizzato)

### 1. Esegui lo script di setup
```powershell
cd C:\Users\Anas\giorgio\backend
$env:PYTHONPATH = "C:\Users\Anas\giorgio\backend"; python setup_error_channel.py
```

Lo script ti guiderà passo-passo e aggiornerà automaticamente il `.env`.

### 2. Testa la configurazione
```powershell
$env:PYTHONPATH = "C:\Users\Anas\giorgio\backend"; python test_error_channel.py
```

---

## 📋 Metodo Manuale (Se lo script fallisce)

### Step 1: Crea il Canale Telegram
1. Apri Telegram (app o web.telegram.org)
2. Clicca su **"Nuovo Canale"** (o "New Channel")
3. **Nome**: `Giorgio Errors` (o quello che preferisci)
4. **Descrizione**: `Errori automazioni YAP`
5. Tipo: **Canale Privato** (più sicuro)
6. Clicca **Crea**

### Step 2: Aggiungi il Bot come Amministratore
1. Nel canale, vai su:
   - **Info Canale** → **Amministratori** → **Aggiungi Amministratore**
2. Cerca il tuo bot (es. `@GiorgioBot`)
3. **IMPORTANTE**: Abilita questi permessi:
   - ✅ Invia messaggi
   - ✅ Invia media
   - ✅ Aggiungi membri
4. Clicca **Aggiungi**

### Step 3: Ottieni l'ID del Canale
Metodo A - Via API:
1. Vai su: `https://api.telegram.org/bot<IL_TUO_TOKEN>/getUpdates`
   (sostituisci `<IL_TUO_TOKEN>` con il token del bot)
2. Cerca `"chat":{"id":-100...`
3. Copia il numero (es: `-1001234567890`)

Metodo B - Via Bot:
1. Aggiungi il bot `@userinfobot` al canale
2. Invia un messaggio qualsiasi nel canale
3. Il bot risponderà con l'ID

### Step 4: Configura il .env
Aggiungi al file `backend/.env`:
```env
TELEGRAM_ERROR_CHANNEL_ID=-1001234567890
```

### Step 5: Testa
1. Avvia il backend: `python main.py`
2. Chiama l'endpoint di test:
   ```bash
   curl -X POST http://127.0.0.1:8000/yap/test-error-channel
   ```
   Oppure vai con il browser su: `http://127.0.0.1:8000/yap/error-channel-status`

---

## 🔧 Comandi Utili

### Verifica stato configurazione
```powershell
# Via API
Invoke-RestMethod -Uri "http://127.0.0.1:8000/yap/error-channel-status"

# Via script Python
$env:PYTHONPATH = "C:\Users\Anas\giorgio\backend"; python test_error_channel.py --check-only
```

### Invia messaggio di test personalizzato
```powershell
$env:PYTHONPATH = "C:\Users\Anas\giorgio\backend"; python test_error_channel.py --custom "Prova messaggio"
```

### Test completo con messaggi di esempio
```powershell
$env:PYTHONPATH = "C:\Users\Anas\giorgio\backend"; python test_error_channel.py
```

---

## 🐛 Risoluzione Problemi

### "Il bot non può accedere al canale"
- Il bot non è stato aggiunto come amministratore
- Soluzione: Riaggiungi il bot come admin con tutti i permessi

### "Bad Request: chat not found"
- L'ID del canale è sbagliato
- Soluzione: Ricontrolla l'ID (deve iniziare con `-100`)

### "Unauthorized"
- Il token del bot è sbagliato o il bot è stato eliminato
- Soluzione: Crea un nuovo bot con @BotFather

### Non ricevi messaggi reali ma i test funzionano
- Verifica che `API_BASE_URL` sia configurato nei worker YAP
- Verifica che il backend sia raggiungibile dai worker

---

## 📱 Formato Messaggi di Errore

Quando i worker YAP falliscono, riceverai messaggi come:

```
🚨 Errore YAP Automation

📋 Practice ID: 123
👤 Cliente: Mario Rossi (AB123CD)
📅 Appuntamento: 2026-05-30 14:30
🔧 Worker: yap-worker.mjs

❌ Errore:
TimeoutError: Element not found after 30s

📄 Stack Trace:
Traceback (most recent call last):
  File "yap-worker.mjs", line 456...
```

Con allegato uno screenshot dello stato del browser al momento dell'errore.

---

## 🔒 Sicurezza

- Mantieni il canale **privato**
- Non condividere l'ID del canale pubblicamente
- L'ID inizia sempre con `-100` per i canali privati
- Lo screenshot potrebbe contenere dati sensibili: limita l'accesso al canale

---

## 📞 Supporto

Se hai problemi:
1. Verifica che il bot funzioni: `@BotFather` → `/mybots` → seleziona il tuo
2. Verifica che il bot sia admin del canale
3. Controlla i log del backend: `python main.py` deve mostrare "Running in DEBUG mode"
