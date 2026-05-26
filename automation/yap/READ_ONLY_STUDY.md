# Studio YAP — solo lettura

Nessun inserimento, nessuna modifica su YAP. Obiettivo: capire struttura, tag, reparti e casi mancanti (Cofano, officina) prima di qualsiasi automazione in scrittura.

## Cosa è sicuro vs da evitare

| Azione | Sicuro? | Note |
|--------|---------|------|
| Login + navigazione calendario (mese/giorno) | Sì | Solo lettura navigazione |
| `yap-agenda-search.mjs` (API/traffic) | Sì | Non tocca UI appuntamenti |
| `yap-network-sniffer.mjs` | Sì | Ascolta JSON in background |
| `yap-readonly-day-scan.mjs` | Sì | Elenca eventi del giorno **senza click** |
| Click su appuntamento **esistente** → popup dettagli | Sì* | Solo visualizzazione; chiudere con `Esc`, **mai** "Salva" |
| `yap-precise-inspector` / `yap-deep-inspector` / `yap-agenda-inspector` | Sì* | Aprono popup esistenti; non salvare |
| `yap-worker.mjs` (default, senza `--commit`) | Sì | Non apre popup, solo screenshot agenda |
| Doppio click su slot **vuoto** | **No** | YAP può creare bozza |
| Pulsante "Nuovo appuntamento" | **No** | Apre form di inserimento |
| `yap-worker.mjs --commit` | **No** | Scrittura reale |

\* Aprire un popup esistente è lettura se non si modifica nulla e non si clicca Salva.

## Priorità di studio (precisione massima)

### A. Trovare Cofano (15/03) e officina (20/03) — senza UI click

1. **Scan giornaliero read-only** (titoli barra + classe colonna):
   ```powershell
   $env:YAP_USERNAME="..."; $env:YAP_PASSWORD="..."
   node automation/yap/yap-readonly-day-scan.mjs --date 2026-03-15
   node automation/yap/yap-readonly-day-scan.mjs --date 2026-03-20
   ```
   Output: `analysis/readonly-scan-YYYY-MM-DD.json` — cercare telefono/targa nei titoli.

2. **Ricerca API** (già usata per 5/9 esempi):
   ```powershell
   node automation/yap/yap-agenda-search.mjs
   ```
   Output: `analysis/agenda-message-matches-live-2026.json`

3. **Sniffer rete** su date sospette:
   ```powershell
   node automation/yap/yap-network-sniffer.mjs
   ```

### B. Confermare popup su appuntamenti noti (4 già mappati)

Ripetere ispezione **solo** se servono più dettagli (tag, note, sezione Veicolo):

```powershell
node automation/yap/yap-agenda-inspector.mjs --date 2026-03-16 --search "FX339TM" --headed
node automation/yap/yap-deep-inspector.mjs
```

Poi consolidare:
```powershell
node automation/yap/analyze-inspections.mjs
```

### C. Legenda reparti (colonne colorate)

```powershell
node automation/yap/yap-extract-legend.mjs
```

Confrontare con `analysis/yap-reparto-mapping.json`.

### D. Casi misti e tag

Per Passat e Porta posteriore: un solo run `yap-deep-inspector` (read-only) e annotare **tutti** i chip tag + classe `LCWVQRD-b-*`.

## Checklist dati da raccogliere (per ogni appuntamento)

- [ ] Titolo barra agenda (testo completo)
- [ ] Classe colonna (`LCWVQRD-b-f`, `b-r`, …)
- [ ] Campo **Cosa** nel popup
- [ ] Quando / dalle / alle
- [ ] Tag chip (tutti)
- [ ] Campi note vuoti o valorizzati
- [ ] Contesto Giorgio vs tag YAP (tabella in `STRATEGY.md`)

## File da aggiornare dopo ogni sessione di studio

1. `analysis/readonly-scan-*.json` — inventario giorni
2. `analysis/precise-inspection-results.json` / `deep-inspection-results.json` — se ispezioni UI
3. `node automation/yap/analyze-inspections.mjs` → rigenera mapping
4. Note in `STRATEGY.md` se cambia una regola

## Cosa NON fare finché lo studio non è chiuso

- `--commit` sul worker
- Test su slot vuoti
- Assumere che `carrozzeria` Giorgio = tag `carrozzeria` in YAP (non esiste nei popup visti)

## Definition of done (studio read-only)

- [ ] Cofano 15/03: titolo reale in agenda identificato (scan o API)
- [ ] Almeno 1 esempio **officina** con popup ispezionato o dati API equivalenti
- [ ] Mapping tag officina/carrozzeria/revisione/misto con confidence alta
- [ ] Legenda colonne confermata o documentata come "inferita"
- [ ] Campi lavorazione: verificato se esistono altrove in YAP (fuori popup agenda)
