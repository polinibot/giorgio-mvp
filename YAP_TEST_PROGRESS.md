# YAP Test Progress

**Sessione**: 2026-06-11  
**WORKER_BUILD deployato**: `2026-06-11c-delete-time-fallback`  
**WORKER_BUILD commit locale (non deployato)**: `2026-06-11d-audit-locator-click` (0ae8ade)  
**Auth**: X-Smoke-Secret  
**Pratiche test create**: 352(08:00), 353(09:00), 354(08:20), 355(08:40), 356(09:20), 357(09:40), 358(T12 slot collision), 359(T13 stress)

## Checklist

### Fase 1 — Veicolo
- [x] **T1 — Sync base con veicolo reale** (practice 354, 08:20, officina) → `partial_synced`
- [x] **T2 — Idempotenza** (re-sync practice 354) → dedup `plate_time_match` ✅
- [ ] **T3 — Pratica senza targa** → SKIP: backend richiede `plate_confirmed` min 5 char (impossibile da API)

### Fase 2 — Tag e popup
- [ ] **T4 — Tag corretti** → non testato formalmente (popup auto-chiude, difficile verificare)
- [ ] **T5 — Tag ereditati** → skip per ora
- [ ] **T6 — Righe preventivo** → skip per ora

### Fase 3 — Preventivo / ODL
- [ ] **T7 — ODL** → popup auto-chiude quando appointment salvato → `openedPractice=false`; noto come bug noto
- [x] **T8 — Audit endpoint** → ⏳ BLOCCATO su deploy `2026-06-11d-audit-locator-click`  
  Fix: `clickAgendaEventRobust` usa ora Playwright locator per `.fc-time` (commit 0ae8ade — da pushare)

### Fase 4 — Cancellazione
- [x] **T9 — Delete pulito** (practice 354) → `status: deleted`, time-only fallback confermato ✅
- [x] **T10 — Delete con preventivo** (practice 356) → `status: deleted`, time-only fallback ✅
- [x] **T11 — Delete + re-sync** (practice 357, via manual-delete) → re-sync OK `partial_synced` ✅

### Fase 5 — Robustezza
- [x] **T12 — Slot occupato** (practice 358 su 09:40 di 357) → **BUG RILEVATO**: primo sync crea duplicato (dedup missa), secondo sync/dry-run correttamente hitта. Duplicato rimosso. ⚠️
- [x] **T13 — Stress sequenziale** (352, 357, 359 in serie) → tutti `partial_synced`, nessun crash ✅

### Finale
- [x] **PULIZIA TOTALE** ✅
  - Pratiche 353-359 eliminate (status=deleted in Giorgio)
  - Pratica 352 eliminated (status=deleted)
  - Sweep manuale slot 08:00-10:20 su 2026-11-24: confermato pulito
  - Evento orfano 09:00 (353) rimosso da YAP manualmente

### Mini-app UI
- [ ] **Smoke test produzione** → in corso (`node scripts/run-prod-smoke.mjs`)

## Bug rilevati
1. **T12 slot collision**: il dedup missa quando due pratiche diverse provano lo stesso slot in rapida successione (la prima scrive, la seconda trova l'evento nel scan solo in dry-run successivo). Da investigare timing dedup vs write nel worker.
2. **ODL / popup auto-chiude**: quando il popup si chiude automaticamente dopo il salvataggio, il worker non può navigare alla pratica collegata. `openedPractice=false`.
3. **Tutti i titoli come icone "V"**: YAP rende il `.fc-title` come font-icon. Fix applicati in dedup (Pass 2 time-only) e delete (time-only fallback). Audit fix in deploy.

## Stato pratiche test
Tutte le pratiche (352-359) hanno status=deleted in Giorgio.  
Tutti gli appuntamenti YAP creati sono stati rimossi.
