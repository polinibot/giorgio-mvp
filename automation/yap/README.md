# YAP Worker

Automazione Playwright per inserire una pratica Giorgio nell'agenda YAP.

## Flusso comune

1. Login su `https://yap.mmbsoftware.it`.
2. Apertura diretta di `#!/agenda`.
3. In `--commit`, click su uno slot vicino all'orario richiesto per aprire il popup.
4. In `--commit`, compilazione di `Cosa`, `Quando`, `dalle`, `alle` e tag quando riconosciuto.
5. Screenshot di controllo.
6. Salvataggio reale solo con `--commit`.

## Modalita sicura

Di default il worker non apre il popup appuntamento, perche YAP crea/modifica una bozza gia all'apertura. La modalita sicura valida payload, login e agenda, poi produce uno screenshot:

```powershell
$env:YAP_USERNAME="..."
$env:YAP_PASSWORD="..."
node automation/yap/yap-worker.mjs --payload-file automation/yap/sample-payload.json
```

## Da una pratica Giorgio

```powershell
$env:YAP_USERNAME="..."
$env:YAP_PASSWORD="..."
$env:API_BASE_URL="https://<backend>"
$env:GIORGIO_TELEGRAM_USER_ID="<telegram_id>"
node automation/yap/yap-worker.mjs --practice-id 123
```

## Salvataggio reale

Usare solo quando si vuole inserire davvero l'appuntamento:

```powershell
node automation/yap/yap-worker.mjs --practice-id 123 --commit
```

## Contesti

La parte comune apre e compila l'appuntamento solo in `--commit`. La parte per contesto oggi decide il tag e il testo appuntamento:

- `officina` -> tag preferito `officina`
- `carrozzeria` -> tag preferito `carrozzeria`
- `revisione` -> tag preferito `revisione`

Le sezioni operative sono gia nel mapping `lavorazioni`. Quando saranno confermati i passaggi successivi nel gestionale, il worker puo aggiungere moduli dedicati per officina, carrozzeria e revisione senza cambiare il flusso comune.

## Note tecniche

- Gli ID YAP sono dinamici, quindi il worker usa testo visibile, campi riconosciuti da valore e coordinate della griglia.
- YAP mostra spesso slot visuali da 20 minuti; in `--commit` il worker clicca uno slot vicino e poi forza `dalle/alle` nel popup.
- Il dry-run non apre il popup, per evitare bozze involontarie nel gestionale.
- Gli screenshot finiscono in `automation/artifacts/yap`.

## Recovery di appuntamenti bloccati da ODL

Se `yap-delete-appointment.mjs` risponde `blocked_by_odl`, l'appuntamento non si puo cancellare direttamente perche e' legato a un ordine di lavoro.

La sequenza corretta e':

1. eliminare prima l'ODL collegato con `node automation/yap/yap-delete-linked-odl.mjs --date YYYY-MM-DD --search TESTO`
2. rilanciare `node automation/yap/yap-delete-appointment.mjs --date YYYY-MM-DD --search TESTO`

Il dialog di conferma ODL osservato e': `Confermi di voler eliminare l'ordine di lavoro?`
