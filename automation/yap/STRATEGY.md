# Strategia: Da Mini-App a YAP Gestionale

> **Aggiornamento v2 (maggio 2026):** regole cliente in [`DOMANDE_CLIENTE.md`](DOMANDE_CLIENTE.md). Tag da checkbox mini-app (tutti i contesti spuntati). Niente inferenza dal testo righe. Anteprima: `run-mapping-dry-test.bat`. Sezioni «misto → solo revisione» e eccezione Frigor **non** sono più policy attive.

## Obiettivo finale

Trasformare i dati raccolti nella mini-app Giorgio nel formato corretto per YAP/MMB, coprendo tutti i contesti: officina, carrozzeria, revisione e casi misti.

## Stato attuale (maggio 2026)

| Fase | Stato | Dettaglio |
|------|-------|-----------|
| **1. Ricerca** | Completata | 5/9 esempi trovati (15/03–15/04/2026) |
| **2. Ispezione UI** | Completata (parziale) | 4/5 popup estratti via browser; Cofano+revisione e officina non cliccabili in UI |
| **3. Mapping** | Completata | `analysis/yap-field-mapping.json`, `analysis/yap-reparto-mapping.json` |
| **4. Worker** | Aggiornato | Navigazione in-app, Cosa=targa, tag chip |
| **5. Testing** | Dry-run pronto | Commit reale solo dopo validazione manuale |

### File di riferimento persistenti

- [`READONLY_FINAL_REPORT.md`](READONLY_FINAL_REPORT.md) — **report finale studio read-only**
- [`analysis/yap-giorgio-bridge-mapping-v1.json`](analysis/yap-giorgio-bridge-mapping-v1.json) — **Mapping v1 congelato** (accepted/proposed/blocked)
- [`analysis/yap-evidence-dataset.json`](analysis/yap-evidence-dataset.json) — evidenze unificate
- [`MAPPING.md`](MAPPING.md) — tabella Giorgio ↔ YAP
- [`analysis/yap-giorgio-bridge-mapping.json`](analysis/yap-giorgio-bridge-mapping.json) — bozza precedente
- [`build-mapping-preview.mjs`](build-mapping-preview.mjs) — anteprima valori YAP da payload (no browser)
- [`analysis/yap-field-mapping.json`](analysis/yap-field-mapping.json) — struttura popup e regole worker
- [`analysis/yap-reparto-mapping.json`](analysis/yap-reparto-mapping.json) — colonne CSS, tag YAP, contesti Giorgio
- [`analysis/precise-inspection-results.json`](analysis/precise-inspection-results.json) — ispezione 4 appuntamenti
- [`analysis/deep-inspection-results.json`](analysis/deep-inspection-results.json) — tag chips + repartoClass
- [`analysis/supplement-inspection-results.json`](analysis/supplement-inspection-results.json) — tentativo Cofano/officina
- [`lib/yap-shared.mjs`](lib/yap-shared.mjs) — login, navigazione calendario, utility condivise

## Fase 1: Ricerca (COMPLETATA)

| # | Esempio | Data | Stato |
|---|---------|------|-------|
| 1 | Frigor Trasporti | 25/03 | Trovato |
| 2 | Kit frizione | 20/03 | API sì, UI no |
| 3 | Rumore motore | - | Non trovato |
| 4 | Cofano/paraurti | - | Non trovato |
| 5 | Passat | 23/03 | Trovato |
| 6 | Manuel/Zubani | - | Non trovato |
| 7 | Porta posteriore | 30/03 | Trovato |
| 8 | Italtrans | 16/03 | Trovato |
| 9 | Cofano+revisione | 15/03 | API sì, UI no |

## Fase 2: Ispezione — risultati confermati

### Popup "Dettagli appuntamento"

7 input text, ordine stabile:

| Campo | Formato | Esempio |
|-------|---------|---------|
| Cosa | targa/riferimento breve | `FX339TM`, `RADWAN` |
| Quando | DD/MM/YYYY | `16/03/2026` |
| dalle / alle | HH.MM | `08.20` / `08.40` |
| Note 1–2 | spesso vuoti | — |
| Tag | chip multipli | `pneumatici`, `revisione`, … |

### Titolo barra agenda (non = campo Cosa)

```
{ora} - {TARGA} - {MODELLO} - {CLIENTE} - {TELEFONO} - {ALTRO}
```

### Reparti vs tag (critico)

- **Colonna agenda** (`LCWVQRD-b-*`): giallo `b-f`, azzurro `b-r`, altro `b-e`, `b-n`, `b-a`
- **Tag popup**: operativi (`pneumatici`, `revisione`, `preventivo`, `comunicato`) — **non** equivalgono a officina/carrozzeria Giorgio

| Appuntamento | Giorgio | Colonna | Tag YAP |
|--------------|---------|---------|---------|
| Italtrans | carrozzeria | b-f | pneumatici |
| Passat | misto | b-r | revisione |
| Frigor | carrozzeria | b-r | revisione |
| Porta posteriore | carrozzeria | b-e | pneumatici, comunicato, preventivo |

### Casi misti

Un appuntamento può avere più tag chip (es. Porta). Passat (misto) mostra solo `revisione` nel popup — strategia: `single_appointment_multi_tag` quando YAP lo consente.

## Fase 3: Mapping worker

Regenerate dopo nuove ispezioni:

```powershell
node automation/yap/analyze-inspections.mjs
```

Mapping tag Giorgio → YAP (conservativo):

- `revisione` → `revisione`
- `carrozzeria` → `pneumatici` (+ `preventivo`/`comunicato` se preventivo)
- `officina` → chip `officina`
- più contesti spuntati → **tutti** i tag (v2 cliente)

## Fase 4: Worker (`yap-worker.mjs`)

- **Dry-run (default)**: login, nav a data, screenshot, `planned` JSON (cosa, quando, tag)
- **Commit**: doppio click slot, compila popup, tag chip, salva
- **Non usare** `page.goto` su `#!agenda` dopo login (perde sessione GWT)
- **Cosa** = targa uppercase, non titolo cliente+contesto
- Se un delete appuntamento torna `blocked_by_odl`, la sequenza giusta e': elimina prima l'ODL da `Gestione pratica > Ordini di lavoro`, poi rilancia il delete appuntamento.

## Fase 5: Testing

```powershell
$env:YAP_USERNAME="..."
$env:YAP_PASSWORD="..."
node automation/yap/yap-worker.mjs --payload-file automation/yap/sample-payload.json

# Commit solo su slot di test dopo controllo screenshot
node automation/yap/yap-worker.mjs --payload-file automation/yap/sample-payload.json --commit --headed
```

## Script utili

```powershell
# Ispezione mirata (5 target)
node automation/yap/yap-precise-inspector.mjs

# Ispezione supplementare (Cofano, officina)
node automation/yap/yap-supplement-inspector.mjs

# Legenda / classi CSS
node automation/yap/yap-extract-legend.mjs

# Consolida mapping
node automation/yap/analyze-inspections.mjs
```

## Checklist

- [x] Ispezione batch 4/5 popup
- [x] Tentativo supplementare Cofano + officina
- [x] `yap-field-mapping.json` e `yap-reparto-mapping.json`
- [x] Worker allineato a mapping v1 (`lib/yap-mapping.mjs`)
- [ ] Commit reale validato su YAP
- [ ] Fase successiva: gestione pratica / ordini di lavoro per ore, materiali, ricambi

## Domande ancora aperte

1. Regola generale per casi misti: un appuntamento o più appuntamenti?
2. Nei preventivi carrozzeria, `comunicato` sempre o solo se il cliente è stato avvisato?
3. Flusso post-agenda già separato: gestione pratica → ordine di lavoro.
