# Mapping Giorgio ↔ YAP

> **Regole operative v2 (maggio 2026):** vedi [`DOMANDE_CLIENTE.md`](DOMANDE_CLIENTE.md) e motore [`lib/yap-mapping.mjs`](lib/yap-mapping.mjs).  
> Tag **solo** da `practice.contexts` (mini-app). Più contesti → **tutti** i tag. Cosa popup = best-effort; YAP compone la barra agenda.  
> Le sezioni sotto con Frigor/Passat/misto sono **storiche** (ispezioni 2025–2026), non regole attive.

Questo documento collega i dati che **Giorgio** produce (`management-mapping`) ai campi YAP in agenda.

**Mapping v1 congelato (usare questo):** [`analysis/yap-giorgio-bridge-mapping-v1.json`](analysis/yap-giorgio-bridge-mapping-v1.json)  
Report completo: [`READONLY_FINAL_REPORT.md`](READONLY_FINAL_REPORT.md)  
Dataset evidenze: [`analysis/yap-evidence-dataset.json`](analysis/yap-evidence-dataset.json)  
Bozza precedente: [`analysis/yap-giorgio-bridge-mapping.json`](analysis/yap-giorgio-bridge-mapping.json)

## Da dove partiamo (Giorgio)

Endpoint: `GET /practices/{id}/management-mapping`

```json
{
  "anagrafica": { "cliente_nome", "cliente_telefono", "cliente_tipo", "targa" },
  "agenda": { "data", "ora", "durata_minuti", "tipo_pratica" },
  "lavorazioni": [{ "reparto", "descrizioni", "ore_man", "materiali_euro", "ricambi", ... }],
  "note_interne": "...",
  "meta": { "practice_id" }
}
```

Esempio file: [`sample-payload.json`](sample-payload.json)

## Dove andiamo (YAP — popup agenda)

| # | YAP | Tipo | Formato |
|---|-----|------|---------|
| 1 | **Cosa** | input | Spesso **solo targa** (es. `FX339TM`) |
| 2 | **Quando** | input | `DD/MM/YYYY` |
| 3 | **dalle** | input | `HH.MM` |
| 4 | **alle** | input | `HH.MM` (fine slot) |
| 5–6 | (vuoti) | input | Non usati in fase agenda |
| 7 | **Tag** | chip | `pneumatici`, `revisione`, `preventivo`, … |

**Titolo barra agenda** (es. `8:20 - 8:40FX339TM - SPA ITALTRANS - …`) è **diverso** dal campo Cosa: YAP lo compone con modello, cliente, telefono.

## Tabella mapping proposta

| Giorgio | → YAP | Confidenza | Note |
|---------|-------|------------|------|
| `anagrafica.targa` | popup **Cosa** | Alta | uppercase |
| `agenda.data` | popup **Quando** | Alta | |
| `agenda.ora` | popup **dalle** | Alta | `14:30` → `14.30` |
| `agenda.ora` + `durata_minuti` | popup **alle** | Alta | default 20 min |
| `lavorazioni[].reparto` | popup **Tag** (chip) | Media | Vedi sotto |
| `note_interne` | gestione pratica / ODL | Fuori agenda | Non scrivere nel popup agenda |
| `lavorazioni[].descrizioni` | gestione pratica / ODL | Fuori agenda | Non scrivere nel popup agenda |
| `ore_man`, `materiali`, `ricambi` | `Gestione pratica › Ordini di lavoro › MANODOPERA / MATERIALI` | Mapping **completo** in anteprima | Scrittura worker ODL pianificata (dopo agenda) |

**Nota:** `v2_optional` / «pianificato» indicava solo che il **worker** non scrive ancora quel campo — non che la destinazione YAP mancasse. Da v2.2 ogni riga in `fieldMapping` ha `yapPath` + `writer`.

## Reparto Giorgio → Tag YAP (bozza)

| Giorgio | Tag YAP proposti | Esempio reale |
|---------|------------------|---------------|
| `revisione` | `revisione` | Passat, Frigor |
| `carrozzeria` | `pneumatici` (+ `preventivo` se preventivo) | Italtrans, Porta posteriore |
| `officina` | `officina` | Categoria O confermata via RPC |
| `misto` | `revisione` | Passat: in YAP solo `revisione` |

**Attenzione:** la colonna/colorazione agenda e i chip del popup sono due cose diverse. Non usare il colore per decidere il reparto.

## Esempi già osservati (per validare)

| ID | Giorgio | Cosa YAP | Tag YAP | OK? |
|----|---------|----------|---------|-----|
| 8 Italtrans | carrozzeria | `FX339TM` | `pneumatici` | Cosa sì, tag plausibile |
| 7 Porta posteriore | carrozzeria | `GD109AR` | `pneumatici`, `preventivo`; `comunicato` manuale dopo invio | Buon allineamento |
| 1 Frigor | carrozzeria | `GA019BC` | `revisione` | Tag ≠ pneumatici — **chiedere** |
| 5 Passat | misto | `RADWAN` | `revisione` | Cosa ≠ targa — **chiedere** |
| 2 Kit frizione | officina | (storico) `DP126GZ` in barra | popup N/D | Data YAP 2025-04-04, non 2026-03-20 |
| 9 Cofano revisione | revisione | — | — | Non in agenda UI 15/03 |

## Anteprima mapping (senza YAP)

Da payload JSON o pratica, genera i valori che **proporremmo** in YAP:

```powershell
node automation/yap/build-mapping-preview.mjs --payload-file automation/yap/sample-payload.json
```

Output: JSON con `proposedYap` da confrontare nei prossimi messaggi.

## Payload di test

- [`sample-payload.json`](sample-payload.json) — officina base
- [`sample-payload-carrozzeria-revisione.json`](sample-payload-carrozzeria-revisione.json) — carrozzeria + revisione in descrizioni (regola Frigor)

## Come validare nei prossimi messaggi

1. Incolla contesto pratica Giorgio (o id pratica).
2. Confronta con `proposedYap` dell’anteprima.
3. Rispondi: «Cosa ok / Tag sbagliato dovrebbe essere X».
4. Aggiorniamo `yap-giorgio-bridge-mapping.json` e le regole `contextToYapTags`.

## Domande aperte

Nessuna domanda cliente aperta per agenda V1.

Decisione cliente:
- `comunicato` si mette solo dopo invio preventivo al cliente.
- resta compito manuale della persona per doppio controllo prima dell'ordine ricambi.
