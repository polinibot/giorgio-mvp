# YAP Test Progress

**Sessione**: 2026-06-11  
**WORKER_BUILD atteso**: `2026-06-10w-descr-only-retry` (commit `2bd8131` + `cea94c8`)  
**Auth**: X-Smoke-Secret  
**Pratiche esistenti**: 352(08:00 officina synced), 353(09:00 carrozzeria), 354(08:20 officina), 355(08:40 carrozzeria), 356(09:20 officina+carrozzeria), 357(09:40 officina+carrozzeria)

## Checklist

### Fase 1 — Veicolo
- [ ] **T1 — Sync base con veicolo reale** (practice 354, 08:20, officina)
- [ ] **T2 — Idempotenza** (re-sync practice 354)
- [ ] **T3 — Pratica senza targa** (da creare)

### Fase 2 — Tag e popup
- [ ] **T4 — Tag corretti** (practice 354 dopo T1)
- [ ] **T5 — Tag ereditati** (practice 354 + altro orario)

### Fase 3 — Preventivo / ODL
- [ ] **T6 — Righe preventivo**
- [ ] **T7 — ODL**
- [ ] **T8 — Audit endpoint**

### Fase 4 — Cancellazione
- [ ] **T9 — Delete pulito**
- [ ] **T10 — Delete con pratica collegata**
- [ ] **T11 — Delete + re-sync**

### Fase 5 — Robustezza
- [ ] **T12 — Slot occupato**
- [ ] **T13 — Stress sequenziale**

### Finale
- [ ] **PULIZIA TOTALE**

## Pratiche di test create
- 352 (pre-esistente, synced) — da pulire
- 353, 354, 355, 356, 357 (pre-esistenti, non synced) — da pulire
