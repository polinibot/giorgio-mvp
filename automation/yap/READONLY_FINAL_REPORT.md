# Report finale studio read-only YAP

Generato: 2026-05-22T13:58:33.366Z

## Stato Mapping v1

| Stato | Regole |
|-------|--------|
| accepted | 6 |
| proposed | 3 |
| blocked | 3 |

## Regole congelate (usare così)

### R001_cosa_targa_default
- **anagrafica.targa** → **popup.cosa**
- Confidence: high
- Default: Cosa = targa. Eccezione documentata: riferimento breve (RADWAN) su casi misti.

### R002_quando
- **agenda.data** → **popup.quando**
- Confidence: high

### R003_dalle_alle
- **agenda.ora + agenda.durata_minuti** → **popup.dalle / popup.alle**
- Confidence: high

### R004_tag_revisione
- **lavorazioni[].reparto=revisione OR contexts includes revisione** → **popup.tag chip**
- Confidence: high

### R005_tag_carrozzeria
- **lavorazioni[].reparto=carrozzeria** → **popup.tag chip**
- Confidence: medium
- Usare pneumatici; aggiungere preventivo se tipo_pratica=preventivo. Non aggiungere comunicato automaticamente: resta manuale dopo invio preventivo al cliente.

### R011_agenda_bar
- **anagrafica + veicolo** → **agendaBar.title**
- Confidence: high
- Composto da YAP automaticamente; non scrivere manualmente in fase 1.

## Regole proposte (da validare operativamente)
- **R007_misto**: Passat: un appuntamento, un solo tag revisione in YAP. Confermare se vale come regola generale.
- **R012_column_css**: Colonna CSS != tag. b-f giallo, b-r azzurro, b-e giallo alternativo. Non usare per decidere tag.

## Bloccate (non usare finché non c'è evidenza)
- **R008_note_fields**: Campi note popup sempre vuoti nelle ispezioni. Non mappare finche non si vede un esempio valorizzato.
- **R009_work_sections**: Non presenti nel popup agenda. Modulo diverso o post-creazione.
- **R010_cofano_revisione**: Non in agenda UI 15/03/2026. Non pianificare inserimento su quella data finche non compare in YAP.

## Esempi Giorgio

| ID | Caso | Stato |
|----|------|-------|
| 1 | Frigor | mapped_with_exception |
| 2 | Kit frizione | historical_reference |
| 5 | Passat | mapped_with_exception |
| 7 | Porta posteriore | best_aligned |
| 8 | Italtrans | best_aligned |
| 9 | Cofano revisione | blocked_not_in_ui |

## Comandi read-only

```powershell
node automation/yap/consolidate-evidence.mjs
node automation/yap/build-mapping-preview.mjs --payload-file automation/yap/sample-payload.json
node automation/yap/yap-readonly-day-scan.mjs --date YYYY-MM-DD
```

## Vietato
- yap-worker --commit
- doppio click slot vuoto
- Nuovo appuntamento
## Ultime chiusure (2026-05-22)

- Scan 2026-03-16: ricostruito da ispezione Italtrans (live scan in timeout)
- Officina Kit frizione: Cosa=DP126GZ, tag=officina (categoria O confermata via RPC)
- Cofano 15/03: resta blocked (non in agenda)
- Frigor: regola operativa carrozzeria + revisione se in lavorazioni
