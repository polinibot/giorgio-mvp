import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const YAP_BASE_URL = process.env.YAP_BASE_URL || "https://yap.mmbsoftware.it";
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const YAP_SESSION_STATE = process.env.YAP_SESSION_STATE || path.join(ROOT_DIR, "automation", "artifacts", "yap", "session-state.json");
export const YAP_APPOINTMENT_DELETE_CONFIRM = "Confermi l'eliminazione dell'appuntamento?";
export const YAP_ODL_DELETE_CONFIRM = "Confermi di voler eliminare l'ordine di lavoro?";
export const DEFAULT_YAP_SLOT_MINUTES = 20;
const DEFAULT_CHROMIUM_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chrome",
];

export function getYapSlotMinutes() {
  const raw = String(process.env.YAP_SLOT_MINUTES || DEFAULT_YAP_SLOT_MINUTES).trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_YAP_SLOT_MINUTES;
}

export function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toItalianDate(isoDate) {
  const [year, month, day] = String(isoDate).slice(0, 10).split("-");
  if (!year || !month || !day) {
    throw new Error(`Data non valida per YAP: ${isoDate}`);
  }
  return `${day}/${month}/${year}`;
}

export function toYapTime(time) {
  const raw = String(time || "").trim();
  if (!raw) return "";
  if (!/^\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`Ora non valida: ${raw}. Atteso formato HH:MM`);
  }
  return raw.replace(":", ".");
}

function parseTimeToMinutes(time) {
  const raw = String(time || "").trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`Ora non valida: ${raw}. Atteso formato HH:MM`);
  }
  const [hours, minutes] = raw.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function roundToSlot(totalMinutes, slotMinutes) {
  const remainder = totalMinutes % slotMinutes;
  const lower = totalMinutes - remainder;
  const upper = lower + slotMinutes;
  let rounded = totalMinutes;

  if (remainder !== 0) {
    rounded = remainder * 2 >= slotMinutes ? upper : lower;
  }

  const maxValid = (24 * 60) - slotMinutes;
  if (rounded < 0) return 0;
  if (rounded > maxValid) return maxValid;
  return rounded;
}

export function normalizeAppointmentTime(time, slotMinutes = getYapSlotMinutes()) {
  if (!String(time || "").trim()) return "";
  const minutes = parseTimeToMinutes(time);
  const step = Number(slotMinutes) > 0 ? Number(slotMinutes) : getYapSlotMinutes();
  return formatMinutes(roundToSlot(minutes, step));
}

export function addMinutes(time, minutes) {
  if (!String(time || "").trim()) return "";
  const [hours, mins] = time.split(":").map(Number);
  const date = new Date(Date.UTC(2000, 0, 1, hours, mins + minutes, 0));
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

async function pathExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function pickChromiumExecutablePath() {
  const envCandidates = [
    process.env.YAP_CHROMIUM_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    process.env.CHROME_PATH,
  ].filter(Boolean);
  for (const candidate of [...envCandidates, ...DEFAULT_CHROMIUM_PATHS]) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function isMissingPlaywrightBrowserError(error) {
  const message = String(error?.message || "");
  return message.includes("Executable doesn't exist")
    || message.includes("download new browsers")
    || message.includes("Please run the following command");
}

async function runNodeCli(args, { cwd }) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: "pipe", env: process.env });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk || ""); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `Node CLI failed (${code})`));
    });
  });
}

export async function installPlaywrightChromium(resolveModule, cwd = ROOT_DIR) {
  const candidates = ["playwright/cli.js", "playwright/cli"];
  let cliPath = null;
  for (const name of candidates) {
    try {
      cliPath = resolveModule(name);
      if (cliPath) break;
    } catch {
      // Try next
    }
  }
  if (!cliPath) {
    throw new Error("Impossibile trovare Playwright CLI per installare Chromium");
  }
  await runNodeCli([cliPath, "install", "chromium"], { cwd });
}

export async function launchChromiumWithFallback(chromium, baseLaunchOptions, { resolveModule, cwd = ROOT_DIR } = {}) {
  const preferredPath = await pickChromiumExecutablePath();
  const launchOptions = preferredPath
    ? { ...baseLaunchOptions, executablePath: preferredPath }
    : { ...baseLaunchOptions };

  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    if (!resolveModule || !isMissingPlaywrightBrowserError(error)) throw error;
    await installPlaywrightChromium(resolveModule, cwd);
    return chromium.launch({ ...baseLaunchOptions });
  }
}

// Directory profilo Chrome persistente: i cookie IAP sopravvivono tra i run senza dover
// catturare manualmente il cookie di sessione (che è HttpOnly e non esposto da storageState).
export const YAP_CHROME_PROFILE_DIR = process.env.YAP_CHROME_PROFILE_DIR
  || path.join(ROOT_DIR, "automation", "artifacts", "yap", "chrome-profile");
export const YAP_PROFILE_LOCK_FILE = ".yap-profile.lock.json";

// Lancia Chromium con un profilo persistente su disco usando launchPersistentContext.
// Restituisce { browser: null, context } — nessun browser object separato come in launch().
export async function launchPersistentContextWithFallback(
  chromium,
  userDataDir,
  contextOptions,
  { resolveModule, cwd = ROOT_DIR } = {},
) {
  // Rimuove SingletonLock/SingletonCookie che bloccano indefinitamente il launch
  // se un processo Chromium precedente è terminato in modo anomalo.
  for (const lockFile of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    await fs.rm(path.join(userDataDir, lockFile), { force: true }).catch(() => {});
  }
  // Pulisce Default/ ad ogni avvio preservando solo Cookies e Login Data.
  // Il profilo persistente accumula Cache/State/GPUCache che causano OOM su Railway.
  // I Cookies vengono preservati per riutilizzare la sessione senza re-login.
  try {
    const defaultDir = path.join(userDataDir, "Default");
    const entries = await fs.readdir(defaultDir).catch(() => []);
    const keep = new Set(["Cookies", "Login Data", "Login Data-journal", "Cookies-journal", "Preferences", "Secure Preferences"]);
    for (const entry of entries) {
      if (!keep.has(entry)) {
        await fs.rm(path.join(defaultDir, entry), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch (_) {}
  // Pulisce anche le dir top-level del profilo
  for (const dir of [
    path.join(userDataDir, "GrShaderCache"),
    path.join(userDataDir, "ShaderCache"),
    path.join(userDataDir, "Crash Reports"),
    path.join(userDataDir, "System Profile"),
  ]) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const preferredPath = await pickChromiumExecutablePath();
  const options = preferredPath
    ? { ...contextOptions, executablePath: preferredPath }
    : { ...contextOptions };

  process.stderr.write(JSON.stringify({ event: "yap:phase", phase: "browser", status: "launch_persistent_start", ts: new Date().toISOString() }) + "\n");
  const tryLaunch = (opts) => chromium.launchPersistentContext(userDataDir, { timeout: 30000, ...opts });

  try {
    const context = await tryLaunch(options);
    process.stderr.write(JSON.stringify({ event: "yap:phase", phase: "browser", status: "launch_persistent_done", ts: new Date().toISOString() }) + "\n");
    return context;
  } catch (error) {
    process.stderr.write(JSON.stringify({ event: "yap:phase", phase: "browser", status: "launch_persistent_error", error: String(error?.message || error).slice(0, 200), ts: new Date().toISOString() }) + "\n");
    if (!resolveModule || !isMissingPlaywrightBrowserError(error)) throw error;
    await installPlaywrightChromium(resolveModule, cwd);
    return tryLaunch(contextOptions);
  }
}

export function buildYapProfileLockPath(profileDir) {
  return path.join(profileDir, YAP_PROFILE_LOCK_FILE);
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function shouldBreakYapProfileLock(
  lockInfo,
  {
    nowMs = Date.now(),
    staleMs = 15 * 60 * 1000,
    isPidAlive = defaultIsPidAlive,
  } = {},
) {
  if (!lockInfo || typeof lockInfo !== "object") return true;
  const pid = Number(lockInfo.pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const startedAtMs = Date.parse(lockInfo.startedAt || "");
  if (!Number.isFinite(startedAtMs)) return true;
  if ((nowMs - startedAtMs) > staleMs) return true;
  return !isPidAlive(pid);
}

async function readYapProfileLock(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function acquireYapProfileLease(
  profileDir,
  {
    waitMs = Number(process.env.YAP_PROFILE_LOCK_WAIT_MS) || 1200,
    pollMs = Number(process.env.YAP_PROFILE_LOCK_POLL_MS) || 150,
    staleMs = Number(process.env.YAP_PROFILE_LOCK_STALE_MS) || (15 * 60 * 1000),
  } = {},
) {
  await fs.mkdir(profileDir, { recursive: true });
  const lockPath = buildYapProfileLockPath(profileDir);
  const startedAtMs = Date.now();
  const owner = {
    pid: process.pid,
    startedAt: new Date(startedAtMs).toISOString(),
    host: os.hostname(),
  };

  const release = async () => {
    try {
      const current = await readYapProfileLock(lockPath);
      if (current?.pid === owner.pid && current?.startedAt === owner.startedAt) {
        await fs.rm(lockPath, { force: true });
      }
    } catch {
      // best-effort cleanup
    }
  };

  while ((Date.now() - startedAtMs) <= waitMs) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(owner), "utf-8");
      } finally {
        await handle.close();
      }
      return {
        acquired: true,
        lockPath,
        owner,
        elapsedMs: Date.now() - startedAtMs,
        release,
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = await readYapProfileLock(lockPath);
      if (shouldBreakYapProfileLock(current, { nowMs: Date.now(), staleMs })) {
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, pollMs)));
    }
  }

  return {
    acquired: false,
    lockPath,
    owner: await readYapProfileLock(lockPath),
    elapsedMs: Date.now() - startedAtMs,
    release: async () => {},
  };
}

export async function createYapRuntime(
  chromium,
  {
    headed = false,
    freshLogin = false,
    viewport = { width: 1440, height: 950 },
    locale = "it-IT",
    launchArgs = [],
    preferPersistentProfile = true,
    profileDir = process.env.YAP_CHROME_PROFILE_DIR || YAP_CHROME_PROFILE_DIR,
    resolveModule,
    cwd = ROOT_DIR,
  } = {},
) {
  let browser = null;
  let context = null;
  let page = null;
  let profileLease = null;
  const startedAtMs = Date.now();
  const telemetry = {
    session_mode: "browser_context",
    used_persistent_profile: false,
    profile_lock: null,
    started_at_ms: startedAtMs,
  };

  if (preferPersistentProfile && !freshLogin) {
    profileLease = await acquireYapProfileLease(profileDir);
    telemetry.profile_lock = {
      acquired: profileLease.acquired,
      wait_ms: profileLease.elapsedMs,
      owner_pid: profileLease.owner?.pid ?? null,
      lock_path: profileLease.lockPath,
    };
    if (profileLease.acquired) {
      process.stderr.write(JSON.stringify({
        event: "yap:session",
        status: "profile_lock_acquired",
        elapsed_ms: profileLease.elapsedMs,
        lock_path: profileLease.lockPath,
        ts: new Date().toISOString(),
      }) + "\n");
      context = await launchPersistentContextWithFallback(
        chromium,
        profileDir,
        {
          headless: !headed,
          args: launchArgs,
          viewport,
          locale,
        },
        { resolveModule, cwd },
      );
      telemetry.session_mode = "persistent_profile";
      telemetry.used_persistent_profile = true;
    } else {
      process.stderr.write(JSON.stringify({
        event: "yap:session",
        status: "profile_lock_fallback",
        reason: "profile_busy",
        owner_pid: profileLease.owner?.pid ?? null,
        elapsed_ms: profileLease.elapsedMs,
        ts: new Date().toISOString(),
      }) + "\n");
    }
  }

  if (!context) {
    browser = await launchChromiumWithFallback(
      chromium,
      { headless: !headed, args: launchArgs },
      { resolveModule, cwd },
    );
    context = await browser.newContext(await yapContextOptions({ freshLogin, viewport, locale }));
    await applyYapSessionStorage(context, { freshLogin });
    telemetry.session_mode = "browser_context";
  }

  page = await context.newPage();
  process.stderr.write(JSON.stringify({
    event: "yap:session",
    status: "runtime_ready",
    session_mode: telemetry.session_mode,
    used_persistent_profile: telemetry.used_persistent_profile,
    elapsed_ms: Date.now() - startedAtMs,
    ts: new Date().toISOString(),
  }) + "\n");

  const close = async () => {
    await context?.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (profileLease) await profileLease.release().catch(() => {});
  };

  return {
    browser,
    context,
    page,
    profileLease,
    telemetry,
    close,
  };
}

export function buildYapTelemetry({
  runtime = null,
  viewport = null,
  eventCount = null,
  startedAtMs = null,
  extra = {},
} = {}) {
  return {
    session_mode: runtime?.telemetry?.session_mode || null,
    used_persistent_profile: runtime?.telemetry?.used_persistent_profile ?? null,
    profile_lock: runtime?.telemetry?.profile_lock || null,
    agenda_date: viewport?.centerDateLabel || null,
    event_count: eventCount ?? viewport?.visibleEventCount ?? null,
    empty_confirmed: viewport?.agendaSettle?.emptyConfirmed ?? null,
    agenda_unstable: viewport?.agendaSettle?.unstable ?? null,
    agenda_settle_polls: viewport?.agendaSettle?.polls ?? null,
    total_elapsed_ms: startedAtMs ? (Date.now() - startedAtMs) : null,
    ...extra,
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// --- Riuso sessione YAP -------------------------------------------------------
// Playwright `storageState` salva solo cookie + localStorage, NON il sessionStorage,
// dove YAP tiene il token di sessione: per questo, pur ripristinando lo storageState,
// l'agenda veniva rimandata al login (agenda_redirected_to_login) costringendo a rifare
// tutto il login (~30-45s). Qui salviamo un "bundle" {playwright, sessionStorage} e
// ripristiniamo anche il sessionStorage via addInitScript PRIMA della prima navigazione.
async function readYapSessionBundle() {
  try {
    const raw = await fs.readFile(YAP_SESSION_STATE, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.__yapBundle) return parsed;                         // formato nuovo
    if (parsed && (parsed.cookies || parsed.origins)) {                      // formato legacy Playwright
      return { __yapBundle: 0, playwright: parsed, sessionStorage: null };
    }
  } catch {
    // file assente o illeggibile -> nessuna sessione da riusare
  }
  return null;
}

export async function yapContextOptions({ viewport = { width: 1440, height: 950 }, locale = "it-IT", freshLogin = false } = {}) {
  const options = { viewport };
  if (locale) options.locale = locale;
  if (!freshLogin) {
    const bundle = await readYapSessionBundle();
    if (bundle && bundle.playwright) options.storageState = bundle.playwright;
  }
  return options;
}

// Ripristina il sessionStorage salvato iniettandolo prima del boot dell'app YAP.
// Va chiamata SUBITO dopo newContext() e PRIMA del primo page.goto().
export async function applyYapSessionStorage(context, { freshLogin = false } = {}) {
  if (freshLogin) return false;
  const bundle = await readYapSessionBundle();
  // Invalida bundle legacy (formato Playwright puro senza sessionStorage catturato)
  if (!bundle || !bundle.__yapBundle) return false;
  const ss = bundle.sessionStorage;
  if (!ss || !ss.origin || !ss.data || Object.keys(ss.data).length === 0) {
    process.stderr.write(JSON.stringify({
      event: "yap:session",
      status: "no_session_storage",
      savedAt: bundle.savedAt || null,
      ts: new Date().toISOString(),
    }) + "\n");
    return false;
  }
  const keyCount = Object.keys(ss.data).length;
  await context.addInitScript((payload) => {
    try {
      if (window.location.origin === payload.origin && window.sessionStorage) {
        for (const key of Object.keys(payload.data)) {
          if (window.sessionStorage.getItem(key) == null) {
            window.sessionStorage.setItem(key, payload.data[key]);
          }
        }
      }
    } catch (_) { /* no-op */ }
  }, ss);
  process.stderr.write(JSON.stringify({
    event: "yap:session",
    status: "session_storage_injected",
    keyCount,
    origin: ss.origin,
    savedAt: bundle.savedAt || null,
    ts: new Date().toISOString(),
  }) + "\n");
  return true;
}

export async function persistYapSession(context) {
  try {
    await fs.mkdir(path.dirname(YAP_SESSION_STATE), { recursive: true });
    const playwright = await context.storageState();
    // Cattura anche i cookie direttamente dal contesto (più completo di storageState in alcuni casi)
    const allCookies = await context.cookies().catch(() => []);
    const yapOrigin = new URL(YAP_BASE_URL).origin;
    const yapBaseHost = new URL(YAP_BASE_URL).hostname;
    // Cookie sull'host YAP principale o su sottodomini .mmbsoftware.it
    const yapCookies = allCookies.filter((c) =>
      c.domain === yapBaseHost
      || c.domain === `.${yapBaseHost.split(".").slice(-2).join(".")}`
      || c.domain === yapBaseHost.split(".").slice(-2).join(".")
      || (c.domain && c.domain.endsWith(".mmbsoftware.it"))
      || (c.domain && c.domain.endsWith("yap.mmbsoftware.it")),
    );
    // Merge: aggiunge i yapCookies non già presenti in playwright.cookies
    const playwrightCookieKeys = new Set(
      (playwright.cookies || []).map((c) => `${c.domain}|${c.name}`),
    );
    const mergedCookies = [
      ...(playwright.cookies || []),
      ...yapCookies.filter((c) => !playwrightCookieKeys.has(`${c.domain}|${c.name}`)),
    ];
    if (mergedCookies.length !== (playwright.cookies || []).length) {
      playwright.cookies = mergedCookies;
    }
    process.stderr.write(JSON.stringify({
      event: "yap:session",
      status: "persist_cookies",
      total: allCookies.length,
      yapCookies: yapCookies.length,
      merged: mergedCookies.length,
      domains: [...new Set(allCookies.map((c) => c.domain))],
      ts: new Date().toISOString(),
    }) + "\n");
    let sessionStorage = null;
    const pages = (typeof context.pages === "function" ? context.pages() : []) || [];
    // Cerca prima una pagina sull'origine YAP; fallback alla prima non chiusa
    const yapPage = pages.find((p) => {
      try { return !p.isClosed() && p.url().startsWith(yapOrigin); } catch { return false; }
    }) || pages.find((p) => { try { return !p.isClosed(); } catch { return false; } }) || null;
    if (yapPage) {
      sessionStorage = await yapPage.evaluate((origin) => {
        try {
          if (window.location.origin !== origin) return null;
          const data = {};
          for (let i = 0; i < window.sessionStorage.length; i += 1) {
            const key = window.sessionStorage.key(i);
            if (key != null) data[key] = window.sessionStorage.getItem(key);
          }
          return Object.keys(data).length > 0 ? { origin: window.location.origin, data } : null;
        } catch (_) { return null; }
      }, yapOrigin).catch(() => null);
    }
    const bundle = { __yapBundle: 1, savedAt: new Date().toISOString(), playwright, sessionStorage };
    await fs.writeFile(YAP_SESSION_STATE, JSON.stringify(bundle), "utf-8");
  } catch (_) {
    // best-effort: la persistenza della sessione non deve mai far fallire il login
  }
}

// Esegue page.evaluate con un timeout HARD. Playwright NON applica alcun timeout a
// page.evaluate: durante un redirect-loop di login il contesto JS viene distrutto e
// ricreato di continuo, quindi la promise di evaluate può non risolversi MAI (né
// resolve né reject). Senza questa corsa, un singolo evaluate appeso blocca l'intero
// worker fino al kill a 210s (vedi crash openAgenda:recovery1_nav_done). Qui forziamo
// un fallback dopo `ms` così i loop a deadline possono davvero uscire.
export async function evalWithTimeout(page, fn, arg, ms = 4000, fallback = undefined, label = "") {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      process.stderr.write(JSON.stringify({
        event: "yap:phase",
        phase: "evalGuard",
        status: "evaluate_timeout",
        label,
        ms,
        ts: new Date().toISOString(),
      }) + "\n");
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([
      Promise.resolve(page.evaluate(fn, arg)).catch(() => fallback),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForYapBootSurface(page, timeout = 25000) {
  const started = Date.now();
  while ((Date.now() - started) < timeout) {
    const state = await evalWithTimeout(page, () => {
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
      };
      const loginUser = document.querySelector('input[name="u"]');
      const agendaMarkers = [
        document.querySelector(".fc-time-grid"),
        document.querySelector(".fc-view-container"),
        document.querySelector(".view-switch"),
        document.querySelector(".fc-agenda-view"),
      ].some(isVisible);
      const appShellMarkers = [
        ...document.querySelectorAll("a, span, div"),
      ].filter(isVisible).some((node) => {
        const text = (node.textContent || "").trim();
        return /^(Dashboard|Agenda|Nuovo|Revisioni|Banche dati|Analisi|Archivi|Configurazioni|Aiuto)$/i.test(text)
          || /@offcarchiuduno/i.test(text);
      });
      const bodyText = (document.body?.innerText || "").toLowerCase();
      const loadingVisible = [...document.querySelectorAll("div, span, td")]
        .filter(isVisible)
        .some((node) => /caricamento|loading|attendere/i.test(node.textContent || ""));
      if (isVisible(loginUser)) return "login";
      if (agendaMarkers) return "agenda";
      if (appShellMarkers) return "app_shell";
      if (loadingVisible) return "loading";
      if (/\bagenda\b/.test(bodyText)) return "app_shell";
      return "unknown";
    }, undefined, 3500, "unknown", "bootSurface");

    if (state === "login" || state === "agenda" || state === "app_shell") return state;
    await page.waitForTimeout(250).catch(() => {});
  }
  return "timeout";
}

export async function waitForAgendaReady(page, timeout = 20000) {
  await page.locator(".fc-time-grid, .fc-view-container, .view-switch, .fc-agenda-view").first().waitFor({
    state: "visible",
    timeout,
  });
}

export async function isYapLoginPage(page, timeout = 1200) {
  return page.locator('input[name="u"]').first().isVisible({ timeout }).catch(() => false);
}

async function hasYapAppShell(page, timeout = 2000) {
  return evalWithTimeout(page, () => {
    const isVisible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll("a, span, div")]
      .filter(isVisible)
      .some((node) => {
        const text = (node.textContent || "").trim();
        return /^(Dashboard|Agenda|Nuovo|Revisioni|Banche dati|Analisi|Archivi|Configurazioni|Aiuto)$/i.test(text)
          || /@offcarchiuduno/i.test(text);
      });
  }, undefined, Math.max(1500, timeout), false, "hasAppShell");
}

async function openAgendaFromAppShell(page, timeout = 15000) {
  const agendaLink = page.getByText("Agenda", { exact: true }).first();
  if (await agendaLink.isVisible({ timeout: 1500 }).catch(() => false)) {
    await agendaLink.click().catch(() => {});
  } else {
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("a, button, span, div")];
      const target = nodes.find((node) => (node.textContent || "").trim() === "Agenda");
      target?.click?.();
    }).catch(() => {});
  }
  await waitForYapBootSurface(page, 5000).catch(() => {});
  await waitForAgendaReady(page, timeout);
}

async function dismissUnsupportedBrowserWarningRobust(page, { timeout = 6000 } = {}) {
  const started = Date.now();
  let dismissed = false;
  while ((Date.now() - started) < timeout) {
    const handled = await evalWithTimeout(page, () => {
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
      };
      const dialogs = [...document.querySelectorAll(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel")]
        .filter(isVisible);
      const warning = dialogs.find((dialog) => {
        const text = (dialog.textContent || "").toLowerCase();
        return text.includes("versione del browser")
          || text.includes("browser in uso")
          || text.includes("non è più supportata")
          || text.includes("non e piu supportata")
          || text.includes("safari - null");
      });
      if (!warning) return false;
      const okBtn = [...warning.querySelectorAll("button, .gwt-Button, [role='button'], a")]
        .find((node) => isVisible(node) && (node.textContent || "").trim().toUpperCase() === "OK");
      if (!okBtn) return false;
      okBtn.click();
      return true;
    }, undefined, 3000, false, "dismissWarning_handle");
    if (handled) {
      dismissed = true;
      await page.waitForTimeout(250).catch(() => {});
      continue;
    }
    const stillVisible = await evalWithTimeout(page, () => {
      const isVisible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
      };
      return [...document.querySelectorAll(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel")]
        .filter(isVisible)
        .some((dialog) => {
          const text = (dialog.textContent || "").toLowerCase();
          return text.includes("versione del browser")
            || text.includes("browser in uso")
            || text.includes("non è più supportata")
            || text.includes("non e piu supportata")
            || text.includes("safari - null");
        });
    }, undefined, 3000, false, "dismissWarning_check");
    if (!stillVisible) return dismissed;
    await page.waitForTimeout(250).catch(() => {});
  }
  return dismissed;
}

async function dismissUnsupportedBrowserWarning(page) {
  const warningVisible = await page
    .getByText(/ATTENZIONE! La versione del browser in uso non è più supportata!/i)
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (!warningVisible) return false;

  const dialog = page.locator(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel");
  const ok = dialog.locator("button, .gwt-Button, [role='button']").filter({ hasText: /^OK$/i }).first();

  if (await ok.isVisible({ timeout: 1500 }).catch(() => false)) {
    await ok.click({ force: true }).catch(() => {});
    await page.waitForTimeout(100);
    return true;
  }

  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, .gwt-Button, [role=\"button\"]")];
    const okBtn = btns.find((b) => (b.textContent || "").trim().toUpperCase() === "OK");
    if (okBtn) okBtn.click();
  }).catch(() => {});
  await page.waitForTimeout(100);
  return true;
}

export async function waitForYapAction(page, actionName, trigger, timeout = 15000) {
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/yap/action/${actionName}`),
  { timeout }).catch(() => null);
  await trigger();
  return responsePromise;
}

async function navigateWithRetry(page, url, options = {}, attempts = 3) {
  let lastError = null;
  const opts = { timeout: 15000, ...options };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await page.goto(url, opts);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      const retryable = /ERR_FAILED|ERR_ABORTED|Timeout/i.test(message);
      if (!retryable || attempt === attempts) throw error;
      await page.waitForTimeout(350 * attempt).catch(() => {});
    }
  }
  throw lastError;
}

export async function gotoAgendaDate(page, isoDate) {
  const months = {
    gennaio: 0,
    febbraio: 1,
    marzo: 2,
    aprile: 3,
    maggio: 4,
    giugno: 5,
    luglio: 6,
    agosto: 7,
    settembre: 8,
    ottobre: 9,
    novembre: 10,
    dicembre: 11,
  };
  const target = new Date(`${isoDate}T12:00:00`);
  const targetIndex = target.getFullYear() * 12 + target.getMonth();
  const targetDay = String(target.getDate());
  const targetNeedle = `${targetDay} ${Object.keys(months)[target.getMonth()]} ${target.getFullYear()}`;
  const currentMonthIndex = async () => {
    const text = normalize(await page.locator(".view-switch").first().innerText({ timeout: 600 }).catch(() => ""));
    if (!text) return null;
    const [monthName, yearText] = text.split(/\s+/);
    if (!(monthName in months) || !yearText) return null;
    return Number(yearText) * 12 + months[monthName];
  };
  const agendaShowsTargetDate = async () => {
    const state = await readAgendaViewportState(page).catch(() => null);
    if (!state) return false;
    return normalize(state.centerDateLabel || "").includes(normalize(targetNeedle));
  };
  const agendaLoadingVisible = async () => {
    return page.evaluate(() => {
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
      };
      return [...document.querySelectorAll("div, span, td")]
        .filter(isVisible)
        .some((node) => /caricamento appuntamenti in corso/i.test(node.textContent || ""));
    }).catch(() => false);
  };

  for (let settle = 0; settle < 20; settle += 1) {
    if (!(await agendaLoadingVisible())) break;
    await page.waitForTimeout(250).catch(() => {});
  }

  let consecutiveNulls = 0;
  for (let guard = 0; guard < 36; guard += 1) {
    const currentIndex = await currentMonthIndex();
    if (currentIndex == null) {
      consecutiveNulls += 1;
      if (consecutiveNulls >= 3) break;
      await page.waitForTimeout(200).catch(() => {});
      continue;
    }
    consecutiveNulls = 0;
    if (currentIndex === targetIndex) break;
    await page.locator(currentIndex > targetIndex ? ".prev-button" : ".next-button").first().click();
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(250).catch(() => {});

  const dayTarget = await page.evaluate(({ dayText, isoDate }) => {
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const normalizeClass = (value) => String(value || "").toLowerCase();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 10 && rect.height > 10 && style.display !== "none" && style.visibility !== "hidden";
    };
    const titleButton = document.querySelector(".view-switch");
    const scope = titleButton?.parentElement?.parentElement?.parentElement || document.body;
    const candidates = [...scope.querySelectorAll("button, div, span, td, a")]
      .filter(isVisible)
      .filter((node) => normalizeText(node.textContent || "") === dayText)
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const selfClasses = normalizeClass(node.className || "");
        const parentClasses = normalizeClass(node.parentElement?.className || "");
        const containerClasses = normalizeClass(node.closest("td, div, span, a, button")?.className || "");
        const dataDate = String(node.getAttribute?.("data-date") || node.parentElement?.getAttribute?.("data-date") || "");
        const title = String(node.getAttribute?.("title") || node.parentElement?.getAttribute?.("title") || "");
        const parsedDataDate = /^\d{10,13}$/.test(dataDate)
          ? new Date(Number(dataDate))
          : null;
        const dataDateIso = parsedDataDate && !Number.isNaN(parsedDataDate.getTime())
          ? `${parsedDataDate.getFullYear()}-${String(parsedDataDate.getMonth() + 1).padStart(2, "0")}-${String(parsedDataDate.getDate()).padStart(2, "0")}`
          : "";
        const blocked = [selfClasses, parentClasses, containerClasses].some((classes) =>
          classes.includes("disabled") || classes.includes("other") || classes.includes("outside"),
        );
        const dateMismatch = (dataDateIso && dataDateIso !== isoDate) || (title && title.includes("/") && !title.includes(dayText));
        return rect.width > 12 && rect.height > 12 && !blocked && !dateMismatch;
      });
    const candidate = candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.y - br.y || ar.x - br.x;
    })[0];
    if (!candidate) return null;
    const rect = candidate.getBoundingClientRect();
    return {
      x: rect.left + (rect.width / 2),
      y: rect.top + (rect.height / 2),
    };
  }, { dayText: targetDay, isoDate }).catch(() => false);

  const moved = Boolean(dayTarget && Number.isFinite(dayTarget.x) && Number.isFinite(dayTarget.y));
  if (moved) {
    await page.mouse.click(dayTarget.x, dayTarget.y).catch(() => {});
    await page.waitForTimeout(250).catch(() => {});
  } else {
    await page.keyboard.press("Home").catch(() => {});
  }
  await waitForAgendaReady(page, 5000).catch(() => {});
  for (let loadingGuard = 0; loadingGuard < 12; loadingGuard += 1) {
    if (await agendaShowsTargetDate()) return true;
    const state = await readAgendaViewportState(page).catch(() => null);
    const selectedMatches = state?.selectedMiniDay === targetDay;
    const centerMentionsTargetMonth = normalize(state?.centerDateLabel || "").includes(normalize(`${Object.keys(months)[target.getMonth()]} ${target.getFullYear()}`));
    const loadingVisible = await agendaLoadingVisible();
    if (!loadingVisible && !selectedMatches && !centerMentionsTargetMonth) break;
    await page.waitForTimeout(280);
  }
  for (let verify = 0; verify < 5; verify += 1) {
    if (await agendaShowsTargetDate()) return true;
    await page.waitForTimeout(280);
    if ((verify === 1 || verify === 3) && moved) {
      await page.mouse.dblclick(dayTarget.x, dayTarget.y).catch(() => {});
    }
  }
  await page.waitForTimeout(200);
  const finalState = await readAgendaViewportState(page).catch(() => null);
  const stateSuffix = finalState
    ? `:view=${encodeURIComponent(finalState.viewSwitchLabel || "")}:center=${encodeURIComponent(finalState.centerDateLabel || "")}:selected=${encodeURIComponent(finalState.selectedMiniDay || "")}:events=${finalState.visibleEventCount ?? 0}`
    : "";
  throw new Error(`agenda_date_not_reached:${isoDate}${stateSuffix}`);
}

export async function readAgendaViewportState(page) {
  const state = await evalWithTimeout(
    page,
    () => {
      const normalizeText = (value) => String(value || "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .trim();
      const normalizeClass = (value) => String(value || "").toLowerCase();
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 6
          && rect.height > 6
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0";
      };
      const roots = [
        ...document.querySelectorAll(".fc-view-container, .fc-agenda-view, .fc-time-grid"),
      ].filter(isVisible);
      const primaryRoot = roots[0] || document.body;
      const allNodes = [...document.querySelectorAll("h1, h2, h3, div, span, td")].filter(isVisible);
      const headerNodes = allNodes
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            text: normalizeText((node.textContent || "").slice(0, 120)),
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        })
        .filter((node) =>
          node.x > 220
          && node.y < 260
          && /\b\d{1,2}\b.*\b(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|dicembre|novembre)\b.*\b20\d{2}\b/i.test(node.text),
        )
        .sort((a, b) => (b.width * b.height) - (a.width * a.height));
      const calendarRoot = document.querySelector(".view-switch")?.parentElement?.parentElement?.parentElement || document.body;
      const selectedMiniDay = [...calendarRoot.querySelectorAll("button, div, span, td, a")]
        .filter(isVisible)
        .map((node) => ({
          text: normalizeText(node.textContent || ""),
          classes: [
            normalizeClass(node.className || ""),
            normalizeClass(node.parentElement?.className || ""),
          ].join(" "),
        }))
        .find((node) =>
          /^\d{1,2}$/.test(node.text)
          && /\b(selected|active|current|today)\b/.test(node.classes),
        )?.text || null;
      const events = [...primaryRoot.querySelectorAll(".fc-time-grid-event, .fc-event")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.x > 220
            && rect.width > 20
            && rect.height > 6
            && style.display !== "none"
            && style.visibility !== "hidden"
            && style.opacity !== "0";
        })
        .map((el) => {
          const titleEl = el.querySelector(".fc-title") || el;
          const timeEl = el.querySelector(".fc-time");
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const repartoClass =
            String(el.className || "")
              .split(/\s+/)
              .find((c) => /^LCWVQRD-b-[a-z]$/.test(c)) || "";
          return {
            time: normalizeText(timeEl?.textContent || ""),
            title: normalizeText(titleEl.textContent || ""),
            repartoClass,
            bgColor: style.backgroundColor,
            borderColor: style.borderColor,
            left: `${Math.round(rect.left)}px`,
            width: `${Math.round(rect.width)}px`,
          };
        })
        .filter((ev) => ev.title);
      const uniqueEvents = [];
      const seen = new Set();
      for (const ev of events) {
        const key = `${ev.time}|${ev.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueEvents.push(ev);
      }
      return {
        viewSwitchLabel: normalizeText(document.querySelector(".view-switch")?.textContent || ""),
        centerDateLabel: headerNodes[0]?.text || "",
        selectedMiniDay,
        visibleEventCount: uniqueEvents.length,
        visibleEvents: uniqueEvents,
      };
    },
    null,
    Number(process.env.YAP_VIEWPORT_EVAL_TIMEOUT_MS) || 4000,
    null,
    "readAgendaViewportState",
  );
  if (!state) {
    throw new Error("agenda_viewport_state_timeout");
  }
  return state;
}

export async function waitForAgendaEventPopulation(
  page,
  {
    timeoutMs = Number(process.env.YAP_AGENDA_SETTLE_MS) || 1800,
    pollMs = 300,
    confirmEmptyReads = 2,
    readState = readAgendaViewportState,
  } = {},
) {
  const started = Date.now();
  let latest = await readState(page).catch(() => null);
  let polls = 0;
  let emptyReads = (latest?.visibleEventCount || 0) === 0 ? 1 : 0;
  if ((latest?.visibleEventCount || 0) > 0) {
    return {
      ...latest,
      agendaSettle: {
        polls,
        initialCount: latest.visibleEventCount || 0,
        finalCount: latest.visibleEventCount || 0,
        unstable: false,
        emptyConfirmed: false,
      },
    };
  }
  const initialCount = latest?.visibleEventCount || 0;
  while ((Date.now() - started) < timeoutMs) {
    await page.waitForTimeout(pollMs).catch(() => {});
    polls += 1;
    latest = await readState(page).catch(() => null) || latest;
    if ((latest?.visibleEventCount || 0) > 0) {
      return {
        ...latest,
        agendaSettle: {
          polls,
          initialCount,
          finalCount: latest.visibleEventCount || 0,
          unstable: initialCount === 0,
          emptyConfirmed: false,
        },
      };
    }
    emptyReads += 1;
  }
  if (!latest) {
    throw new Error("agenda_event_population_timeout");
  }
  return {
    ...latest,
    agendaSettle: {
      polls,
      initialCount,
      finalCount: latest?.visibleEventCount || 0,
      unstable: false,
      emptyConfirmed: emptyReads >= Math.max(1, confirmEmptyReads),
    },
  };
}

export async function scanVisibleAgendaEvents(page, { includeStyle = false } = {}) {
  const state = await waitForAgendaEventPopulation(page);
  return state.visibleEvents.map((event) => (
    includeStyle
      ? event
      : {
          time: event.time,
          title: event.title,
          repartoClass: event.repartoClass,
        }
  ));
}

export async function scanVisibleAgendaEventTargets(page, { includeStyle = false } = {}) {
  await waitForAgendaEventPopulation(page);
  return page.evaluate((wantStyle) => {
    const normalizeText = (value) => String(value || "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 8
        && rect.height > 6
        && rect.x > 220
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0";
    };
    const roots = [
      ...document.querySelectorAll(".fc-view-container, .fc-agenda-view, .fc-time-grid"),
    ].filter(isVisible);
    const primaryRoot = roots[0] || document.body;
    const rows = [...primaryRoot.querySelectorAll(".fc-time-grid-event, .fc-event")]
      .filter(isVisible)
      .map((el) => {
        const titleEl = el.querySelector(".fc-title") || el;
        const timeEl = el.querySelector(".fc-time");
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const repartoClass =
          String(el.className || "")
            .split(/\s+/)
            .find((c) => /^LCWVQRD-b-[a-z]$/.test(c)) || "";
        return {
          title: normalizeText(titleEl.textContent || ""),
          time: normalizeText(timeEl?.textContent || ""),
          repartoClass,
          x: rect.x + (rect.width / 2),
          y: rect.y + (rect.height / 2),
          ...(wantStyle ? {
            bgColor: style.backgroundColor,
            borderColor: style.borderColor,
            left: `${Math.round(rect.left)}px`,
            width: `${Math.round(rect.width)}px`,
          } : {}),
        };
      })
      .filter((row) => row.title);
    const deduped = [];
    const seen = new Set();
    for (const row of rows) {
      const key = `${row.time}|${row.title}|${Math.round(row.x)}|${Math.round(row.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
    }
    return deduped.sort((a, b) => a.time.localeCompare(b.time) || a.title.localeCompare(b.title));
  }, includeStyle);
}

export async function loginYap(page, username, password) {
  const _loginStart = Date.now();
  const _logLogin = (status, extra = {}) => process.stderr.write(JSON.stringify({ event: "yap:phase", phase: "loginYap", status, elapsed_ms: Date.now() - _loginStart, ts: new Date().toISOString(), ...extra }) + "\n");
  const _detectLoginInputVisible = async (timeout = 2500) => evalWithTimeout(
    page,
    () => {
      const input = document.querySelector('input[name="u"]');
      if (!input) return false;
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      return rect.width > 8
        && rect.height > 8
        && style.display !== "none"
        && style.visibility !== "hidden"
        && style.opacity !== "0";
    },
    undefined,
    Math.max(1500, timeout),
    false,
    "loginInputVisible",
  );
  _logLogin("start");
  const _cookieLog = [];
  const _cookieListener = (response) => {
    try {
      const setCookie = response.headers()["set-cookie"];
      if (setCookie) {
        const url = response.url();
        _cookieLog.push({ url: url.slice(0, 120), setCookie: setCookie.slice(0, 300) });
      }
    } catch (_) {}
  };
  page.on("response", _cookieListener);
  try {
    _logLogin("navigating");
    // Naviga solo se non siamo già su YAP (evita doppia navigazione quando il chiamante
    // ha già fatto page.goto(YAP_BASE_URL) con sessionStorage svuotato).
    const _currentUrl = page.url();
    const _onYap = _currentUrl.startsWith(new URL(YAP_BASE_URL).origin);
    if (!_onYap) {
      await navigateWithRetry(page, YAP_BASE_URL, { waitUntil: "domcontentloaded" });
    } else {
      _logLogin("already_on_yap", { url: _currentUrl.slice(0, 80) });
    }
    _logLogin("nav_done", { url: page.url().slice(0, 80) });
    await dismissUnsupportedBrowserWarningRobust(page, { timeout: 3500 });

    _logLogin("waiting_boot_surface");
    const bootSurface = await waitForYapBootSurface(page, 10000).catch(() => "unknown");
    _logLogin("boot_surface", { surface: bootSurface });
    const ssSnapshot = await evalWithTimeout(
      page,
      (origin) => {
        try {
          if (window.location.origin !== origin) return { origin: window.location.origin, keys: [] };
          const keys = [];
          for (let i = 0; i < window.sessionStorage.length; i += 1) {
            const key = window.sessionStorage.key(i);
            if (key != null) keys.push(key);
          }
          return { origin: window.location.origin, keys };
        } catch (_) { return null; }
      },
      new URL(YAP_BASE_URL).origin,
      3000,
      null,
      "login_session_snapshot",
    ).catch(() => null);
    process.stderr.write(JSON.stringify({
      event: "yap:session",
      status: "boot_surface_detected",
      surface: bootSurface,
      sessionStorageKeys: ssSnapshot?.keys?.length ?? 0,
      sessionStorageOrigin: ssSnapshot?.origin ?? null,
      ts: new Date().toISOString(),
    }) + "\n");
    if (bootSurface === "agenda") {
      _logLogin("already_in_agenda");
      await persistYapSession(page.context()).catch(() => {});
      return;
    }
    if (bootSurface === "app_shell") {
      _logLogin("opening_agenda_from_shell");
      try {
        await openAgendaFromAppShell(page, 12000);
        await persistYapSession(page.context()).catch(() => {});
        _logLogin("done_via_shell");
        return;
      } catch {}
    }

    let loginInputVisible = bootSurface === "login"
      || await _detectLoginInputVisible(2500);
    _logLogin("login_input_probe", { visible: loginInputVisible, surface: bootSurface });
    if (!loginInputVisible) {
      const alreadyIn = await hasYapAppShell(page, 3000).catch(() => false);
      _logLogin("app_shell_probe", { alreadyIn });
      if (alreadyIn) {
        try {
          await openAgendaFromAppShell(page, 12000);
        } catch {}
        await persistYapSession(page.context()).catch(() => {});
        return;
      }
      await navigateWithRetry(page, `${YAP_BASE_URL}/#!agenda`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await dismissUnsupportedBrowserWarningRobust(page, { timeout: 8000 });
      const agendaReady = await waitForAgendaReady(page, 5000).then(() => true).catch(() => false);
      _logLogin("agenda_probe", { agendaReady });
      if (agendaReady) {
        await persistYapSession(page.context()).catch(() => {});
        return;
      }
      loginInputVisible = await _detectLoginInputVisible(2500);
      _logLogin("login_input_retry", { visible: loginInputVisible });
      if (!loginInputVisible) {
        throw new Error("login_form_not_visible");
      }
    }

    if (loginInputVisible && ssSnapshot?.keys?.length === 0) {
      const bundle = await readYapSessionBundle();
      const ss = bundle?.__yapBundle && bundle.sessionStorage;
      if (ss && ss.origin && ss.data && Object.keys(ss.data).length > 0) {
        const injected = await page.evaluate((payload) => {
          try {
            if (window.location.origin !== payload.origin) return 0;
            let count = 0;
            for (const key of Object.keys(payload.data)) {
              if (window.sessionStorage.getItem(key) == null) {
                window.sessionStorage.setItem(key, payload.data[key]);
                count += 1;
              }
            }
            return count;
          } catch (_) { return -1; }
        }, ss).catch(() => -1);
        process.stderr.write(JSON.stringify({
          event: "yap:session",
          status: "reinject_attempt",
          injected,
          origin: ss.origin,
          ts: new Date().toISOString(),
        }) + "\n");
        if (injected > 0) {
          await navigateWithRetry(page, YAP_BASE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
          await dismissUnsupportedBrowserWarningRobust(page, { timeout: 3500 });
          const reinjectedSurface = await waitForYapBootSurface(page, 14000).catch(() => "unknown");
          process.stderr.write(JSON.stringify({
            event: "yap:session",
            status: "reinject_surface",
            surface: reinjectedSurface,
            ts: new Date().toISOString(),
          }) + "\n");
          if (reinjectedSurface === "agenda") {
            await persistYapSession(page.context()).catch(() => {});
            return;
          }
          if (reinjectedSurface === "app_shell") {
            await openAgendaFromAppShell(page, 12000).catch(() => {});
            await persistYapSession(page.context()).catch(() => {});
            return;
          }
        }
      }
    }

    // FIX: clicca "OK" SOLO se il login input NON è visibile — significa che un popup
    // sta coprendo il form. Se l'input è già visibile, il click OK potrebbe colpire
    // un elemento GWT errato e navigare via dalla pagina di login.
    const inputBeforeOkClick = await _detectLoginInputVisible(800);
    if (!inputBeforeOkClick) {
      const okBtn = page.getByRole("button", { name: /^OK$/i }).or(page.getByText("OK", { exact: true }));
      try {
        await okBtn.first().waitFor({ state: "visible", timeout: 3000 });
        await okBtn.first().click({ force: true });
      } catch {
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll("button, .gwt-Button, [role=\"button\"]")];
          const ok = btns.find((b) => b.textContent.trim().toUpperCase() === "OK");
          if (ok) ok.click();
        });
      }
    }

    _logLogin("filling_credentials");
    await page.waitForTimeout(100);
    await dismissUnsupportedBrowserWarningRobust(page, { timeout: 3000 });
    _logLogin("waiting_input_visible");
    await page.waitForTimeout(300);
    // FIX: usa _detectLoginInputVisible (evalWithTimeout-safe, fast-fail) invece di
    // waitFor 25s. Se l'input è sparito (popup navigazione errata), ri-naviga alla
    // pagina login e riprova una volta sola prima di fallire.
    const inputAfterDismiss = await _detectLoginInputVisible(5000);
    if (!inputAfterDismiss) {
      _logLogin("input_disappeared_recovering");
      await navigateWithRetry(page, YAP_BASE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(300);
      await dismissUnsupportedBrowserWarningRobust(page, { timeout: 3000 });
      const recoveredInput = await _detectLoginInputVisible(8000);
      if (!recoveredInput) {
        throw new Error("login_input_disappeared_after_dismiss");
      }
    }
    _logLogin("input_ready");
    const filled = await page.evaluate(({ u, p }) => {
      const userEl = document.querySelector('input[name="u"]');
      const passEl = document.querySelector('input[name="pw"]');
      if (!userEl || !passEl) return false;
      userEl.focus();
      userEl.value = u;
      userEl.dispatchEvent(new Event("input", { bubbles: true }));
      userEl.dispatchEvent(new Event("change", { bubbles: true }));
      passEl.focus();
      passEl.value = p;
      passEl.dispatchEvent(new Event("input", { bubbles: true }));
      passEl.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, { u: username, p: password });
    if (!filled) {
      await page.locator('input[name="u"]').click({ force: true, timeout: 5000 });
      await page.locator('input[name="u"]').pressSequentially(username, { delay: 40 });
      await page.locator('input[name="pw"]').click({ force: true });
      await page.locator('input[name="pw"]').pressSequentially(password, { delay: 40 });
    }
    const loginBtn = page
      .getByTestId("loginSubmitButton")
      .or(page.getByRole("button", { name: /acc[ée]di/i }))
      .first();
    _logLogin("clicking_submit");
    try {
      await loginBtn.click({ force: true, timeout: 8000 });
    } catch {
      await page.evaluate(() => {
        const btn =
          document.querySelector('[data-testid="loginSubmitButton"]') ||
          [...document.querySelectorAll("button, .gwt-Button")].find((b) =>
            /acc[eé]di/i.test(b.textContent || ""),
          );
        if (btn) btn.click();
      });
    }

    _logLogin("submitted");
    const _loginSubmitMs = Date.now();
    _logLogin("waiting_post_login");
    const postLoginState = await waitForYapBootSurface(page, 15000).catch(() => "unknown");
    _logLogin("post_login_surface", { surface: postLoginState, ms: Date.now() - _loginSubmitMs });
    process.stderr.write(JSON.stringify({
      event: "yap:session",
      status: "post_login_surface",
      surface: postLoginState,
      elapsed_ms: Date.now() - _loginSubmitMs,
      ts: new Date().toISOString(),
    }) + "\n");
    if (postLoginState === "app_shell") {
      await openAgendaFromAppShell(page, 12000).catch(() => {});
    } else if (postLoginState !== "agenda") {
      await dismissUnsupportedBrowserWarningRobust(page, { timeout: 3500 });
      await waitForAgendaReady(page, 12000).catch(() => {});
    }
    await persistYapSession(page.context()).catch(() => {});
  } finally {
    page.off("response", _cookieListener);
    if (_cookieLog.length > 0) {
      process.stderr.write(JSON.stringify({
        event: "yap:session",
        status: "set_cookie_trace",
        count: _cookieLog.length,
        entries: _cookieLog,
        ts: new Date().toISOString(),
      }) + "\n");
    }
  }
}

const _logShared = (phase, status, extra = {}) => process.stderr.write(JSON.stringify({ event: "yap:phase", phase, status, ts: new Date().toISOString(), ...extra }) + "\n");

// Deadline complessiva di apertura agenda (ms). Tetto di sicurezza: anche con tutti
// gli evaluate protetti, un redirect-loop persistente non deve mai consumare i 210s
// del worker. Allo scadere lanciamo "agenda_redirected_to_login" — errore che
// openAgendaWithRecovery tratta come recuperabile (pulisce cookie + ri-login).
const OPEN_AGENDA_DEADLINE_MS = Number(process.env.YAP_OPEN_AGENDA_DEADLINE_MS || 75000);

export async function openAgendaInApp(page) {
  const _deadlineStart = Date.now();
  let _deadlineTimer = null;
  const deadline = new Promise((_, reject) => {
    _deadlineTimer = setTimeout(() => {
      _logShared("openAgenda", "deadline_exceeded", { ms: Date.now() - _deadlineStart, limit_ms: OPEN_AGENDA_DEADLINE_MS });
      reject(new Error("agenda_redirected_to_login"));
    }, OPEN_AGENDA_DEADLINE_MS);
  });
  try {
    return await Promise.race([_openAgendaInAppInner(page), deadline]);
  } finally {
    if (_deadlineTimer) clearTimeout(_deadlineTimer);
  }
}

async function _openAgendaInAppInner(page) {
  const _t0 = Date.now();
  await navigateWithRetry(page, `${YAP_BASE_URL}/#!agenda`, { waitUntil: "domcontentloaded" });
  _logShared("openAgenda", "nav_done", { ms: Date.now() - _t0, url: page.url().slice(0, 80) });
  // Early-exit: se l'URL post-navigazione non è sull'origine YAP (redirect IAP/auth), è già login.
  const postNavUrl = page.url();
  const yapOrigin = new URL(YAP_BASE_URL).origin;
  if (!postNavUrl.startsWith(yapOrigin)) {
    throw new Error("agenda_redirected_to_login");
  }
  const _t1 = Date.now();
  const initialSurface = await waitForYapBootSurface(page, 8000).catch(() => "unknown");
  _logShared("openAgenda", "boot_surface", { surface: initialSurface, ms: Date.now() - _t1 });
  await dismissUnsupportedBrowserWarningRobust(page, { timeout: 3000 });
  // Short-circuit: se la sessione è scaduta la prima rilevazione su #!agenda dà
  // "login" in modo pulito e affidabile (~2.8s). NON tentare la navigation-recovery
  // verso la base URL nuda: in pratica manda il GWT in redirect-loop e la rilevazione
  // diventa "timeout", bruciando i 75s del deadline e corrompendo lo stato della
  // pagina PRIMA che il chiamante possa fare un login pulito con credenziali.
  // Usciamo subito → openAgendaWithRecovery pulisce cookie/storage e chiama loginYap.
  if (initialSurface === "login") {
    _logShared("openAgenda", "login_surface_fastfail", { ms: Date.now() - _t0 });
    throw new Error("agenda_redirected_to_login");
  }
  if (initialSurface === "app_shell") {
    _logShared("openAgenda", "app_shell_open_start");
    await openAgendaFromAppShell(page, 12000).catch(() => {});
    _logShared("openAgenda", "app_shell_open_done", { ms: Date.now() - _t0 });
  }
  if (await isYapLoginPage(page, 1000)) {
    _logShared("openAgenda", "login_redirect_1", { ms: Date.now() - _t0 });
    await navigateWithRetry(page, YAP_BASE_URL, { waitUntil: "domcontentloaded" }, 1).catch(() => {});
    _logShared("openAgenda", "recovery1_nav_done", { url: page.url().slice(0, 80), ms: Date.now() - _t0 });
    await dismissUnsupportedBrowserWarningRobust(page, { timeout: 2000 });
    const recoveredSurface = await waitForYapBootSurface(page, 6000).catch(() => "unknown");
    _logShared("openAgenda", "recovery1_surface", { surface: recoveredSurface, ms: Date.now() - _t0 });
    if (recoveredSurface === "login" || recoveredSurface === "unknown") {
      throw new Error("agenda_redirected_to_login");
    }
    if (recoveredSurface === "app_shell") {
      await openAgendaFromAppShell(page, 12000).catch(() => {});
    }
    if (await isYapLoginPage(page, 1000)) {
      throw new Error("agenda_redirected_to_login");
    }
  }

  const selectors = [".fc-time-grid", ".fc-view-container", ".view-switch", ".fc-agenda-view"];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const sel of selectors) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) { _logShared("openAgenda", "agenda_visible_early", { sel, attempt, ms: Date.now() - _t0 }); return; }
    }
    _logShared("openAgenda", "retry_loop", { attempt, ms: Date.now() - _t0 });
    if (await isYapLoginPage(page, 800)) {
      await navigateWithRetry(page, YAP_BASE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      await dismissUnsupportedBrowserWarningRobust(page, { timeout: 3000 });
      const recoveredSurface2 = await waitForYapBootSurface(page, 6000).catch(() => "unknown");
      _logShared("openAgenda", "recovery2_surface", { surface: recoveredSurface2, attempt, ms: Date.now() - _t0 });
      if (recoveredSurface2 === "app_shell") {
        await openAgendaFromAppShell(page, 12000).catch(() => {});
        continue;
      }
      if (recoveredSurface2 === "agenda") continue;
      throw new Error("agenda_redirected_to_login");
    }
    if (await hasYapAppShell(page, 1500).catch(() => false)) {
      _logShared("openAgenda", "app_shell_retry", { attempt, ms: Date.now() - _t0 });
      await openAgendaFromAppShell(page, 12000).catch(() => {});
      continue;
    }
    await waitForYapBootSurface(page, 3500).catch(() => {});
    await navigateWithRetry(page, `${YAP_BASE_URL}/#!agenda`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await dismissUnsupportedBrowserWarningRobust(page, { timeout: 3000 });
    if (await isYapLoginPage(page, 800)) {
      await navigateWithRetry(page, YAP_BASE_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      await dismissUnsupportedBrowserWarningRobust(page, { timeout: 3000 });
      const recoveredSurface3 = await waitForYapBootSurface(page, 6000).catch(() => "unknown");
      _logShared("openAgenda", "recovery3_surface", { surface: recoveredSurface3, attempt, ms: Date.now() - _t0 });
      if (recoveredSurface3 === "app_shell") {
        await openAgendaFromAppShell(page, 12000).catch(() => {});
        continue;
      }
      if (recoveredSurface3 === "agenda") continue;
      throw new Error("agenda_redirected_to_login");
    }
    await waitForAgendaReady(page, 6000).catch(() => {});
  }

  if (await isYapLoginPage(page, 1000)) {
    throw new Error("agenda_redirected_to_login");
  }
  _logShared("openAgenda", "final_waitForAgendaReady", { ms: Date.now() - _t0 });
  await waitForAgendaReady(page, 12000);
  _logShared("openAgenda", "done", { ms: Date.now() - _t0 });
}

export async function openAgendaWithRecovery(
  page,
  {
    dateIso = null,
    username = "",
    password = "",
    maxAttempts = 3,
    onRetry = null,
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await openAgendaInApp(page);
      if (dateIso) {
        await gotoAgendaDate(page, dateIso);
      }
      return;
    } catch (error) {
      const message = String(error?.message || "");
      const needsRelogin = /agenda_redirected_to_login/i.test(message);
      const wrongDate = /agenda_date_not_reached:/i.test(message);
      const recoverable = needsRelogin || wrongDate;
      if (!recoverable) throw error;
      if (!username || !password) throw error;
      if (typeof onRetry === "function") {
        await onRetry({
          attempt,
          error: message,
          reason: needsRelogin ? "relogin" : "date_retry",
        });
      }
      const context = page.context();
      await context.clearCookies().catch(() => {});
      await page.evaluate(() => {
        try { window.localStorage?.clear?.(); } catch {}
        try { window.sessionStorage?.clear?.(); } catch {}
      }).catch(() => {});
      // Naviga a #!agenda (non alla base URL nuda): con sessione pulita questa rotta
      // presenta la schermata di login in modo rilevabile (surface "login" ~2.8s),
      // mentre la base URL nuda entra in redirect-loop e dà surface "timeout",
      // impedendo a loginYap di trovare il form. loginYap vedrà already_on_yap e
      // resterà su questa rotta per compilare le credenziali.
      await page.goto(`${YAP_BASE_URL}/#!agenda`, { waitUntil: "domcontentloaded" }).catch(() => {});
      await loginYap(page, username, password);
      if (attempt === maxAttempts) {
        await openAgendaInApp(page);
        if (dateIso) {
          await gotoAgendaDate(page, dateIso);
        }
        return;
      }
      await page.waitForTimeout(350 * attempt).catch(() => {});
    }
  }
}

export function matchEventText(text, terms) {
  const haystack = normalize(text);
  return terms.some((term) => haystack.includes(normalize(term)));
}

export async function clickAgendaEvent(page, terms) {
  return page.evaluate((searchTerms) => {
    const normalizedTerms = searchTerms.map((t) =>
      String(t || "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
    );
    const plateRe = /^[A-Z]{2}\d{3}[A-Z]{2}$/i;
    const events = [...document.querySelectorAll(".fc-time-grid-event, .fc-event")].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    });

    let best = null;
    let bestScore = -1;

    for (const el of events) {
      const titleEl = el.querySelector(".fc-title") || el;
      const text = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      const hay = text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();

      for (const term of normalizedTerms) {
        if (!term || !hay.includes(term)) continue;
        let score = term.length;
        if (plateRe.test(term) && hay.includes(term)) score += 100;
        if (hay.startsWith(term)) score += 20;
        if (score > bestScore) {
          bestScore = score;
          best = { el, text };
        }
      }
    }

    if (!best) return { success: false };
    const { el, text } = best;
    const rect = el.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    for (const type of ["click", "dblclick"]) {
      el.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: center.x,
          clientY: center.y,
        }),
      );
    }
    const classes = String(el.className || "").split(/\s+/);
    const repartoClass = classes.find((c) => /^LCWVQRD-b-[a-z]$/.test(c)) || "";
    return { success: true, text: text.trim(), repartoClass };
  }, terms);
}
