# PIANO ODL YAP — Handoff per esecuzione (Sonnet)

> Documento di handoff. Obiettivo: portare il worker a **scrivere davvero i campi ODL**
> (note / descrizione / MAN / MAC / materiali / ricambi / smaltimento) in modo ripetibile.
> Strategia scelta dall'utente: **automazione ODL completa su pratiche con veicolo reale**,
> pilotando la SPA via **route `#!pratica` con `Page=ODL`** + **gating su RPC**, NON via click sul tab.
>
> Generato dopo analisi diretta di codice, log reali (decodificati da UTF-16), screenshot,
> probe e artefatti di `analysis/`. Le righe `~Lxxx` sono indicative (riferirsi ai nomi funzione).

---

> **NOTA OPERATIVA PER SONNET (importante):** il worker va **letto con la file-tool (Read)
> sui path Windows** ed **eseguito su Windows**, **non letto via shell della sandbox**: nel mount
> Linux della sandbox `yap-worker.mjs` appare **troncato** (~riga 1439, a metà istruzione), quindi
> `grep`/`cat`/`git diff` da shell sandbox danno risultati fuorvianti. Il file reale su Windows è
> **integro e funzionante**. Regola: per leggere il codice usa Read; per i comandi `node …`/`git …`
> esegui sul PC dell'utente.

## 0. TL;DR — la diagnosi in una frase

Il blocco "pratica → ODL" **non è un bug di click né di timeout**: il caso di test usa una
**targa fantasma (`ZZ998ZZ`, "TEST FULL FIELDS DELETE ME")**, quindi YAP apre una **pratica-guscio
senza veicolo** (`Page:"VEICOLO"`, scheda anagrafica vuota) in cui il tab *Ordini di lavoro* esiste
ma **non può attivarsi perché non c'è né veicolo né pratica reale dietro**. Sullo **stesso codice**,
con targhe reali (EL733YJ, FK079BX) l'ODL si apre completo. → Si è ottimizzato un flusso su un input
che **non potrà mai** produrre un ODL.

**Conseguenza pratica:** prima di toccare altro codice ODL, bisogna (a) testare su **veicolo reale**
e (b) far sì che il worker **leghi un veicolo reale** alla prenotazione. Poi l'ingresso ODL diventa
un problema di routing/gating, non di "tecnica di click".

---

## 1. PROVE (perché la diagnosi è solida)

| Evidenza | Fonte | Cosa dimostra |
|---|---|---|
| Payload test = targa `ZZ998ZZ`, cliente "TEST FULL FIELDS DELETE ME" | `test-complete-fields-payload.json` | Il veicolo non esiste a sistema |
| Screenshot: **"PRATICA VEICOLO 'ZZ998ZZ'"** con tab **"Dettagli pratica ⚠️"** attiva, Telaio/Omologazione/Fabbrica/Modello e cliente **tutti vuoti** | `artifacts/yap/odl-open-test-full-fields-001-1780353212090.png` | La pratica è un guscio in modalità "inserisci veicolo" |
| Tab ridotte (mancano "Dati tecnici / Controllo / Revisione"; ODL **senza** badge "U") | stesso screenshot | Senza veicolo la pratica è degenere |
| Probe del 01/06 sullo stesso `ZZ998ZZ`: `popup:null, odlClick:null, rpcAnalysis.hitCount:0` | `analysis/pratica-odl-probe-2026-06-15-full-fields.json` | Nessun ODL raggiungibile per quella targa |
| Probe su targhe **reali**: ODL completo ("Descrizione danni / Smaltimento / Materiali / Note interne / Tempi / Totali"), tab **"Ordini di lavoro U"** (badge = ha contenuto), RPC `OdlGetAnagraficheDepositoVeicoloAction` | `analysis/pratica-odl-probe-2026-11-12-fk079bx.json` | Su veicolo reale lo stesso flusso funziona |
| "Appuntamento con tag revisione ha **già pratica collegata** e sezione ODL … YAP crea/collega pratica **da prenotazione**" | `analysis/pratica-odl-discovery-findings.json` | Pratica+ODL nascono dagli **automatismi tenant** (`AutomatismoOdlDaPrenotazione`) a partire da un veicolo reale |
| Log decodificati: `practiceOpenStrategy:"footer:3"` (10×), route `#!pratica\|{...,"Page":"VEICOLO","ShowOdlMarcatempo":false}`, `workspaceState` = `detail_form` (8×) / `practice_shell` (2×), **mai** `odl_full`; e **anche con `practiceLoadingDone:true` resta `detail_form`** | `test-output-latest-route-fix.log`, `...-no-practice-regoto.log` | Non è "ancora in caricamento": è la **`Page` della route** + assenza veicolo |
| Il worker scrive solo **`Cosa = targa` come testo** (`fillVisibleInput`, ~L1706, "Non trovo il campo 'Cosa'") e **non seleziona mai il widget Veicolo** del popup | `yap-worker.mjs` | Nessun veicolo viene legato → pratica senza veicolo |

**Falso positivo confermato:** nei report `smaltimento` risulta `written:"2"` anche in `detail_form`
(scrittura finita su un campo a caso della form anagrafica). Va eliminato (vedi F5).

---

## 2. ⛔ PRIMA DI TUTTO — sistemare lo stato GIT (bloccante, NON è codice)

Il repo è in uno stato pericoloso lasciato da un processo interrotto ("casino di Codex"):

- È stato eseguito un **`git rm -r --cached .`**: **189 file** risultano *staged come deleted*
  (0 staged non-deleted), pur essendo **tutti presenti su disco**. I tuoi 2 file YAP compaiono
  sia come `D` (staged) sia come `??` (untracked).
- C'è un **`.git/index.lock` stale** (0 byte, 01/06 11:39) che **blocca ogni operazione git**.
- **Non sono riuscito a rimuoverlo dalla sandbox** (`rm: Operation not permitted`): il lock è
  trattenuto **lato Windows**. Va sbloccato da te sul PC.

### Recovery sicuro (eseguire su Windows, in `C:\Users\Anas\giorgio`)

```powershell
# 0) BACKUP di sicurezza dell'intera cartella (consigliato prima di toccare git)
#    Copia C:\Users\Anas\giorgio altrove, oppure almeno i 2 file:
copy automation\yap\yap-worker.mjs            automation\yap\yap-worker.mjs.bak
copy automation\yap\lib\yap-shared.mjs        automation\yap\lib\yap-shared.mjs.bak

# 1) Chiudi TUTTO ciò che può tenere il lock: VS Code, Codex, GitHub Desktop,
#    terminali con un git a metà, estensioni git dell'editor.

# 2) Rimuovi il lock stale (è a 0 byte, vecchio: è sicuro)
del .git\index.lock

# 3) Annulla il rm --cached SENZA toccare i file su disco (mixed reset, NON distruttivo)
git reset

# 4) Verifica: ora deve mostrare i 2 file come "modified" + i nuovi file come untracked,
#    NON 189 deletion
git status
```

### ⚠️ Da NON fare assolutamente (rischio perdita lavoro)
- ❌ `git add -A && git commit` ora → **committerebbe la cancellazione di 189 file**.
- ❌ `git reset --hard` / `git checkout -- .` → **cancella le tue modifiche locali** a worker/shared.
- ❌ `git clean -fd` → **elimina i file untracked utili** (payload di test, probe, log).

> Nota tecnica: finché il repo è in `rm --cached`, i 2 file risultano *untracked*, quindi
> `git diff` **non mostra** le tue vere modifiche. Solo **dopo `git reset`** potrai vedere il diff
> reale con `git diff -- automation/yap/yap-worker.mjs`. (Non mi è stato possibile calcolarlo in
> modo affidabile dalla sandbox: il mount Linux serviva una copia *troncata* del worker — il file
> reale su Windows è **integro**, lo conferma il fatto che gira e produce report completi.)

---

## 2bis. ⚠️ SICUREZZA — testare senza toccare i dati dei clienti

> Il cliente ha chiesto di **non sbagliare nulla** (in particolare sui **preventivi**). Vincolo non
> negoziabile: durante i test **non si tocca nessun cliente reale e nessun preventivo reale**.
> Si lavora a **livelli di rischio crescente**, e si scrive SOLO all'ultimo, su dati di test isolati.

### Livello 0 — Tutto ciò che NON scrive = rischio ZERO
La maggior parte del piano si valida in **sola lettura**, su una pratica **già esistente**:
- **F1** (scoperta `Page=ODL` + nomi RPC), **F3/F4/F5** (routing, gating RPC, detection) si verificano
  aprendo/osservando: leggere `location.hash`, registrare le RPC, screenshot, controllare che si
  raggiunga `workspaceState:"odl_full"`. **Nessun campo scritto, nessun commit.**
- Gli automatismi YAP (`AutomatismoOdlDaPrenotazione`, quote ecc.) scattano sulla **creazione di una
  prenotazione**, NON sull'apertura in lettura di una pratica già esistente → aprire e guardare è sicuro.
- `PraticaGetOverviewAction`/`OdlGet…Action` sono **GET** (lettura). Non modificano dati.
→ ~80% del piano è validabile così, a rischio nullo.

### Livello 1 — Veicolo di TEST dedicato (solo per le scritture: F2 / F6)
Per testare la scrittura serve un veicolo **reale per YAP** ma **non un cliente vero**. I dati di test
sono **già pronti** nel payload **`test-real-vehicle-payload.json`** (cliente `TEST AUTOMAZIONE — NON
USARE`, targa `ZZ555ZZ`, marcatore G1 incluso). Due modi per ottenere il veicolo di test:

- **Modo A — preferito: lo crea il worker in F2 (nessun intervento manuale su YAP).**
  Con i guardrail **G1–G5 attivi**, F2 implementa "crea veicolo dalla targa" (YAP espone già
  *"crea un nuovo veicolo dalla targa"*, vedi `hasVehicleSearchOverlay` ~L1009) e lega il veicolo di
  test alla prenotazione. Poiché G1 consente scritture **solo** se il cliente è `TEST AUTOMAZIONE`,
  questa creazione è **fenced**: impossibile creare/scrivere su un cliente reale. → l'utente non tocca
  YAP a mano.
- **Modo B — manuale (solo se si preferisce pre-crearlo): checklist prudente.**
  1. In YAP: `Archivi`/`Banche dati` → sezione Veicoli/Anagrafiche → **Nuovo** (confermare il percorso
     esatto nella propria installazione).
  2. Inserire **solo** dati di test: cliente **`TEST AUTOMAZIONE - NON USARE`**, targa **`ZZ555ZZ`**.
  3. **NON** collegarlo ad alcun cliente reale; **NON** creare/toccare preventivi.
  4. Salvare. Ora `ZZ555ZZ` esiste → pratica + ODL si creano davvero, ma isolati.

In entrambi i casi: tutti i test di scrittura ODL si fanno **solo** su questa anagrafica; a fine test
**pulizia** con `yap-delete-appointment.mjs` poi `yap-delete-linked-odl.mjs`.
→ **Mai** usare la targa di un cliente reale per i test di scrittura.

### Guardrail da implementare nel worker PRIMA di abilitare qualsiasi scrittura
- **G1 — Hard guard "test-only":** prima di scrivere QUALSIASI campo, verificare che il cliente della
  pratica contenga un marcatore di test (es. nome include `TEST AUTOMAZIONE`, configurabile via env
  `YAP_TEST_CUSTOMER_MARKER`). Se non combacia → **abortire la scrittura** con
  `writeReport.odl.error = "refused_non_test_customer"`. Rende *fisicamente impossibile* scrivere su un
  cliente vero durante lo sviluppo.
- **G2 — Mai i Preventivi:** la navigazione va dritta all'ODL (`Page=ODL`); le scritture sono confinate
  al **pannello ODL** (scoping del DOM al contenitore ODL, vedi F5). Il worker **non** apre né scrive la
  tab *Preventivi*. → il preventivo del cliente non viene mai toccato.
- **G3 — Read-back obbligatorio:** un campo è `written:true` solo dopo riletture/conferma dal pannello
  ODL (F5.4). Evita scritture "alla cieca" nel punto sbagliato.
- **G4 — Sempre `--debug` + slot/data di test** lontani dagli appuntamenti reali; conservare gli
  screenshot prima/dopo.
- **G5 — Niente `--commit` finché G1–G3 non sono attivi.** Ordine: prima si scrivono i guardrail, poi
  si testa la scrittura.

> In sintesi: si **scopre e si valida tutto in lettura**; si **scrive solo su un'anagrafica di test**,
> con un guard che blocca i clienti veri e che non sfiora mai i preventivi.

---

## 3. Come funziona DAVVERO il flusso oggi (mappa del codice)

```
agenda → doppio slot → popup "Dettagli appuntamento"
  └─ openPracticeFromAppointment()           ~L918  (yap-worker.mjs)
       strategie: footer slot 2 (= "footer:3"), retry, poi "text"   ~L920
       clickAppointmentPopupFooterSlot()       ~L684   → click a coordinate sul footer
       waitForPracticeTransition()             ~L904
       waitForPracticeLoadingToFinish()        ~L1026  (poll su innerText "recupero/caricamento")
  └─ (YAP naviga da solo a) #!pratica|{"IdCompanyFolder":<id>,"Page":"VEICOLO",...}
       ⚠️ il worker NON costruisce la route: legge solo page.url()
  └─ writePracticeAndOdl()                    ~L1305
       getPracticeWorkspaceState()            ~L1111  → detail_form / odl_full / ... (innerText GLOBALE)
       clickOdlSection()                      ~L706   (cerca "ordini di lavoro" con rect.y<140, click coord)
       waitForOdlWorkspaceReady()             ~L1085
       loop sezioni → fillWithRetry()/fillBestEditableByKeywords()  ~L1123,~L1460
```

**3 difetti strutturali da correggere (oltre al dato di test):**

1. **Route mai pilotata.** Si apre sempre `Page:"VEICOLO"` e si tenta di cliccare il tab ODL (inerte).
   Va invece costruita la route con la **Page giusta** (`Page:"ODL"` o equivalente) + `ShowOdlMarcatempo:true`.
2. **`getPracticeWorkspaceState` usa `document.body.innerText` globale**, con ordine
   `loading → detail_form → odl_full`. I termini anagrafica (`telefono`, `ragione sociale`,
   `fabbrica (d1)`) sono **sempre** presenti nell'header pratica → ritorna `detail_form` anche quando
   l'ODL è caricato. Detection da riscrivere a **scope ristretto** (tab selezionato + marker locali ODL).
3. **Loading detection fragile.** `"recupero dettagli pratica in corso"` persiste nell'`innerText`
   anche quando l'elemento non è visibile → `waitForPracticeLoadingToFinish` non torna mai `true`.
   Va sostituita da **gating su RPC** (deterministico).

---

## 4. RPC e route note (materiale già scoperto, da riusare)

- **RPC su apertura pratica reale:** `PraticaGetOverviewAction`, `DocumentoFiscaleTableAction`,
  `PraticaDocumentoFiscaleGetOverviewAction`  (`pratica-odl-discovery-findings.json`).
- **RPC su ODL reale:** `OdlGetAnagraficheDepositoVeicoloAction` (+ modello `PraticaVeicoloOmologazione`)
  (`pratica-odl-probe-2026-11-12-fk079bx.json`). Endpoint: `POST /yap/action/<Action>`.
- **Helper già pronto:** `waitForYapAction(page, actionName, trigger, timeout)` in `lib/yap-shared.mjs`
  (~L236) — aspetta `"/yap/action/${actionName}"`. Usarlo per il gating.
- **Forma route:** `#!pratica|{"IdCompanyFolder":<num>,"Page":"VEICOLO","ShowOdlMarcatempo":false}`
  (in alcune run appare **senza** `Page`). `IdCompanyFolder` è già catturato in
  `writeReport.practiceDirectUrl` (debug).
- **Tab pratica reale (FK079BX):** Dettagli pratica · Dati tecnici · Controllo · Revisione ·
  Preventivi · **Ordini di lavoro U** · Documenti fiscali · DDT di uscita · Ordini a fornitore ·
  Notifiche · Firme. → Il badge **"U"** distingue un ODL **con contenuto** da uno vuoto.

---

## 5. PIANO PER FASI

> Ogni fase ha: **Obiettivo · Dove · Azione · Criterio di accettazione**.
> Le fasi F1→F3 sono **diagnostiche read-only su veicolo reale**: non rischiano dati.
> Comando base (NON cambiare il flusso, usare questo):
> ```powershell
> $env:YAP_USERNAME='...' ; $env:YAP_PASSWORD='...'
> node automation/yap/yap-worker.mjs --payload-file <payload> --date <YYYY-MM-DD> --time <HH:MM> --commit --debug
> ```

### F0 — Sblocco git + anagrafica di TEST  *(precondizione — leggere §2bis)*
- **Dove:** repo + anagrafica YAP di test + payload.
- **Azione:**
  1. Eseguire il recovery git della §2.
  2. Registrare **una volta** in YAP l'anagrafica di test (cliente `TEST AUTOMAZIONE — NON USARE` +
     targa di test) — vedi §2bis Livello 1. **Questa** è la sola targa per i test di *scrittura*.
  3. Creare `test-real-vehicle-payload.json` puntando a quella targa di test.
  4. Per la **scoperta** (F1) si può aprire in **SOLA LETTURA** una pratica reale già esistente
     (es. FK079BX) — ⚠️ quelle sono di **clienti veri**: solo lettura, **mai** `--commit`, mai scrittura.
- **Accettazione:** lo screenshot `practice-open-*` mostra la pratica **con veicolo reale** e il tab
  **"Ordini di lavoro U"** (badge). Se è ancora un guscio vuoto → il veicolo non è legato: vai a F2.

### F1 — Scoprire l'enum `Page` dell'ODL e i nomi RPC  *(read-only, su pratica reale)*
- **Dove:** estendere `inspect-practice-tabs.mjs` o `yap-pratica-odl-probe.mjs`.
- **Azione (in quest'ordine, fermarsi al primo che funziona):**
  1. Aprire una pratica reale, far renderizzare l'ODL col percorso che **già funziona** nel probe,
     poi leggere `window.location.hash`: se YAP aggiorna l'hash al cambio pagina interna, **leggi lì
     il valore di `Page`** (candidati attesi: `ODL`, `ORDINI_LAVORO`, `ORDINE_LAVORO`, `LAVORI`).
  2. Se l'hash non cambia: `page.waitForResponse(/\/yap\/action\/(Odl|Pratica)\w+/)` per **loggare i
     nomi RPC reali** in sequenza all'attivazione ODL (registra anche payload/response action name).
  3. In ultima istanza: scaricare il bundle GWT (`*.cache.js`, via `page.evaluate(fetch)` nel
     contesto autenticato) e **grep delle stringhe vicine a `"VEICOLO"`** per estrarre l'enum completo
     delle Page.
- **Accettazione:** hai (a) il valore stringa esatto di `Page` per l'ODL e (b) il nome dell'azione RPC
  che segna "ODL pronto" (probabile `OdlGet…Action`).

### F2 — Legare un VEICOLO reale alla prenotazione  *(il vero pezzo mancante)*
- **Dove:** flusso popup appuntamento (creazione) + `openPracticeFromAppointment`.
- **Contesto:** oggi il worker scrive solo `Cosa=targa` (testo) e lascia "Veicolo: Nessun veicolo
  selezionato". Gli automatismi `AutomatismoOdlDaPrenotazione` creano pratica/ODL **solo se c'è un
  veicolo reale**.
- **Azione (scegliere in base a F0/F1):**
  - **2A (preferita):** nel popup, usare il **widget "Veicolo"** (ricerca per targa) per **selezionare
    un veicolo esistente** prima del salvataggio. Implementare `selectVehicleByPlate(page, plate)`.
  - **2B:** se la targa non esiste, decidere policy: o si **crea l'anagrafica veicolo** (fuori scope
    se non voluto), o si **richiede pre-esistenza** e si fallisce con stato chiaro
    `vehicle_not_registered`.
- **Accettazione:** dopo il salvataggio, riaprendo la pratica il veicolo risulta legato e compaiono le
  tab complete + "Ordini di lavoro U".

### F3 — Ingresso ODL pilotato dalla ROUTE (non dal click)
- **Dove:** nuova `openOdlByRoute(page, idCompanyFolder)` in `yap-worker.mjs`; sostituisce/precede
  `clickOdlSection` dentro `writePracticeAndOdl` (~L1390).
- **Azione:**
  ```js
  // NON usare page.goto (full reload → perde stato GWT, vedi STRATEGY.md).
  // Cambiare l'hash IN-PLACE così GWT History/PlaceController reagisce senza reload.
  async function openOdlByRoute(page, idCompanyFolder, pageEnum /* da F1 */) {
    const token = encodeURIComponent(JSON.stringify({
      IdCompanyFolder: Number(idCompanyFolder),
      Page: pageEnum,            // es. "ODL" — valore esatto da F1
      ShowOdlMarcatempo: true,   // prova true: apre la vista lavorazioni/tempi
    }));
    await page.evaluate((t) => { window.location.hash = `#!pratica|${decodeURIComponent(t)}`; }, token);
    // gating su RPC invece che su testo (vedi F4)
  }
  ```
  - `idCompanyFolder` si estrae da `practiceLink.url` (già catturato).
  - Provare la coppia `{Page:"ODL", ShowOdlMarcatempo:true}`; se F1 ha dato un enum diverso, usarlo.
- **Accettazione:** dopo la navigazione, `workspaceState === "odl_full"` (con la detection nuova di F5)
  e compaiono i campi ODL editabili reali (Descrizione danni / Tempi / Materiali …).

### F4 — Gating su RPC (sostituire i poll su innerText)
- **Dove:** `waitForPracticeLoadingToFinish` (~L1026) e `waitForOdlWorkspaceReady` (~L1085).
- **Azione:** prima della navigazione registrare la promessa, poi attendere l'azione:
  ```js
  const odlReady = page.waitForResponse(
    (r) => /\/yap\/action\/(OdlGet\w+|PraticaGetOverviewAction)/.test(r.url()) && r.status() === 200,
    { timeout: 15000 }
  ).then(() => true).catch(() => false);
  await openOdlByRoute(page, idCompanyFolder, pageEnum);
  const ready = await odlReady;
  ```
  Usare `waitForYapAction()` già esistente dove comodo. Mantenere un fallback DOM ma **non** basare la
  decisione sul solo `innerText`.
- **Accettazione:** niente più attese cieche da 12s; `ready===true` correla 1:1 con ODL renderizzato.

### F5 — Riscrivere la detection di stato + eliminare i falsi positivi
- **Dove:** `getPracticeWorkspaceState` (~L1111) e il blocco scrittura campi (~L1356, ~L1460+).
- **Azione:**
  1. **Detection a scope ristretto:** determinare il **tab superiore selezionato** (classe/aria attivo,
     non l'`innerText` globale) e cercare i marker ODL **dentro il pannello ODL**, non in tutto il body.
     Riconoscere `detail_form` SOLO se il tab attivo è "Dettagli pratica".
  2. **Loading solo se visibile:** considerare "in caricamento" la stringa `recupero dettagli…` **solo**
     se l'elemento è realmente visibile (test su `getBoundingClientRect`), mai per semplice presenza in
     `innerText`.
  3. **Guard "no veicolo":** se la pratica è guscio senza veicolo (`Page:VEICOLO` + Telaio/Omologazione
     vuoti + tab "Dettagli pratica ⚠️" + ODL **senza** badge "U"), **NON tentare scritture ODL**:
     uscire con `writeReport.odl.error = "odl_unavailable_no_vehicle"`. Questo da solo **uccide il falso
     positivo `smaltimento`**.
  4. **Verifica read-back:** marcare un campo `written:true` **solo dopo** aver riletto il valore dal
     campo target nel pannello ODL e confrontato col valore atteso. Collegare il blocco `writeReport.verify`
     (oggi inutilizzato, ~L1322).
- **Accettazione:** in pratica-guscio nessun campo risulta scritto; in ODL reale ogni campo è
  `written` **e** verificato per read-back.

### F6 — Scrittura campi end-to-end + validazione ripetibile + cleanup
- **Dove:** loop sezioni (~L1460+), più script di validazione/pulizia.
- **Azione:**
  1. Su veicolo reale + ODL aperto via route, scrivere note / descrizione / MAN / MAC / materiali /
     ricambi / smaltimento; verificare ciascuno (F5.4).
  2. Validazione: 3 run consecutive sullo stesso payload reale → `workspaceState:"odl_full"` e tutti i
     campi `written+verified`.
  3. Cleanup: rimuovere appuntamento/ODL di test con `yap-delete-appointment.mjs` e
     `yap-delete-linked-odl.mjs` (sequenza: prima ODL, poi appuntamento — vedi STRATEGY.md ~L105).
- **Accettazione:** report finale senza `*_field_not_found`, `smaltimento` non più falso positivo,
  run ripetibile.

---

## 6. Cosa NON fare (per non bruciare tempo/budget)
- ❌ Non testare più con `ZZ998ZZ` / `test-full-fields-001` per validare l'ODL: **non può funzionare**.
- ❌ Non "migliorare il click sul tab ODL" in modo generico: già provato in tutte le varianti
  (locator.click, inner tab, mouse coord, dispatch DOM, doppio hop) — **non è quello il problema**.
- ❌ Non rimettere `page.goto(practiceLink.url)` sulla stessa route `Page:VEICOLO`: già provato
  (`test-output-no-practice-regoto.log`), nessun effetto. La route va **cambiata** (`Page:ODL`) e
  navigata **in-place** (hash), non con goto.
- ❌ Non toccare login / agenda / banner di stato: già robusti e fuori scope.
- ❌ Non fare `git add -A`/`commit`/`reset --hard`/`clean` (vedi §2).

---

## 7. Riferimenti rapidi

**File codice:** `yap-worker.mjs`, `lib/yap-shared.mjs`
**Probe/inspect:** `inspect-practice-tabs.mjs`, `yap-pratica-odl-probe.mjs`, `yap-rpc-interceptor.mjs`
**Delete/cleanup:** `yap-delete-appointment.mjs`, `yap-delete-linked-odl.mjs`
**Payload:** `test-complete-fields-payload.json` (⚠️ targa fantasma), `test-commit-payload.json`

**Log più utili (sono UTF-16 / output PowerShell → decodificare:
`iconv -f UTF-16 -t UTF-8 file.log`):**
`test-output-latest-route-fix.log`, `test-output-no-practice-regoto.log`,
`test-output-odl-real-click.log`, `test-output-recupero-details-wait.log`, `test-output-putresponse.log`

**Artefatti chiave:**
- `analysis/pratica-odl-probe-2026-11-12-fk079bx.json` — **ODL reale che FUNZIONA** + RPC names
- `analysis/pratica-odl-discovery-findings.json` — automatismi tenant + RPC su apertura pratica
- `analysis/pratica-odl-probe-2026-06-15-full-fields.json` — prova che `ZZ998ZZ` non raggiunge ODL
- `artifacts/yap/odl-open-test-full-fields-001-1780353212090.png` — guscio vuoto `ZZ998ZZ`

---

## 8. Sequenza operativa minima per Sonnet
1. **§2** — far sbloccare git all'utente (lock lato Windows) → `git reset` → `git diff` per vedere le
   modifiche reali ai 2 file.
2. **F0** — payload con **targa reale** + run `--debug`; confermare tab "Ordini di lavoro U".
3. **F1** — probe read-only: ricavare `Page=<enum ODL>` e il nome RPC "ODL pronto".
4. **F2** — implementare `selectVehicleByPlate` (legare veicolo reale).
5. **F3+F4** — `openOdlByRoute` (hash in-place) con gating RPC.
6. **F5** — detection a scope ristretto + guard "no veicolo" + verifica read-back (kill falsi positivi).
7. **F6** — scrittura campi + 3 run di validazione + cleanup.

> Regola d'oro: **niente è "scritto" finché non è riletto dal pannello ODL**. E **niente ODL senza
> veicolo reale**.
