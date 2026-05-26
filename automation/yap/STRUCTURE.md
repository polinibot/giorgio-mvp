# Struttura YAP (semplificata)

## Usa questi (produzione)

| File | Scopo |
|------|--------|
| `yap-worker.mjs` | Automazione agenda (dry-run / commit) |
| `lib/yap-shared.mjs` | Login, navigazione agenda |
| `lib/yap-mapping.mjs` | Regole Giorgio → YAP (Node) |
| `lib/yap-dedup.mjs` | Anti-doppioni |
| `run-dry-batch.mjs` | Test dry-run su sample |
| `build-management-plan.mjs` | Shadow plan offline |

## Read-only / discovery (tenere)

| File | Scopo |
|------|--------|
| `yap-readonly-day-scan.mjs` | Scan giorno senza click |
| `yap-rpc-interceptor.mjs` | Trace RPC popup |
| `yap-pratica-odl-probe.mjs` | Verifica pratica/ODL |
| `yap-agenda-inspector.mjs` | Ispezione popup singolo |

## Analisi offline

| File | Scopo |
|------|--------|
| `analyze-automatismi.mjs` | Automatismi YAP da trace |
| `build-mapping-preview.mjs` | Preview da JSON file |
| `audit-agenda-v1.mjs` | Validazione regole |

## Canonici (non cancellare)

- `analysis/yap-giorgio-bridge-mapping-v1.json`
- `analysis/yap-full-management-mapping-v1.json`
- `analysis/yap-evidence-dataset.json`
- `sample-payload*.json`

## Archivio (`archive/`)

Script fase 1 esplorazione (search, inspector vecchi, bat con credenziali hardcoded).
Non servono per il flusso produzione.

## Mini-app ↔ YAP

- Backend: `GET /practices/{id}/yap-mapping-preview` (`backend/yap_mapping.py`)
- UI: sezione "Anteprima agenda YAP" nel dettaglio pratica (solo API reale, non preview browser)
