# Domande cliente YAP — stato

Tutte le domande indispensabili hanno **risposta**. Non serve altro per procedere con agenda V1 (preview + regole tag).

---

## Risposte ricevute (2026)

### 1. Tre contesti (officina + carrozzeria + revisione) — tag agenda

**Risposta:** **tutti** i tag dei reparti spuntati.

Implementazione Giorgio:
- `officina` → chip `officina`
- `revisione` → chip `revisione`
- `carrozzeria` → chip `pneumatici` (+ `preventivo` se tipo pratica = preventivo)

---

### 2. Campo Cosa / titolo in agenda

**Risposta:** Giorgio **compila i dati strutturati** (mini-app); **YAP in agenda mostra da solo** ciò che ritiene corretto (barra/titolo possono differire dal popup).

Implementazione Giorgio:
- Automazione può proporre un valore Cosa (best-effort da targa + righe mini-app).
- Anteprima: confidence `indicative` se non è revisione pura.
- Operatore verifica in YAP; non forziamo il titolo barra da regole Giorgio.

Eccezione confermata da evidenza: **revisione pura** (solo contesto revisione) → Cosa `REVISIONE`.

---

### 3. Testo nelle righe vs contesti mini-app

**Risposta:** **Non** si usano le righe come “messaggio Telegram” o intuizione sul testo. La mini-app esiste per evitare disguidi: **fonte di verità = checkbox contesti** (+ campi per sezione compilati dall’operatore).

Implementazione Giorgio:
- **Rimossa** eccezione “Frigor” (tag `revisione` solo perché la parola revisione compare nel testo con sole carrozzeria spuntata).
- I tag dipendono **solo** da `practice.contexts`, mai dal contenuto delle descrizioni.

---

## Già deciso in precedenza

- `comunicato` mai automatico.
- `preventivo` automatico se preventivo carrozzeria.
- FD897LP: officina + revisione → tag `officina` + `revisione`.
- Ore / materiali / ricambi fuori popup agenda (ODL dopo save YAP).

---

## Serve altro dal cliente?

**No** per mapping agenda V1 e anteprima. Eventuali affinamenti solo dopo primi sync reali in dry-run (es. ordine chip in UI YAP).
