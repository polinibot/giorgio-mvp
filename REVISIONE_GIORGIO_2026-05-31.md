# Revisione Giorgio — bug, discrepanze, miglioramenti

Data: 2026-05-31 · Metodo: lettura diretta dei file reali (Read/Grep), confronto con `CODE_AUDIT.md` e con la storia git.

---

## TL;DR

Il codice è in buona forma. Confrontando con il tuo `CODE_AUDIT.md`, **quasi tutti i rilievi HIGH/MEDIUM risultano già corretti** nel codice attuale (commit `0bdb032 "Fix security audit findings"`). Restano alcuni punti di sicurezza che sono stati resi *opt-in* invece che *sicuri di default*, una fragilità nel rilevamento dell'ambiente di produzione, e qualche miglioria di igiene/architettura.

Nota di metodo importante: durante l'analisi l'ambiente sandbox mostrava i file backend come "troncati". **È un artefatto del mount, non un problema reale**: ho verificato col tool autoritativo che `main.py` (2930 righe), `config.py`, `security.py` ecc. sono integri e ben formati. Nessun file è corrotto.

---

## 1. Cosa risulta GIÀ CORRETTO rispetto a CODE_AUDIT.md

Verificato leggendo i file reali:

- **IDOR su `/mini-app/data`** (era HIGH): il percorso "repair owner via targa" è stato rimosso; ora serve ownership o token firmato (`_can_access_practice` + `_repair_practice_owner_if_needed`, main.py 296–354, 1634–1640).
- **`manual-delete` non scoped** (era HIGH): ora protetto da `require_yap_internal_auth` (main.py 2481–2492).
- **Path traversal sul filename upload** (era MEDIUM): non c'è più `file.filename.rsplit(".")` nei percorsi.
- **Argument injection `--search`** (era MEDIUM): ora si usa la forma `--search=value` + `_safe_search_arg` (main.py 943, 2442, 2499).
- **`_run_yap_script` che committava la sessione della request** (era MEDIUM): ora usa una `SessionLocal()` dedicata (main.py 1331–1392).
- **Cache YAP illimitate** (era MEDIUM): introdotto `YAP_CACHE_MAX_ENTRIES = 500` (main.py 88).
- **Telegram ID in `Integer`** (era HIGH): ora `BigInteger` (database_sqlite.py 47–48).
- **Migrazioni concorrenti** (era HIGH): aggiunto `GIORGIO_SKIP_MIGRATIONS` (main.py 108–111).
- **`serialize()` rifletteva tutte le colonne** (era LOW): ora usa allow-list esplicite per modello (main.py 175–226).
- **`validate_telegram_init_data` con token vuoto** (era MEDIUM): ora rifiuta esplicitamente se manca il bot token (security.py 89–93).
- **`add_minutes` / normalizzazione telefono** (erano LOW): gestiti separatori `.`/`:` e prefisso +39 solo su 10 cifre.
- **Igiene repo**: `.env` e `*.db` sono in `.gitignore`; la contraddizione su `railway.toml` è stata risolta con una nota esplicita (`.gitignore` 87–89).
- **Mojibake nel frontend** (era LOW): non più presente in `App.js`.

Ottimo lavoro: l'audit è stato preso sul serio.

---

## 2. Rilievi ANCORA APERTI / nuovi (in ordine di priorità)

### 🔴 A — Autorizzazione "fail-open" di default (sicurezza)
`_enforce_whitelist` (main.py 447–459): se la whitelist è **vuota**, di default **lascia passare tutti** gli utenti autenticati; il blocco è attivo solo con `GIORGIO_STRICT_WHITELIST=1`. In parallelo `config.py` (144–158), con whitelist/secret mancanti in produzione, **solo logga un errore e prosegue** l'avvio, a meno di `GIORGIO_STRICT_CONFIG=1`.

Problema: il comportamento sicuro è *opt-in*. Una singola variabile d'ambiente dimenticata (o un placeholder `${...}` non risolto, che `config.py` 61–62 converte in lista vuota) apre l'accesso a chiunque sia autenticato su Telegram.

**Fix consigliato:** invertire i default in produzione — whitelist vuota = nega tutto / non avviare. Tieni il fail-open solo se `DEBUG=True`.

### 🟠 B — Rilevamento "produzione" fragile (out-of-the-box)
`RUNNING_IN_PRODUCTION` (config.py 110–119) è `True` solo su Railway/Render/Fly o con `APP_ENV=production`. Tutte le tutele di produzione (divieto `DEBUG=True`, divieto SQLite, controllo whitelist/secret) **dipendono da questo flag**.

Conseguenza: se deployi su un **VPS generico, Docker self-hosted o un altro PaaS**, `RUNNING_IN_PRODUCTION=False` → `DEBUG=True` viene accettato, SQLite viene accettato, whitelist/secret mancanti solo "warnano". In più, in DEBUG, l'identità viene presa dall'header non verificato `X-Telegram-User-Id` (main.py 419–433) → impersonazione.

**Fix consigliato:** logica a *deny-list* invece che *allow-list*: considera produzione **a meno che** non sia esplicitamente settato `APP_ENV=development`. Oppure richiedi sempre `APP_ENV` esplicito e fallisci se assente.

### 🟠 C — Fallback auth del worker YAP
`require_yap_internal_auth` (main.py 496–528): se `yap_worker_secret` **e** `secret_key` sono entrambi vuoti, `expected_secret` è vuoto e qualunque utente whitelisted viene accettato sull'endpoint distruttivo e non-scoped `manual-delete`. Combinato con A (whitelist vuota → tutti), la catena diventa "chiunque può cancellare qualsiasi appuntamento".

**Fix consigliato:** richiedi sempre un `secret` non vuoto per gli endpoint interni YAP; in caso contrario 503/avvio bloccato.

### 🟡 D — CORS permissivo in produzione
main.py 121–128: `allow_credentials=True` con `allow_methods=["*"]`, `allow_headers=["*"]` e `allow_origin_regex` su `localhost/127.0.0.1` **attivo anche in produzione**.

**Fix consigliato:** limita metodi/header a quelli usati; abilita la regex localhost solo se `DEBUG`.

### 🟡 E — Lock globale YAP = collo di bottiglia disponibilità
`_run_yap_script` serializza **ogni** operazione YAP con un singolo `asyncio.Lock` globale (main.py 1322). Con timeout fino a 150–240s, una run lenta blocca tutte le altre richieste sync/audit/delete.

**Fix consigliato (architetturale):** spostare l'automazione YAP su una coda/worker in background e rispondere `202 Accepted` con polling di stato, invece di tenere aperta la request.

### 🟡 F — Nessun `.gitattributes` (progetto Windows)
Non esiste `.gitattributes`. Su un progetto sviluppato su Windows questo causa churn di fine-riga (CRLF/LF) nei diff git, rendendo le revisioni rumorose e a rischio di "interi file modificati". (È plausibilmente la causa dei diff anomali che ho osservato.)

**Fix consigliato:** aggiungere
```
* text=auto eol=lf
*.bat text eol=crlf
*.png binary
```
e rinormalizzare una volta (`git add --renormalize .`).

### 🟢 G — PII nei draft in `localStorage`
`App.js` usa `localStorage` (4 occorrenze) per i draft con dati cliente e TTL manuale 24h. Su dispositivi condivisi i dati persistono lato client.

**Fix consigliato:** minimizzare i PII nei draft, pulirli al logout/fine sessione.

### 🟢 H — Note minori
- `appointment_time.py`: `_round_minutes`/`normalize` ok; `add_minutes` (yap_mapping.py) costruisce `datetime(2000,1,1,h,m)` fuori dal `try`: un `h` fuori range non validato darebbe `ValueError` non gestito (input attualmente validato a monte — latente).
- `call_seed_production.py`: verificare che non resti un secret hardcoded e che nessuna route admin di seed sia esposta in prod (era MEDIUM nell'audit).
- Tre `# TODO` nei test (`test_e2e_complete.py`, `test_yap_endpoints.py`) per scenari che richiedono DB: coperture e2e incomplete.

---

## 3. Miglioramenti consigliati (oltre ai fix)

1. **CI di base che avrebbe intercettato regressioni**: aggiungere uno step `python -m py_compile backend/*.py` + `ruff`/`flake8` e `npm run build` del mini-app. Banale ma blocca file rotti/troncati prima del deploy.
2. **Endpoint/health "posture"**: estendere `/health` (o un `/ready` riservato) con un self-check che verifica whitelist popolata, `SECRET_KEY` presente, DB non-SQLite in prod — così l'ops vede subito una config insicura.
3. **Default sicuri**: rendere `GIORGIO_STRICT_*` il comportamento predefinito in produzione (vedi A/B).
4. **Pre-commit** con `.gitattributes`, `end-of-file-fixer`, `ruff`, per igiene continua.
5. **Segreti YAP a riposo**: la sessione YAP è già cifrata in DB (Fernet) — bene; assicurarsi che la `SECRET_KEY`/chiave Fernet sia gestita solo via env del provider e mai su disco.

---

## Riepilogo conteggi

| Severità | Aperti/Nuovi |
|---|---|
| 🔴 Alta | 1 (A) |
| 🟠 Media | 3 (B, C, E) |
| 🟡 Bassa | 3 (D, F, + minori) |
| 🟢 Info/Migliorie | G, H + sezione 3 |

Risolti rispetto all'audit precedente: ~18 rilievi (tutti gli HIGH e la maggior parte dei MEDIUM).
