# Handoff pausa progetto YAP

## Stato breve

Il progetto e' in stato **read-only/dry-run avanzato**.
Non e' stato fatto nessun inserimento reale su YAP.

## Percentuali attuali

| Area | Stato |
| --- | --- |
| Agenda YAP | 75-80% |
| Preview/dry-run | 2/3 casi live OK |
| Dedup anti-doppioni | Implementato |
| Gestione pratica | Delegata a YAP, verificata su revisione |
| ODL | Delegato a YAP in V1, verificato su revisione |
| Flusso 1:1 completo | circa 52% |

## Cosa funziona

- Mapping agenda centralizzato in `automation/yap/lib/yap-mapping.mjs`.
- Backend preview reale in `backend/yap_mapping.py`.
- Mini-app mostra "Anteprima agenda YAP" nel dettaglio pratica reale.
- Worker YAP in dry-run non scrive nulla e controlla dedup.
- Regole principali:
  - officina -> `Cosa=targa`, tag `officina`
  - revisione pura -> `Cosa=REVISIONE`, tag `revisione`
  - carrozzeria -> tag `pneumatici`
  - carrozzeria + revisione / misto -> tag `revisione`
  - preventivo carrozzeria -> `pneumatici`, `preventivo`; `comunicato` manuale dopo invio cliente

## Evidenze importanti

- `AutomatismoOdlDaPrenotazione` presente nel tenant YAP.
- `AutomatismoArticoloDocumentoFromTagPrenotazione` presente.
- Caso revisione EL733YJ: da agenda si apre "Gestione pratica" e si vede sezione "Ordini di lavoro".
- Quindi in V1 Giorgio deve puntare bene l'agenda; pratica/ODL restano gestiti da YAP.

## Dry-run

Comando batch:

```powershell
node automation/yap/run-dry-batch.mjs
```

Ultimo esito:

- officina: OK
- revisione pura: OK, dedup rilevato correttamente
- carrozzeria + revisione: timeout agenda YAP, mapping OK offline

Retry singolo Frigor:

```powershell
node automation/yap/yap-worker.mjs --dry-run --payload-file automation/yap/sample-payload-carrozzeria-revisione.json
```

## Mini-app reale

Per vedere dati reali invece dei mock in locale:

```text
http://localhost:3000/
```

La mini-app usa automaticamente l'utente dev whitelisted `761118078` su `localhost`.
Con backend reale e `REACT_APP_API_URL` corretto, nel dettaglio pratica appare "Anteprima agenda YAP".
Per forzare i mock locali usare:

```text
http://localhost:3000/?preview=1
```

## Unica domanda cliente rimasta

Nessuna domanda cliente aperta.

Risposta ricevuta:

- Nei preventivi carrozzeria, **comunicato** va messo solo dopo l'invio del preventivo al cliente.
- Per ora resta un controllo manuale della persona, cosi' prima di ordinare ricambi fa doppio controllo.

Decisione:

- Automazione puo' proporre `preventivo`.
- Automazione non inserisce `comunicato`.

## Prima di fare commit reale

1. Riprovare dry-run Frigor quando YAP non va in timeout.
2. Scegliere una pratica test sicura.
3. Fare screenshot/backup agenda del giorno.
4. Lanciare `--commit` solo con autorizzazione esplicita.
5. Verificare in YAP se pratica/ODL vengono creati come previsto.

## File principali

- `automation/yap/yap-worker.mjs`
- `automation/yap/lib/yap-mapping.mjs`
- `automation/yap/lib/yap-dedup.mjs`
- `backend/yap_mapping.py`
- `mini-app/src/App.js`
- `automation/yap/STRUCTURE.md`
- `automation/yap/DOMANDE_CLIENTE.md`
- `automation/yap/analysis/yap-full-management-mapping-v1.json`
- `automation/yap/analysis/dry-run-batch-report.json`

## Sicurezza

I raw trace RPC e i vecchi script con credenziali hardcoded sono stati rimossi dai file attivi.
Le credenziali YAP vanno comunque tenute solo in variabili ambiente:

```powershell
$env:YAP_USERNAME="..."
$env:YAP_PASSWORD="..."
```
