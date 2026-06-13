# MISSIONE: Test esaustivo end-to-end del worker YAP — non fermarti finché non è tutto verde

Sei un agente autonomo. Lavori da solo, senza chiedere conferme all'utente. L'utente NON è disponibile: ogni decisione la prendi tu. Non ti fermi finché la checklist sotto non è completata o sei genuinamente bloccato (es. server irraggiungibile, secret mancante).

## Contesto

- Repo: `C:\Users\Anas\giorgio` (branch `main`, push = deploy automatico su Railway)
- Il backend FastAPI (`backend/main.py`) gira su Railway: `https://giorgio-mvp-production.up.railway.app`
- Il worker Playwright (`automation/yap/yap-worker.mjs`) gira DENTRO il container Railway e scrive appuntamenti reali sul gestionale YAP (`yap.mmbsoftware.it`) — è PRODUZIONE: rispetta le regole di sicurezza sotto.
- La mini-app Telegram è il client normale, ma tu NON la usi: chiami l'API direttamente.

## Autenticazione API (bypass Telegram)

Leggi `YAP_WORKER_SECRET` (o in mancanza `SECRET_KEY`) da `backend/.env`. Ogni richiesta API porta l'header:

```
X-Yap-Worker-Secret: <valore>
```

Se il secret non c'è in `backend/.env`, FERMATI subito e dillo all'utente: è l'unico prerequisito che non puoi risolvere da solo.

## Endpoint che ti servono (già verificati nel codice, non cercarli di nuovo)

| Azione | Endpoint |
|---|---|
| Lista pratiche | `GET /api/practices` |
| Dettaglio pratica | `GET /api/practices/{id}` |
| Crea pratica | `POST /practices/full` |
| Elimina pratica | `DELETE /practices/{id}` |
| Sync YAP (lancia il worker, ~60-120s) | `POST /practices/{id}/yap/sync` |
| Audit/verifica YAP | `POST /practices/{id}/yap/audit` |
| Elimina appuntamento YAP | `DELETE /practices/{id}/yap/appointment` |
| Delete manuale orfani | `POST /yap/appointment/manual-delete` |
| Ultimo crash worker | `GET /yap/last-crash` |

La risposta del sync contiene il log completo del worker (le righe `action:`/`phase:`). È la tua fonte di verità.

## REGOLE DI SICUREZZA (non negoziabili)

1. **Solo targa `CN401MV`** (VW Golf V, esiste nell'anagrafica YAP — l'aggancio veicolo è garantito). Nessun'altra targa, mai, nemmeno fittizia.
2. **Solo date di NOVEMBRE 2026** (`2026-11-XX`). Mai altri mesi: l'agenda YAP reale è in uso negli altri mesi.
3. Usa orari diversi per ogni test (08:00, 08:40, 09:20, 10:00...) per evitare collisioni tra test.
4. **Pulizia obbligatoria**: a fine missione (o se ti fermi) elimina TUTTI gli appuntamenti YAP creati e le pratiche di test create. Nessun residuo.
5. Un solo sync alla volta (c'è un lock server-side, il secondo si accoda): procedi sequenziale.
6. Non toccare eventi agenda che non hai creato tu.

## IL CICLO DI LAVORO (per ogni fix)

1. Modifica `automation/yap/yap-worker.mjs` (o backend)
2. **Bumpa `WORKER_BUILD`** (riga ~59 del worker, es. `2026-06-11a-<descrizione>`) — è il tuo marcatore di deploy
3. Commit (messaggio chiaro, in italiano) + push su `main`
4. Aspetta il deploy Railway: sleep 180s in background, poi lancia un sync e controlla che nel log compaia `build=<il tuo nuovo WORKER_BUILD>`. Se è vecchio, aspetta altri 60s e riprova (max 10 minuti, poi segnala).
5. Esegui il test, leggi il log, decidi: verde → spunta la checklist e committa il progresso; rosso → analizza, fixa, torna al punto 1.

## STEPPING STONES (obbligatorio)

Mantieni il file `YAP_TEST_PROGRESS.md` nella root del repo con la checklist sotto, stato di ogni test (✅/❌/⏳ + note di 1 riga), e committalo+pushalo **dopo ogni test completato o fix**. Se finisci i token a metà, la prossima sessione riparte da lì leggendo solo quel file. Prima di iniziare, controlla se `YAP_TEST_PROGRESS.md` esiste già: se sì, riprendi da dove era arrivata la sessione precedente, non ricominciare.

## CHECKLIST DEI TEST (in quest'ordine — i primi sono i più importanti)

### Fase 1 — Veicolo (il bug appena fixato, build `2026-06-10w` è ANTECEDENTE ai fix: verifica che il deploy contenga i commit `cea94c8` e `2bd8131`)
- [ ] **T1 — Sync base con veicolo reale**: pratica preventivo CN401MV, contesto officina, 24/11/2026. Atteso nel log: `cosa_vehicle_pick` con `sug=match`, poi (`vehicle_agenda_verify linked=true` con `source=auto_close` OPPURE verifica agenda positiva), `vehicleState=linked`, NIENTE `commit-agenda-only`, il worker prosegue su preventivo/ODL.
- [ ] **T2 — Idempotenza**: rilancia lo STESSO sync. Atteso: `dedup:hit=true`, nessun secondo appuntamento creato.
- [ ] **T3 — Pratica senza targa**: appuntamento salvato senza veicolo, nessun crash. (Campo targa vuoto — NON inventare targhe.)

### Fase 2 — Tag e popup
- [ ] **T4 — Tag corretti**: log `tags_written ok=true` con i tag attesi (`officina`, `preventivo`), e `tags_cleanup` NON deve più tentare di rimuovere il simbolo `’` (verifica che `failedRemove` sia vuoto o assente).
- [ ] **T5 — Tag ereditati**: due sync consecutivi con contesti diversi (prima `officina`+`preventivo`, poi solo `carrozzeria` su altro orario): il secondo non deve ereditare i tag del primo.

### Fase 3 — Preventivo / ODL (solo dopo che la Fase 1 è tutta verde)
- [ ] **T6 — Righe preventivo**: pratica con almeno una riga lavoro (descrizione + qtà): il write_report del worker deve confermare le righe scritte nella griglia (verifica campo per campo nel log).
- [ ] **T7 — ODL**: pratica officina con lavori: ODL creato, audit `verified=true` o ratio alto, nessun campo `missing` ingiustificato.
- [ ] **T8 — Audit endpoint**: `POST /practices/{id}/yap/audit` su una pratica già sincronizzata: coerente con lo stato reale.

### Fase 4 — Cancellazione (OBBLIGATORIA, non saltarla mai)
- [ ] **T9 — Delete pulito**: `DELETE /practices/{id}/yap/appointment` su appuntamento senza ODL: rimosso dall'agenda. Poi rilancia l'audit e verifica che l'appuntamento NON ci sia più davvero (non fidarti della sola risposta del delete).
- [ ] **T10 — Delete con pratica collegata**: delete su pratica CON preventivo/ODL collegato: deve essere bloccato o cascadare come da design (commit `f201220`), MAI lasciare orfani silenziosamente. Verifica anche il caso bulk-delete (commit `9ce3d7a`: un 409 non deve orfanare l'appuntamento YAP).
- [ ] **T11 — Delete + re-sync**: dopo un delete riuscito, un nuovo sync sulla stessa pratica deve ricreare l'appuntamento da zero senza errori di dedup.

### Fase 5 — Robustezza
- [ ] **T12 — Slot occupato**: due pratiche stesso orario: la seconda deve shiftare (`slot_scan shifted=true`) o gestire la collisione senza sovrascrivere.
- [ ] **T13 — Stress sequenziale**: 3 sync di fila su pratiche diverse: il lock server-side li serializza, tutti e 3 completano.

### Fase finale
- [ ] **PULIZIA TOTALE**: elimina ogni appuntamento YAP di novembre 2026 creato dai test e ogni pratica di test. Verifica con un ultimo audit che l'agenda di novembre sia pulita.
- [ ] Aggiorna `YAP_TEST_PROGRESS.md` con il riepilogo finale e pusha.

## Come creare le pratiche di test

Leggi prima `GET /api/practices` per trovare la pratica CN401MV esistente (era id 352, può essere cambiata). Per le altre, clona la sua struttura via `POST /practices/full` variando targa/data/ora/contesti. Guarda `backend/seed_test_practices.py` solo se il POST ti dà problemi di schema.

## ECONOMIA TOKEN (importante)

- **Non incollare mai log interi nel contesto**: la risposta del sync è grande. Salvala su file temp (`curl ... -o tmp-sync.json`) e filtra con grep/jq SOLO le righe che ti servono (`vehicle`, `tag`, `dedup`, `save`, `error`, `build`).
- Niente browser, niente screenshot: solo API.
- Le attese (deploy, sync) falle con comandi in background, non restare a pollare attivamente.
- Risposte brevi: aggiorna il progress file, non scrivere riassunti lunghi in chat.
- Commit piccoli e frequenti: sono i tuoi salvataggi.
