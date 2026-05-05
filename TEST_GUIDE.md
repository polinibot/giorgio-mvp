# 🧪 Guida di Test - Giorgio MVP

## Prerequisiti
- Tutti i servizi avviati con `avvio_semplice.bat`
- Tesseract OCR installato
- Bot Token configurato

## Test 1: Verifica Backend API
1. Apri browser: http://localhost:8000
2. Dovresti vedere: `{"status": "ok", "service": "giorgio-api"}`

## Test 2: Verifica Mini App
1. Apri browser: http://localhost:3000
2. Dovresti vedere l'interfaccia della Mini App (dark theme)

## Test 3: Test Bot Telegram
1. Apri Telegram
2. Cerca `@Polini_OfficinaBot`
3. Invia `/start`
4. Dovresti vedere il menu con "🆕 Nuova pratica"

## Test 4: Flusso Completo
1. Clicca su "🆕 Nuova pratica" nel bot
2. Invia una foto di una targa
3. Il bot dovrebbe rilevare la targa e chiedere conferma
4. Conferma la targa
5. Si aprirà la Mini App con form precompilato
6. Compila i dati e salva
7. Dovresti ricevere un riepilogo in Telegram

## Troubleshooting

### Bot non risponde
- Verifica che il processo del bot sia attivo (finestra "Bot Telegram")
- Controlla il Bot Token nel file `.env`
- Verifica che il tuo User ID (761118078) sia nella whitelist

### Mini App non si apre
- Verifica che il backend sia attivo su http://localhost:8000
- Controlla la console della Mini App per errori

### OCR non funziona
- Verifica installazione Tesseract: `tesseract --version`
- Prova con una foto più chiara della targa

### Database errori
- Verifica che il file `giorgio.db` esista in `backend/`
- Riavviare il backend ricrea automaticamente le tabelle

## Log Utile
- **Backend**: Finestra "Backend API" mostra log API
- **Bot**: Finestra "Bot Telegram" mostra log bot
- **Mini App**: Apri console del browser (F12) per errori

## Contatti
Per problemi: controlla i log delle finestre terminali aperte.
