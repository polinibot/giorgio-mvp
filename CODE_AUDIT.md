# Giorgio — Exhaustive Code Audit

Scope audited: Python backend (`backend/*.py`, production code), React mini-app security surface (`mini-app/src/App.js`), deployment/config (`Dockerfile`, `docker-compose.yml`, `railway.toml`, `.gitignore`, `start_production.py`), and the seed helper. Node YAP automation scripts (`automation/yap/*.mjs`) were treated as a trust boundary (invoked as subprocesses) but not line-audited individually.

This is a maximize-coverage pass: low-confidence and speculative findings are included and marked as such. Findings are grouped by file, ordered by severity within each file.

---

## backend/main.py

### `[SEVERITY] HIGH` · `[CONFIDENCE] High` · `[LOCATION]` lines 250–269, 1477–1478
- `[ISSUE]` Broken access control / IDOR: in `GET /mini-app/data`, any whitelisted user can take ownership of another user's DRAFT practice by supplying its `practice_id` plus a matching `plate_confirmed`; `_can_access_draft_via_plate_compat` requires no signed token and plates are low-entropy/guessable, after which `_repair_practice_owner_via_plate_compat` rewrites `created_by_telegram_id` to the caller.
- `[FIX]` Remove the plate-based ownership "repair" path entirely, or gate it behind a valid signed `access_token`; never reassign `created_by_telegram_id` based on attacker-supplied, low-entropy data.

### `[SEVERITY] HIGH` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 2341–2371 (`manual_delete_yap_appointment`)
- `[ISSUE]` Destructive operation without resource scoping: any whitelisted user can delete an arbitrary YAP appointment by `date`+`search` (note `del user_data` at line 2349 — the identity is explicitly discarded), with no check that the appointment/practice belongs to them.
- `[FIX]` Require the appointment to map to a practice owned by the caller, or restrict this endpoint to an admin/worker role.

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` line 1362 (and write at 1363–1370)
- `[ISSUE]` Path traversal via uploaded `file.filename`: `ext = file.filename.rsplit(".",1)[-1]` can contain `/` and `..` (e.g. filename `x.jpg/../../evil`), and `ext` is concatenated into `temp_path = storage/photos/{uuid}.{ext}`, allowing a write outside `storage/photos`.
- `[FIX]` Whitelist the extension (`ext = ext if ext.lower() in {"jpg","jpeg","png","webp"} else "jpg"`) or derive it from the validated `content_type`; never trust client filename in a path.

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 1183–1242 (`_run_yap_script`), called e.g. 1719, 2302
- `[ISSUE]` Argument injection: user-controlled `search` (`plate_confirmed`/`customer_name`) is passed as a CLI value to the Node script via `--search <value>`; a value beginning with `--` (e.g. customer name `--commit`) could be parsed as a flag by the worker. (No shell injection — `create_subprocess_exec` is used — but argv injection remains.)
- `[FIX]` Pass values using a `--key=value` form or `--` end-of-options separator, and validate/escape `search` before spawning.

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 1184–1242 (hidden `db.commit()` at 1238)
- `[ISSUE]` `_run_yap_script` receives the request-scoped `Session` and calls `db.commit()` to persist YAP session-state; this commits any other pending ORM changes in that session prematurely, coupling unrelated transactional state to a side-effecting subprocess helper.
- `[FIX]` Use a separate, dedicated DB session/connection for session-state persistence rather than the request session.

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 73, 226–230, 1184 (`YAP_RUN_LOCK`)
- `[ISSUE]` A single global `asyncio.Lock` serializes every YAP operation across all users; with worker timeouts of 150–240s (lines 1996, 2072, 2213) one slow run blocks all other sync/audit/delete requests, creating an availability bottleneck and request pile-up.
- `[FIX]` Move YAP automation to a background queue/worker with per-session concurrency, or shard the lock per YAP session; return 202/async status to the UI instead of holding the request.

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 75–76, 932–955 (in-memory caches)
- `[ISSUE]` `YAP_PRECHECK_CACHE` / `YAP_PREVIEW_CACHE` are process-global dicts with only lazy per-key expiry and no size cap (unbounded growth = memory leak), and they are per-process so results are inconsistent across multiple uvicorn workers/replicas.
- `[FIX]` Use a bounded LRU (e.g. `cachetools.TTLCache(maxsize=...)`) or a shared cache (Redis); add a max-entries cap and periodic eviction.

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Low` · `[LOCATION]` lines 2439–2459 (`/yap/error-channel-status`)
- `[ISSUE]` This endpoint has no auth dependency and returns configuration state plus a 15-char preview of the Telegram error channel ID — minor information disclosure of internal infra.
- `[FIX]` Require `require_yap_internal_auth` (as the sibling error endpoints do) and drop the `channel_id_preview` field.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 101–108 (CORS)
- `[ISSUE]` `allow_credentials=True` combined with `allow_methods=["*"]`, `allow_headers=["*"]`, and a `localhost`/`127.0.0.1` origin regex is broadly permissive; the localhost regex is active in production too.
- `[FIX]` Restrict methods/headers to those actually used; gate `LOCAL_DEV_ORIGIN_REGEX` behind `DEBUG`.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 28–45 (slowapi fallback)
- `[ISSUE]` If `slowapi` is unavailable the fallback `Limiter.limit` becomes a no-op, silently disabling all rate limiting with no startup warning.
- `[FIX]` Log a prominent warning when the fallback is used, or fail fast in production if rate limiting is required.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 93–98 (`_initialize_database`)
- `[ISSUE]` Database initialization swallows all exceptions and lets the app start anyway, turning a fatal DB/migration problem into a flood of later 500s.
- `[FIX]` Re-raise on init failure (fail fast) so the orchestrator restarts/holds the container.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 2538–2589 (`create_section`)
- `[ISSUE]` `context_value = section_data["context"]` is stored without validating it against the `Context` enum; an invalid value reaches the DB flush and surfaces as a 500 instead of a 400.
- `[FIX]` Validate `context` against `Context` up front and return 400 on mismatch.

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 147–178 (`serialize`)
- `[ISSUE]` Generic serializer reflects every non-underscore ORM attribute into the response (including `created_by_telegram_id`, audit fields), risking accidental exposure if new sensitive columns are added later.
- `[FIX]` Serialize via explicit allow-lists / Pydantic response models per endpoint.

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 1288–1319, 1633–1680 (read-modify-write endpoints)
- `[ISSUE]` Practice mutations perform read-modify-write with no row locking; concurrent updates can clobber each other (last-writer-wins) on Postgres.
- `[FIX]` Use `SELECT ... FOR UPDATE` (`with_for_update()`) or optimistic concurrency (version column) for mutating endpoints.

---

## backend/config.py

### `[SEVERITY] HIGH` · `[CONFIDENCE] High` · `[LOCATION]` config.py line 17 + main.py lines 353–372 (`_enforce_whitelist`)
- `[ISSUE]` Fail-open authorization: when `whitelist_telegram_ids` resolves to empty (unset, blank, or unresolved `${...}` placeholder — see config.py lines 61–62), `_enforce_whitelist` allows **all** authenticated Telegram users and merely logs "whitelist is empty - all users allowed".
- `[FIX]` Fail closed in production: if the whitelist is empty while `DEBUG=False`, deny all access (or refuse to boot).

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` config.py line 31 + main.py lines 317–350
- `[ISSUE]` If `DEBUG=True` is ever set in production, auth degrades dramatically: invalid/absent Telegram `initData` is accepted and the unverified `X-Telegram-User-Id` header (or `user_id` query param) is trusted as identity (main.py 333–347), and the whitelist is bypassed (main.py 358–359) — full impersonation.
- `[FIX]` Ensure `DEBUG` can never be enabled in production builds; add a startup assertion that `DEBUG` is False when a production `DATABASE_URL`/host is detected.

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 126–131 (SECRET_KEY handling)
- `[ISSUE]` Missing `SECRET_KEY` in production only logs a warning; the failure is deferred to request time where `SecurityService._practice_access_secret()` raises and yields 500s, instead of failing fast at boot.
- `[FIX]` Raise at startup if `DEBUG=False` and `SECRET_KEY` is empty.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` line 21 (`telegram_init_data_max_age_seconds = 86400`)
- `[ISSUE]` A 24-hour acceptance window for Telegram `initData` is a long replay window for a stolen `initData` string.
- `[FIX]` Reduce to a short TTL (Telegram commonly uses ~1h or less) unless a longer session is justified.

---

## backend/database_sqlite.py

### `[SEVERITY] HIGH` · `[CONFIDENCE] High` · `[LOCATION]` lines 163–345 (`create_tables`) + concurrent startup (bot.py:470, main.py:95)
- `[ISSUE]` Destructive, non-atomic migration runs on **every** startup and, under the nullable-column branch, performs `DROP TABLE practices` / `RENAME` (lines 298–299); because `start_production.py` launches `bot.py` and uvicorn simultaneously and **both** call `create_tables()`, two processes can run this DDL concurrently against the same SQLite file → "database is locked", partial migration, or data loss.
- `[FIX]` Run migrations once, in a single dedicated step (not on every boot, not from two processes); adopt Alembic (already a dependency) and wrap table rebuilds in a single transaction; have the bot skip `create_tables`.

### `[SEVERITY] HIGH` · `[CONFIDENCE] High` · `[LOCATION]` lines 46–47 (`created_by_telegram_id`, `updated_by_telegram_id` as `Integer`)
- `[ISSUE]` Telegram user IDs already exceed 2^31 and are moving toward 64-bit; storing them in `Integer` (32-bit on Postgres) will overflow/raise for large IDs, breaking creation and ownership checks for affected users.
- `[FIX]` Use `BigInteger` for all Telegram-ID columns (and any index keyed on them).

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 222–246 (recreated `practices_new`)
- `[ISSUE]` The rebuilt table re-creates only two indexes (lines 300–301) and omits the composite indexes defined on the model (`ix_practices_owner_status_created`, `ix_practices_owner_status_synced`); they are only restored later by a separate best-effort `try/except` block (lines 334–343), so a failure there silently leaves the table unindexed → slow queries.
- `[FIX]` Recreate all required indexes inside the same migration step and verify, or use Alembic with explicit, versioned schema.

### `[SEVERITY] LOW` · `[CONFIDENCE] High` · `[LOCATION]` lines 166–173
- `[ISSUE]` `UPDATE ... SET status = lower(status) ...` (and the customer_type/practice_type/context variants) run full-table writes on every startup even when already normalized — unnecessary write load and lock contention at boot.
- `[FIX]` Run these one-time normalizations as a guarded migration, not on each startup.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 14–20 (engine config)
- `[ISSUE]` No connection pool tuning / `pool_pre_ping` for SQLite path and `check_same_thread=False` allows cross-thread use; with the app's `asyncio.to_thread` usage this is workable but relies on SQLAlchemy session-per-request discipline that the YAP helper (above) violates.
- `[FIX]` Confirm one session per request and avoid sharing sessions across threads/subprocess helpers.

---

## backend/security.py

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Low` · `[LOCATION]` lines 102–114 (`validate_telegram_init_data`)
- `[ISSUE]` If `settings.telegram_bot_token` is empty, the WebApp secret is an HMAC over an empty key; combined with the empty-token deployment warning (config 112–113) this could let a crafted `initData` validate. Low confidence because the token is required in practice.
- `[FIX]` Refuse to validate `initData` (return False) when `telegram_bot_token` is empty, and enforce token presence at startup.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 18–25, 69–76 (debug secret/legacy token)
- `[ISSUE]` In `DEBUG`, the practice-access secret falls back to the bot token or a hardcoded `"dev-practice-access-secret"`, and legacy tokens (no expiry) are accepted; acceptable for dev but a footgun if `DEBUG` leaks to prod.
- `[FIX]` Tie these fallbacks to an explicit non-production assertion; never accept non-expiring legacy tokens when `DEBUG=False` (already the case — keep it enforced).

---

## backend/bot.py

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 213–215 (`handle_plate_action`)
- `[ISSUE]` `callback.data.split("_")` then `int(action_data[2])` will raise `IndexError`/`ValueError` on malformed callback data, producing an unhandled exception in the handler.
- `[FIX]` Validate the split length and wrap the `int()` parse; answer the callback with an error on malformed data.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 399–406 (`confirm_plate_and_open_form`)
- `[ISSUE]` The practice `access_token` (and plate) are embedded in the Mini App URL query string, where they can leak via logs, referrers, or history.
- `[FIX]` Prefer passing the token via Telegram WebApp `initData`/`start_param` or a short-lived one-time code rather than a raw query param.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` line 40 (`self.user_states = {}`)
- `[ISSUE]` Conversation state is held in an in-process dict — lost on restart and incorrect under multiple bot processes/replicas.
- `[FIX]` Persist transient state in the DB/Redis keyed by user ID.

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 267–329 (`_save_or_update_draft_practice`)
- `[ISSUE]` Multiple sequential `db.commit()` calls with no enclosing transaction; a Cloudinary failure mid-flow can leave a practice persisted without its photo (partially handled by fallback, but state is non-atomic).
- `[FIX]` Wrap the create+photo flow in a single transaction and commit once.

---

## backend/error_notifier.py

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Low` · `[LOCATION]` lines 80–86 (`_format_message`)
- `[ISSUE]` Raw `error_message` and `stack_trace` are sent to a Telegram channel with `parse_mode="Markdown"` and without escaping; stack traces can leak file paths/secrets to the ops channel, and unbalanced Markdown can break or alter rendering.
- `[FIX]` Escape Markdown (or use `MarkdownV2`/plain text) and scrub stack traces of environment values before sending.

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 143–152 (singleton)
- `[ISSUE]` The notifier captures `telegram_bot_token`/`channel_id` at first instantiation; later env changes are ignored.
- `[FIX]` Read config per-send or provide a reset hook.

---

## backend/automation_service.py

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 22–31 (`_normalize_phone`)
- `[ISSUE]` `+39` is prepended for numbers starting with `3` and length 9 **or** 10; Italian mobiles are 10 digits, so the 9-digit branch can produce malformed numbers fed downstream to YAP.
- `[FIX]` Tighten to the correct length rules (or reuse the validated `normalize_phone_value` from `models.py`).

### `[SEVERITY] LOW` · `[CONFIDENCE] High` · `[LOCATION]` line 365 (`export_practices_for_automation`)
- `[ISSUE]` Uses `print(...)` for error reporting instead of the module logger, so failures are invisible in structured logs.
- `[FIX]` Replace with `logger.warning(...)`.

---

## backend/yap_mapping.py

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 125–130 (`add_minutes`)
- `[ISSUE]` `add_minutes` parses `time_str` with `split(":")`; if ever called with a YAP-formatted `HH.MM` (dot) value it would `int("09.30")` → unhandled `ValueError`. Current callers pass colon form, so latent.
- `[FIX]` Normalize/validate the input format inside `add_minutes` and handle both separators.

---

## backend/ocr_service.py

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 77–90 (Tesseract loop)
- `[ISSUE]` `data.get('conf', [])[i]` indexes the confidence list by the text-list index; if Tesseract returns mismatched list lengths this raises `IndexError` (caught by the outer handler, returning empty OCR rather than the best partial result).
- `[FIX]` Guard with `i < len(conf)` before indexing.

---

## backend/cloudinary_service.py

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 70–74 (`compress_image` fallback) and line 219 (module-level instantiation)
- `[ISSUE]` On a generic exception during compression the original (possibly very large) file bytes are returned and uploaded; and the service is instantiated at import time with possibly-empty credentials (import side effect).
- `[FIX]` Enforce a max size on the fallback path; lazily construct the client and validate credentials on first use.

---

## backend/models.py

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 209–236 (`Practice` response model)
- `[ISSUE]` `plate_confirmed`, `phone`, `customer_name` are declared non-optional, but the DB columns are nullable and drafts store `None`; if this model were ever used with `from_attributes`, validation would fail. It appears unused (endpoints use the ad-hoc `serialize()`), making it dead/misleading.
- `[FIX]` Make these `Optional` to match the schema, or remove the unused model.

---

## backend/call_seed_production.py

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 7–8
- `[ISSUE]` Hardcoded production URL and admin secret (`ADMIN_SECRET = "giorgio-seed-2026"`) committed to the repo, targeting `/admin/seed-test-practices`. No matching admin route exists in `main.py` (so the route is currently dead), but the credential is exposed and may match a real secret elsewhere/in history.
- `[FIX]` Remove the hardcoded secret (read from env), and confirm no admin seeding route is exposed in production; rotate the secret if it was ever real.

---

## start_production.py

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 24–36
- `[ISSUE]` Launches `bot.py` and uvicorn as two independent processes that both initialize the DB/migrations concurrently (see database_sqlite HIGH finding) and both hold the SQLite file; this is the trigger for the concurrent-migration race.
- `[FIX]` Run migrations once before spawning either process; have only one process own schema creation.

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 38–47 (supervisor loop)
- `[ISSUE]` Busy `while True: ... time.sleep(1)` poll with no backoff and no restart of a crashed child (it tears everything down on first child exit, relying entirely on Railway to restart).
- `[FIX]` Acceptable for "restart container on any exit," but document the intent; consider a real supervisor (e.g. `honcho`/`supervisord`).

---

## Deployment / repo hygiene

### `[SEVERITY] MEDIUM` · `[CONFIDENCE] Medium` · `[LOCATION]` `railway.toml` line 19 + `config.py` line 16
- `[ISSUE]` `DATABASE_URL` defaults to SQLite (`sqlite:///./giorgio.db`); on Railway's ephemeral container filesystem this means data loss on every redeploy unless a real Postgres `DATABASE_URL` and/or a mounted volume is configured.
- `[FIX]` Require a non-SQLite `DATABASE_URL` in production (fail fast if SQLite is detected when `DEBUG=False`), and attach a persistent volume otherwise.

### `[SEVERITY] LOW` · `[CONFIDENCE] High` · `[LOCATION]` `docker-compose.yml` line 9
- `[ISSUE]` Hardcoded weak Postgres password (`password`) in the committed compose file.
- `[FIX]` Source from an `.env`/secret; keep dev defaults clearly non-production.

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` `.gitignore` line 88 vs. tracked `railway.toml`
- `[ISSUE]` `railway.toml` is listed in `.gitignore` yet is present/committed in the repo — contradictory, and risks future deploy-config drift or accidental secret commits to a file the team assumes is ignored.
- `[FIX]` Decide whether the file is tracked; if tracked, remove it from `.gitignore`; ensure it never contains real secrets (currently only `${...}` placeholders — good).

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` `Dockerfile` line 28
- `[ISSUE]` `npm install --include=dev` (not `npm ci`) ignores lockfile determinism and pulls dev dependencies into the production image (larger attack surface and image size; Chromium + full toolchain shipped).
- `[FIX]` Use `npm ci --omit=dev` where possible and prune build-only tooling from the runtime image (multi-stage build).

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` `automation/artifacts/yap/session-state.json` (+ persisted in `SystemSetting` via main.py 1232–1238)
- `[ISSUE]` YAP login session cookies are stored in plaintext on disk and in the DB (`yap_session_state`); anyone with DB or filesystem read access obtains a live authenticated YAP session. (The artifact dir is git-ignored — good — but at-rest exposure remains.)
- `[FIX]` Encrypt session-state at rest (the `cryptography` dependency is already present) and restrict file permissions; treat it as a secret.

---

## mini-app/src/App.js

### `[SEVERITY] LOW` · `[CONFIDENCE] Medium` · `[LOCATION]` lines 9–13, 1080–1094
- `[ISSUE]` Auth identity is largely driven by URL params (`user_id`, `access_token`, `tgWebAppData`) read from `window.location`; tokens in the URL are exposed to browser history/referrers, and the `DEV_TELEGRAM_USER_ID` default (`'761118078'`) is a hardcoded real-looking ID baked into the bundle.
- `[FIX]` Prefer Telegram `initData` over URL params for identity; avoid shipping a concrete default user ID; keep `access_token` out of the address bar.

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 230, 231 (and similar literals)
- `[ISSUE]` Mojibake in user-facing strings (e.g. `'Appuntamento giÃ  assente su YAP'`) indicates a UTF-8/encoding handling defect in source literals.
- `[FIX]` Re-save the file as UTF-8 and fix the corrupted accented strings.

### `[SEVERITY] LOW` · `[CONFIDENCE] Low` · `[LOCATION]` lines 15, 1234, 926–935 (localStorage drafts)
- `[ISSUE]` Drafts (including customer PII) are stored unencrypted in `localStorage` with a manual 24h TTL; on shared devices this persists customer data client-side.
- `[FIX]` Minimize PII in drafts; clear on logout/session end; document retention.

---

## Summary (total findings per severity tier)

- CRITICAL: 0
- HIGH: 5
- MEDIUM: 12
- LOW: 23
