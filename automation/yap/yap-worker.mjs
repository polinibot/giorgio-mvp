#!/usr/bin/env node
import fs from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createYapRuntime,
  buildYapTelemetry,
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  clickAgendaEvent,
  scanVisibleAgendaEvents,
  scanVisibleAgendaEventTargets,
  toItalianDate,
  toYapTime,
  addMinutes,
  normalizeAppointmentTime,
  getYapSlotMinutes,
  waitForAgendaReady,
  waitForYapAction,
  YAP_CHROME_PROFILE_DIR,
} from "./lib/yap-shared.mjs";
import {
  pickCosaFromJob,
  pickYapTagsFromJob,
  buildNotesForPopup,
  jobToMapping,
  hasWorkContexts,
  yapRepartoForOdl,
} from "./lib/yap-mapping.mjs";
import {
  buildDedupKey,
  findExistingAppointment,
  buildSyncLogEntry,
} from "./lib/yap-dedup.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ARTIFACT_DIR = path.join(ROOT_DIR, "automation", "artifacts", "yap");
const WORKSPACE_STATES = Object.freeze({
  AGENDA: "agenda_shell",
  LOADING: "loading_shell",
  PRACTICE: "practice_shell",
  DETAIL: "detail_form",
  ODL_LOADING: "odl_loading",
  ODL_FULL: "odl_full",
  UNKNOWN: "unknown",
});

// MARKER DI BUILD: serve a sapere con CERTEZZA quale versione del worker gira in
// produzione. Compare nei log (stderr) di ogni esecuzione e nel risultato/telemetria.
// Se dopo un deploy questo valore NON cambia nei log di produzione, il deploy NON e'
// andato a buon fine (Railway non ha ricompilato il worker). Aggiornarlo ad ogni fix
// rilevante per il flusso YAP.
const WORKER_BUILD = "2026-06-11g-dom-dispatch-click";
const _workerStart = Date.now();
// --- Timeline super-dettagliata (orari + azioni) ----------------------------
// Ogni azione viene loggata con: ts wall-clock, ms dall'avvio worker, delta ms
// dall'azione precedente, n. progressivo, fase/stato e dettagli. Oltre allo stderr
// (catturato dal backend) viene scritta riga-per-riga su un file .jsonl persistente
// che sopravvive a crash/timeout, cosi' e' usabile per il debug post-mortem.
const ACTION_TIMELINE = [];
let _lastActionMs = _workerStart;
let _actionSeq = 0;
let _timelineFile = null;        // impostato dopo parseArgs (sappiamo artifactDir)
const _timelineBuffer = [];      // entry emesse prima che il file sia noto
let _runCorrelationId = `run-${_workerStart}-${process.pid}`;

function _writeTimelineLine(entry) {
  if (!_timelineFile) {
    _timelineBuffer.push(entry);
    return;
  }
  try {
    appendFileSync(_timelineFile, JSON.stringify(entry) + "\n");
  } catch (_) { /* il log non deve mai abbattere il worker */ }
}

function setTimelineFile(artifactDir, suffix) {
  try {
    const dir = path.join(artifactDir, "timelines");
    mkdirSync(dir, { recursive: true });
    _timelineFile = path.join(dir, `timeline-${suffix}.jsonl`);
    _runCorrelationId = `run-${suffix}`;
    // Flush di tutto quello bufferizzato prima di conoscere il path.
    for (const entry of _timelineBuffer) _writeTimelineLine(entry);
    _timelineBuffer.length = 0;
    logPhase("timeline", "file_ready", { file: _timelineFile });
  } catch (error) {
    logPhase("timeline", "file_error", { error: String(error?.message || error) });
  }
}

function logPhase(phase, status, extra = {}) {
  const nowMs = Date.now();
  const entry = {
    event: "yap:phase",
    seq: (_actionSeq += 1),
    run: _runCorrelationId,
    phase,
    status,
    elapsed_ms: nowMs - _workerStart,
    delta_ms: nowMs - _lastActionMs,
    ts: new Date(nowMs).toISOString(),
    ...extra,
  };
  _lastActionMs = nowMs;
  ACTION_TIMELINE.push(entry);
  if (ACTION_TIMELINE.length > 2000) ACTION_TIMELINE.shift(); // safety cap memoria
  process.stderr.write(JSON.stringify(entry) + "\n");
  _writeTimelineLine(entry);
}

// Helper esplicito per loggare una singola AZIONE atomica (click, fill, navigazione)
// con i dettagli completi: target, valore, esito, durata.
function logAction(action, details = {}) {
  logPhase("action", action, details);
}

process.stderr.write(JSON.stringify({ event: "yap:phase", phase: "worker", status: "module_loaded", build: WORKER_BUILD, ts: new Date().toISOString(), pid: process.pid }) + "\n");

function parseArgs(argv) {
  const args = {
    dryRun: true,
    headed: false,
    debug: false,
    freshLogin: false,
    artifactDir: process.env.YAP_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (!argv[i]) {
        throw new Error(`Valore mancante per ${arg}`);
      }
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--commit") args.dryRun = false;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--debug") args.debug = true;
    else if (arg === "--fresh-login") args.freshLogin = true;
    else if (arg === "--no-persist-profile") args.noPersistProfile = true;
    else if (arg === "--payload-file") args.payloadFile = next();
    else if (arg === "--practice-id") args.practiceId = next();
    else if (arg === "--api-base-url") args.apiBaseUrl = next();
    else if (arg === "--telegram-user-id") args.telegramUserId = next();
    else if (arg === "--artifact-dir") args.artifactDir = next();
    else if (arg === "--date") args.date = next();
    else if (arg === "--time") args.time = next();
    else if (arg === "--duration") args.duration = Number(next());
    else throw new Error(`Argomento non riconosciuto: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`
YAP worker - automazione agenda gestionale

Uso sicuro (non salva):
  node automation/yap/yap-worker.mjs --payload-file automation/yap/sample-payload.json

Uso da pratica API (non salva):
  node automation/yap/yap-worker.mjs --practice-id 123 --api-base-url http://127.0.0.1:8000 --telegram-user-id 761118078

Salvataggio reale:
  node automation/yap/yap-worker.mjs --practice-id 123 --commit

Variabili richieste:
  YAP_USERNAME
  YAP_PASSWORD

Variabili opzionali:
  YAP_BASE_URL              default: https://yap.mmbsoftware.it
  API_BASE_URL              default per --practice-id
  GIORGIO_TELEGRAM_USER_ID  default per --telegram-user-id
  YAP_ARTIFACT_DIR          default: automation/artifacts/yap
`);
}

function ensureEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Variabile ambiente obbligatoria mancante: ${name}`);
  }
  return value.trim();
}

function toIsoDate(value) {
  if (!value) return "";
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString().slice(0, 10);
}

// Default "oggi" e "ora attuale" nel fuso Europe/Rome, usati quando la mini-app
// NON imposta data/ora nel payload (deve essere il worker a metterle).
function todayIsoRome(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function nowTimeRome(now = new Date()) {
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("hour")}:${get("minute")}`;
}

function normalizeJob(rawInput, overrides = {}) {
  const input = rawInput?.data?.mapping || rawInput?.mapping || rawInput?.data?.payload || rawInput?.payload || rawInput;

  if (input?.anagrafica && input?.agenda) {
    let contexts = input.contexts || [];
    if (typeof contexts === "string") {
      contexts = contexts.split(",").map((c) => c.trim()).filter(Boolean);
    }
    if (!contexts.length) {
      contexts = (input.lavorazioni || []).map((item) => item.reparto).filter(Boolean);
    }
    return {
      practiceId: input.meta?.practice_id || rawInput?.practice_id || null,
      meta: input.meta || {},
      cosaOverride: input.meta?.cosa_override || input.anagrafica?.riferimento_breve || null,
      customer: {
        name: input.anagrafica.cliente_nome || "",
        phone: input.anagrafica.cliente_telefono || "",
        plate: input.anagrafica.targa || "",
        type: input.anagrafica.cliente_tipo || "",
      },
      appointment: (() => {
        const rawDate = toIsoDate(overrides.date || input.agenda.data);
        const rawTime = overrides.time || input.agenda.ora || "";
        const dateDefaulted = !rawDate;
        const timeDefaulted = !rawTime;
        return {
          date: rawDate || todayIsoRome(),
          rawTime: rawTime || (timeDefaulted ? nowTimeRome() : ""),
          time: normalizeAppointmentTime(rawTime || nowTimeRome()),
          dateDefaulted,
          timeDefaulted,
          duration: Number(overrides.duration || input.agenda.durata_minuti || getYapSlotMinutes()),
          type: input.agenda.tipo_pratica || "",
        };
      })(),
      contexts,
      sections: (input.lavorazioni || []).map((l) => ({
        ...l,
        note: l.note ?? l.notes ?? null,
      })),
      internalNotes: input.note_interne || "",
    };
  }

  const customer = input.customer || {};
  const appointment = input.appointment || {};
  const sections = input.sections
    ? Object.values(input.sections).map((section) => ({
        reparto: section.context,
        descrizioni: section.description_rows || [],
        ore_man: section.man_hours,
        ore_mac: section.mac_hours,
        materiali_euro: section.materials_amount,
        smaltimento_applica: section.waste?.apply,
        smaltimento_percentuale: section.waste?.percentage,
        ricambi: section.parts || [],
      }))
    : [];

  return {
    practiceId: input.practice_id || null,
    meta: input.meta || {},
    cosaOverride: input.meta?.cosa_override || null,
    customer: {
      name: customer.name || "",
      phone: customer.phone || "",
      plate: customer.plate || "",
      type: customer.type || "",
    },
    appointment: (() => {
      const rawDate = toIsoDate(overrides.date || appointment.date);
      const rawTime = overrides.time || appointment.time || "";
      const dateDefaulted = !rawDate;
      const timeDefaulted = !rawTime;
      return {
        date: rawDate || todayIsoRome(),
        rawTime: rawTime || (timeDefaulted ? nowTimeRome() : ""),
        time: normalizeAppointmentTime(rawTime || nowTimeRome()),
        dateDefaulted,
        timeDefaulted,
        duration: Number(overrides.duration || appointment.slot_duration || getYapSlotMinutes()),
        type: appointment.practice_type || "",
      };
    })(),
    contexts: input.contexts || sections.map((section) => section.reparto).filter(Boolean),
    sections,
    internalNotes: input.internal_notes || "",
  };
}

function validateJob(job) {
  const missing = [];
  if (!job.customer.name) missing.push("cliente");
  if (!job.customer.plate) missing.push("targa");
  if (!job.appointment.date) missing.push("data appuntamento");
  if (!job.appointment.time) missing.push("ora appuntamento");
  if (!job.contexts.length) missing.push("contesto");
  if (missing.length) {
    throw new Error(`Payload non pronto per YAP: mancano ${missing.join(", ")}`);
  }
  if (!/^\d{2}:\d{2}$/.test(job.appointment.time)) {
    throw new Error(`Ora appuntamento non valida: ${job.appointment.time}`);
  }
}

async function readPayloadFile(payloadFile, overrides) {
  const fullPath = path.resolve(payloadFile);
  const content = await fs.readFile(fullPath, "utf8");
  return normalizeJob(JSON.parse(content), overrides);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} su ${url}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

function withUserId(url, telegramUserId) {
  const parsed = new URL(url);
  parsed.searchParams.set("user_id", telegramUserId);
  return parsed.toString();
}

async function readPracticeFromApi(args) {
  const apiBaseUrl = args.apiBaseUrl || process.env.API_BASE_URL;
  const telegramUserId = args.telegramUserId || process.env.GIORGIO_TELEGRAM_USER_ID;
  if (!apiBaseUrl) throw new Error("Serve --api-base-url oppure API_BASE_URL");
  if (!telegramUserId) throw new Error("Serve --telegram-user-id oppure GIORGIO_TELEGRAM_USER_ID");

  const base = apiBaseUrl.replace(/\/$/, "");
  const checkUrl = withUserId(`${base}/practices/${args.practiceId}/pre-sync-check`, telegramUserId);
  const mappingUrl = withUserId(`${base}/practices/${args.practiceId}/management-mapping`, telegramUserId);

  const preSync = await fetchJson(checkUrl);
  const check = preSync.data || preSync;
  if (check.ready === false) {
    const issues = (check.issues || []).map((issue) => issue.message).join("; ");
    throw new Error(`Pratica non pronta per YAP (score ${check.score ?? "n/d"}): ${issues}`);
  }

  const mapping = await fetchJson(mappingUrl);
  return normalizeJob(mapping, args);
}

async function openAgenda(page, isoDate) {
  await openAgendaInApp(page);
  if (isoDate) {
    await gotoAgendaDate(page, isoDate);
  }
}

function hasWriteableOdlWork(job) {
  if (hasWorkContexts(jobToMapping(job))) return true;
  return Array.isArray(job?.sections) && job.sections.some((section) => {
    const reparto = String(section?.reparto || "").trim().toLowerCase();
    return reparto === "officina" || reparto === "carrozzeria";
  });
}

function shouldWriteOdlFromWorker(job) {
  return String(process.env.YAP_WRITE_ODL || "1").trim() !== "0" && hasWriteableOdlWork(job);
}

function shouldBlockPracticeWriteForVehicle(job, popupResult) {
  return Boolean(job?.customer?.plate) && popupResult?.vehicleState !== "linked";
}

function shouldBlockAppointmentSaveForVehicle(job, popupResult) {
  return Boolean(job?.customer?.plate) && popupResult?.vehicleState !== "linked";
}

function normalizeLoose(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeGridArticleCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^O+/, "")
    .trim();
}

function isExpectedGridArticle(readbackValue, expectedCode) {
  const expected = normalizeGridArticleCode(expectedCode);
  const actual = normalizeGridArticleCode(readbackValue);
  if (!expected || !actual) return false;
  return actual === expected;
}

function formatManNeedle(value) {
  return `MAN: ${value}`;
}

function formatMacNeedle(value) {
  return `MAC: ${value}`;
}

function isEffectiveOdlState(state) {
  return state === WORKSPACE_STATES.ODL_FULL;
}

function extractTrailingJsonBlock(text) {
  const source = String(text || "");
  for (let i = source.length - 1; i >= 0; i -= 1) {
    if (source[i] !== "{") continue;
    const candidate = source.slice(i).trim();
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep scanning backward.
    }
  }
  return null;
}

function parsePraticaHashPayload(rawUrl) {
  const raw = String(rawUrl || "").trim();
  const hashRaw = raw.replace(/^[^#]*/, "");
  let hashDecoded = hashRaw;
  try {
    hashDecoded = decodeURIComponent(hashRaw);
  } catch {
    // Leave raw hash when it is already decoded or malformed.
  }
  const match = hashDecoded.match(/#!pratica\|(.+)$/);
  if (!match) {
    return {
      ok: false,
      reason: "no_pratica_hash",
      hashRaw,
      hashDecoded,
      preview: hashDecoded.slice(0, 160),
      payload: null,
      idCompanyFolder: null,
      pageEnum: null,
    };
  }

  let payload = null;
  let idCompanyFolder = null;
  try {
    payload = JSON.parse(match[1]);
    idCompanyFolder = payload?.IdCompanyFolder ?? null;
  } catch {
    const idMatch = /IdCompanyFolder[^0-9]*(\d+)/.exec(match[1]);
    idCompanyFolder = idMatch ? Number(idMatch[1]) : null;
  }

  if (!idCompanyFolder) {
    return {
      ok: false,
      reason: "no_idcompanyfolder",
      hashRaw,
      hashDecoded,
      preview: hashDecoded.slice(0, 160),
      payload,
      idCompanyFolder: null,
      pageEnum: payload?.Page ?? null,
    };
  }

  return {
    ok: true,
    reason: null,
    hashRaw,
    hashDecoded,
    preview: hashDecoded.slice(0, 160),
    payload,
    idCompanyFolder: Number(idCompanyFolder),
    pageEnum: payload?.Page ?? null,
  };
}

function buildOdlNeedles(job) {
  const needles = [];
  const hasWork = hasWriteableOdlWork(job);
  for (const section of hasWork ? (job.sections || []) : []) {
    const reparto = String(section.reparto || "").trim();
    if (reparto) needles.push(reparto);
    for (const row of section.descrizioni || []) {
      if (row) needles.push(String(row));
    }
    if (section.ore_man != null) needles.push(formatManNeedle(section.ore_man));
    if (section.ore_mac != null) needles.push(formatMacNeedle(section.ore_mac));
    if (section.materiali_euro != null) needles.push(String(section.materiali_euro));
    if (section.smaltimento_applica) needles.push(String(section.smaltimento_percentuale ?? 2));
    for (const part of section.ricambi || []) {
      const name = part?.name || part?.nome;
      const qty = part?.quantity || part?.quantita;
      if (name) needles.push(String(name));
      if (qty) needles.push(String(qty));
    }
    if (section.note) needles.push(String(section.note));
  }
  return [...new Set(needles.map((item) => String(item || "").trim()).filter(Boolean))];
}

function buildSectionSummary(section) {
  const lines = [];
  const reparto = String(section.reparto || "reparto").trim();
  lines.push(`[${reparto}]`);
  for (const row of section.descrizioni || []) {
    if (row) lines.push(`- ${String(row).trim()}`);
  }
  if (section.ore_man != null) lines.push(formatManNeedle(section.ore_man));
  if (section.ore_mac != null) lines.push(formatMacNeedle(section.ore_mac));
  if (section.materiali_euro != null) lines.push(`Materiali: ${section.materiali_euro}`);
  if (section.smaltimento_applica) lines.push(`Smaltimento: ${section.smaltimento_percentuale ?? 2}%`);
  for (const part of section.ricambi || []) {
    const name = part?.name || part?.nome;
    const qty = part?.quantity || part?.quantita;
    if (!name) continue;
    lines.push(`Ricambio: ${String(name).trim()}${qty ? ` x ${String(qty).trim()}` : ""}`);
  }
  if (section.note) lines.push(`Note reparto: ${String(section.note).trim()}`);
  return lines.join("\n");
}

function buildOdlSummaryText(job) {
  const blocks = [];
  if (hasWriteableOdlWork(job) && job.internalNotes) {
    blocks.push(`Note interne: ${String(job.internalNotes).trim()}`);
  }
  for (const section of hasWriteableOdlWork(job) ? (job.sections || []) : []) {
    blocks.push(buildSectionSummary(section));
  }
  return blocks.join("\n\n").slice(0, 12000);
}

async function safeEvaluate(page, evaluator, arg, { retries = 2, delayMs = 250 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await page.evaluate(evaluator, arg);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "");
      const fatal = /Target crashed|Target closed|Page closed|Browser has been closed/i.test(message);
      const recoverable = !fatal && /Execution context was destroyed|Cannot find context with specified id/i.test(message);
      if (!recoverable || attempt === retries) break;
      await page.waitForTimeout(delayMs * (attempt + 1)).catch(() => {});
    }
  }
  throw lastError;
}

async function visibleTimeLabels(page) {
  return safeEvaluate(page, () => {
    return [...document.querySelectorAll("td.fc-axis.fc-time, .fc-time")]
      .map((node) => {
        const text = (node.textContent || "").trim();
        const rect = node.getBoundingClientRect();
        return { text, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
      .filter((item) => /^\d{2}:\d{2}$/.test(item.text) && item.height > 0 && item.width > 0);
  });
}

async function waitForAppointmentPopup(page, timeout = 6000) {
  return page.waitForFunction(() => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const popups = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel, .popup")];
    return popups.some((popup) => {
      if (!isVisible(popup)) return false;
      const text = (popup.textContent || "").toLowerCase();
      const visibleInputs = [...popup.querySelectorAll("input, textarea, select, button, a, [role='button']")].filter(isVisible);
      return text.includes("dettagli appuntamento") || visibleInputs.length >= 5;
    });
  }, null, { timeout }).then(() => true).catch(() => false);
}

function minutesOf(time) {
  const [hours, minutes] = String(time || "").replace(".", ":").split(":").map(Number);
  return hours * 60 + minutes;
}

async function clickApproximateSlot(page, targetTime) {
  const normalizedTarget = normalizeAppointmentTime(targetTime);
  await waitForAgendaReady(page, 8000).catch(() => {});
  const candidate = await safeEvaluate(page, (requestedTime) => {
    const toMinutes = (time) => {
      const raw = String(time || "").replace(".", ":");
      const match = raw.match(/^(\d{2}):(\d{2})$/);
      if (!match) return null;
      return Number(match[1]) * 60 + Number(match[2]);
    };
    const targetMinutes = toMinutes(requestedTime);
    if (targetMinutes == null) return null;

    const rows = [...document.querySelectorAll(".fc-slats tr[data-time]")].map((row) => {
      const cell = row.querySelector("td:not(.fc-axis)");
      const time = String(row.getAttribute("data-time") || "").slice(0, 5);
      const minutes = toMinutes(time);
      if (!cell || minutes == null) return null;
      return { row, cell, time, minutes };
    }).filter(Boolean);

    if (!rows.length) return null;

    const exact = rows.find((item) => item.minutes === targetMinutes);
    if (!exact) {
      return {
        missing: true,
        requestedTime,
        minTime: rows[0]?.time || null,
        maxTime: rows[rows.length - 1]?.time || null,
        availableSample: rows.slice(0, 4).map((item) => item.time).concat(rows.slice(-4).map((item) => item.time)),
      };
    }

    exact.cell.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const rect = exact.cell.getBoundingClientRect();
    return {
      time: exact.time,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }, normalizedTarget).catch(() => null);

  if (candidate) {
    if (candidate.missing) {
      throw new Error(`Slot YAP non visibile per ${normalizedTarget} (range visibile ${candidate.minTime || "?"}-${candidate.maxTime || "?"})`);
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  let slot = candidate;
  if (!slot) {
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll(".fc-slats tr[data-time]");
      if (rows.length > 0) return true;
      const labels = [...document.querySelectorAll("td.fc-axis.fc-time, .fc-time")];
      return labels.some((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return /^\d{2}:\d{2}$/.test((node.textContent || "").trim()) && rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
    }, null, { timeout: 5000 }).catch(() => {});

    const labels = await visibleTimeLabels(page);
    if (!labels.length) {
      throw new Error("Non trovo la griglia oraria YAP o non è ancora pronta");
    }

    const targetMinutes = minutesOf(normalizedTarget);
    const sorted = labels.sort((a, b) => minutesOf(a.text || a.time) - minutesOf(b.text || b.time));
    slot = null;
    for (const item of sorted) {
      const candidateTime = item.text || item.time;
      if (minutesOf(candidateTime) === targetMinutes) {
        slot = item;
      }
    }
    if (!slot) {
      throw new Error(`Slot YAP non visibile per ${normalizedTarget} (range visibile ${sorted[0]?.text || "?"}-${sorted[sorted.length - 1]?.text || "?"})`);
    }
  }

  const clickY = slot.y + Math.max(8, slot.height / 2);
  const clickPoints = [
    {
      x: slot.x + Math.max(20, slot.width / 2),
      y: clickY,
    },
    {
      x: slot.x + slot.width + 120,
      y: clickY,
    },
    {
      x: slot.x + slot.width + 220,
      y: clickY,
    },
    {
      x: slot.x + slot.width + 320,
      y: clickY,
    },
  ];

  for (const point of clickPoints) {
    // Usa page.mouse.click nativo (OS-level) invece di dispatchEvent sintetico
    // GWT risponde meglio agli eventi OS-level per l'apertura del popup
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(60).catch(() => {});
    await page.mouse.click(point.x, point.y, { button: "left", clickCount: 1 });
    await page.waitForTimeout(60).catch(() => {});
    const opened = await waitForAppointmentPopup(page, 5000);
    if (opened) return;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(120);
  }

  throw new Error("Popup YAP non aperto dopo il click sullo slot");
}

// Rileva se lo slot dell'orario richiesto è già occupato da un appuntamento esistente.
// "Si vede visivamente": cerca un evento (.fc-event) che si sovrappone — sia in
// verticale (fascia oraria dello slot) sia in orizzontale (colonna del giorno, così
// non dà falsi positivi in vista settimanale) — al centro dello slot target.
async function isSlotOccupied(page, time) {
  const target = normalizeAppointmentTime(time);
  return safeEvaluate(page, (requested) => {
    const toMinutes = (t) => {
      const m = String(t || "").replace(".", ":").match(/^(\d{1,2}):(\d{2})$/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const targetMin = toMinutes(requested);
    if (targetMin == null) return false;
    const rows = [...document.querySelectorAll(".fc-slats tr[data-time]")];
    let band = null;
    let column = null;
    for (let i = 0; i < rows.length; i += 1) {
      const rowTime = String(rows[i].getAttribute("data-time") || "").slice(0, 5);
      if (toMinutes(rowTime) !== targetMin) continue;
      const rowRect = rows[i].getBoundingClientRect();
      const nextRect = rows[i + 1]?.getBoundingClientRect();
      const top = rowRect.top;
      const bottom = nextRect && nextRect.top > top ? nextRect.top : rowRect.bottom;
      band = { mid: (top + bottom) / 2 };
      const cell = rows[i].querySelector("td:not(.fc-axis)");
      if (cell) {
        const cr = cell.getBoundingClientRect();
        if (cr.width > 4) column = { left: cr.left, right: cr.right };
      }
      break;
    }
    if (!band) return false;
    const events = [...document.querySelectorAll(".fc-event, .fc-time-grid-event, a.fc-event")];
    return events.some((ev) => {
      const er = ev.getBoundingClientRect();
      if (er.width < 4 || er.height < 4) return false;
      const overlapsY = er.top <= band.mid && er.bottom >= band.mid;
      if (!overlapsY) return false;
      if (!column) return true;
      return er.left < column.right && er.right > column.left;
    });
  }, target).catch(() => false);
}

// Logica ricorsiva richiesta: se lo slot è occupato, avanza di +slotMinutes (default 20)
// e riprova, fino a trovarne uno libero (entro fine giornata). Restituisce l'orario libero.
async function resolveFreeSlotTime(page, desiredTime, slotMinutes = getYapSlotMinutes()) {
  const step = Number(slotMinutes) > 0 ? Number(slotMinutes) : getYapSlotMinutes();
  const base = normalizeAppointmentTime(desiredTime);
  const lastSlotMin = 23 * 60; // non oltre le 23:00
  const tried = [];
  const maxSteps = Math.max(0, Math.ceil((lastSlotMin - minutesOf(base)) / step));
  for (let i = 0; i <= maxSteps; i += 1) {
    const candidate = i === 0 ? base : normalizeAppointmentTime(addMinutes(base, i * step));
    const occupied = await isSlotOccupied(page, candidate);
    tried.push({ time: candidate, occupied });
    if (!occupied) {
      return { time: candidate, shifted: i > 0, steps: i, exhausted: false, tried };
    }
  }
  // Tutti gli slot fino a fine giornata risultano occupati: usa il richiesto.
  return { time: base, shifted: false, steps: 0, exhausted: true, tried };
}

async function inputSnapshot(page) {
  return safeEvaluate(page, () => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };

    return [...document.querySelectorAll("input")].filter(isVisible).map((node, index) => {
      const rect = node.getBoundingClientRect();
      return {
        index,
        value: node.value || "",
        placeholder: node.getAttribute("placeholder") || "",
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
  });
}

async function appointmentPopupRect(page) {
  return safeEvaluate(page, () => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel, .popup")]
      .find((element) => {
        if (!isVisible(element)) return false;
        const text = (element.textContent || "").toLowerCase();
        if (text.includes("dettagli appuntamento")) return true;
        const visibleInputs = [...element.querySelectorAll("input, textarea, select, button, a, [role='button']")].filter(isVisible);
        return visibleInputs.length >= 5;
      });
    if (!popup) return null;
    const rect = popup.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

async function fillVisibleInput(page, index, value) {
  await safeEvaluate(page, ({ index: targetIndex, value: nextValue }) => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const input = [...document.querySelectorAll("input")].filter(isVisible)[targetIndex];
    if (!input) {
      throw new Error(`Input visibile non trovato: ${targetIndex}`);
    }

    input.focus();
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }, { index, value });
}

// Individua il campo "Tag" nel popup e restituisce le coordinate (per il focus reale).
async function locateTagInput(page) {
  return safeEvaluate(page, () => {
    const isVisible = (node) => {
      const r = node.getBoundingClientRect();
      const s = window.getComputedStyle(node);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")]
      .find((p) => (p.textContent || "").includes("Dettagli"));
    if (!popup) return null;
    const visInputs = [...popup.querySelectorAll("input")].filter(isVisible);
    // Il campo Tag e' identificabile in modo stabile: maxlength="25" e
    // text-transform lowercase (a differenza del Cosa uppercase e degli orari HH.MM).
    let input = visInputs.find((el) => el.getAttribute("maxlength") === "25");
    if (!input) input = visInputs.find((el) => (el.style && el.style.textTransform === "lowercase"));
    if (!input) {
      // Fallback: un gwt-SuggestBox vuoto che non sia un orario (HH.MM) ne' una data.
      input = visInputs.find((el) => /gwt-SuggestBox/.test(el.className)
        && !/^\d{1,2}\.\d{2}$/.test(el.value || "")
        && !/^\d{2}\/\d{2}\/\d{4}$/.test(el.value || ""));
    }
    if (!input) return null;
    input.scrollIntoView({ block: "center", inline: "nearest" });
    const r = input.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }).catch(() => null);
}

// Verifica (readback) che il tag risulti effettivamente selezionato come chip nel popup.
async function isTagConfirmed(page, tag) {
  return safeEvaluate(page, (wanted) => {
    const norm = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")]
      .find((p) => (p.textContent || "").includes("Dettagli"));
    if (!popup) return false;
    // Un chip è un elemento foglia (senza figli) il cui testo è esattamente il tag,
    // e NON è un <input> (quello conterrebbe il testo digitato, non un chip).
    return [...popup.querySelectorAll("span, div, td, button, a, li")]
      .some((el) => el.children.length === 0
        && el.tagName !== "INPUT"
        && norm(el.textContent) === norm(wanted));
  }, tag).catch(() => false);
}

// Vocabolario dei tag YAP conosciuti: serve a distinguere un chip-tag dalle altre
// label del popup ("Cosa", "Quando", "Tag", ...) quando si rimuovono i residui.
const KNOWN_YAP_TAGS = ["officina", "revisione", "pneumatici", "preventivo", "carrozzeria", "gommista"];

// Rimuove i chip-tag PRE-ESISTENTI non richiesti. YAP pre-compila il popup del nuovo
// appuntamento con i tag dell'ultimo appuntamento creato nella sessione browser
// (profilo persistente): senza pulizia l'appuntamento eredita tag spuri (es.
// "pneumatici" su una pratica solo officina).
async function removeStaleTagChips(page, wantedTags) {
  const wanted = new Set(wantedTags.map((t) => String(t).trim().toLowerCase()));
  const removed = [];
  const failedRemove = [];
  for (let pass = 0; pass < KNOWN_YAP_TAGS.length; pass += 1) {
    const stale = await safeEvaluate(page, ({ known, want }) => {
      const norm = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (node) => {
        const r = node.getBoundingClientRect();
        const s = window.getComputedStyle(node);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")]
        .find((p) => (p.textContent || "").includes("Dettagli"));
      if (!popup) return null;
      const chip = [...popup.querySelectorAll("span, div, td, li")]
        .filter(isVisible)
        .find((el) => el.children.length === 0
          && el.tagName !== "INPUT"
          && known.includes(norm(el.textContent))
          && !want.includes(norm(el.textContent)));
      if (!chip) return null;
      const r = chip.getBoundingClientRect();
      return {
        label: norm(chip.textContent),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        chip: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
        containerHtml: (chip.parentElement?.parentElement?.outerHTML || chip.parentElement?.outerHTML || "").slice(0, 600),
      };
    }, { known: KNOWN_YAP_TAGS, want: [...wanted] }).catch(() => null);
    if (!stale) break;

    // L'icona di rimozione dei chip GWT spesso compare solo all'HOVER: prima
    // hover sul chip, poi ricerca dei candidati-icona vicino al chip.
    await page.mouse.move(stale.chip.x, stale.chip.y).catch(() => {});
    await page.waitForTimeout(300).catch(() => {});
    const icons = await safeEvaluate(page, ({ rect }) => {
      const isVisible = (node) => {
        const r = node.getBoundingClientRect();
        const s = window.getComputedStyle(node);
        return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none";
      };
      const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")]
        .find((p) => (p.textContent || "").includes("Dettagli"));
      if (!popup) return [];
      // Candidati: elementi piccoli (icon-font) sulla stessa riga del chip, dentro
      // il chip o subito a destra (max 40px oltre il bordo destro).
      return [...popup.querySelectorAll("span, div, a, button, i")]
        .filter(isVisible)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ el, r }) => el.children.length === 0
          && r.width < 28 && r.height < 28
          && Math.abs((r.y + r.height / 2) - (rect.y + rect.h / 2)) < 14
          && r.x + r.width / 2 > rect.x - 4
          && r.x < rect.x + rect.w + 40)
        .map(({ el, r }) => ({
          x: r.x + r.width / 2, y: r.y + r.height / 2,
          txt: (el.textContent || "").trim().slice(0, 8),
          cls: (el.className || "").slice(0, 40),
        }))
        .slice(0, 4);
    }, { rect: stale.rect }).catch(() => []);

    let gone = false;
    let how = null;
    // Filtra l'icona che e' il chip stesso (stesso testo del tag).
    const candidates = icons.filter((c) => c.txt.toLowerCase() !== stale.label);
    for (const c of candidates) {
      await page.mouse.click(c.x, c.y).catch(() => {});
      await page.waitForTimeout(280).catch(() => {});
      gone = !(await isTagConfirmed(page, stale.label));
      if (gone) { how = `icon:${c.txt || c.cls}`; break; }
    }
    if (!gone) {
      // Fallback: click sul chip + Delete/Backspace.
      await page.mouse.click(stale.chip.x, stale.chip.y).catch(() => {});
      await page.waitForTimeout(150).catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await page.waitForTimeout(250).catch(() => {});
      gone = !(await isTagConfirmed(page, stale.label));
      if (gone) how = "chip_delete";
    }
    if (!gone) {
      // Ultimo tentativo: doppio click sul chip.
      await page.mouse.dblclick(stale.chip.x, stale.chip.y).catch(() => {});
      await page.waitForTimeout(280).catch(() => {});
      gone = !(await isTagConfirmed(page, stale.label));
      if (gone) how = "dblclick";
    }
    logAction("tag_chip_removed", {
      tag: stale.label, how, gone, iconCandidates: icons,
      containerHtml: gone ? undefined : stale.containerHtml,
    });
    if (gone) removed.push(stale.label);
    else { failedRemove.push(stale.label); break; }
  }
  return { removed, failedRemove };
}

// Scrive i tag in modo AFFIDABILE: focus reale sul campo, digitazione con eventi
// veri (così l'oracle GWT del SuggestBox si attiva), click sul suggerimento
// corrispondente (o Enter), poi readback di conferma per ogni tag.
async function addYapTagChips(page, tags) {
  if (!tags.length) return { ok: true, added: [], failed: [] };
  const added = [];
  const failed = [];

  // Prima la pulizia dei tag spuri ereditati dalla sessione, poi l'aggiunta.
  const cleanup = await removeStaleTagChips(page, tags).catch(() => ({ removed: [], failedRemove: [] }));
  if (cleanup.removed.length || cleanup.failedRemove.length) {
    logAction("tags_cleanup", { removed: cleanup.removed, failedRemove: cleanup.failedRemove });
  }

  for (const tag of tags) {
    // Se è già presente, salta.
    if (await isTagConfirmed(page, tag)) { added.push(tag); continue; }

    // Fino a 2 tentativi: dopo l'aggancio veicolo il popup puo' essere ancora
    // "in movimento" (fetch + re-render) e il primo tentativo puo' fallire.
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt += 1) {
      const target = await locateTagInput(page);
      if (!target) {
        logAction("tag_debug", { tag, attempt, located: false });
        await page.waitForTimeout(300).catch(() => {});
        continue;
      }

      // Focus reale + pulizia eventuale residuo + digitazione con eventi veri.
      await page.mouse.click(target.x, target.y).catch(() => {});
      await page.waitForTimeout(140).catch(() => {});
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.press("Delete").catch(() => {});
      await page.keyboard.type(tag, { delay: 45 }).catch(() => {});
      await page.waitForTimeout(450).catch(() => {});

      // Diagnostica + ricerca suggerimento: leggo cosa c'e' nel campo e nel popup.
      const probe = await safeEvaluate(page, ({ wanted, tx, ty }) => {
        const norm = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
        const isVisible = (node) => {
          const r = node.getBoundingClientRect();
          const s = window.getComputedStyle(node);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
        };
        // valore attuale dell'input Tag (l'elemento sotto le coordinate cliccate)
        const active = document.activeElement;
        const inputVal = active && active.tagName === "INPUT" ? (active.value || "") : null;
        const activeCls = active ? (active.className || "").slice(0, 50) : null;
        const pops = [...document.querySelectorAll(".gwt-SuggestBoxPopup, .gwt-PopupPanel, [role='listbox']")]
          .filter(isVisible)
          .filter((p) => !/dettagli appuntamento/i.test(p.textContent || ""));
        const suggestions = [];
        let match = null;
        for (const pop of pops) {
          for (const el of [...pop.querySelectorAll("td, div, span, li, [role='option']")].filter(isVisible)) {
            if (el.children.length !== 0) continue;
            const t = (el.textContent || "").trim();
            if (!t) continue;
            if (suggestions.length < 8) suggestions.push(t.slice(0, 30));
            if (!match && norm(t).includes(norm(wanted))) {
              const r = el.getBoundingClientRect();
              match = { x: r.x + (r.width / 2), y: r.y + (r.height / 2) };
            }
          }
        }
        return { inputVal, activeCls, suggestions, match };
      }, { wanted: tag, tx: target.x, ty: target.y }).catch(() => ({}));

      if (probe?.match) {
        await page.mouse.click(probe.match.x, probe.match.y).catch(() => {});
      } else {
        await page.keyboard.press("Enter").catch(() => {});
      }
      await page.waitForTimeout(260).catch(() => {});
      ok = await isTagConfirmed(page, tag);
      logAction("tag_debug", {
        tag, attempt, located: true, target,
        inputVal: probe?.inputVal ?? null,
        activeCls: probe?.activeCls ?? null,
        suggestions: probe?.suggestions || [],
        pickedSuggestion: Boolean(probe?.match),
        confirmed: ok,
      });
    }

    if (ok) added.push(tag);
    else failed.push(tag);
  }

  logPhase("tags", failed.length ? "partial" : "done", { requested: tags, added, failed });
  return { ok: failed.length === 0, added, failed };
}

async function clickAppointmentPopupPractice(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
    };
    const popup = document.querySelector(".gwt-DecoratedPopupPanel");
    const root = popup || document.body;
    const candidates = [...root.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div")].filter((el) => {
      const t = (el.textContent || "").toLowerCase();
      return (
        (t.includes("gestione pratica")
          || t.includes("apri pratica")
          || (t.includes("pratica") && !t.includes("prenotazione")))
        && t.length < 80
      );
    });
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, label: (el.textContent || "").trim().slice(0, 100) };
    }
    return { clicked: false, label: null };
  }).catch(() => ({ clicked: false, label: null }));
}

async function clickAppointmentPopupFooterSlot(page, slotIndex) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0) return { clicked: false, label: null };
  const target = await safeEvaluate(page, (index) => {
    const popup = document.querySelector(".gwt-DecoratedPopupPanel");
    if (!popup) return null;
    const rect = popup.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) return null;
    const slots = 4;
    const clamped = Math.min(Math.max(index, 0), slots - 1);
    const segmentWidth = rect.width / slots;
    return {
      x: rect.x + (segmentWidth * clamped) + (segmentWidth / 2),
      y: rect.y + rect.height - 18,
      label: `footer-slot-${clamped + 1}`,
    };
  }, slotIndex).catch(() => null);
  if (!target) return { clicked: false, label: null };
  await page.mouse.click(target.x, target.y).catch(() => {});
  await page.waitForTimeout(180).catch(() => {});
  return { clicked: true, label: target.label };
}

async function clickOdlSection(page, { candidateIndex = 0, maxY = 220, returnDebug = false } = {}) {
  const candidate = await safeEvaluate(page, ({ index, topLimit, wantDebug }) => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")].filter((el) => {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!(t.includes("ordini di lavoro") || t === "odl" || t.startsWith("ordini di lavoro"))) return false;
      if (t.length >= 60) return false;
      const rect = el.getBoundingClientRect();
      return rect.y < topLimit;
    });
    const ranked = candidates
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        const cls = String(el.className || "");
        const role = String(el.getAttribute("role") || "");
        const title = String(el.getAttribute("title") || "");
        const ariaSelected = String(el.getAttribute("aria-selected") || "");
        let score = 0;
        if (/^ordini di lavoro$/i.test(text)) score += 20;
        if (/^ordini di lavoro/i.test(text)) score += 12;
        if (/tab|item|label|button/i.test(cls)) score += 8;
        if (role === "tab") score += 12;
        if (ariaSelected === "false") score += 6;
        if (/ordini di lavoro/i.test(title)) score += 4;
        if (rect.width >= 40 && rect.width <= 180) score += 4;
        if (rect.height >= 18 && rect.height <= 42) score += 4;
        return {
          text,
          x: rect.x + (rect.width / 2),
          y: rect.y + (rect.height / 2),
          width: rect.width,
          height: rect.height,
          score,
        };
      })
      .sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    const selectedIndex = Math.min(Math.max(0, Number(index) || 0), Math.max(0, ranked.length - 1));
    const selected = ranked[selectedIndex] || ranked[0] || null;
    if (!wantDebug) return selected;
    return {
      selected,
      ranked: ranked.slice(0, 8),
      selectedIndex,
      candidateCount: ranked.length,
    };
  }, { index: Math.max(0, Number(candidateIndex) || 0), topLimit: Math.max(120, Number(maxY) || 220), wantDebug: Boolean(returnDebug) }).catch(() => null);
  const selected = returnDebug ? candidate?.selected : candidate;
  if (!selected) return returnDebug ? { clicked: false, label: null, debug: candidate || null } : { clicked: false, label: null };
  await page.mouse.click(selected.x, selected.y).catch(() => {});
  await page.waitForTimeout(120).catch(() => {});
  return returnDebug
    ? {
        clicked: true,
        label: String(selected.text || "").slice(0, 100),
        debug: {
          candidateCount: candidate?.candidateCount || 0,
          selectedIndex: candidate?.selectedIndex ?? 0,
          ranked: candidate?.ranked || [],
          selected: candidate?.selected || null,
          topLimit: Math.max(120, Number(maxY) || 220),
        },
      }
    : { clicked: true, label: String(selected.text || "").slice(0, 100) };
}

async function activateOdlTopTab(page) {
  const target = await safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8
        && style.display !== "none" && style.visibility !== "hidden"
        && rect.left > -200 && rect.top > -200;
    };
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const candidates = [...document.querySelectorAll(".gwt-TabLayoutPanelTab, [role='tab'], button, a, td, div, span")]
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const cls = String(el.className || "");
        const text = norm(el.textContent || el.getAttribute("title") || el.getAttribute("aria-label") || "");
        let host = el;
        const wrapper = el.closest?.(".gwt-TabLayoutPanelTab");
        if (wrapper && isVisible(wrapper)) host = wrapper;
        const hostRect = host.getBoundingClientRect();
        let score = 0;
        if (text === "ordini di lavoro" || text === "ordini di lavoro u") score += 30;
        if (/^ordini di lavoro\b/.test(text)) score += 18;
        if (/\bgwt-TabLayoutPanelTab\b/.test(String(host.className || "")) && !/Inner/.test(String(host.className || ""))) score += 16;
        if (el.getAttribute("role") === "tab" || host.getAttribute?.("role") === "tab") score += 8;
        if (hostRect.y >= 50 && hostRect.y <= 150) score += 8;
        if (hostRect.width >= 60 && hostRect.width <= 180) score += 4;
        if (hostRect.height >= 18 && hostRect.height <= 40) score += 4;
        if (/dettagli pratica|preventivi|documenti fiscali|notifiche|firme/.test(text)) score -= 50;
        return { el, host, text, cls, score, rect: hostRect };
      })
      .filter((it) => /^ordini di lavoro\b/.test(it.text) && it.rect.y < 180 && it.score > 0)
      .sort((a, b) => b.score - a.score || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const selected = candidates[0];
    if (!selected) return null;
    const rect = selected.rect;
    const x = rect.x + (rect.width / 2);
    const y = rect.y + (rect.height / 2);
    selected.host.scrollIntoView?.({ block: "nearest", inline: "center" });
    for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
      selected.host.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
      }));
    }
    if (typeof selected.host.click === "function") selected.host.click();
    return {
      clicked: true,
      label: selected.text,
      className: String(selected.host.className || selected.cls || ""),
      x,
      y,
      width: rect.width,
      height: rect.height,
      score: selected.score,
    };
  }).catch(() => null);
  if (!target) return { clicked: false, label: null, reason: "odl_gwt_tab_not_found" };
  await page.mouse.click(target.x, target.y, { button: "left", clickCount: 1 }).catch(() => {});
  await page.waitForTimeout(300).catch(() => {});
  return target;
}

async function snapshotTopOdlCandidates(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")]
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        return {
          text,
          className: String(el.className || ""),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((item) => item.text && /ordini di lavoro|\bodl\b/i.test(item.text))
      .filter((item) => item.y < 160)
      .slice(0, 25);
  }).catch(() => []);
}

async function openFirstOdlEntryFromList(page) {
  // Quando YAP è sul tab "Ordini di lavoro", mostra una lista ODL.
  // Bisogna cliccare il primo entry per aprire il form ODL con i sub-tab.
  const result = await safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
    };
    // Cerca righe/elementi nella lista ODL — escludi tab di navigazione, header, bottoni principali
    const odlListRe = /ordini di lavoro|odl/i;
    const navTabRe = /dettagli pratica|preventivi|note interne|ordini di lavoro|ordini cliente|fattura|archivio/i;
    const subTabRe = /descrizione danni|materiali di consumo|smaltimento rifiuti|note interne|tempi|totali|ordini cliente|prospetti/i;
    const loadingVisible = [...document.querySelectorAll("div, span, td, label")]
      .filter(isVisible)
      .some((el) => /recupero dettagli pratica in corso|caricamento .* in corso|loading/i.test((el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase()));
    if (loadingVisible) {
      return { clicked: false, strategy: "loading_visible" };
    }

    // Prova 1: bottone/link "Apri" o "Modifica" o simile dentro la lista ODL
    const actionCandidates = [...document.querySelectorAll("button, a, [role='button'], .gwt-Button, .gwt-Anchor")]
      .filter(isVisible)
      .filter(el => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return t === "apri" || t === "modifica" || t === "edit" || t === "open" || t === "seleziona";
      });
    if (actionCandidates.length) {
      const target = actionCandidates[0];
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, strategy: "action_button", text: (target.textContent || "").trim(), x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2) };
    }

    // Prova 2: prima TR nella tabella lista ODL (dopo l'header) che ha click handler
    const tableRows = [...document.querySelectorAll("tbody tr, .gwt-FlexTable tr, .gwt-Grid tr")]
      .filter(isVisible)
      .filter(el => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length < 3) return false;
        if (subTabRe.test(text) || navTabRe.test(text)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.y < 130) return false;
        return rect.height >= 16 && rect.height <= 80 && rect.width >= 100;
      });
    if (tableRows.length) {
      const target = tableRows[0];
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, strategy: "table_row", text: (target.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80), x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2) };
    }

    // Prova 3: td/span/label con testo che contiene un numero (ID ODL) o pattern tipo stato
    // Es: "ODL-1234", "preventivo", "in corso", "data creazione"
    const idCandidates = [...document.querySelectorAll("td")]
      .filter(isVisible)
      .filter(el => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length < 2 || text.length > 40) return false;
        if (navTabRe.test(text) || subTabRe.test(text)) return false;
        // Cerca celle con numero o ID (pattern ODL comuni: "1", "ODL-1", "Aperto", date brevi)
        if (!/\d/.test(text) && !/^(aperto|chiuso|in corso|preventivo|bozza)$/i.test(text)) return false;
        const rect = el.getBoundingClientRect();
        return rect.y >= 130 && rect.height >= 16 && rect.height <= 50;
      })
      .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
    if (idCandidates.length) {
      const target = idCandidates[0];
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, strategy: "id_cell", text: (target.textContent || "").trim().slice(0, 80), x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2) };
    }

    return { clicked: false, strategy: "none" };
  }).catch(() => ({ clicked: false, strategy: "error" }));

  if (result?.clicked) {
    await page.mouse.click(result.x, result.y).catch(() => {});
    await page.waitForTimeout(200).catch(() => {});
  }
  return result;
}

// Verifica se la sub-tab `label` risulta SELEZIONATA nel TabLayoutPanel GWT.
async function isBottomSectionTabSelected(page, needle) {
  return safeEvaluate(page, (target) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    return [...document.querySelectorAll(".gwt-TabLayoutPanelTab-selected, [class*='TabLayoutPanelTab-selected']")]
      .some((el) => norm(el.textContent).includes(target));
  }, needle).catch(() => false);
}

// Coordinate del centro del WRAPPER tab GWT che contiene `needle` (per click reale).
async function _bottomTabCoords(page, needle) {
  return safeEvaluate(page, (target) => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
    };
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const cands = [...document.querySelectorAll(".gwt-TabLayoutPanelTab, button, a, [role='button'], .gwt-Label, span, div, td")]
      .filter(isVisible)
      .map((el) => ({ el, cls: String(el.className || ""), text: norm(el.textContent), rect: el.getBoundingClientRect() }))
      .filter((it) => (it.text === target || it.text.includes(target)) && it.rect.y > 50)
      .map((it) => {
        let s = 0;
        if (it.text === target) s += 20;
        if (/\bgwt-TabLayoutPanelTab\b/.test(it.cls) && !/Inner/.test(it.cls)) s += 14;
        if (it.rect.width >= 40 && it.rect.width <= 220) s += 4;
        if (it.rect.y > window.innerHeight * 0.4) s += 2;
        return { it, s };
      })
      .sort((a, b) => b.s - a.s || b.it.rect.y - a.it.rect.y);
    if (!cands.length) return null;
    const r = cands[0].it.rect;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, needle).catch(() => null);
}

async function clickBottomSectionTab(page, label) {
  const needle = normalizeLoose(label);
  if (!needle) return false;
  // Se è GIÀ selezionata non facciamo nulla (evita di "deselezionare"/ri-animare).
  if (await isBottomSectionTabSelected(page, needle)) return true;
  // Le tab GWT hanno un glifo-icona in coda alla label (es. "Note interne ư") →
  // match per INCLUSIONE via regex. CRITICO: il click sintetico (dispatchEvent,
  // isTrusted=false) a volte NON commuta la tab GWT — causa l'intermittenza per cui
  // le note non venivano scritte e il verify scendeva a 4/10. Quindi prima usiamo il
  // LOCATOR Playwright (eventi nativi *trusted*, auto-wait, scroll-into-view,
  // attesa di non-occlusione), poi confermiamo la selezione e solo come ultimo
  // fallback usiamo il dispatch DOM. Ritorniamo lo stato REALE di selezione.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelRe = new RegExp(escaped, "i");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // 1) Wrapper tab via locator (il più affidabile per GWT).
    const wrapper = page.locator(".gwt-TabLayoutPanelTab", { hasText: labelRe }).first();
    if (await wrapper.count().catch(() => 0)) {
      await wrapper.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await wrapper.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(180).catch(() => {});
      if (await isBottomSectionTabSelected(page, needle)) return true;
      // 2) A volte serve colpire l'inner.
      const inner = page.locator(".gwt-TabLayoutPanelTabInner", { hasText: labelRe }).first();
      if (await inner.count().catch(() => 0)) {
        await inner.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(180).catch(() => {});
        if (await isBottomSectionTabSelected(page, needle)) return true;
      }
    }
    // 3) Fallback: click reale del mouse alle coordinate del wrapper.
    const coords = await _bottomTabCoords(page, needle);
    if (coords) {
      await page.mouse.click(coords.x, coords.y).catch(() => {});
      await page.waitForTimeout(180).catch(() => {});
      if (await isBottomSectionTabSelected(page, needle)) return true;
      // 4) Ultimo fallback: dispatch DOM completo sul wrapper.
      await safeEvaluate(page, (target) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const el = [...document.querySelectorAll(".gwt-TabLayoutPanelTab")]
          .find((n) => norm(n.textContent).includes(target));
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        for (const t of ["mousedown", "mouseup", "click"]) {
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
        }
        try { el.click(); } catch (e) {}
        return true;
      }, needle).catch(() => false);
      await page.waitForTimeout(180).catch(() => {});
      if (await isBottomSectionTabSelected(page, needle)) return true;
    }
    await page.waitForTimeout(220).catch(() => {});
  }
  return await isBottomSectionTabSelected(page, needle);
}

async function _legacyClickBottomSectionTab(page, label) {
  const needle = normalizeLoose(label);
  if (!needle) return false;
  const candidate = await safeEvaluate(page, (target) => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")]
      .filter(isVisible)
      .map((el) => ({
        rawText: (el.textContent || "").replace(/\s+/g, " ").trim(),
        cls: String(el.className || ""),
        title: String(el.getAttribute("title") || ""),
        tag: el.tagName,
        text: (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase(),
        rect: el.getBoundingClientRect(),
      }))
      .filter((item) => item.text === target || item.text.includes(target))
      .filter((item) => item.rect.y > 50)
      .map((item) => {
        let score = 0;
        if (item.text === target) score += 20;
        if (item.title.toLowerCase() === target) score += 8;
        if (/td|span|a|button/i.test(item.tag)) score += 4;
        if (/tab|item|label/i.test(item.cls)) score += 4;
        if (item.rect.width >= 40 && item.rect.width <= 180) score += 4;
        if (item.rect.height >= 16 && item.rect.height <= 40) score += 3;
        if (item.rect.y > window.innerHeight * 0.4) score += 2;
        return {
          ...item,
          score,
          x: item.rect.x + (item.rect.width / 2),
          y: item.rect.y + (item.rect.height / 2),
        };
      });
    const best = candidates.sort((a, b) => b.score - a.score || b.rect.y - a.rect.y || a.rect.x - b.rect.x)[0];
    if (!best) return null;
    return {
      x: best.x,
      y: best.y,
      text: best.rawText,
      score: best.score,
    };
  }, needle).catch(() => null);
  if (!candidate) return false;
  await page.mouse.click(candidate.x, candidate.y).catch(() => {});
  await page.waitForTimeout(120).catch(() => {});
  return true;
}

async function snapshotBottomSectionTabs(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
    };
    // FIX: filtro y > innerHeight-160 rimosso — restituisce tab ODL ovunque nel viewport.
    const odlTabRe = /descrizione danni|materiali di consumo|smaltimento rifiuti|note interne|tempi|totali|ordini cliente|prospetti/i;
    const allItems = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")]
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        return {
          text,
          className: String(el.className || ""),
          title: String(el.getAttribute("title") || ""),
          tag: el.tagName,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
      .filter((item) => item.text && item.text.length <= 80)
      .filter((item) => item.y > 50)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    // Restituisce prima le tab ODL riconosciute, poi il resto (limitato)
    const odlTabs = allItems.filter((item) => odlTabRe.test(item.text));
    const otherTabs = allItems.filter((item) => !odlTabRe.test(item.text)).slice(0, 30);
    return [...odlTabs, ...otherTabs].slice(0, 60);
  }).catch(() => []);
}

// Legge il testo breve visibile nel DOM corrente (valori input/textarea + label/celle).
async function readVisibleShortText(page) {
  return safeEvaluate(page, () => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 2 && rect.height > 2 && style.visibility !== "hidden" && style.display !== "none";
    };
    const values = [];
    for (const el of document.querySelectorAll("textarea,input[type='text'],input[type='number'],[contenteditable='true'],td,th,label,span,div")) {
      if (!isVisible(el)) continue;
      const text = (el.value || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 300) continue;
      values.push(text);
    }
    return values.join(" | ").slice(0, 30000);
  }).catch(() => "");
}

// Verifica robusta: i dati ODL sono distribuiti su più sub-tab (Descrizione danni,
// Tempi, Materiali di consumo, Smaltimento rifiuti, Ricambi/Articoli, Note interne).
// Un singolo snapshot del DOM vede solo la tab attiva → falsi negativi nel verify
// ("da ricontrollare" anche su campi scritti). Qui clicchiamo ogni sub-tab e
// accumuliamo il testo visibile, così ogni needle può essere confrontato col tab giusto.
async function collectOdlTabsText(page) {
  const parts = [];
  parts.push(await readVisibleShortText(page));
  const tabs = [
    "Descrizione danni",
    "Tempi",
    "Materiali di consumo",
    "Smaltimento rifiuti",
    "Ricambi",
    "Articoli",
    "Note interne",
    "Totali",
  ];
  for (const tab of tabs) {
    try {
      const clicked = await clickBottomSectionTab(page, tab).catch(() => false);
      if (!clicked) continue;
      await page.waitForTimeout(180).catch(() => {});
      parts.push(await readVisibleShortText(page));
    } catch (_e) { /* tab assente: ignora */ }
  }
  return parts.filter(Boolean).join(" | ").slice(0, 60000);
}

async function clickRepartoSection(page, reparto) {
  const needle = normalizeLoose(reparto);
  if (!needle) return false;
  return safeEvaluate(page, (target) => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")]
      .filter(isVisible)
      .filter((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return t && (t === target || t.includes(target));
      });
    const best = candidates.sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)[0];
    if (!best) return false;
    best.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, needle).catch(() => false);
}

async function waitForPracticeWorkspaceReady(page, timeout = 1800) {
  return page.waitForFunction(() => {
    const loadingRe = /caricamento .* in corso|recupero dettagli pratica in corso/;
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8
        && style.display !== "none" && style.visibility !== "hidden"
        && rect.left > -200 && rect.top > -200;
    };
    const bodyText = (document.body?.innerText || "").toLowerCase();
    const popup = document.querySelector(".gwt-DecoratedPopupPanel");
    const popupVisible = Boolean(popup && isVisible(popup));
    if (popupVisible && /dettagli appuntamento/.test(popup.textContent || "")) return false;
    if (/giornaliere|filtro appuntamenti|numero appuntamenti/.test(bodyText)) return false;
    const loadingVisible = [...document.querySelectorAll("div, span, td, label")]
      .filter(isVisible)
      .some((el) => loadingRe.test((el.textContent || "").toLowerCase()));
    if (loadingVisible) return false;
    const editables = [...document.querySelectorAll("textarea, input[type='text'], input[type='number'], input:not([type]), [contenteditable='true'], [role='textbox']")]
      .filter(isVisible)
      .filter((el) => !el.disabled && !el.readOnly);
    const usefulTabs = [...document.querySelectorAll("button, a, span, div, td")]
      .filter(isVisible)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean)
      .filter((text) => /dettagli pratica|ordini di lavoro|preventivi|note interne|materiali di consumo|smaltimento rifiuti/.test(text));
    return (editables.length >= 3 || usefulTabs.length >= 2) && /pratica veicolo|ordini di lavoro|preventivi|ragione sociale/.test(bodyText);
  }, null, { timeout }).then(() => true).catch(() => false);
}

async function waitForPracticeTransition(page, timeout = 6000) {
  const started = Date.now();
  while ((Date.now() - started) < timeout) {
    const state = await getPracticeWorkspaceState(page);
    if (state !== "agenda_shell") return state;
    const popupOpen = await waitForAppointmentPopup(page, 200);
    if (!popupOpen) {
      await page.waitForTimeout(200).catch(() => {});
    }
    await page.waitForTimeout(200).catch(() => {});
  }
  return await getPracticeWorkspaceState(page);
}

async function clickExactAgendaEvent(page, { plate, time }) {
  const targetPlate = String(plate || "").trim().toUpperCase();
  const targetTime = String(time || "").trim().slice(0, 5).replace(".", ":");
  if (!targetPlate || !targetTime) return { success: false, reason: "missing_identity" };

  return safeEvaluate(page, ({ expectedPlate, expectedTime }) => {
    const toMinutes = (value) => {
      const match = String(value || "").match(/(\d{1,2})[.:](\d{2})/);
      if (!match) return null;
      return (Number(match[1]) * 60) + Number(match[2]);
    };
    const expectedMinutes = toMinutes(expectedTime);
    const events = [...document.querySelectorAll(".fc-time-grid-event, .fc-event")].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    });
    const match = events.find((el) => {
      const title = String((el.querySelector(".fc-title") || el).textContent || "").toUpperCase();
      const shownMinutes = toMinutes(el.querySelector(".fc-time")?.textContent || "");
      return title.includes(expectedPlate)
        && expectedMinutes != null
        && shownMinutes === expectedMinutes;
    });
    if (!match) return { success: false, reason: "exact_event_not_found" };

    const rect = match.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    for (const type of ["click", "dblclick"]) {
      match.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: center.x,
        clientY: center.y,
      }));
    }
    return { success: true, time: expectedTime };
  }, { expectedPlate: targetPlate, expectedTime: targetTime }).catch(() => ({
    success: false,
    reason: "exact_event_click_failed",
  }));
}

async function openPracticeFromAppointment(page, job) {
  // Quando YAP auto-chiude il popup (alreadyClosed=true) naviga direttamente alla pagina
  // pratica: in quel caso siamo già a destinazione, non serve riaprire nulla.
  try {
    const currentUrl = page.url();
    if (/pratica/i.test(currentUrl) && /IdCompanyFolder/i.test(currentUrl)) {
      return { clicked: true, label: null, strategy: "already_on_practice_page", attempts: [] };
    }
  } catch (_) {}

  const searchTerms = [job.customer?.plate, pickCosaFromJob(job)].filter(Boolean);
  // "text" (click sul link "Gestione pratica") PRIMA: e' piu' affidabile del click a
  // coordinate sul footer. Il footer resta come fallback.
  const strategies = [
    { type: "text" },
    { type: "footer", slotIndex: 2 },
    { type: "footer", slotIndex: 2, retry: true },
    { type: "text" },
  ];
  const attempts = [];

  // Riapertura popup robusta: dopo un salvataggio (path creazione) il popup si chiude;
  // l'evento appena creato puo' metterci un attimo a comparire in agenda -> ritenta.
  // Pass 1: locator per .fc-time (funziona anche quando .fc-title mostra icone "V")
  // Pass 2: clickAgendaEvent (text-based, fallback legacy)
  const ensurePopup = async () => {
    if (await waitForAppointmentPopup(page, 600)) return true;
    // Prova prima con locator .fc-time se abbiamo l'orario.
    // YAP può mostrare "10:00" o "10.00" a seconda del locale → prova entrambi.
    if (job.appointment?.time) {
      const timeRaw = String(job.appointment.time).trim().slice(0, 5); // "10:00"
      const timeAlt = timeRaw.includes(":") ? timeRaw.replace(":", ".") : timeRaw.replace(".", ":");
      for (const t of [timeRaw, timeAlt]) {
        try {
          const evLoc = page
            .locator(".fc-time-grid-event:visible, .fc-event:visible")
            .filter({ has: page.locator(".fc-time").filter({ hasText: t }) })
            .first();
          if (await evLoc.count()) {
            await evLoc.dblclick({ timeout: 2000 });
            await page.waitForTimeout(800);
            if (await waitForAppointmentPopup(page, 1500)) return true;
          }
        } catch (_) {}
      }
    }
    for (let i = 0; i < 3; i += 1) {
      const reopened = await clickAgendaEvent(page, searchTerms).catch(() => ({ success: false }));
      if (reopened?.success && await waitForAppointmentPopup(page, 1500)) return true;
      await page.waitForTimeout(700).catch(() => {});
    }

    // Dopo la verifica automatica del veicolo FullCalendar puo' essere stato
    // ridisegnato: i locator precedenti diventano stale e l'evento ricompare con
    // qualche secondo di ritardo. Ricarica una sola volta la data e cerca l'evento
    // esatto per targa + orario prima di dichiarare la pratica irraggiungibile.
    await openAgenda(page, job.appointment?.date).catch(() => {});
    const plate = String(job.customer?.plate || "").trim().toUpperCase();
    const expectedTime = String(job.appointment?.time || "").trim().slice(0, 5).replace(".", ":");
    const exactEvent = page.locator(".fc-time-grid-event:visible, .fc-event:visible").filter({
      hasText: plate,
    }).filter({
      has: page.locator(".fc-time"),
    });
    const count = await exactEvent.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const event = exactEvent.nth(i);
      const shownTime = String(await event.locator(".fc-time").first().textContent().catch(() => ""))
        .trim().slice(0, 5).replace(".", ":");
      if (expectedTime && shownTime !== expectedTime) continue;
      await event.dblclick({ timeout: 3000 }).catch(() => {});
      if (await waitForAppointmentPopup(page, 2000)) return true;
    }
    return false;
  };

  for (const strategy of strategies) {
    const popupReady = await ensurePopup();
    if (!popupReady) break;
    let clickResult = { clicked: false, label: null };
    if (strategy.type === "text") {
      clickResult = await clickAppointmentPopupPractice(page);
    } else {
      clickResult = await clickAppointmentPopupFooterSlot(page, strategy.slotIndex);
    }
    if (!clickResult?.clicked) {
      attempts.push({
        strategy: strategy.type === "footer" ? `footer:${strategy.slotIndex + 1}` : "text",
        clicked: false,
      });
      continue;
    }
    const state = await waitForPracticeTransition(page, 6500);
    if (state !== "agenda_shell") {
      const loadingDone = await waitForPracticeLoadingToFinish(page, Number(process.env.YAP_PRACTICE_LOADING_MS) || 8000);
      const url = page.url();
      const isDirectPracticeRoute = /#!pratica/i.test(url) && /IdCompanyFolder/i.test(url);
      const blankShell = isDirectPracticeRoute ? false : await isBlankNewPracticeShell(page);
      const courtesyPopup = isDirectPracticeRoute ? false : await isCourtesyCommunicationPopup(page);
      const attemptMeta = {
        strategy: strategy.type === "footer" ? `footer:${strategy.slotIndex + 1}` : "text",
        clicked: true,
        state,
        loadingDone,
        blankShell,
        courtesyPopup,
        url,
      };
      attempts.push(attemptMeta);
      if (courtesyPopup) {
        await page.keyboard.press("Escape").catch(() => {});
        await openAgenda(page, job.appointment.date).catch(() => {});
        continue;
      }
      if (blankShell) {
        await openAgenda(page, job.appointment.date).catch(() => {});
        continue;
      }
      return {
        clicked: true,
        label: clickResult.label,
        strategy: strategy.type === "footer" ? `footer:${strategy.slotIndex + 1}` : "text",
        state,
        loadingDone,
        url: page.url(),
        attempts,
      };
    }
    attempts.push({
      strategy: strategy.type === "footer" ? `footer:${strategy.slotIndex + 1}` : "text",
      clicked: true,
      state,
      url: page.url(),
    });
  }

  return { clicked: false, label: null, strategy: null, state: await getPracticeWorkspaceState(page), url: page.url(), attempts };
}

async function hasVehicleSearchOverlay(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 30 && rect.height > 30 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll("div, td, span, label")]
      .filter(isVisible)
      .some((el) => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return text.includes("ricerca autoveicolo") || text.includes("crea un nuovo veicolo dalla targa");
      });
  }).catch(() => false);
}

async function dismissVehicleSearchOverlay(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const visible = await hasVehicleSearchOverlay(page);
    if (!visible) return true;
    await page.keyboard.press("Escape").catch(() => {});
    const viewport = page.viewportSize() || { width: 1440, height: 950 };
    await page.mouse.click(Math.max(40, viewport.width - 80), 120).catch(() => {});
    await page.waitForTimeout(180).catch(() => {});
  }
  return !(await hasVehicleSearchOverlay(page));
}

async function waitForPracticeLoadingToFinish(page, timeout = 12000) {
  return page.waitForFunction(() => {
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const loadingRe = /caricamento .* in corso|recupero dettagli pratica in corso/;
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 20
        && style.display !== "none" && style.visibility !== "hidden"
        && rect.left > -200 && rect.top > -200;
    };
    const loadingVisible = [...document.querySelectorAll("div, span, td, label")]
      .filter(isVisible)
      .some((el) => loadingRe.test(normalizeText(el.textContent || "")));
    if (loadingVisible) return false;
    const bodyText = normalizeText(document.body?.innerText || "");
    const editables = [...document.querySelectorAll("textarea, input[type='text'], input[type='number'], input:not([type]), [contenteditable='true'], [role='textbox']")]
      .filter(isVisible)
      .filter((el) => !el.disabled && !el.readOnly);
    const usefulTabs = [...document.querySelectorAll("button, a, span, div, td")]
      .filter(isVisible)
      .map((el) => normalizeText(el.textContent || ""))
      .filter((text) => /dettagli pratica|ordini di lavoro|preventivi|note interne|materiali di consumo|smaltimento rifiuti/.test(text));
    return bodyText.includes("pratica veicolo") && (editables.length >= 3 || usefulTabs.length >= 2);
  }, null, { timeout }).then(() => true).catch(() => false);
}

async function isBlankNewPracticeShell(page) {
  return safeEvaluate(page, () => {
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 12 && rect.height > 12 && style.display !== "none" && style.visibility !== "hidden";
    };
    const visibleText = [...document.querySelectorAll("div, span, td, label, button, a")]
      .filter(isVisible)
      .map((el) => normalizeText(el.textContent || ""))
      .filter(Boolean)
      .join(" | ");
    return visibleText.includes("nuovo")
      && visibleText.includes("crea una nuova anagrafica")
      && visibleText.includes("ragione sociale")
      && visibleText.includes("partita iva");
  }).catch(() => false);
}

async function isCourtesyCommunicationPopup(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel")]
      .filter(isVisible)
      .some((el) => /comunicazioni di cortesia/i.test(el.textContent || ""));
  }).catch(() => false);
}

async function confirmUnsavedChangesIfPresent(page) {
  const target = await safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const dialogs = [...document.querySelectorAll(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel")]
      .filter(isVisible)
      .filter((el) => /modifiche non salvate|andranno perse|confermi/i.test(norm(el.textContent || "")));
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return null;
    const buttons = [...dialog.querySelectorAll("button, .gwt-Button, a, [role='button'], td, div, span")]
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = norm(el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "");
        let score = 0;
        if (/^ok$/i.test(text)) score += 30;
        if (/conferma|si|sì/i.test(text)) score += 20;
        if (/annulla|cancel/i.test(text)) score -= 50;
        if (rect.width >= 40 && rect.width <= 180 && rect.height >= 18 && rect.height <= 50) score += 6;
        return { el, text, rect, score };
      })
      .filter((it) => it.score > 0)
      .sort((a, b) => b.score - a.score || a.rect.x - b.rect.x);
    const selected = buttons[0];
    if (!selected) return null;
    const x = selected.rect.x + selected.rect.width / 2;
    const y = selected.rect.y + selected.rect.height / 2;
    for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
      selected.el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0,
      }));
    }
    if (typeof selected.el.click === "function") selected.el.click();
    return { clicked: true, label: selected.text, x, y };
  }).catch(() => null);
  if (!target?.clicked) return false;
  await page.mouse.click(target.x, target.y, { button: "left", clickCount: 1 }).catch(() => {});
  await page.waitForTimeout(700).catch(() => {});
  logPhase("modal", "confirmed_unsaved_changes", { label: target.label });
  return true;
}

// F3: naviga alla pagina lavorazioni cambiando hash in-place (niente page.goto → GWT non fa full-reload)
async function openOdlByRoute(page, currentUrl, pageEnum = "ODL") {
  try {
    const parsed = parsePraticaHashPayload(currentUrl || page.url());
    if (!parsed.ok) {
      return {
        attempted: false,
        navigated: false,
        reason: parsed.reason,
        preview: parsed.preview,
        idCompanyFolder: parsed.idCompanyFolder,
        pageEnum: parsed.pageEnum,
      };
    }

    const nextPayload = {
      ...(parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {}),
      IdCompanyFolder: parsed.idCompanyFolder,
      Page: pageEnum,
      PageEnum: pageEnum,
      // Vogliamo SEMPRE la griglia documento (Righe), mai la vista marcatempo: false
      // sia per Preventivo che per ODL (scriviamo noi le righe nella stessa tabella).
      ShowOdlMarcatempo: false,
    };
    const token = JSON.stringify(nextPayload);
    await page.evaluate((t) => {
      window.location.hash = `#!pratica|${t}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    }, token);
    await page.waitForTimeout(220).catch(() => {});
    return {
      attempted: true,
      navigated: true,
      reason: null,
      idCompanyFolder: parsed.idCompanyFolder,
      pageEnum,
      payloadKeys: Object.keys(nextPayload || {}),
    };
  } catch (error) {
    return { attempted: true, navigated: false, reason: String(error?.message || "error") };
  }
}

async function openOdlByFullReload(page, currentUrl, pageEnum = "ODL") {
  try {
    const parsed = parsePraticaHashPayload(currentUrl || page.url());
    if (!parsed.ok) {
      return {
        attempted: false,
        navigated: false,
        reason: parsed.reason,
        preview: parsed.preview,
        idCompanyFolder: parsed.idCompanyFolder,
        pageEnum: parsed.pageEnum,
      };
    }

    const nextPayload = {
      ...(parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {}),
      IdCompanyFolder: parsed.idCompanyFolder,
      Page: pageEnum,
      PageEnum: pageEnum,
      // Vogliamo SEMPRE la griglia documento (Righe), mai la vista marcatempo: false
      // sia per Preventivo che per ODL (scriviamo noi le righe nella stessa tabella).
      ShowOdlMarcatempo: false,
    };
    const baseUrl = new URL(currentUrl || page.url());
    baseUrl.hash = `!pratica|${JSON.stringify(nextPayload)}`;
    await page.goto(baseUrl.href, { waitUntil: "domcontentloaded", timeout: 22000 });
    await page.waitForTimeout(800).catch(() => {});
    return {
      attempted: true,
      navigated: true,
      reason: null,
      idCompanyFolder: parsed.idCompanyFolder,
      pageEnum,
      url: page.url().slice(0, 160),
      payloadKeys: Object.keys(nextPayload || {}),
    };
  } catch (error) {
    return { attempted: true, navigated: false, reason: String(error?.message || "error") };
  }
}

// F2: usa il campo Cosa del popup appuntamento per agganciare la targa.
async function readAppointmentVehicleText(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.display !== "none" && s.visibility !== "hidden";
    };
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel")]
      .find((p) => isVisible(p) && /dettagli appuntamento/i.test(p.textContent || ""));
    if (!popup) return null;
    const rawText = (popup.textContent || "").replace(/\s+/g, " ").trim();
    const vehicleMatch = rawText.match(/veicolo\s*(.*?)(?:\s+cosa\b|\s+quando\b|\s+tag\b|$)/i);
    const text = (vehicleMatch?.[1] || "").replace(/\s+/g, " ").trim() || rawText;
    return {
      text: text.slice(0, 160),
      linked: !/nessun veicolo selezionato/i.test(text)
        && !/nessun veicolo/i.test(text)
        && /[A-Z0-9]{6,}/i.test(text),
    };
  }).catch(() => null);
}

async function locateAppointmentVehicleControls(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.display !== "none" && s.visibility !== "hidden";
    };
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel")]
      .find((p) => isVisible(p) && /dettagli appuntamento/i.test(p.textContent || ""));
    if (!popup) return null;

    const labelFor = (input) => {
      let node = input;
      for (let i = 0; i < 6 && node && node !== popup; i += 1) {
        node = node.parentElement;
        if (!node) break;
        const own = [...node.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (own && own.length <= 40) return own;
      }
      return "";
    };

    const vehicleBlock = [...popup.querySelectorAll("div, td")]
      .filter(isVisible)
      .find((el) => /veicolo|nessun veicolo selezionato/.test((el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase()));
    if (!vehicleBlock) return null;

    const clickable = [...vehicleBlock.querySelectorAll("a, button, [role='button'], [tabindex], .gwt-HTML, .gwt-InlineLabel, span, div")]
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.textContent || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        return {
          text,
          x: rect.x + (rect.width / 2),
          y: rect.y + (rect.height / 2),
          width: rect.width,
          height: rect.height,
          tabIndex: el.getAttribute("tabindex"),
          role: el.getAttribute("role") || "",
          tag: el.tagName,
        };
      })
      .filter((item) => item.width >= 8 && item.height >= 8)
      .map((item) => {
        let score = 0;
        if (item.tabIndex != null) score += 10;
        if (/^A$|^BUTTON$/i.test(item.tag)) score += 8;
        if (item.role) score += 6;
        if (item.width <= 40 && item.height <= 40) score += 5;
        if (!/veicolo|nessun veicolo selezionato/i.test(item.text)) score += 3;
        return { ...item, score };
      })
      .sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x)
      .slice(0, 6);

    const r = vehicleBlock.getBoundingClientRect();
    return {
      x: r.x + (r.width / 2),
      y: r.y + (r.height / 2),
      strategy: `block:${((vehicleBlock.textContent || "").replace(/\s+/g, " ").trim().toLowerCase()).slice(0, 40)}`,
      kind: "row",
      text: ((vehicleBlock.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 80),
      candidates: clickable,
    };
  }).catch(() => null);
}

async function chooseVehicleFromSearchOverlay(page, plate) {
  const cleanPlate = String(plate || "").trim().toUpperCase();
  const rowHit = await safeEvaluate(page, (wantedPlate) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.display !== "none" && s.visibility !== "hidden";
    };
    const norm = (v) => String(v || "").replace(/\s+/g, " ").trim().toUpperCase();
    const wanted = norm(wantedPlate);
    const popups = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel, .popup, [role='dialog']")]
      .filter(isVisible);
    for (const popup of popups) {
      const rows = [...popup.querySelectorAll("tr")]
        .filter(isVisible)
        .map((el) => {
          const text = (el.textContent || "").replace(/\s+/g, " ").trim();
          const r = el.getBoundingClientRect();
          const focusTarget = el.querySelector("[__gwt_cell], [tabindex]");
          const fr = focusTarget ? focusTarget.getBoundingClientRect() : r;
          return {
            el,
            text,
            x: fr.x + (fr.width / 2),
            y: fr.y + (fr.height / 2),
            width: fr.width,
            height: fr.height,
            usesFocusTarget: Boolean(focusTarget),
          };
        })
        .filter((item) => item.text && item.text.length <= 240);
      const exact = rows.find((item) => norm(item.text).includes(wanted));
      if (exact) return exact;
    }
    return null;
  }, cleanPlate).catch(() => null);

  if (rowHit) {
    await page.mouse.move(rowHit.x, rowHit.y).catch(() => {});
    await page.waitForTimeout(120).catch(() => {});
    await page.mouse.click(rowHit.x, rowHit.y, { button: "left", clickCount: 1 }).catch(() => {});
    await page.waitForTimeout(3000).catch(() => {});
    const popupVehicle = await readAppointmentVehicleText(page);
    const popupStillOpen = await safeEvaluate(page, () => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== "none" && s.visibility !== "hidden";
      };
      return [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel")]
        .filter(isVisible)
        .some((p) => /nessun veicolo selezionato/i.test((p.textContent || "").replace(/\s+/g, " ")));
    }).catch(() => false);
    return {
      found: true,
      selected: true,
      confirmed: !popupStillOpen || Boolean(popupVehicle?.linked),
      clickMode: "native_mouse",
      popupStillOpen,
      vehicleText: popupVehicle?.text || rowHit.text || null,
    };
  }

  return { found: false, reason: "vehicle_row_not_found" };
}

async function selectVehicleByPlate(page, plate, { skipInputFallback = false } = {}) {
  if (!plate) return { found: false, reason: "no_plate" };
  const cleanPlate = String(plate).trim().toUpperCase();

  const vehicleControls = await locateAppointmentVehicleControls(page).catch(() => null);
  if (vehicleControls) {
    const triggerPoints = [
      ...(vehicleControls.candidates || []).map((c) => ({ x: c.x, y: c.y, strategy: `candidate:${c.tag}:${c.text || "icon"}` })),
      { x: vehicleControls.x, y: vehicleControls.y, strategy: vehicleControls.strategy || "vehicle_block" },
    ];
    let openedBy = null;
    for (const point of triggerPoints) {
      await page.mouse.move(point.x, point.y).catch(() => {});
      await page.waitForTimeout(80).catch(() => {});
      await page.mouse.click(point.x, point.y).catch(() => {});
      await page.waitForTimeout(180).catch(() => {});
      const opened = await chooseVehicleFromSearchOverlay(page, cleanPlate).catch(() => null);
      if (opened?.found) {
        openedBy = { ...opened, trigger: point.strategy };
        return {
          found: true,
          strategy: point.strategy,
          selected: Boolean(opened.selected),
          confirmed: Boolean(opened.confirmed),
          vehicleText: opened.vehicleText || null,
          attempts: [{ attempt: 1, selected: Boolean(opened.selected), confirmed: Boolean(opened.confirmed), vehicleText: opened.vehicleText || null }],
          reason: opened.confirmed ? null : "vehicle_not_confirmed",
        };
      }
    }
    if (skipInputFallback) {
      return {
        found: true,
        strategy: vehicleControls?.strategy || "vehicle_trigger_attempted",
        selected: false,
        confirmed: false,
        vehicleText: null,
        attempts: [],
        reason: "vehicle_row_not_found",
      };
    }
  }

  const overlayAttempt = await chooseVehicleFromSearchOverlay(page, cleanPlate).catch(() => null);
  if (overlayAttempt?.confirmed) {
    return {
      found: true,
      strategy: `overlay:${overlayAttempt.selected ? "selected" : "confirmed"}`,
      selected: true,
      confirmed: true,
      vehicleText: overlayAttempt.vehicleText || null,
      attempts: [{ attempt: 1, selected: true, confirmed: true, vehicleText: overlayAttempt.vehicleText || null }],
    };
  }

  if (skipInputFallback) {
    return {
      found: Boolean(vehicleControls || overlayAttempt?.found),
      strategy: vehicleControls?.strategy || overlayAttempt?.reason || "vehicle_overlay_attempted",
      selected: Boolean(overlayAttempt?.selected),
      confirmed: false,
      vehicleText: overlayAttempt?.vehicleText || null,
      attempts: overlayAttempt ? [{ attempt: 1, selected: Boolean(overlayAttempt.selected), confirmed: false, vehicleText: overlayAttempt.vehicleText || null }] : [],
      reason: overlayAttempt?.reason || "vehicle_not_confirmed",
    };
  }

  // Step 1: individua il campo Cosa nel popup tramite il contesto del DOM.
  // Nel popup compatto il veicolo non ha un input dedicato: si usa il campo Cosa.
  const vehicleInputCoords = await safeEvaluate(page, () => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.display !== "none" && s.visibility !== "hidden";
    };
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel")]
      .find((p) => isVisible(p) && (p.textContent || "").toLowerCase().includes("dettagli appuntamento"));
    if (!popup) return null;

    const labelFor = (input) => {
      let node = input;
      for (let i = 0; i < 6 && node && node !== popup; i += 1) {
        node = node.parentElement;
        if (!node) break;
        const own = [...node.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (own && own.length <= 40) return own;
      }
      return "";
    };
    const inputs = [...popup.querySelectorAll("input[type='text'], input:not([type])")].filter(isVisible).map((input) => {
      const r = input.getBoundingClientRect();
      const s = window.getComputedStyle(input);
      return {
        input,
        label: labelFor(input),
        x: r.x + (r.width / 2),
        y: r.y + (r.height / 2),
        width: r.width,
        textTransform: (s.textTransform || "").toLowerCase(),
        maxlength: input.getAttribute("maxlength") || "",
        readOnly: Boolean(input.readOnly),
      };
    });
    const target = inputs.find((el) => /veicolo/.test(el.label))
      || inputs.find((el) => /cosa/.test(el.label))
      || inputs.find((el) => el.textTransform === "uppercase" && el.width > 80 && !el.readOnly && el.maxlength !== "25")
      || inputs.find((el) => el.width > 80 && !el.readOnly);
    if (!target) return null;
    return { x: target.x, y: target.y, strategy: target.label ? `label:${target.label}` : "uppercase_input" };
  }).catch(() => null);

  if (!vehicleInputCoords) return { found: false, reason: "cosa_input_not_found" };

  const attempts = [];
  let confirmed = false;
  let selected = false;
  let vehicleText = null;

  for (let attempt = 1; attempt <= 3 && !confirmed; attempt += 1) {
    // Step 2: click + type (usa keyboard per triggerare autocomplete GWT)
    await page.mouse.click(vehicleInputCoords.x, vehicleInputCoords.y).catch(() => {});
    await page.waitForTimeout(150);
    await page.keyboard.press("Control+a").catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
    await page.keyboard.type(cleanPlate, { delay: 55 }).catch(() => {});
    await page.waitForTimeout(650);

    // Step 3: clicca il suggerimento del dropdown autocomplete.
    selected = await safeEvaluate(page, (targetPlate) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== "none" && s.visibility !== "hidden";
      };
      const candidates = [...document.querySelectorAll(
        ".gwt-SuggestBoxPopup li, .gwt-SuggestBoxPopup td, .gwt-SuggestBoxPopup .item, " +
        "[class*='suggest'] li, [class*='suggest'] td, [class*='autocomplete'] li, " +
        ".gwt-MenuBar li, .gwt-MenuBar td"
      )].filter(isVisible);
      const match = candidates.find((el) => (el.textContent || "").toUpperCase().includes(targetPlate));
      const target = match || candidates[0];
      if (!target) return false;
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    }, cleanPlate).catch(() => false);

    if (!selected) {
      await page.keyboard.press("ArrowDown").catch(() => {});
      await page.waitForTimeout(120);
      await page.keyboard.press("Enter").catch(() => {});
    }
    await page.waitForTimeout(450);

    const popupVehicle = await readAppointmentVehicleText(page);
    vehicleText = popupVehicle?.text || vehicleText;
    confirmed = Boolean(popupVehicle?.linked)
      || Boolean(popupVehicle?.text && !/nessun veicolo selezionato/i.test(popupVehicle.text) && popupVehicle.text.toUpperCase().includes(cleanPlate));
    attempts.push({
      attempt,
      selected,
      confirmed,
      vehicleText: vehicleText ? vehicleText.slice(0, 80) : null,
    });
    if (!confirmed) {
      await page.waitForTimeout(200);
    }
  }

  return {
    found: true,
    strategy: vehicleInputCoords.strategy,
    toggle: vehicleControls?.strategy || null,
    selected,
    confirmed,
    vehicleText,
    attempts,
  };
}

// F5: guard "no veicolo" — rileva pratica guscio senza veicolo reale
async function isPracticeShellWithoutVehicle(page) {
  return safeEvaluate(page, () => {
    const rawText = document.body?.innerText || "";
    // Tab "Dettagli pratica ⚠" → warning = nessun veicolo
    const hasWarningTab = /dettagli pratica\s*⚠/i.test(rawText);
    // "Ordini di lavoro U" → il badge U indica che esiste un ODL con contenuto
    const hasOdlBadge = /ordini di lavoro\s*U\b/.test(rawText);
    // Targa placeholder come ZZ998ZZ o Telaio vuoto (campi anagrafici vuoti)
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
    };
    // Se il tab ODL esiste senza badge U + c'è il warning sul tab dettagli → guscio
    if (hasWarningTab && !hasOdlBadge) return true;
    // Ulteriore segnale: Telaio/Omologazione visibili vuoti E nessun ODL badge
    const inputs = [...document.querySelectorAll("input[type='text'], input:not([type])")].filter(isVisible);
    const emptyKeyFields = inputs.filter((el) => {
      const label = (el.getAttribute("placeholder") || "").toLowerCase();
      const ctxText = (el.parentElement?.textContent || "").toLowerCase();
      return (label.includes("telaio") || ctxText.includes("telaio")
              || label.includes("omologazione") || ctxText.includes("omologazione"))
             && !el.value.trim();
    });
    return emptyKeyFields.length >= 2 && !hasOdlBadge;
  }).catch(() => false);
}

async function waitForOdlWorkspaceReady(page, timeout = 1800) {
  return page.waitForFunction(() => {
    const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const loadingRe = /caricamento .* in corso|recupero dettagli pratica in corso/;
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8
        && style.display !== "none" && style.visibility !== "hidden"
        && rect.left > -200 && rect.top > -200; // esclude pannelli GWT off-screen
    };
    const loadingVisible = [...document.querySelectorAll("div, span, td, label")]
      .filter(isVisible)
      .some((el) => loadingRe.test(normalizeText(el.textContent || "")));
    if (loadingVisible) return false;
    const editables = [...document.querySelectorAll("textarea, input[type='text'], input[type='number'], input:not([type]), [contenteditable='true'], [role='textbox']")]
      .filter(isVisible)
      .filter((el) => !el.disabled && !el.readOnly);
    const usefulTabs = [...document.querySelectorAll("button, a, span, div, td")]
      .filter(isVisible)
      .map((el) => normalizeText(el.textContent || ""))
      .filter((text) => /descrizione danni|materiali di consumo|smaltimento rifiuti|note interne|tempi|totali|ordini cliente|prospetti/.test(text));
    return usefulTabs.length >= 2 || editables.length >= 3;
  }, null, { timeout }).then(() => true).catch(() => false);
}

async function getPracticeWorkspaceState(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3
        && style.display !== "none" && style.visibility !== "hidden"
        && rect.left > -200 && rect.top > -200;
    };
    const bodyText = (document.body?.innerText || "").toLowerCase();

    if (/giornaliere|filtro appuntamenti|numero appuntamenti/.test(bodyText)
        && !/pratica veicolo|gestione pratica/i.test(bodyText)) return "agenda_shell";

    const odlMarkerRe = /descrizione danni|smaltimento rifiuti|materiali di consumo|note interne|tempi|totali|ordini cliente|prospetti/;
    const odlMarkersVisible = [...document.querySelectorAll("button, a, span, div, td")]
      .filter(isVisible)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase())
      .filter((t) => odlMarkerRe.test(t));
    if (odlMarkersVisible.length >= 2) return "odl_full";

    const loadingRe = /caricamento .* in corso|recupero dettagli pratica in corso/;
    const loadingVisible = [...document.querySelectorAll("div, span, td, label")]
      .filter(isVisible)
      .some((el) => loadingRe.test((el.textContent || "").toLowerCase()));
    if (loadingVisible) return "loading_shell";

    if (!/pratica veicolo|gestione pratica/i.test(bodyText)) return "unknown";

    const topTabs = [...document.querySelectorAll("td, span, a, div, button")]
      .filter(isVisible)
      .filter((el) => el.getBoundingClientRect().y < 140)
      .map((el) => ({
        text: (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase(),
        cls: String(el.className || ""),
        ariaSel: el.getAttribute("aria-selected"),
        tag: el.tagName,
      }));

    const activeTab = topTabs.find((t) =>
      /\bselected\b|\bactive\b|gwt-selected/i.test(t.cls) || t.ariaSel === "true"
    );

    if (activeTab) {
      if (/ordini di lavoro/.test(activeTab.text)) {
        const odlMarkers = /descrizione danni|smaltimento rifiuti|materiali di consumo|note interne|tempi|totali|ordini cliente|prospetti/;
        const visibleTabTexts = [...document.querySelectorAll("button, a, span, div, td")]
          .filter(isVisible)
          .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase())
          .filter((t) => odlMarkers.test(t));
        return visibleTabTexts.length >= 2 ? "odl_full" : "odl_loading";
      }
      if (/dettagli pratica/.test(activeTab.text)) return "detail_form";
      if (/preventivi/.test(activeTab.text)) return "preventivi";
    }

    const odlMarkersInBody = /descrizione danni|smaltimento rifiuti|materiali di consumo|note interne|tempi|totali/.test(bodyText);
    if (odlMarkersInBody) return "odl_full";

    const dettagliPraticaVisible = topTabs.some((t) => /dettagli pratica/.test(t.text));
    const odlTabVisible = topTabs.some((t) => /ordini di lavoro/.test(t.text));
    if (dettagliPraticaVisible && !odlMarkersInBody) return "detail_form";
    if (!odlTabVisible) return "practice_shell";

    return "practice_shell";
  }).catch(() => "unknown");
}

async function fillBestEditableByKeywords(page, keywords, value, { append = false, returnDebug = false } = {}) {
  const textValue = String(value || "").trim();
  if (!textValue) return returnDebug ? { ok: false, debug: { reason: "empty_value" } } : false;
  return safeEvaluate(page, ({ keywordsRaw, text, appendMode, wantDebugInner }) => {
    const keywords = (keywordsRaw || []).map((k) => String(k || "").toLowerCase().trim()).filter(Boolean);
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
    };
    const editableNodes = [...document.querySelectorAll("textarea, input[type='text'], input[type='number'], input:not([type]), [contenteditable='true']")]
      .filter(isVisible)
      .filter((el) => !el.disabled && !el.readOnly);

    const normalize = (val) => String(val || "").toLowerCase().replace(/\s+/g, " ").trim();
    const scoreNode = (node) => {
      const attrText = normalize(
        [
          node.getAttribute("name"),
          node.getAttribute("id"),
          node.getAttribute("placeholder"),
          node.getAttribute("aria-label"),
          node.className,
        ].join(" "),
      );
      let container = node;
      for (let i = 0; i < 4 && container?.parentElement; i += 1) {
        container = container.parentElement;
      }
      const ctxText = normalize((container?.textContent || "").slice(0, 800));
      let score = 0;
      for (const keyword of keywords) {
        if (!keyword) continue;
        if (attrText.includes(keyword)) score += 4;
        if (ctxText.includes(keyword)) score += 2;
      }
      if (node.tagName === "TEXTAREA") score += 0.4;
      return score;
    };

    const ranked = editableNodes
      .map((node) => ({ node, score: scoreNode(node), y: node.getBoundingClientRect().y, x: node.getBoundingClientRect().x }))
      .filter((item) => item.score > 0)
      .sort((a, b) => (b.score - a.score) || (a.y - b.y) || (a.x - b.x));

    const target = ranked[0]?.node;
    if (!target) {
      return wantDebugInner
        ? {
            ok: false,
            debug: {
              candidateCount: editableNodes.length,
              keywordCount: keywords.length,
              keywords,
              appendMode,
              ranked: ranked.slice(0, 8).map(({ node, score, x, y }) => ({
                tag: node.tagName,
                type: node.getAttribute("type") || null,
                name: node.getAttribute("name") || null,
                id: node.getAttribute("id") || null,
                placeholder: node.getAttribute("placeholder") || null,
                ariaLabel: node.getAttribute("aria-label") || null,
                role: node.getAttribute("role") || null,
                score,
                x: Math.round(x),
                y: Math.round(y),
              })),
              selected: null,
              reason: "no_keyword_match",
            },
          }
        : false;
    }

    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    const current = isInput ? (target.value || "") : (target.innerText || target.textContent || "");
    const nextValue = appendMode && current ? `${current}\n${text}` : text;

    target.focus();
    if (isInput) target.value = nextValue;
    else target.textContent = nextValue;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.blur();
    if (!wantDebugInner) return true;
    return {
      ok: true,
      debug: {
        candidateCount: editableNodes.length,
        keywordCount: keywords.length,
        keywords,
        appendMode,
        valueLength: text.length,
        selected: {
          tag: target.tagName,
          type: target.getAttribute("type") || null,
          name: target.getAttribute("name") || null,
          id: target.getAttribute("id") || null,
          placeholder: target.getAttribute("placeholder") || null,
          ariaLabel: target.getAttribute("aria-label") || null,
          role: target.getAttribute("role") || null,
          className: String(target.className || ""),
          textPreview: String(current || "").slice(0, 120),
        },
        ranked: ranked.slice(0, 8).map(({ node, score, x, y }) => ({
          tag: node.tagName,
          type: node.getAttribute("type") || null,
          name: node.getAttribute("name") || null,
          id: node.getAttribute("id") || null,
          placeholder: node.getAttribute("placeholder") || null,
          ariaLabel: node.getAttribute("aria-label") || null,
          role: node.getAttribute("role") || null,
          score,
          x: Math.round(x),
          y: Math.round(y),
        })),
      },
    };
  }, { keywordsRaw: keywords, text: textValue, appendMode: Boolean(append), wantDebugInner: Boolean(returnDebug) }).catch(() => returnDebug ? { ok: false, debug: { error: "evaluate_failed" } } : false);
}

async function fillWithRetry(page, attempts, value, options = {}, { debug = false, fieldId = "", returnDebug = false } = {}) {
  const plans = Array.isArray(attempts) ? attempts : [];
  const attemptsDebug = [];
  for (let i = 0; i < plans.length; i++) {
    const attempt = plans[i];
    const keywords = Array.isArray(attempt) ? attempt : (attempt?.keywords || []);
    const append = typeof attempt === "object" && "append" in attempt ? attempt.append : options.append;
    if (debug) logPhase("fill_attempt", `plan_${i}`, { fieldId, keywords: keywords.slice(0, 3), value: String(value).slice(0, 50) });
    const result = await fillBestEditableByKeywords(page, keywords, value, { ...options, append, returnDebug });
    const ok = Boolean(result?.ok ?? result);
    if (returnDebug) {
      attemptsDebug.push({
        index: i,
        keywords: keywords.slice(0, 6),
        append: Boolean(append),
        ok,
        debug: result?.debug || null,
      });
    }
    if (ok) {
      if (debug) logPhase("fill_success", fieldId, { plan: i, keywords: keywords.slice(0, 3) });
      return returnDebug
        ? { ok: true, debug: { fieldId, attempts: attemptsDebug, selected: result?.debug?.selected || null } }
        : true;
    }
    await page.waitForTimeout(60).catch(() => {});
  }
  if (debug) logPhase("fill_failed", fieldId, { attempts: plans.length });
  return returnDebug
    ? { ok: false, debug: { fieldId, attempts: attemptsDebug } }
    : false;
}

async function appendStructuredBlockToAnyTextarea(page, text, options = {}) {
  const payload = String(text || "").trim();
  if (!payload) return false;
  const wantDebug = Boolean(options.returnDebug);
  return safeEvaluate(page, ({ blockText, keywordsRaw, wantDebugInner }) => {
    const keywords = Array.isArray(keywordsRaw)
      ? keywordsRaw.map((item) => String(item || "").toLowerCase().trim()).filter(Boolean)
      : [];
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
    };
    const selectors = [
      "textarea",
      "[contenteditable='true']",
      "[contenteditable]",
      "[role='textbox']",
    ];
    const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
    const scoreTarget = (el) => {
      const rect = el.getBoundingClientRect();
      const ownText = normalize([
        el.getAttribute("name"),
        el.getAttribute("id"),
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.className,
      ].join(" "));
      let ctxNode = el;
      let ctxText = ownText;
      for (let i = 0; i < 5 && ctxNode?.parentElement; i += 1) {
        ctxNode = ctxNode.parentElement;
        ctxText += ` ${normalize((ctxNode.textContent || "").slice(0, 500))}`;
      }
      let score = Math.min(40, Math.round(rect.height / 8));
      for (const keyword of keywords) {
        if (!keyword) continue;
        if (ownText.includes(keyword)) score += 12;
        if (ctxText.includes(keyword)) score += 6;
      }
      if (el.tagName === "TEXTAREA") score += 8;
      if (el.getAttribute("role") === "textbox") score += 4;
      if (el.getAttribute("contenteditable") === "true") score += 6;
      return score;
    };
    const targets = [...document.querySelectorAll(selectors.join(", "))].filter(el => {
      if (!isVisible(el)) return false;
      const ce = el.getAttribute("contenteditable");
      if (ce === "false") return false;
      return true;
    });
    if (!targets.length) return false;
    const target = targets
      .map((el) => ({ el, score: scoreTarget(el) }))
      .sort((a, b) => b.score - a.score || b.el.getBoundingClientRect().height - a.el.getBoundingClientRect().height)[0]?.el;
    if (!target) return wantDebugInner ? { ok: false, debug: { candidateCount: targets.length, keywords, selected: null } } : false;
    const isInput = target.tagName === "TEXTAREA" || target.tagName === "INPUT";
    const current = isInput ? (target.value || "") : (target.innerText || target.textContent || "");
    const nextValue = current ? `${current}\n${blockText}` : blockText;
    target.focus();
    if (isInput) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (nativeInputValueSetter) nativeInputValueSetter.call(target, nextValue);
      else target.value = nextValue;
    } else {
      if (typeof document.execCommand === "function") {
        try {
          document.execCommand("selectAll", false, null);
          document.execCommand("insertText", false, nextValue);
        } catch {
          target.textContent = nextValue;
        }
      } else {
        target.textContent = nextValue;
      }
      if ((target.innerText || target.textContent || "").trim() !== nextValue.trim()) {
        target.textContent = nextValue;
      }
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    target.blur();
    if (!wantDebugInner) return true;
    return {
      ok: true,
      debug: {
        candidateCount: targets.length,
        keywords,
        selected: {
          tag: target.tagName,
          role: target.getAttribute("role") || null,
          className: String(target.className || ""),
          placeholder: target.getAttribute("placeholder") || null,
          ariaLabel: target.getAttribute("aria-label") || null,
          contenteditable: target.getAttribute("contenteditable") || null,
          textPreview: String(current || "").slice(0, 120),
        },
      },
    };
  }, { blockText: payload, keywordsRaw: options.keywords || [], wantDebugInner: wantDebug }).catch(() => wantDebug ? { ok: false, debug: { error: "evaluate_failed" } } : false);
}

async function writeStructuredBlockToBestEditable(page, text, options = {}) {
  const payload = String(text || "").trim();
  if (!payload) return options.returnDebug ? { ok: false, debug: { reason: "empty_value" } } : false;

  const wantDebug = Boolean(options.returnDebug);
  const keywords = Array.isArray(options.keywords)
    ? options.keywords.map((item) => String(item || "").toLowerCase().trim()).filter(Boolean)
    : [];
  const preferBottomHalf = Boolean(options.preferBottomHalf);
  const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();

  const frameCandidates = [];
  const frames = page.frames().filter((frame) => frame && !frame.isDetached());
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const candidate = await frame.evaluate(({ keywordsRaw, preferBottomHalfInner }) => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
      };
      const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
      const buildXPath = (el) => {
        const segments = [];
        let node = el;
        while (node && node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName.toLowerCase();
          let index = 1;
          let sibling = node.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === node.tagName) index += 1;
            sibling = sibling.previousElementSibling;
          }
          segments.unshift(`${tag}[${index}]`);
          if (tag === "html") break;
          node = node.parentElement;
        }
        return `/${segments.join("/")}`;
      };
      const selectors = [
        "textarea",
        "[contenteditable='true']",
        "[role='textbox']",
      ];
      const collect = [];
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (!isVisible(el)) continue;
          const ce = el.getAttribute("contenteditable");
          if (ce === "false") continue;
          const rect = el.getBoundingClientRect();
          const ownText = normalize([
            el.getAttribute("name"),
            el.getAttribute("id"),
            el.getAttribute("placeholder"),
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.className,
          ].join(" "));
          let ctxNode = el;
          let ctxText = ownText;
          for (let i = 0; i < 5 && ctxNode?.parentElement; i += 1) {
            ctxNode = ctxNode.parentElement;
            ctxText += ` ${normalize((ctxNode.textContent || "").slice(0, 500))}`;
          }
          let score = Math.min(40, Math.round(rect.height / 8));
          for (const rawKeyword of keywordsRaw || []) {
            const keyword = String(rawKeyword || "").toLowerCase().trim();
            if (!keyword) continue;
            if (ownText.includes(keyword)) score += 12;
            if (ctxText.includes(keyword)) score += 6;
          }
          if (el.tagName === "TEXTAREA") score += 8;
          if (el.getAttribute("role") === "textbox") score += 4;
          if (el.getAttribute("contenteditable") === "true") score += 6;
          if (preferBottomHalfInner && rect.y > window.innerHeight * 0.4) score += 5;
          if (rect.height >= 80) score += 3;
          if (rect.height >= 160) score += 4;
          if ((el.value || el.innerText || el.textContent || "").trim()) score += 1;
          collect.push({
            selector,
            xpath: buildXPath(el),
            score,
            tag: el.tagName,
            role: el.getAttribute("role") || null,
            placeholder: el.getAttribute("placeholder") || null,
            ariaLabel: el.getAttribute("aria-label") || null,
            contenteditable: el.getAttribute("contenteditable") || null,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            textPreview: String((el.value || el.innerText || el.textContent || "")).slice(0, 120),
            isInput: el.tagName === "TEXTAREA" || el.tagName === "INPUT",
          });
        }
      }
      collect.sort((a, b) => b.score - a.score || b.height - a.height || a.y - b.y || a.x - b.x);
      return {
        selected: collect[0] || null,
        candidateCount: collect.length,
        candidates: collect.slice(0, 8),
      };
    }, { keywordsRaw: keywords, preferBottomHalfInner: preferBottomHalf }).catch(() => null);

    if (!candidate?.selected) continue;
    frameCandidates.push({
      frameIndex,
      frameUrl: frame.url(),
      ...candidate,
    });
  }

  const bestFrame = frameCandidates.sort((a, b) => b.selected.score - a.selected.score || b.selected.height - a.selected.height || a.selected.y - b.selected.y)[0];
  if (!bestFrame?.selected) {
    return wantDebug
      ? { ok: false, debug: { reason: "no_editable_found", keywords, preferBottomHalf, frameCandidates } }
      : false;
  }

  const frame = frames[bestFrame.frameIndex];
  const locator = frame.locator(`xpath=${bestFrame.selected.xpath}`);
  let writeMode = "fill";
  let readback = "";
  let success = false;
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await locator.click({ timeout: 2000 }).catch(() => {});
    await locator.fill(payload, { timeout: 3000 });
    await page.waitForTimeout(120).catch(() => {});
    readback = bestFrame.selected.isInput
      ? await locator.inputValue().catch(() => "")
      : await locator.evaluate((el) => String(el.value || el.innerText || el.textContent || "")).catch(() => "");
    success = normalize(readback).includes(normalize(payload));
  } catch (_fillError) {
    writeMode = "type";
  }

  if (!success) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await locator.click({ timeout: 2000 }).catch(() => {});
      await locator.press("Control+A").catch(() => {});
      await locator.type(payload, { delay: 18 });
      await page.waitForTimeout(120).catch(() => {});
      readback = bestFrame.selected.isInput
        ? await locator.inputValue().catch(() => "")
        : await locator.evaluate((el) => String(el.value || el.innerText || el.textContent || "")).catch(() => "");
      success = normalize(readback).includes(normalize(payload));
    } catch (_typeError) {}
  }

  if (!success) {
    try {
      await locator.evaluate((el, value) => {
        const isInput = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
        if (isInput) {
          const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
            || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (valueSetter) valueSetter.call(el, value);
          else el.value = value;
        } else {
          el.textContent = value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
      }, payload);
      await page.waitForTimeout(120).catch(() => {});
      readback = bestFrame.selected.isInput
        ? await locator.inputValue().catch(() => "")
        : await locator.evaluate((el) => String(el.value || el.innerText || el.textContent || "")).catch(() => "");
      success = normalize(readback).includes(normalize(payload));
      if (success) writeMode = "dom";
    } catch (_domError) {}
  }

  if (!success) {
    return wantDebug
      ? {
          ok: false,
          debug: {
            reason: "write_not_verified",
            writeMode,
            frameIndex: bestFrame.frameIndex,
            frameUrl: bestFrame.frameUrl,
            selected: bestFrame.selected,
            readbackPreview: String(readback || "").slice(0, 160),
            frameCandidates: frameCandidates.map(({ frameIndex: idx, frameUrl, selected }) => ({
              frameIndex: idx,
              frameUrl: String(frameUrl || "").slice(0, 120),
              selected,
            })),
          },
        }
      : false;
  }

  await page.mouse.click(8, 8).catch(() => {});
  return wantDebug
    ? {
        ok: true,
        debug: {
          frameIndex: bestFrame.frameIndex,
          frameUrl: bestFrame.frameUrl,
          writeMode,
          selected: bestFrame.selected,
          readbackPreview: String(readback || "").slice(0, 160),
          frameCandidates: frameCandidates.map(({ frameIndex: idx, frameUrl, selected }) => ({
            frameIndex: idx,
            frameUrl: String(frameUrl || "").slice(0, 120),
            selected,
          })),
        },
      }
    : true;
}

async function clickGenericSaveInPractice(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = [...document.querySelectorAll("button, a, [role='button'], .gwt-Button, .gwt-Anchor, span, div")]
      .filter(isVisible)
      .map((el) => {
        const t = (el.textContent || el.getAttribute("title") || el.getAttribute("alt") || "").toLowerCase();
        return { el, t };
      });
    const save = candidates.find(({ t }) => t.includes("salva") || t.includes("save") || t.includes("conferma"));
    if (!save) return false;
    save.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }).catch(() => false);
}

function buildFieldWriteReport(job, writeReport) {
  const fields = [];
  const hasWork = hasWriteableOdlWork(job);
  const pushField = (fieldId, expected, ok, hint) => {
    fields.push({
      field_id: fieldId,
      expected: expected ?? "",
      found: ok ? String(expected ?? "") : null,
      status: ok ? "written" : "missing",
      hint,
    });
  };

  if (hasWork && job.internalNotes) {
    pushField("note.interne", String(job.internalNotes).trim(), Boolean(writeReport?.notes?.success), "Apri Gestione pratica e verifica note interne.");
  }

  for (const section of hasWork ? (job.sections || []) : []) {
    const reparto = String(section.reparto || "").trim().toLowerCase() || "reparto";
    const labels = writeReport?.odl?.sections || [];
    const sectionHit = labels.some((item) => String(item?.reparto || "").trim().toLowerCase() === reparto && item.written);
    for (const row of section.descrizioni || []) {
      pushField(`odl.${reparto}.descrizione`, String(row || "").trim(), sectionHit, "Apri ODL e verifica le righe descrizione.");
    }
    if (section.ore_man != null) {
      pushField(`odl.${reparto}.man`, formatManNeedle(section.ore_man), Boolean(writeReport?.hours?.man?.success), "Apri ODL e verifica MAN.");
    }
    if (section.ore_mac != null) {
      pushField(`odl.${reparto}.mac`, formatMacNeedle(section.ore_mac), Boolean(writeReport?.hours?.mac?.success), "Apri ODL e verifica MAC.");
    }
    if (section.materiali_euro != null) {
      pushField(`odl.${reparto}.materiali`, String(section.materiali_euro), Boolean(writeReport?.materials?.success), "Apri Materiali di consumo e verifica importo.");
    }
    if (section.smaltimento_applica) {
      const wasteAmount = sectionWasteAmount(section);
      pushField(`odl.${reparto}.smaltimento`, String(section.smaltimento_percentuale ?? 2), Boolean(writeReport?.waste?.success), "Apri Smaltimento rifiuti e verifica percentuale.");
      if (wasteAmount != null) {
        pushField(`odl.${reparto}.smaltimento_importo`, formatGridAmount(wasteAmount), Boolean(writeReport?.waste?.amountSuccess ?? writeReport?.waste?.success), "Apri Smaltimento rifiuti e verifica importo.");
      }
    }
    for (const part of section.ricambi || []) {
      const name = String(part?.name || part?.nome || "").trim();
      const qty = String(part?.quantity || part?.quantita || "").trim();
      const expected = `${name}${qty ? ` x ${qty}` : ""}`.trim();
      if (!expected) continue;
      pushField(`odl.${reparto}.ricambio.${name || "item"}`, expected, Boolean(writeReport?.parts?.success), "Apri Ricambi/Articoli e verifica nome + quantita.");
    }
  }
  return fields;
}

function hasVerifiedOdlWorkspace(writeReport) {
  if (!writeReport || typeof writeReport !== "object") return false;
  if (writeReport.openedOdl || writeReport.odlRouteEffective || writeReport.odlFullReloadEffective) {
    return true;
  }
  const debug = writeReport.debug?.odl || {};
  return [
    writeReport.workspaceState,
    debug.workspaceStateAfter,
    debug.workspaceStateAfterFullReload,
    debug.workspaceStateAfterFullReloadClick,
    debug.workspaceStateAfterFullReloadEntry,
  ].some((state) => state === WORKSPACE_STATES.ODL_FULL || state === "odl_full");
}

// === GRIGLIA PREVENTIVO/ODL (righe-documento, GWT CellTable) =================
// Mappa colonne (da DOM reale, attributo yapcolumnid sui <td>).
const GRID_COL = {
  tipo: 2,
  articolo: 3,
  descrizione: 4,
  cl: 5,
  cat: 6,
  udm: 7,
  qta: 8,
  prezzo: 9,
  sconto: 10,
  imponibile: 11,
  iva: 12,
};

const GRID_DEFAULT_WORK_PRICES = {
  man: 44,
  mac: 38,
};

const GRID_DEFAULT_ROW_VALUES = {
  cl: {
    man: "M",
    mac: "M",
    part: "A",
  },
  cat: "101",
  udm: "NR",
  iva: "I22",
  sconto: "0",
};

function gridWorkPriceForArticle(article) {
  return GRID_DEFAULT_WORK_PRICES[String(article || "").trim().toLowerCase()] ?? null;
}

// Coordinate del centro di una cella della griglia documento (righe con td[yapcolumnid]).
async function gridCellRect(page, rowIndex, colId) {
  return safeEvaluate(page, ({ rowIndex, colId }) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
    };
    // righe della griglia documento = tr che contengono celle con yapcolumnid (esclude il popup catalogo)
    const rows = [...document.querySelectorAll("tr")].filter((tr) => tr.querySelector("td[yapcolumnid]") && isVisible(tr));
    const row = rows[rowIndex];
    if (!row) return null;
    const cell = row.querySelector(`td[yapcolumnid="${colId}"]`);
    if (!cell) return null;
    const r = cell.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, rowCount: rows.length };
  }, { rowIndex, colId }).catch(() => null);
}

// Clicca "Aggiungi prima riga" (1ª) oppure l'anchor "T" (yapcolumnid=13) per le successive.
async function gridAddRow(page, hasRows) {
  const clicked = await safeEvaluate(page, (hasRows) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
    };
    if (!hasRows) {
      const btn = [...document.querySelectorAll("button.gwt-Button, button")]
        .find((b) => /aggiungi prima riga/i.test(b.textContent || ""));
      if (btn && isVisible(btn)) { btn.click(); return { ok: true, via: "first_row_button" }; }
    }
    // righe esistenti: clicca l'anchor "T" (aggiungi) nell'ultima riga, colonna 13
    const rows = [...document.querySelectorAll("tr")].filter((tr) => tr.querySelector('td[yapcolumnid="13"]') && isVisible(tr));
    const last = rows[rows.length - 1];
    const addAnchor = last?.querySelector('td[yapcolumnid="13"] a.gwt-Anchor');
    if (addAnchor) { addAnchor.click(); return { ok: true, via: "add_anchor" }; }
    return { ok: false };
  }, hasRows).catch(() => ({ ok: false }));
  await page.waitForTimeout(280).catch(() => {});
  return clicked;
}

// Seleziona un articolo per CODICE ESATTO dal catalogo autocomplete.
async function gridSelectArticolo(page, rowIndex, code, options = {}) {
  const cell = await gridCellRect(page, rowIndex, GRID_COL.articolo);
  if (!cell) return { ok: false, reason: "cell_not_found" };
  await page.mouse.click(cell.x, cell.y).catch(() => {});
  await page.waitForTimeout(200).catch(() => {});
  await page.keyboard.type(code, { delay: 45 }).catch(() => {});
  // il catalogo fa una lookup server: pollo fino a ~3s per i risultati
  let picked = null;
  for (let i = 0; i < 12 && !picked; i += 1) {
    await page.waitForTimeout(250).catch(() => {});
    picked = await safeEvaluate(page, ({ wanted, expectedPrice, preferredTerms }) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
      };
      const norm = (v) => String(v || "").replace(/\s+/g, " ").trim().toUpperCase();
      const normalizePrice = (v) => norm(v).replace(/[^\d,.-]/g, "");
      const priceFromText = (text) => {
        const raw = String(text || "");
        const match = raw.match(/VENDITA\s*([0-9]+,\d{1,4})/i);
        return normalizePrice(match?.[1] || "");
      };
      const pickPrimaryCode = (tr) => {
        const cells = [...tr.querySelectorAll("td, th")]
          .map((cell) => norm(cell.textContent))
          .filter(Boolean);
        if (cells.length) return cells[0];
        const firstChunk = norm(tr.textContent).split(/\s+/).filter(Boolean)[0] || "";
        return firstChunk;
      };
      // righe del popup catalogo = tr SENZA yapcolumnid ma con uno span in grassetto (codice)
      const rows = [...document.querySelectorAll("tr")].filter((tr) =>
        !tr.querySelector("[yapcolumnid]") && isVisible(tr)
        && [...tr.querySelectorAll("span")].some((s) => /font-weight:\s*bolder/i.test(s.getAttribute("style") || "")));
      const results = rows.map((tr) => {
        const bold = [...tr.querySelectorAll("span")].find((s) => /font-weight:\s*bolder/i.test(s.getAttribute("style") || ""));
        return {
          tr,
          code: norm(bold?.textContent),
          primaryCode: pickPrimaryCode(tr),
          text: norm(tr.textContent),
          price: priceFromText(tr.textContent),
        };
      });
      const wantedNorm = norm(wanted);
      const expectedPriceNorm = normalizePrice(expectedPrice || "");
      const preferredNeedles = Array.isArray(preferredTerms) ? preferredTerms.map((term) => norm(term)).filter(Boolean) : [];
      const strictExact = results.find((r) => r.primaryCode === wantedNorm);
      const looseExact = results.find((r) => r.code === wantedNorm);
      const startsWithCandidates = results.filter((r) =>
        r.primaryCode === `O${wantedNorm}`
        || r.primaryCode.startsWith(`${wantedNorm} `)
        || r.primaryCode.startsWith(`${wantedNorm}-`)
        || r.primaryCode.startsWith(`O${wantedNorm}`)
      );
      const priceMatchedStartsWith = expectedPriceNorm
        ? startsWithCandidates.find((r) => r.price === expectedPriceNorm)
        : null;
      const preferredStartsWith = preferredNeedles.length
        ? startsWithCandidates.find((r) => preferredNeedles.some((needle) => r.text.includes(needle)))
        : null;
      const exact = strictExact || (!expectedPriceNorm && !preferredNeedles.length ? looseExact : null);
      const startsWith = exact || priceMatchedStartsWith || preferredStartsWith || startsWithCandidates[0] || looseExact || null;
      const fuzzy = startsWith || results.find((r) => r.text.includes(wantedNorm) || wantedNorm.includes(r.primaryCode));
      if (fuzzy) {
        const rr = fuzzy.tr.getBoundingClientRect();
        return {
          x: rr.x + rr.width / 2,
          y: rr.y + rr.height / 2,
          codes: results.slice(0, 6).map((r) => r.primaryCode || r.code),
          matchMode: exact ? "exact" : (priceMatchedStartsWith ? "price_match" : (preferredStartsWith ? "preferred" : (startsWith ? "startswith" : "fuzzy"))),
        };
      }
      return results.length ? { x: null, y: null, codes: results.slice(0, 6).map((r) => r.primaryCode || r.code) } : null;
    }, {
      wanted: code,
      expectedPrice: options.expectedPrice || "",
      preferredTerms: options.preferredTerms || [],
    }).catch(() => null);
    if (picked && picked.x == null) {
      // popup presente ma nessun match esatto ancora: continua a pollare
      if (i >= 6) break;
      picked = null;
    }
  }
  if (picked && picked.x != null) {
    await page.mouse.click(picked.x, picked.y).catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
    return { ok: true, codes: picked.codes, matchMode: picked.matchMode || "exact" };
  }
  await page.keyboard.press("Escape").catch(() => {});
  return { ok: false, reason: "no_exact_match", codes: picked?.codes || [] };
}

// Imposta una cella (Qtà/Descrizione). Diagnostica forte: cosa diventa attivo al click,
// e dove finisce il testo digitato (per capire se la cella entra davvero in modifica).
async function gridSetCell(page, rowIndex, colId, value) {
  // In ODL la selezione articolo committa la riga: il primo dblclick sulla cella
  // puo' non aprire l'editor (activeElement resta BODY). Riprova fino a 3 volte,
  // ricalcolando le coordinate (la riga puo' essersi spostata al re-render).
  // Il retry vale solo per la descrizione: cat/udm sono derivate dall'articolo e
  // non diventano mai INPUT — ritentarle sprecherebbe ~5s a riga articolo.
  const editableCols = new Set([
    GRID_COL.descrizione,
    GRID_COL.qta,
    GRID_COL.prezzo,
    GRID_COL.sconto,
    GRID_COL.iva,
  ]);
  const maxAttempts = editableCols.has(colId) ? 3 : 1;
  let before = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const cell = await gridCellRect(page, rowIndex, colId);
    if (!cell) return { ok: false, reason: "cell_not_found" };
    await page.mouse.dblclick(cell.x, cell.y).catch(() => {});
    await page.waitForTimeout(attempt === 0 ? 220 : 380).catch(() => {});
    // Stato attivo PRIMA di digitare.
    before = await safeEvaluate(page, () => {
      const ae = document.activeElement;
      return ae ? { tag: ae.tagName, cls: (ae.className || "").slice(0, 40), val: (ae.value || "").slice(0, 20) } : null;
    }).catch(() => null);
    if (before?.tag === "INPUT" || before?.tag === "TEXTAREA") break;
  }
  if (before?.tag !== "INPUT" && before?.tag !== "TEXTAREA") {
    return { ok: false, reason: "editor_not_opened", before, afterType: null, typedInActive: false };
  }
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.type(String(value), { delay: 45 }).catch(() => {});
  // DOVE e' finito il testo? Leggo il valore dell'elemento attivo DOPO la digitazione.
  const afterType = await safeEvaluate(page, () => {
    const ae = document.activeElement;
    return ae ? { tag: ae.tagName, cls: (ae.className || "").slice(0, 40), val: (ae.value || "").slice(0, 30) } : null;
  }).catch(() => null);
  // Tab invece di Enter: Enter in ODL committa immediatamente la riga (chiude tutti gli
  // input), Tab sposta il focus alla cella successiva mantenendo la riga in modifica.
  // Effetto: dopo la descrizione, qta/prezzo restano INPUT editabili in entrambi i docKind.
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(220).catch(() => {});
  return { ok: true, before, afterType, typedInActive: Boolean(afterType?.val && afterType.val.length > 0) };
}

// Scrive nella cella Descrizione della riga in modifica targettando direttamente
// l'INPUT (il piu' largo della griglia, sotto la testata), non le coordinate della cella.
async function gridTypeDescrizione(page, text) {
  const target = await safeEvaluate(page, () => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 30 && r.height > 6 && s.display !== "none" && s.visibility !== "hidden";
    };
    // Input di testo nella zona "Righe" (sotto la testata, top > 250): la Descrizione
    // e' di gran lunga il piu' largo.
    const inputs = [...document.querySelectorAll("input.gwt-TextBox[type='text'], input.gwt-TextBox:not([type])")]
      .filter(isVisible)
      .filter((el) => el.getBoundingClientRect().top > 250);
    if (!inputs.length) return null;
    inputs.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    const el = inputs[0];
    const r = el.getBoundingClientRect();
    return { x: r.x + (r.width / 2), y: r.y + (r.height / 2), width: Math.round(r.width), cls: (el.className || "").slice(0, 50) };
  }).catch(() => null);
  if (!target) return { ok: false, reason: "descr_input_not_found" };
  await page.mouse.click(target.x, target.y).catch(() => {});
  await page.waitForTimeout(120).catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.type(String(text), { delay: 40 }).catch(() => {});
  // Committi la descrizione cliccando la cella tipo della stessa riga (single-click, non dblclick).
  // Tab sposta il focus fuori dalla riga; il successivo gridAddRow usa JS .click() sull'anchor
  // che NON genera blur sull'INPUT description → valore perso. Il click sulla cella tipo
  // (gia' settata, es. "D") genera blur sull'INPUT description → GWT salva il valore.
  // Single-click non apre il dropdown tipo (serve dblclick).
  const tipoCell = await safeEvaluate(page, ({ tx, ty }) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
    };
    const el = document.elementFromPoint(tx, ty);
    const tr = el && el.closest("tr");
    if (!tr) return null;
    const tipoTd = tr.querySelector('td[yapcolumnid="2"]');
    if (!tipoTd || !isVisible(tipoTd)) return null;
    const r = tipoTd.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, { tx: target.x, ty: target.y }).catch(() => null);
  if (tipoCell) {
    await page.mouse.click(tipoCell.x, tipoCell.y).catch(() => {});
  } else {
    await page.keyboard.press("Tab").catch(() => {});
  }
  await page.waitForTimeout(200).catch(() => {});
  // Readback: INPUT ancora attivo o cella gia' committata (textContent)?
  const value = await safeEvaluate(page, ({ tx, ty }) => {
    const el = document.elementFromPoint(tx, ty);
    const cell = el && el.closest ? el.closest("td[yapcolumnid]") : null;
    if (!cell) return null;
    const inp = cell.querySelector("input");
    if (inp) return inp.value || "";
    return (cell.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }, { tx: target.x, ty: target.y }).catch(() => null);
  return { ok: true, target, value };
}

// Imposta il TIPO (col 2) dell'ULTIMA riga (quella appena aggiunta, in modifica).
// Le righe di sola descrizione devono essere Tipo "D" (Descrizione): con "N" (riga
// articolo) YAP le considera invalide ("Impossibile salvare, alcuni valori non sono
// validi") perche' senza articolo/prezzo. Dumpa anche le opzioni del dropdown.
async function gridSetLastRowTipo(page, tipo) {
  const cell = await safeEvaluate(page, () => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
    };
    const rows = [...document.querySelectorAll("tr")].filter((tr) => tr.querySelector('td[yapcolumnid="2"]') && isVisible(tr));
    if (!rows.length) return null;
    const c = rows[rows.length - 1].querySelector('td[yapcolumnid="2"]');
    const r = c.getBoundingClientRect();
    return { x: r.x + (r.width / 2), y: r.y + (r.height / 2) };
  }).catch(() => null);
  if (!cell) return { ok: false, reason: "tipo_cell_not_found" };

  await page.mouse.dblclick(cell.x, cell.y).catch(() => {});
  await page.waitForTimeout(200).catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.type(String(tipo), { delay: 60 }).catch(() => {});
  await page.waitForTimeout(260).catch(() => {}); // lascia comparire il dropdown

  // Trova e CLICCA l'opzione "D (DESCRITTIVA)" DENTRO il .gwt-SuggestBoxPopup del Tipo.
  // Lo scoping STRETTO al SuggestBoxPopup esclude il menu di navigazione in alto (il bug
  // precedente cliccava "Dashboard"). ArrowDown+Enter NON selezionava (readback vuoto),
  // quindi serve il clic sull'opzione, ma confinato al popup -> sicuro.
  const pick = await safeEvaluate(page, (want) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
    };
    const W = String(want).toUpperCase();
    const items = [];
    for (const p of [...document.querySelectorAll(".gwt-SuggestBoxPopup")].filter(isVisible)) {
      for (const e of p.querySelectorAll("td, div, [__gwt_cell], [role='option']")) {
        const t = (e.textContent || "").replace(/\s+/g, " ").trim();
        if (isVisible(e) && t) items.push({ e, t });
      }
    }
    const opts = [...new Set(items.map((i) => i.t.slice(0, 24)))].slice(0, 8);
    // Opzione foglia che INIZIA col tipo voluto (es. "D (DESCRITTIVA)"), corta (non il
    // contenitore con tutte le opzioni concatenate).
    const hit = items.find((i) => i.t.toUpperCase().startsWith(W) && i.t.length < 24);
    let coords = null;
    if (hit) { const r = hit.e.getBoundingClientRect(); coords = { x: r.x + Math.min(r.width / 2, 60), y: r.y + (r.height / 2) }; }
    return { opts, coords, hitText: hit ? hit.t.slice(0, 24) : null };
  }, tipo).catch(() => ({ opts: [], coords: null, hitText: null }));

  if (pick.coords) {
    await page.mouse.click(pick.coords.x, pick.coords.y).catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }

  // Readback in POLLING: il re-render della cella Tipo arriva con un attimo di ritardo,
  // leggerlo subito dava vuoto (falso negativo ok=false anche se "D" era impostato).
  const readTipo = () => safeEvaluate(page, () => {
    const rows = [...document.querySelectorAll("tr")].filter((tr) => tr.querySelector('td[yapcolumnid="2"]'));
    const c = rows[rows.length - 1]?.querySelector('td[yapcolumnid="2"]');
    let t = (c?.textContent || "");
    for (const inp of (c?.querySelectorAll("input") || [])) t += " " + (inp.value || "");
    return t.replace(/\s+/g, " ").trim().slice(0, 20);
  }).catch(() => null);
  const W = String(tipo).toUpperCase();
  let readback = null;
  for (let i = 0; i < 6; i += 1) {
    readback = await readTipo();
    if (readback && readback.toUpperCase().startsWith(W)) break;
    await page.waitForTimeout(150).catch(() => {});
  }
  // Guardia: se siamo finiti sulla dashboard, e' un fallimento grave (non navigare mai via).
  const hash = await safeEvaluate(page, () => location.hash || "").catch(() => "");
  const navigatedAway = /dashboard/i.test(hash);
  // ok = ho selezionato l'opzione giusta dal dropdown (segnale affidabile) OPPURE il
  // readback conferma. Il readback da solo dava falsi negativi (legge la riga-coda).
  const pickedRightOption = Boolean(pick.coords) && String(pick.hitText || "").toUpperCase().startsWith(W);
  const setOk = pickedRightOption || Boolean(readback && readback.toUpperCase().startsWith(W));
  return { ok: !navigatedAway && setOk, opts: pick.opts, hitText: pick.hitText, pickedDropdown: Boolean(pick.coords), readback, navigatedAway: navigatedAway || undefined };
}

// Legge il contenuto testuale delle celle chiave di una riga (readback).
async function gridDumpRow(page, rowIndex) {
  return safeEvaluate(page, ({ rowIndex, COL }) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
    };
    const rows = [...document.querySelectorAll("tr")].filter((tr) => tr.querySelector("td[yapcolumnid]") && isVisible(tr));
    const row = rows[rowIndex];
    if (!row) return { found: false };
    // Legge textContent + input.value: se la riga e' ancora in edit mode (INPUT visibile),
    // textContent e' vuoto ma input.value contiene il valore effettivo.
    const txt = (id) => {
      const cell = row.querySelector(`td[yapcolumnid="${id}"]`);
      if (!cell) return "";
      const inp = cell.querySelector("input");
      const valPart = inp ? (inp.value || "") : "";
      return ((cell.textContent || "") + " " + valPart).replace(/\s+/g, " ").trim().slice(0, 40);
    };
    return {
      found: true,
      tipo: txt(COL.tipo),
      articolo: txt(COL.articolo),
      descrizione: txt(COL.descrizione),
      cl: txt(COL.cl),
      cat: txt(COL.cat),
      udm: txt(COL.udm),
      qta: txt(COL.qta),
      prezzo: txt(COL.prezzo),
      sconto: txt(COL.sconto),
      imponibile: txt(COL.imponibile),
      iva: txt(COL.iva),
    };
  }, { rowIndex, COL: GRID_COL }).catch(() => ({ found: false }));
}

// Salva il documento (Preventivo/ODL): bottone gwt-Button con <span>Salva</span>
// (anche nascosto) + icona floppy. Abilitato == ci sono modifiche da salvare;
// dopo il salvataggio diventa gwt-Button-disabled -> segnale di conferma affidabile.
async function saveWorkDocument(page, args = {}) {
  const locate = () => safeEvaluate(page, () => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 6 && r.height > 6 && s.display !== "none" && s.visibility !== "hidden";
    };
    const btns = [...document.querySelectorAll("button.gwt-Button, .gwt-Button")].filter(isVisible);
    const save = btns.find((b) => {
      const span = b.querySelector("span");
      const label = (span?.textContent || b.getAttribute("title") || "").trim().toLowerCase();
      return label === "salva";
    });
    if (!save) return { found: false };
    const disabled = /gwt-Button-disabled/.test(save.className || "") || save.disabled === true;
    const r = save.getBoundingClientRect();
    return { found: true, disabled, x: r.x + (r.width / 2), y: r.y + (r.height / 2) };
  }).catch(() => ({ found: false }));

  const shot = async (tag) => {
    if (!args?.artifactDir) return null;
    const p = path.join(args.artifactDir, `doc-save-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: true }).catch(() => {});
    return p;
  };
  const notifNow = () => safeEvaluate(page, () => {
    const t = [...document.querySelectorAll(".notifierWidget, .notifierMessageContainer, .gwt-InlineHTML")]
      .map((e) => (e.textContent || "").trim())
      .find((x) => /salvat|salvatagg/i.test(x) && !/appuntamento/i.test(x));
    return t || null;
  }).catch(() => null);

  // 1) Committo l'eventuale edit di cella in corso (blur): se una cella e' in modifica,
  // il primo click su Salva verrebbe "consumato" dal blur invece di salvare.
  await safeEvaluate(page, () => { try { document.activeElement && document.activeElement.blur(); } catch {} }).catch(() => {});
  await page.waitForTimeout(250).catch(() => {});

  const info = await locate();
  if (!info.found) { const s = await shot("notfound"); logAction("doc_save", { found: false, shot: s }); return { ok: false, reason: "save_btn_not_found" }; }
  if (info.disabled) { logAction("doc_save", { found: true, disabled: true, note: "niente da salvare" }); return { ok: false, reason: "nothing_to_save", disabled: true }; }

  const beforeShot = await shot("before");

  // RPC di salvataggio (best-effort, secondario rispetto al bottone che si disabilita).
  const saveRpc = page.waitForResponse(
    (r) => /\/yap\/action\/\w+Action/i.test(r.url()) && r.request().method() === "POST" && r.status() === 200,
    { timeout: 9000 },
  ).then((r) => (r.url().split("/action/")[1] || "").slice(0, 44)).catch(() => null);

  // 2) Click su Salva, con un RETRY: alcune UI consumano il primo click per chiudere
  // l'editor di cella, e serve un secondo click per salvare davvero.
  let becameDisabled = false;
  let notif = null;
  const clicks = [];
  for (let attempt = 0; attempt < 2 && !becameDisabled && !notif; attempt += 1) {
    const cur = await locate();
    if (!cur.found || cur.disabled) { becameDisabled = true; break; }
    await page.mouse.click(cur.x, cur.y).catch(() => {});
    clicks.push(attempt + 1);
    for (let i = 0; i < 14; i += 1) {
      const s = await locate();
      if (!s.found || s.disabled) { becameDisabled = true; break; }
      notif = await notifNow();
      if (notif) break;
      await page.waitForTimeout(200).catch(() => {});
    }
  }
  const rpc = await saveRpc;
  const ok = becameDisabled || Boolean(notif) || Boolean(rpc);
  const afterShot = await shot(ok ? "ok" : "fail");

  // Diagnostico ONESTO quando NON confermato: dialog aperti, notifiche, stato bottone.
  let diag = null;
  if (!ok) {
    diag = await safeEvaluate(page, () => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 6 && r.height > 6 && s.display !== "none" && s.visibility !== "hidden";
      };
      const dialogs = [...document.querySelectorAll(".gwt-DialogBox, .gwt-DecoratedPopupPanel, .gwt-PopupPanel")]
        .filter(isVisible).map((p) => (p.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90)).filter(Boolean).slice(0, 5);
      const notifs = [...document.querySelectorAll(".notifierWidget, .notifierMessageContainer")]
        .filter(isVisible).map((p) => (p.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 5);
      const saveBtn = [...document.querySelectorAll("button.gwt-Button")]
        .find((b) => (b.querySelector("span")?.textContent || "").trim().toLowerCase() === "salva");
      // Righe della griglia (testo + valori input) per vedere se c'e' una riga incompleta.
      const rows = [...document.querySelectorAll("tr")].filter((tr) => tr.querySelector("td[yapcolumnid]"))
        .map((tr) => { let h = tr.textContent || ""; for (const inp of tr.querySelectorAll("input")) h += " " + (inp.value || ""); return h.replace(/\s+/g, " ").trim().slice(0, 60); });
      return { dialogs, notifs, saveBtnCls: (saveBtn?.className || "").slice(0, 64), rows: rows.slice(0, 12) };
    }).catch(() => null);
  }
  logAction("doc_save", { found: true, clicks, becameDisabled, notif, rpc, ok, beforeShot, afterShot, diag });
  return { ok, becameDisabled, notif, rpc };
}

async function snapshotWorkGrid(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.display !== "none" && s.visibility !== "hidden";
    };
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const topTabs = [...document.querySelectorAll(".gwt-TabLayoutPanelTab, [role='tab'], button, a, span, div, td")]
      .filter(isVisible)
      .filter((el) => el.getBoundingClientRect().y < 150)
      .map((el) => ({
        text: normalize(el.textContent || "").slice(0, 40),
        selected: /selected|active/i.test(String(el.className || "")) || el.getAttribute("aria-selected") === "true",
      }))
      .filter((item) => item.text)
      .slice(0, 20);
    const gridHeaders = [...document.querySelectorAll("th, td[yapcolumnid]")]
      .filter(isVisible)
      .map((el) => normalize(el.textContent || el.getAttribute("yapcolumnid") || ""))
      .filter(Boolean)
      .slice(0, 20);
    const rows = [...document.querySelectorAll("tr")]
      .filter((tr) => tr.querySelector("td[yapcolumnid]"))
      .map((tr) => {
        let hay = tr.textContent || "";
        for (const inp of tr.querySelectorAll("input")) hay += ` ${inp.value || ""}`;
        return normalize(hay).slice(0, 120);
      })
      .filter(Boolean)
      .slice(0, 12);
    const buttons = [...document.querySelectorAll("button, a, [role='button']")]
      .filter(isVisible)
      .map((el) => normalize(el.textContent || el.getAttribute("title") || el.getAttribute("aria-label") || ""))
      .filter(Boolean)
      .slice(0, 20);
    return {
      hash: String(location.hash || "").slice(0, 180),
      topTabs,
      gridHeaders,
      rowCount: rows.length,
      rows,
      buttons,
      hasAddFirstRow: buttons.some((text) => /aggiungi prima riga/i.test(text)),
      hasSalva: buttons.some((text) => /^salva$/i.test(text) || /salva/i.test(text)),
      bodyPreview: normalize(document.body?.innerText || "").slice(0, 260),
    };
  }).catch(() => ({ error: true }));
}

async function readWorkGridTexts(page) {
  return safeEvaluate(page, () => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll("tr")]
      .filter((tr) => tr.querySelector("td[yapcolumnid]"))
      .map((tr) => {
        let hay = tr.textContent || "";
        for (const inp of tr.querySelectorAll("input")) hay += ` ${inp.value || ""}`;
        return normalize(hay);
      })
      .filter(Boolean);
  }).catch(() => []);
}

function comparableGridText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function gridRowsIncludeText(rows, needle) {
  const n = comparableGridText(needle);
  if (!n) return false;
  return (rows || []).some((row) => comparableGridText(row).includes(n));
}

function gridWorkSections(job) {
  const order = { officina: 0, carrozzeria: 1 };
  return (job.sections || [])
    .filter((section) => {
      const reparto = String(section?.reparto || "").trim().toLowerCase();
      return reparto === "officina" || reparto === "carrozzeria";
    })
    .sort((a, b) => {
      const ar = String(a?.reparto || "").trim().toLowerCase();
      const br = String(b?.reparto || "").trim().toLowerCase();
      return (order[ar] ?? 99) - (order[br] ?? 99);
    });
}

function sectionGridLabel(section) {
  const reparto = String(section?.reparto || "").trim().toLowerCase();
  if (reparto === "officina") return "Officina";
  if (reparto === "carrozzeria") return "Carrozzeria";
  return reparto || "Reparto";
}

function sectionNumber(value) {
  if (value == null || value === "") return null;
  return value;
}

function normalizeGridQty(value) {
  const n = sectionNumber(value);
  return n == null ? null : String(n).trim();
}

function normalizeGridMoney(value) {
  const n = sectionNumber(value);
  return n == null ? null : String(n).trim();
}

function buildPartDisplayText(name, qty) {
  const partName = String(name || "").trim();
  const partQty = String(qty || "").trim();
  if (!partName) return "";
  return partQty ? `${partName} x ${partQty}` : partName;
}

function parseGridNumber(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim().replace(/\s+/g, "").replace(/[€]/g, "");
  const normalized = raw
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatGridAmount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed.toFixed(2);
}

function sectionKnownPriceTotal(section) {
  let total = 0;
  const manHours = parseGridNumber(section?.ore_man ?? section?.man_hours);
  if (manHours != null) total += manHours * (gridWorkPriceForArticle("MAN") ?? 0);
  const macHours = parseGridNumber(section?.ore_mac ?? section?.mac_hours);
  if (macHours != null) total += macHours * (gridWorkPriceForArticle("MAC") ?? 0);
  const materialsAmount = parseGridNumber(section?.materiali_euro ?? section?.materials_amount);
  if (materialsAmount != null) total += materialsAmount;
  for (const part of (section?.ricambi || [])) {
    const qty = parseGridNumber(part?.quantity ?? part?.quantita) ?? 1;
    const price = parseGridNumber(part?.prezzo ?? part?.price ?? part?.unit_price ?? part?.costo);
    if (price != null) total += qty * price;
  }
  return total;
}

function sectionWasteDetails(section) {
  if (!section?.smaltimento_applica) return null;
  const percent = parseGridNumber(section?.smaltimento_percentuale ?? 2);
  if (percent == null) return null;
  const manHours = parseGridNumber(section?.ore_man ?? section?.man_hours);
  const macHours = parseGridNumber(section?.ore_mac ?? section?.mac_hours);
  const materialsAmount = parseGridNumber(section?.materiali_euro ?? section?.materials_amount);
  const pricedParts = [];
  for (const part of (section?.ricambi || [])) {
    const qty = parseGridNumber(part?.quantity ?? part?.quantita) ?? 1;
    const price = parseGridNumber(part?.prezzo ?? part?.price ?? part?.unit_price ?? part?.costo);
    if (price == null) continue;
    pricedParts.push({
      name: String(part?.name || part?.nome || "").trim(),
      qty,
      price,
      total: Number((qty * price).toFixed(2)),
    });
  }
  const subtotal = Number(sectionKnownPriceTotal(section).toFixed(2));
  const amount = Number((subtotal * (percent / 100)).toFixed(2));
  return {
    reparto: String(section?.reparto || "").trim().toLowerCase() || null,
    percent,
    subtotal,
    amount,
    components: {
      manHours,
      manRate: manHours != null ? (gridWorkPriceForArticle("MAN") ?? null) : null,
      macHours,
      macRate: macHours != null ? (gridWorkPriceForArticle("MAC") ?? null) : null,
      materialsAmount,
      pricedParts,
    },
  };
}

function sectionWasteAmount(section) {
  const details = sectionWasteDetails(section);
  return details ? details.amount : null;
}

function buildWorkGridDescriptionLines(job) {
  return buildWorkGridRows(job);
}

async function writeGridFlowExtraFields(page, job, writeReport, args = {}) {
  const sections = Array.isArray(job?.sections) ? job.sections : [];
  const out = {
    attempted: false,
    wroteAny: false,
  };
  for (const section of sections) {
    const reparto = String(section?.reparto || "").trim();
    const yapReparto = yapRepartoForOdl(reparto);
    const repartoKeys = [...new Set([yapReparto, reparto].filter(Boolean))];
    if (reparto) {
      await clickRepartoSection(page, yapReparto).catch(() => false);
      if (yapReparto !== reparto) {
        await clickRepartoSection(page, reparto).catch(() => false);
      }
      await page.waitForTimeout(60).catch(() => {});
    }
    const sectionDebug = args.debug ? {
      reparto,
      yapReparto,
      fields: {},
    } : null;
    if (section.materiali_euro != null) {
      out.attempted = true;
      writeReport.materials.attempted = true;
      const materialsTabReady = await clickBottomSectionTab(page, "Materiali di consumo").catch(() => false);
      await page.waitForTimeout(180).catch(() => {});
      const matOkResult = await fillWithRetry(
        page,
        [
          ["materiali di consumo", "importo"],
          ["materiali di consumo", "euro"],
          [...repartoKeys, "materiali", "consumo", "euro"],
          [...repartoKeys, "materiali di consumo", "materiali"],
          [...repartoKeys, "materiali"],
        ],
        String(section.materiali_euro),
        {},
        { debug: args.debug, fieldId: `odl.${reparto}.materiali`, returnDebug: args.debug },
      );
      const matOk = materialsTabReady && Boolean(matOkResult?.ok ?? matOkResult);
      writeReport.materials.success = writeReport.materials.success || matOk;
      if (matOk) writeReport.materials.error = null;
      else if (!writeReport.materials.error) {
        writeReport.materials.error = materialsTabReady ? "materials_field_not_found" : "materials_tab_not_found";
      }
      out.wroteAny = out.wroteAny || matOk;
      if (sectionDebug) sectionDebug.fields.materiali = {
        tabReady: materialsTabReady,
        ...(matOkResult?.debug || {}),
      };
    }
    if (section.smaltimento_applica) {
      out.attempted = true;
      writeReport.waste.attempted = true;
      const wasteTabReady = await clickBottomSectionTab(page, "Smaltimento rifiuti").catch(() => false);
      await page.waitForTimeout(180).catch(() => {});
      const wasteDetails = sectionWasteDetails(section);
      logAction("waste_calc", wasteDetails || {
        reparto,
        percent: section?.smaltimento_percentuale ?? 2,
        subtotal: null,
        amount: null,
        reason: "missing_numeric_basis",
      });
      const smaltOkResult = await fillWithRetry(
        page,
        [
          [...repartoKeys, "smaltimento", "rifiuti", "%"],
          [...repartoKeys, "smaltimento rifiuti", "smaltimento"],
          [...repartoKeys, "rifiuti", "percentuale"],
        ],
        String(section.smaltimento_percentuale ?? 2),
        {},
        { debug: args.debug, fieldId: `odl.${reparto}.smaltimento`, returnDebug: args.debug },
      );
      const smaltOk = wasteTabReady && Boolean(smaltOkResult?.ok ?? smaltOkResult);
      writeReport.waste.success = writeReport.waste.success || smaltOk;
      if (smaltOk) writeReport.waste.error = null;
      else if (!writeReport.waste.error) {
        writeReport.waste.error = wasteTabReady ? "waste_field_not_found" : "waste_tab_not_found";
      }
      out.wroteAny = out.wroteAny || smaltOk;
      if (sectionDebug) sectionDebug.fields.smaltimento = {
        tabReady: wasteTabReady,
        ...(smaltOkResult?.debug || {}),
      };

      const smaltAmount = sectionWasteAmount(section);
      if (smaltAmount != null) {
        writeReport.waste.amountAttempted = true;
        const smaltAmountText = formatGridAmount(smaltAmount);
        logAction("waste_amount_write", {
          reparto,
          amount: smaltAmountText,
          percent: wasteDetails?.percent ?? null,
          subtotal: wasteDetails?.subtotal ?? null,
        });
        const smaltAmountResult = await fillWithRetry(
          page,
          [
            [...repartoKeys, "smaltimento", "importo"],
            [...repartoKeys, "smaltimento", "prezzo"],
            [...repartoKeys, "smaltimento", "euro"],
            [...repartoKeys, "smaltimento rifiuti", "importo"],
            [...repartoKeys, "smaltimento rifiuti", "prezzo"],
            [...repartoKeys, "rifiuti", "totale"],
          ],
          smaltAmountText,
          {},
          { debug: args.debug, fieldId: `odl.${reparto}.smaltimento_importo`, returnDebug: args.debug },
        );
        const smaltAmountOk = wasteTabReady && Boolean(smaltAmountResult?.ok ?? smaltAmountResult);
        writeReport.waste.amountSuccess = writeReport.waste.amountSuccess || smaltAmountOk;
        writeReport.waste.success = writeReport.waste.success || smaltAmountOk;
        if (smaltAmountOk) {
          writeReport.waste.amountError = null;
          writeReport.waste.error = null;
        } else if (!writeReport.waste.amountError) {
          writeReport.waste.amountError = wasteTabReady
            ? "waste_amount_field_not_found"
            : "waste_tab_not_found";
        }
        out.wroteAny = out.wroteAny || smaltAmountOk;
        if (sectionDebug) sectionDebug.fields.smaltimentoImporto = smaltAmountResult?.debug || null;
      }
    }
    if (sectionDebug && Object.keys(sectionDebug.fields).length) {
      writeReport.debug.sections.push(sectionDebug);
    }
  }
  return out;
}

function buildWorkGridRows(job) {
  const workSections = gridWorkSections(job);
  const addRepartoPrefix = workSections.length > 1;
  const rows = [];
  const withPrefix = (section, text) => {
    const base = String(text || "").trim();
    if (!base) return "";
    return addRepartoPrefix ? `${sectionGridLabel(section)} - ${base}` : base;
  };
  const sectionWorkText = (section, kind) => {
    const reparto = sectionGridLabel(section).toUpperCase();
    const desc = (section?.descrizioni || []).map((d) => String(d || "").trim()).filter(Boolean);
    const head = kind === "mac" ? "MACCHINA" : "MANODOPERA";
    if (!desc.length) return `${head} ${reparto}`;
    return `${head} ${reparto} PER LA ${desc.join(", ")}`;
  };

  for (const section of workSections) {
    for (const d of (section?.descrizioni || [])) {
      const text = withPrefix(section, d);
      if (text) rows.push({
        kind: "descrizione",
        reparto: String(section?.reparto || "").trim().toLowerCase(),
        tipo: "D",
        text,
      });
    }

    const ricambi = Array.isArray(section?.ricambi) ? section.ricambi : [];
    for (const part of ricambi) {
      const name = String(part?.name || part?.nome || "").trim();
      if (!name) continue;
      const qty = normalizeGridQty(part?.quantity ?? part?.quantita);
      const displayText = withPrefix(section, buildPartDisplayText(name, qty));
      rows.push({
        kind: "ricambio",
        reparto: String(section?.reparto || "").trim().toLowerCase(),
        tipo: "D",
        articleQuery: null,
        text: displayText || name,
      });
    }

    const manHours = sectionNumber(section?.ore_man ?? section?.man_hours);
    if (manHours != null) {
      rows.push({
        kind: "man",
        reparto: String(section?.reparto || "").trim().toLowerCase(),
        tipo: "N",
        articleQuery: "MAN",
        text: sectionWorkText(section, "man"),
        cl: GRID_DEFAULT_ROW_VALUES.cl.man,
        cat: GRID_DEFAULT_ROW_VALUES.cat,
        udm: GRID_DEFAULT_ROW_VALUES.udm,
        qta: normalizeGridQty(manHours),
        prezzo: normalizeGridMoney(gridWorkPriceForArticle("MAN")),
        sconto: GRID_DEFAULT_ROW_VALUES.sconto,
        iva: GRID_DEFAULT_ROW_VALUES.iva,
      });
    }

    const macHours = sectionNumber(section?.ore_mac ?? section?.mac_hours);
    if (macHours != null) {
      rows.push({
        kind: "mac",
        reparto: String(section?.reparto || "").trim().toLowerCase(),
        tipo: "N",
        articleQuery: "MAC",
        text: sectionWorkText(section, "mac"),
        cl: GRID_DEFAULT_ROW_VALUES.cl.mac,
        cat: GRID_DEFAULT_ROW_VALUES.cat,
        udm: GRID_DEFAULT_ROW_VALUES.udm,
        qta: normalizeGridQty(macHours),
        prezzo: normalizeGridMoney(gridWorkPriceForArticle("MAC")),
        sconto: GRID_DEFAULT_ROW_VALUES.sconto,
        iva: GRID_DEFAULT_ROW_VALUES.iva,
      });
    }
  }

  return rows;
}

// Orchestratore: scrive le righe del documento (Preventivo/ODL).
async function writeWorkGrid(page, job, args = {}) {
  const workSections = gridWorkSections(job);
  const manSection = workSections.find((s) => sectionNumber(s?.ore_man ?? s?.man_hours) != null);
  const manHours = sectionNumber(manSection?.ore_man ?? manSection?.man_hours);

  // Rileva la griglia anche se il documento e' VUOTO (niente righe yapcolumnid):
  // bottone "Aggiungi prima riga" / header colonne / testo "documento non ha righe".
  let onGrid = false;
  for (let i = 0; i < 16 && !onGrid; i += 1) {
    onGrid = await safeEvaluate(page, () => {
      const hasRows = !!document.querySelector("td[yapcolumnid]");
      const hasAddBtn = [...document.querySelectorAll("button")].some((b) => /aggiungi prima riga/i.test(b.textContent || ""));
      const hasEmpty = /il documento non ha righe/i.test(document.body?.innerText || "");
      const hasHeader = [...document.querySelectorAll("th")].some((th) => /articolo/i.test(th.textContent || ""));
      return hasRows || hasAddBtn || hasEmpty || hasHeader;
    }).catch(() => false);
    if (!onGrid) await page.waitForTimeout(400).catch(() => {});
  }
  logAction("grid_check", {
    onGrid,
    sections: workSections.map((s) => String(s?.reparto || "").trim()).filter(Boolean),
    manHours: manHours ?? null,
  });
  if (!onGrid) return { ok: false, reason: "not_on_grid" };
  const existingRows = await readWorkGridTexts(page);
  logAction("grid_existing_rows", { count: existingRows.length, sample: existingRows.slice(0, 10) });
  logAction("grid_snapshot_before", await snapshotWorkGrid(page));

  const out = { ok: true, changed: false, manodopera: null, sections: workSections.map((s) => String(s?.reparto || "").trim()).filter(Boolean) };

  const gridRows = buildWorkGridRows(job);
  logAction("grid_rows_plan", {
    count: gridRows.length,
    sections: workSections.map((s) => String(s?.reparto || "").trim()).filter(Boolean),
    rows: gridRows.map((row, index) => ({
      index,
      kind: row.kind,
      reparto: row.reparto,
      tipo: row.tipo,
      articleQuery: row.articleQuery || null,
      text: String(row.text || "").slice(0, 80),
      qta: row.qta ?? null,
      prezzo: row.prezzo ?? null,
      sconto: row.sconto ?? null,
    })),
  });
  out.righe = [];
  let addedGridRows = 0;
  for (const row of gridRows) {
    const rowKey = `${row.tipo}:${row.articleQuery || row.text || row.kind}`;
    if (gridRowsIncludeText(existingRows, row.text) || (row.articleQuery && gridRowsIncludeText(existingRows, row.articleQuery))) {
      logAction("grid_row_skip_existing", {
        kind: row.kind,
        text: row.text.slice(0, 60),
        articleQuery: row.articleQuery || null,
        existingSample: existingRows.slice(0, 8),
      });
      out.righe.push({ ...row, typed: false, written: true, existing: true, article: row.articleQuery ? true : false });
      continue;
    }
    const hasRows = existingRows.length > 0 || addedGridRows > 0;
    const added = await gridAddRow(page, hasRows);
    out.changed = out.changed || Boolean(added.ok);
    addedGridRows += 1;
    await page.waitForTimeout(150).catch(() => {}); // gridAddRow ha gia' la sua attesa interna
    const tipo = await gridSetLastRowTipo(page, row.tipo || "D");
    logAction("grid_row_tipo", {
      kind: row.kind,
      text: row.text.slice(0, 30),
      added: added.ok,
      ...tipo,
    });
    const rowIndex = existingRows.length + addedGridRows - 1;

    let art = { ok: false, skipped: true };
    if (row.articleQuery) {
      const preferredTerms = row.kind === "man"
        ? ["MANODOPERA"]
        : (row.kind === "mac" ? ["MAQNODOPERA", "MACCHINA", "MANODOPERA"] : []);
      art = await gridSelectArticolo(page, rowIndex, row.articleQuery, {
        expectedPrice: row.prezzo,
        preferredTerms,
      });
      logAction("grid_row_articolo", { kind: row.kind, query: row.articleQuery, ...art });
    }

    let setDescr = { ok: true, skipped: true };
    if (row.text) {
      if (row.tipo === "N") {
        setDescr = await gridSetCell(page, rowIndex, GRID_COL.descrizione, row.text);
        logAction("grid_row_descr_cell", {
          kind: row.kind,
          text: row.text.slice(0, 60),
          rowIndex,
          ...setDescr,
        });
      } else {
        setDescr = await gridTypeDescrizione(page, row.text);
      }
    }
    const writeCell = async (field, value) => {
      if (value == null || value === "") return null;
      const res = await gridSetCell(page, rowIndex, GRID_COL[field], value);
      logAction("grid_row_cell", { kind: row.kind, field, value: String(value).slice(0, 30), ...res });
      return res;
    };

    await writeCell("cl", row.cl);
    await writeCell("cat", row.cat);
    await writeCell("udm", row.udm);
    await writeCell("qta", row.qta);
    await writeCell("prezzo", row.prezzo);
    await writeCell("sconto", row.sconto);
    await writeCell("iva", row.iva);
    const readback = await gridDumpRow(page, rowIndex);

    const inGridNow = await safeEvaluate(page, (needle) => {
      const n = String(needle || "").toUpperCase();
      const rows = [...document.querySelectorAll("tr")].filter((tr) => tr.querySelector("td[yapcolumnid]"));
      for (let i = 0; i < rows.length; i += 1) {
        let hay = rows[i].textContent || "";
        for (const inp of rows[i].querySelectorAll("input")) hay += " " + (inp.value || "");
        if (hay.toUpperCase().includes(n)) return { found: true, rowIndex: i };
      }
      return { found: false, rowCount: rows.length };
    }, row.text).catch(() => ({ found: false }));
    logAction("grid_row", {
      kind: row.kind,
      key: rowKey,
      text: row.text.slice(0, 30),
      added: added.ok,
      descrInput: setDescr.target,
      inputValue: setDescr.value,
      article: art.ok,
      inGridNow: inGridNow.found,
      expected: {
        tipo: row.tipo || null,
        articolo: row.articleQuery || null,
        descrizione: row.text || null,
        cl: row.cl || null,
        cat: row.cat || null,
        udm: row.udm || null,
        qta: row.qta || null,
        prezzo: row.prezzo || null,
        sconto: row.sconto || null,
        iva: row.iva || null,
      },
      readback,
    });
    if (!out.manodopera && (row.kind === "man" || row.kind === "mac")) {
      const articleValid = row.articleQuery ? isExpectedGridArticle(readback?.articolo, row.articleQuery) : Boolean(art.ok);
      out.manodopera = {
        expected: true,
        reparto: row.reparto,
        added: added.ok,
        articolo: articleValid,
        qta: row.qta != null,
        readback,
      };
      logAction("grid_lavoro_after", out.manodopera.readback);
    }
    out.righe.push({
      ...row,
      typed: Boolean(setDescr.value && setDescr.value.length > 0),
      written: false,
      article: row.articleQuery ? isExpectedGridArticle(readback?.articolo, row.articleQuery) : Boolean(art.ok),
      readback,
    });
  }

  // FLUSH ultima riga: una riga GWT si committa quando perde il focus, cosa che
  // avviene al gridAddRow SUCCESSIVO. L'ultima riga digitata non ha un "dopo",
  // quindi aggiungo una riga civetta per forzarne il commit (poi resta vuota in coda,
  // come la riga-aggiungi che ogni griglia ha gia').
  if (addedGridRows) {
    await gridAddRow(page, true).catch(() => {});
    await page.waitForTimeout(450).catch(() => {});
  }

  // VERIFICA FINALE ONESTA: rileggo TUTTE le righe della griglia una volta sola.
  // Includo textContent + i valori degli <input> (le celle editabili non mettono il
  // valore in textContent). out.righe[].written = il testo c'e' DAVVERO nella griglia.
  const finalRows = await safeEvaluate(page, () => {
    const rows = [...document.querySelectorAll("tr")].filter((tr) => tr.querySelector("td[yapcolumnid]"));
    return rows.map((tr) => {
      let hay = tr.textContent || "";
      for (const inp of tr.querySelectorAll("input")) hay += " " + (inp.value || "");
      return hay.replace(/\s+/g, " ").trim().slice(0, 240);
    });
  }).catch(() => []);
  for (const r of out.righe) {
    const n = String(r.text || "").toUpperCase();
    const articleNeedle = String(r.articleQuery || "").toUpperCase();
    const hit = r.articleQuery
      ? (finalRows.find((h) => h.toUpperCase().includes(articleNeedle)) || null)
      : (finalRows.find((h) => h.toUpperCase().includes(n)) || null);
    const textWritten = Boolean(hit);
    // Ricalcola `article` dal grid FINALE: il readback fatto a riga ancora in edit
    // leggeva la cella articolo vuota (falso negativo). Se la riga trovata contiene
    // anche il codice articolo, l'articolo c'e'.
    if (r.articleQuery && hit && hit.toUpperCase().includes(String(r.articleQuery).toUpperCase())) {
      r.article = true;
    }
    r.written = r.articleQuery ? Boolean(r.article) : textWritten;
  }
  // Aggiorna anche il flag manodopera con il risultato finale (stesso falso negativo).
  if (out.manodopera && !out.manodopera.articolo) {
    const lavoro = out.righe.find((r) => r.kind === "man" || r.kind === "mac");
    if (lavoro?.article) out.manodopera.articolo = true;
  }
  logAction("grid_verify_rows", out.righe.map((row) => ({
    kind: row.kind,
    reparto: row.reparto,
    tipo: row.tipo,
    text: String(row.text || "").slice(0, 80),
    articleQuery: row.articleQuery || null,
    article: row.article || false,
    written: row.written,
    existing: row.existing || false,
    readback: row.readback || null,
  })));
  logAction("grid_desc_verify", {
    gridRows: finalRows.length,
    persisted: out.righe.filter((r) => r.written).length,
    expected: out.righe.length,
    sample: finalRows.slice(0, 14),
  });
  logAction("grid_snapshot_before_save", await snapshotWorkGrid(page));

  // SALVA il documento: senza questo le righe restano solo client-side e si perdono
  // (su YAP "Preventivi" risultava vuoto). Il bottone Salva che si disabilita conferma.
  out.saved = out.changed ? await saveWorkDocument(page, args) : { ok: true, reason: "already_written", disabled: true };
  logAction("grid_snapshot_after_save", { saved: out.saved?.ok || false, ...(await snapshotWorkGrid(page)) });
  return out;
}

// Diagnostica (read-only): mappa lo stato della pratica dopo "Gestione pratica".
// Cattura URL/hash, i TAB disponibili (Preventivi/ODL/Dettagli...) e gli input della
// tabella visibile. Serve per ricostruire la navigazione e i campi precisi (come popup_fields).
async function dumpPracticeState(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden";
    };
    const tabs = [...document.querySelectorAll(".gwt-TabLayoutPanelTab, [role='tab']")]
      .filter(isVisible)
      .map((el) => ({
        txt: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30),
        cls: (el.className || "").slice(0, 50),
        selected: /selected/i.test(el.className || ""),
      }))
      .slice(0, 16);
    const inputs = [...document.querySelectorAll("input, textarea")]
      .filter(isVisible)
      .map((el) => ({
        tag: el.tagName,
        type: el.getAttribute("type") || "",
        cls: (el.className || "").slice(0, 50),
        value: (el.value || "").slice(0, 20),
        maxlength: el.getAttribute("maxlength") || "",
        ph: el.getAttribute("placeholder") || "",
      }))
      .slice(0, 30);
    return {
      hash: (location.hash || "").slice(0, 200),
      tabCount: tabs.length,
      tabs,
      inputCount: inputs.length,
      inputs,
    };
  }).catch(() => ({ error: true }));
}

async function writePracticeAndOdl(page, job, args) {
  const summary = buildOdlSummaryText(job);
  // CATTURA RPC: registra il traffico GWT /yap/action/* durante apertura pratica+ODL.
  // È il dato che manca per capire perché su Railway "Recupero dettagli pratica in
  // corso" non finisce mai: l'RPC dei dettagli non parte? va in errore (4xx/5xx)?
  // risponde vuota? non risponde affatto (hang)? Confronteremo Railway vs locale.
  const rpcLog = [];
  const rpcStats = new Map();
  const rpcMaxLog = 200;
  const _rpcT0 = Date.now();
  const _rpcAction = (u) => { const m = /\/yap\/action\/([A-Za-z0-9_]+)/.exec(u || ""); return m ? m[1] : null; };
  const _rpcStat = (a) => {
    if (!rpcStats.has(a)) {
      rpcStats.set(a, { req: 0, res: 0, fail: 0, firstMs: null, lastMs: null, lastStatus: null, lastLen: null, lastError: null, method: null });
    }
    return rpcStats.get(a);
  };
  const _recordRpc = (entry) => {
    if (!entry?.a) return;
    const t = Date.now() - _rpcT0;
    const item = { t, ...entry };
    rpcLog.push(item);
    if (rpcLog.length > rpcMaxLog) rpcLog.splice(0, rpcLog.length - rpcMaxLog);
    const stat = _rpcStat(entry.a);
    if (stat.firstMs == null) stat.firstMs = t;
    stat.lastMs = t;
    if (entry.ev === "req") {
      stat.req += 1;
      stat.method = entry.m || stat.method;
    } else if (entry.ev === "res") {
      stat.res += 1;
      stat.lastStatus = entry.s;
      stat.lastLen = entry.len;
    } else if (entry.ev === "fail") {
      stat.fail += 1;
      stat.lastError = entry.err || "failed";
    }
  };
  const _onRpcReq = (req) => {
    const a = _rpcAction(req.url());
    if (a) _recordRpc({ ev: "req", a, m: typeof req.method === "function" ? req.method() : null });
  };
  const _onRpcRes = (res) => {
    const a = _rpcAction(res.url());
    if (a) _recordRpc({ ev: "res", a, s: res.status(), len: Number(res.headers()["content-length"] || 0) });
  };
  const _onRpcFail = (req) => {
    const a = _rpcAction(req.url());
    if (a) _recordRpc({ ev: "fail", a, err: ((req.failure && req.failure()) || {}).errorText || "failed" });
  };
  const _rpcSnapshot = () => {
    const allSummaryRows = [...rpcStats.entries()].map(([action, stat]) => ({
      action,
      req: stat.req,
      res: stat.res,
      fail: stat.fail,
      pending: Math.max(0, stat.req - stat.res - stat.fail),
      lastStatus: stat.lastStatus,
      lastLen: stat.lastLen,
      lastError: stat.lastError,
      lastAt: Number(((stat.lastMs || 0) / 1000).toFixed(1)),
    })).sort((a, b) =>
      (b.pending - a.pending)
      || (b.fail - a.fail)
      || (b.lastAt - a.lastAt)
      || a.action.localeCompare(b.action)
    );
    const summaryRows = allSummaryRows.slice(0, 12);
    return {
      rpc: rpcLog.slice(-40).map((e) => {
        const ts = (e.t / 1000).toFixed(1);
        if (e.ev === "res") return `${ts}s ${e.a}=${e.s}/${e.len}b`;
        if (e.ev === "fail") return `${ts}s ${e.a}=FAIL:${e.err}`;
        return `${ts}s ${e.a}=req`;
      }),
      rpcSummary: summaryRows,
      rpcReqCount: allSummaryRows.reduce((sum, row) => sum + row.req, 0),
      rpcResCount: allSummaryRows.reduce((sum, row) => sum + row.res, 0),
      rpcFailCount: allSummaryRows.reduce((sum, row) => sum + row.fail, 0),
      rpcPendingCount: allSummaryRows.reduce((sum, row) => sum + row.pending, 0),
      rpcCapturedCount: rpcLog.length,
    };
  };
  let _rpcAttached = false;
  const _detachRpcTrace = () => {
    if (!_rpcAttached) return;
    try {
      page.off("request", _onRpcReq);
      page.off("response", _onRpcRes);
      page.off("requestfailed", _onRpcFail);
    } catch (_e) {}
    _rpcAttached = false;
  };
  try {
    page.on("request", _onRpcReq);
    page.on("response", _onRpcRes);
    page.on("requestfailed", _onRpcFail);
    _rpcAttached = true;
  } catch (_e) {}
  const writeReport = {
    attempted: true,
    openedPractice: false,
    openedOdl: false,
    odlRouteAttempted: false,
    odlRouteEffective: false,
    odlFallbackClickUsed: false,
    agenda: { attempted: false, success: false, error: null },
    tags: { attempted: false, success: false, error: null },
    notes: { attempted: hasWriteableOdlWork(job) && Boolean(job.internalNotes), success: false, error: null },
    odl: { attempted: hasWriteableOdlWork(job), success: false, error: null, sections: [] },
    materials: { attempted: false, success: false, error: null },
    parts: { attempted: false, success: false, error: null },
    waste: { attempted: false, success: false, error: null },
    hours: {
      man: { attempted: false, success: false, error: null },
      mac: { attempted: false, success: false, error: null },
    },
    verify: {
      matched: 0,
      total: 0,
    },
    debug: {
      notes: {},
      odl: {},
      sections: [],
    },
    workspaceState: WORKSPACE_STATES.UNKNOWN,
  };

  // G1 — Hard guard: scrive SOLO se il cliente contiene il marker di test
  const testMarker = (process.env.YAP_TEST_CUSTOMER_MARKER || "").trim();
  if (testMarker) {
    const customerName = String(job.customer?.name || "").trim().toLowerCase();
    if (!customerName.includes(testMarker.toLowerCase())) {
      writeReport.attempted = false;
      writeReport.odl.error = "refused_non_test_customer";
      writeReport.reason = `G1_guard: cliente "${job.customer?.name}" non corrisponde al marker "${testMarker}"`;
      _detachRpcTrace();
      return writeReport;
    }
  }

  logPhase("odl_practice", "opening");
  const practiceLink = await openPracticeFromAppointment(page, job);
  if (!practiceLink?.clicked) {
    writeReport.attempted = false;
    writeReport.reason = "practice_link_not_found";
    writeReport.practiceOpenState = practiceLink?.state || "agenda_shell";
    if (args.debug) writeReport.practiceOpenAttempts = practiceLink?.attempts || [];
    _detachRpcTrace();
    return writeReport;
  }
  writeReport.openedPractice = true;
  writeReport.practiceOpenStrategy = practiceLink.strategy || practiceLink.label || null;
  if (args.debug) writeReport.practiceDirectUrl = practiceLink.url || null;
  if (args.debug && practiceLink.loadingDone != null) writeReport.practiceOpenLoadingDone = practiceLink.loadingDone;
  if (args.debug) writeReport.practiceOpenAttempts = practiceLink.attempts || [];
  logPhase("odl_practice", "opened");
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  await waitForPracticeWorkspaceReady(page, 1800);
  const practiceLoadingDone = await waitForPracticeLoadingToFinish(page, Number(process.env.YAP_PRACTICE_LOADING_MS) || 8000);
  if (args.debug) writeReport.practiceLoadingDone = practiceLoadingDone;
  const vehicleOverlayDismissed = await dismissVehicleSearchOverlay(page);
  if (args.debug) writeReport.vehicleOverlayDismissed = vehicleOverlayDismissed;
  // F2-ter: pausa per automatismi YAP (creazione ODL in background) - adaptive, env-tunable.
  // Poll più frequente => early-exit più rapido quando l'ODL è pronto; budget ridotto perché
  // gli step ODL successivi hanno comunque i propri retry di readiness (waitForOdlWorkspaceReady).
  // Per PREVENTIVO e ORDINE DI LAVORO NON aspettiamo gli automatismi: scriviamo NOI le
  // righe (route diretta a Page=PREVENTIVO/ODL + griglia). L'attesa automatismi bruciava
  // ~77s a vuoto E faceva SCADERE LA SESSIONE (la pagina tornava al login -> ODL non
  // trovato). Stesso flusso griglia per entrambi: cambia solo pagina e tag.
  const _practiceType = String(job?.appointment?.type || "").trim().toLowerCase();
  const isGridFlow = _practiceType === "preventivo" || _practiceType === "ordine_di_lavoro";
  logPhase("automatismi_wait", isGridFlow ? "skipped_grid_flow" : "starting", { state: await getPracticeWorkspaceState(page) });
  let workspaceState = await getPracticeWorkspaceState(page);
  if (!isGridFlow) {
  let autoAttempts = 0;
  const autoPollMs = Number(process.env.YAP_AUTOMATISMI_POLL_MS) || 1000;
  // Budget aumentato a 30s (era 20s): su Railway headless/memoria limitata gli
  // automatismi YAP che creano l'ODL in background sono più lenti.
  const autoMaxMs = Math.max(4000, Number(process.env.YAP_AUTOMATISMI_MAX_MS) || 30000);
  const maxAutoAttempts = Math.ceil(autoMaxMs / autoPollMs);
  while ((workspaceState === "loading_shell" || workspaceState === "unknown") && autoAttempts < maxAutoAttempts) {
    await page.waitForTimeout(autoPollMs);
    workspaceState = await getPracticeWorkspaceState(page);
    autoAttempts++;
    // FIX: early-exit SOLO su odl_full. NON uscire su detail_form — gli automatismi
    // YAP creano l'ODL in background e ci vuole qualche secondo dopo che la pratica
    // ha mostrato il tab "Dettagli pratica". Uscire subito su detail_form significa
    // che la navigazione all'ODL fallisce perché l'ODL non esiste ancora.
    if (workspaceState === "odl_full") {
      logPhase("automatismi_early_exit", workspaceState, { attempts: autoAttempts });
      break;
    }
  }
  // Se la pratica è su detail_form, aspetta che compaia il tab "Ordini di lavoro"
  // (segnale che gli automatismi hanno creato l'ODL).
  if (workspaceState === "detail_form" || workspaceState === "practice_shell") {
    const odlBadgeWaitMs = Number(process.env.YAP_ODL_BADGE_WAIT_MS) || 15000;
    logPhase("automatismi_odl_badge", "waiting", { state: workspaceState, waitMs: odlBadgeWaitMs });
    const odlTabVisible = await page.waitForFunction(() => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 3 && r.height > 3 && s.display !== "none" && s.visibility !== "hidden";
      };
      return [...document.querySelectorAll("button, a, span, div, td")]
        .filter(isVisible)
        .some((el) => /ordini di lavoro/i.test((el.textContent || "").replace(/\s+/g, " ").trim()));
    }, null, { timeout: odlBadgeWaitMs }).then(() => true).catch(() => false);
    logPhase("automatismi_odl_badge", odlTabVisible ? "found" : "not_found", { state: workspaceState });
    if (odlTabVisible) {
      workspaceState = await getPracticeWorkspaceState(page);
    }
  }
  // Se ancora in loading/unknown, prova PIÙ reload (non uno solo). Su Railway il
  // renderer è lento o può crashare ("Target crashed"): la pratica resta bloccata
  // in loading_shell e un singolo reload spesso non basta. Ne facciamo fino a 3,
  // con attese generose e ri-attesa del tab "Ordini di lavoro". È la causa del
  // openedOdl=false / "Da ricontrollare: ODL" visto in produzione.
  let refreshAttempts = 0;
  const maxRefresh = Number(process.env.YAP_PRACTICE_REFRESH_RETRIES) || 3;
  while ((workspaceState === "loading_shell" || workspaceState === "unknown") && refreshAttempts < maxRefresh) {
    refreshAttempts += 1;
    logPhase("automatismi_refresh", "attempting", { attempt: refreshAttempts, maxRefresh });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000).catch(() => {});
    await waitForPracticeLoadingToFinish(page, Number(process.env.YAP_PRACTICE_LOADING_MS) || 12000).catch(() => {});
    await dismissVehicleSearchOverlay(page).catch(() => {});
    workspaceState = await getPracticeWorkspaceState(page);
    // Se è uscita dal loading verso la pratica, dai tempo agli automatismi ODL
    // (tab "Ordini di lavoro") e poi esci dal loop di reload.
    if (workspaceState === "detail_form" || workspaceState === "practice_shell") {
      await page.waitForFunction(() => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 3 && r.height > 3 && s.display !== "none" && s.visibility !== "hidden";
        };
        return [...document.querySelectorAll("button, a, span, div, td")]
          .filter(isVisible)
          .some((el) => /ordini di lavoro/i.test((el.textContent || "").replace(/\s+/g, " ").trim()));
      }, null, { timeout: 8000 }).catch(() => {});
      workspaceState = await getPracticeWorkspaceState(page);
      break;
    }
    if (workspaceState === "odl_full") break;
  }
  logPhase("automatismi_wait", "done", { attempts: autoAttempts, refreshAttempts, finalState: workspaceState });
  writeReport.workspaceState = workspaceState;
  if (args.debug) {
    const practiceShot = path.join(args.artifactDir, `practice-open-${job.practiceId || "payload"}-${Date.now()}.png`);
    await page.screenshot({ path: practiceShot, fullPage: true }).catch(() => {});
    writeReport.practiceScreenshot = practiceShot;
  }

  } // fine attesa automatismi (saltata per preventivo)

  // RIMOSSO (best-effort): scrittura delle "note interne pratica" tramite ricerca
  // euristica di una textarea per keyword. Il campo "Note interne (pratica)" non
  // esiste come campo YAP affidabile ed e' stato tolto anche dalla mini-app.

  // F5: guard "no veicolo" — blocca tutte le scritture ODL se la pratica è un guscio
  const noVehicle = await isPracticeShellWithoutVehicle(page);
  if (args.debug) writeReport.noVehicleDetected = noVehicle;
  if (noVehicle) {
    writeReport.odl.error = "odl_unavailable_no_vehicle";
    writeReport.ok = false;
    writeReport.workspaceState = workspaceState;
    logPhase("odl_tab", "skipped_no_vehicle");
    if (args.debug) {
      const noVehicleShot = path.join(args.artifactDir, `no-vehicle-${job.practiceId || "payload"}-${Date.now()}.png`);
      await page.screenshot({ path: noVehicleShot, fullPage: true }).catch(() => {});
      writeReport.noVehicleScreenshot = noVehicleShot;
    }
    writeReport.fields = buildFieldWriteReport(job, writeReport);
    _detachRpcTrace();
    return writeReport; // early return — niente da scrivere senza veicolo
  }
  // DIAGNOSTICA: stato pratica + tab disponibili (per mappare Preventivi/ODL e la tabella).
  logAction("practice_state", await dumpPracticeState(page));

  // F3+F4: naviga alla pagina di lavoro via hash in-place + gating su RPC.
  // PageEnum REALE (da URL YAP): preventivo -> "PREVENTIVO", ordine -> "ODL".
  // (Stessa tabella su entrambe; cambia solo la pagina e i tag.)
  let odlNavigated = false;
  const practiceUrl = page.url();
  const workPageEnum = String(job?.appointment?.type || "").trim().toLowerCase() === "preventivo"
    ? "PREVENTIVO"
    : "ODL";
  logAction("work_page", { practiceType: job?.appointment?.type || null, pageEnum: workPageEnum });
  writeReport.debug.odl = {
    routeAttempted: false,
    routeResult: null,
    fallbackAttempts: [],
    topCandidatesBeforeRetry: [],
    topCandidates: [],
    workspaceStateBefore: workspaceState,
    workspaceStateAfter: null,
    urlAfterRoute: null,
    urlAfterOdl: null,
  };
  if (/#!pratica/i.test(practiceUrl)) {
    writeReport.odlRouteAttempted = true;
    writeReport.debug.odl.routeAttempted = true;
    const odlRpcWaitMs = Number(process.env.YAP_ODL_RPC_WAIT_MS) || 8000;
    // Gate su RPC: per ODL fira un *Odl*Action, per il PREVENTIVO un *Preventiv*Action.
    // Prima il regex matchava solo Odl -> sul preventivo andava in timeout (8s persi ogni
    // volta, rpcReady=false). Ora gattiamo sull'RPC giusto in base alla pagina.
    const odlReadyPromise = page.waitForResponse(
      (r) => /\/yap\/action\/[^/]*(Odl|Preventiv)[^/]*Action/i.test(r.url()) && r.status() === 200,
      { timeout: odlRpcWaitMs },
    ).then(() => true).catch(() => false);
    const routeResult = await openOdlByRoute(page, practiceUrl, workPageEnum);
    if (args.debug) writeReport.odlRouteResult = routeResult;
    writeReport.debug.odl.routeResult = routeResult;
    logPhase("odl_route", routeResult.navigated ? "navigated" : "failed", { reason: routeResult.reason, idCompanyFolder: routeResult.idCompanyFolder });
    if (routeResult.navigated) {
      logPhase("odl_tab", "route_navigated", { idCompanyFolder: routeResult.idCompanyFolder });
      const routeUnsavedConfirmed = await confirmUnsavedChangesIfPresent(page);
      writeReport.debug.odl.routeUnsavedConfirmed = routeUnsavedConfirmed;
      const odlRpcReady = await odlReadyPromise;
      if (args.debug) writeReport.odlRpcReady = odlRpcReady;
      writeReport.debug.odl.odlRpcReady = odlRpcReady;
      logPhase("odl_route", "waiting_ready", { rpcReady: odlRpcReady });
      await waitForOdlWorkspaceReady(page, Number(process.env.YAP_ODL_DOM_WAIT_MS) || 6000);
      await page.waitForTimeout(400);
      workspaceState = await getPracticeWorkspaceState(page);
      // DIAGNOSTICA: DOM della pagina di lavoro dopo la navigazione (Preventivo/ODL):
      // tab + input della tabella, per mappare i campi precisi.
      logAction("work_page_state", { pageEnum: workPageEnum, ...(await dumpPracticeState(page)) });
      // Attesa che "Recupero dettagli pratica in corso..." finisca dopo la route ODL.
      // Alzato da 10 a 25 tentativi (8s -> 20s): su link lento la RPC dei dettagli
      // pratica di YAP può metterci di più; con EU+RAM esce comunque presto (early-exit
      // appena lo stato diventa effettivo). Tunabile via YAP_ODL_WAIT_ATTEMPTS.
      let odlWaitAttempts = 0;
      const maxOdlWaitAttempts = Number(process.env.YAP_ODL_WAIT_ATTEMPTS) || 8;
      while ((workspaceState === WORKSPACE_STATES.LOADING || workspaceState === WORKSPACE_STATES.UNKNOWN || workspaceState === WORKSPACE_STATES.ODL_LOADING) && odlWaitAttempts < maxOdlWaitAttempts) {
        await page.waitForTimeout(800);
        workspaceState = await getPracticeWorkspaceState(page);
        odlWaitAttempts++;
      }
      if (args.debug) writeReport.odlWaitAttempts = odlWaitAttempts;
      writeReport.debug.odl.odlWaitAttempts = odlWaitAttempts;
      writeReport.workspaceState = workspaceState;
      writeReport.debug.odl.workspaceStateAfter = workspaceState;
      const urlAfterRoute = page.url();
      writeReport.urlAfterOdlRoute = urlAfterRoute;
      writeReport.debug.odl.urlAfterRoute = urlAfterRoute;
      const parsedAfterRoute = parsePraticaHashPayload(urlAfterRoute);
      writeReport.pageEnumAfterRoute = parsedAfterRoute.pageEnum ?? (parsedAfterRoute.ok ? "no_page_field" : parsedAfterRoute.reason);
      writeReport.debug.odl.pageEnumAfterRoute = writeReport.pageEnumAfterRoute;
      // FLUSSO GRIGLIA — PREVENTIVO e ORDINE DI LAVORO: scriviamo NOI le righe nella
      // griglia documento (stessa tabella, cambia solo pagina/tag). Salta il vecchio
      // flusso keyword ODL + l'attesa automatismi. Al termine RITORNA SUBITO.
      if (workPageEnum === "PREVENTIVO" || workPageEnum === "ODL") {
        const docKind = workPageEnum === "ODL" ? "odl" : "preventivo";
        const docLabel = workPageEnum === "ODL" ? "Ordine di lavoro" : "Preventivo";
        writeReport.workPage = workPageEnum;
        logAction("grid_flow_entry", {
          docKind,
          workspaceState,
          url: page.url().slice(0, 180),
          pageEnumAfterRoute: writeReport.pageEnumAfterRoute,
        });
        logAction("grid_flow_snapshot_entry", await snapshotWorkGrid(page));
        const gridResult = await writeWorkGrid(page, job, args).catch((e) => ({ ok: false, error: e?.message }));
        if (gridResult && typeof gridResult === "object") gridResult.docKind = docKind;
        writeReport.gridResult = gridResult;
        const manOk = Boolean(gridResult?.manodopera?.articolo);
        const manExpected = Boolean(gridResult?.manodopera?.expected);
        const expectedRows = (gridResult?.righe || []).length;
        const persistedRows = (gridResult?.righe || []).filter((r) => r.written).length;
        const docSaved = Boolean(gridResult?.saved?.ok);
        let extraFieldsResult = { attempted: false, wroteAny: false };
        if (docSaved) {
          extraFieldsResult = await writeGridFlowExtraFields(page, job, writeReport, args).catch((e) => ({ attempted: true, wroteAny: false, error: e?.message || String(e) }));
        }
        const materialsExpected = (job.sections || []).some((section) => section?.materiali_euro != null);
        const materialsOk = !materialsExpected || Boolean(writeReport?.materials?.success);
        const wasteExpected = (job.sections || []).some((section) => section?.smaltimento_applica);
        const wastePercentOk = !wasteExpected || Boolean(writeReport?.waste?.success);
        const wasteAmountExpected = (job.sections || []).some((section) => sectionWasteAmount(section) != null);
        const wasteAmountOk = !wasteAmountExpected || Boolean(writeReport?.waste?.amountSuccess ?? writeReport?.waste?.success);
        const gridOk = Boolean(gridResult?.ok)
          && docSaved
          && (!manExpected || manOk)
          && persistedRows === expectedRows
          && materialsOk
          && wastePercentOk
          && wasteAmountOk;
        logAction("grid_flow_result", {
          docKind,
          workPage: writeReport.workPage,
          pageEnumAfterRoute: writeReport.pageEnumAfterRoute,
          ok: gridOk,
          reason: gridResult?.reason || gridResult?.error || null,
          manodoperaExpected: manExpected,
          manodopera: manOk,
          descrizioniPersisted: persistedRows,
          descrizioniExpected: expectedRows,
          saved: docSaved,
          materialsExpected,
          materials: materialsOk,
          wasteExpected,
          wastePercent: wastePercentOk,
          wasteAmountExpected,
          wasteAmount: wasteAmountOk,
          extraFields: extraFieldsResult,
          rowKinds: (gridResult?.righe || []).map((r) => ({
            kind: r.kind,
            reparto: r.reparto,
            tipo: r.tipo,
            article: Boolean(r.article),
            written: Boolean(r.written),
            existing: Boolean(r.existing),
          })),
        });
        if (gridOk) { writeReport.openedOdl = true; writeReport.odl.success = true; writeReport.odl.error = null; }
        writeReport.ok = gridOk;
        writeReport.workspaceState = workspaceState;
        // Campi ONESTI del documento (da gridResult), prefisso per tipo (preventivo/odl).
        const pf = [];
        if (manExpected) {
          pf.push({
            field_id: `${docKind}.manodopera`, expected: "MAN",
            found: manOk ? "MAN" : null, status: manOk ? "written" : "missing",
            hint: `${docLabel} > riga MANODOPERA (MAN).`,
          });
        }
        for (const r of (gridResult?.righe || [])) {
          pf.push({
            field_id: `${docKind}.${r.kind}`, expected: r.text,
            found: r.written ? r.text : null, status: r.written ? "written" : "missing",
            hint: `${docLabel} > righe descrittive (Tipo D).`,
          });
        }
        pf.push({
          field_id: `${docKind}.salvataggio`, expected: "documento salvato",
          found: docSaved ? "salvato" : null, status: docSaved ? "written" : "missing",
          hint: `${docLabel} > pulsante Salva.`,
        });
        for (const section of (job.sections || [])) {
          const reparto = String(section?.reparto || "").trim().toLowerCase() || "reparto";
          if (section.materiali_euro != null) {
            const matExpected = String(section.materiali_euro);
            const matOk = Boolean(writeReport?.materials?.success);
            pf.push({
              field_id: `${docKind}.${reparto}.materiali`,
              expected: matExpected,
              found: matOk ? matExpected : null,
              status: matOk ? "written" : "missing",
              hint: `${docLabel} > Materiali di consumo.`,
            });
          }
          if (section.smaltimento_applica) {
            const wasteExpectedValue = String(section.smaltimento_percentuale ?? 2);
            const wasteOk = Boolean(writeReport?.waste?.success);
            pf.push({
              field_id: `${docKind}.${reparto}.smaltimento`,
              expected: wasteExpectedValue,
              found: wasteOk ? wasteExpectedValue : null,
              status: wasteOk ? "written" : "missing",
              hint: `${docLabel} > Smaltimento rifiuti.`,
            });
            const wasteAmount = sectionWasteAmount(section);
            if (wasteAmount != null) {
              const wasteAmountExpectedValue = formatGridAmount(wasteAmount);
              const wasteAmountWritten = Boolean(writeReport?.waste?.amountSuccess ?? writeReport?.waste?.success);
              pf.push({
                field_id: `${docKind}.${reparto}.smaltimento_importo`,
                expected: wasteAmountExpectedValue,
                found: wasteAmountWritten ? wasteAmountExpectedValue : null,
                status: wasteAmountWritten ? "written" : "missing",
                hint: `${docLabel} > Smaltimento rifiuti importo.`,
              });
            }
          }
        }
        writeReport.fields = pf;
        logPhase("grid_write", gridOk ? "done" : "failed", {
          docKind,
          manodoperaExpected: manExpected,
          manodopera: manOk,
          rows: `${persistedRows}/${expectedRows}`,
          materials: materialsOk ? "ok" : (materialsExpected ? "fail" : "skip"),
          waste: wastePercentOk ? "ok" : (wasteExpected ? "fail" : "skip"),
          wasteAmount: wasteAmountOk ? "ok" : (wasteAmountExpected ? "fail" : "skip"),
        });
        _detachRpcTrace();
        return writeReport;
      }
      if (isEffectiveOdlState(workspaceState)) {
        odlNavigated = true;
        writeReport.odlRouteEffective = true;
        writeReport.openedOdl = true;
        writeReport.debug.odl.routeEffective = true;
      } else {
        writeReport.odlRouteEffective = false;
        writeReport.odl.error = "odl_route_ineffective";
        writeReport.odlRouteReason = `state_after_route:${workspaceState}`;
        writeReport.debug.odl.routeEffective = false;
        writeReport.debug.odl.routeReason = writeReport.odlRouteReason;
        logPhase("odl_route", "ineffective", { workspaceState, pageEnum: writeReport.pageEnumAfterRoute });
      }
    } else {
      writeReport.odlRouteReason = routeResult.reason || "odl_route_failed";
      writeReport.debug.odl.routeReason = writeReport.odlRouteReason;
    }
  }

  // Fallback: click sul tab (se la route non era disponibile o la navigazione è fallita)
  if (!odlNavigated) {
    writeReport.odlFallbackClickUsed = true;
    let odlTab = null;
    const fallbackAttempts = [];
    const gwtTabAttempt = await activateOdlTopTab(page);
    writeReport.debug.odl.gwtTabAttempt = gwtTabAttempt;
    if (gwtTabAttempt?.clicked) {
      odlTab = { clicked: true, label: gwtTabAttempt.label || "gwt:ordini_di_lavoro" };
      fallbackAttempts.push(odlTab.label);
      logPhase("odl_tab", "gwt_clicked", { label: odlTab.label, score: gwtTabAttempt.score });
      const gwtUnsavedConfirmed = await confirmUnsavedChangesIfPresent(page);
      writeReport.debug.odl.gwtUnsavedConfirmed = gwtUnsavedConfirmed;
    }
    for (let candidateIndex = 0; candidateIndex < 3 && !odlTab?.clicked; candidateIndex += 1) {
      let currentAttempt = await clickOdlSection(page, { candidateIndex, maxY: 220 });
      if (!currentAttempt?.clicked) {
        if (args.debug && candidateIndex === 0) writeReport.odlTopCandidatesBeforeRetry = await snapshotTopOdlCandidates(page);
        await dismissVehicleSearchOverlay(page);
        await page.waitForTimeout(200);
        currentAttempt = await clickOdlSection(page, { candidateIndex, maxY: 240 });
      }
      fallbackAttempts.push(currentAttempt?.label || `candidate_${candidateIndex}`);
      if (currentAttempt?.clicked) {
        if (candidateIndex > 0) {
          logPhase("odl_tab", "retry_candidate", { candidateIndex, label: currentAttempt.label });
        }
        odlTab = currentAttempt;
      }
    }
    if (args.debug) writeReport.odlFallbackAttempts = fallbackAttempts;
    writeReport.debug.odl.fallbackAttempts = fallbackAttempts;
    if (!odlTab?.clicked) {
      const fallbackOdl = page.locator("button, a, [role='button'], .gwt-Label, span, div, td").filter({ hasText: /ordini di lavoro|\bodl\b/i }).first();
      if (await fallbackOdl.count()) {
        await fallbackOdl.click().catch(() => {});
        odlTab = { clicked: true, label: "fallback:odl" };
      }
    }
    if (odlTab?.clicked) {
      if (args.debug) writeReport.odlTopCandidates = await snapshotTopOdlCandidates(page);
      writeReport.debug.odl.topCandidates = await snapshotTopOdlCandidates(page);
      logPhase("odl_tab", "click_opened", { label: odlTab.label });
      await waitForOdlWorkspaceReady(page, 10000);
      workspaceState = await getPracticeWorkspaceState(page);
      writeReport.debug.odl.workspaceStateAfter = workspaceState;
      if (!isEffectiveOdlState(workspaceState)) {
        // FIX: dopo il click sul tab "Ordini di lavoro", YAP mostra la LISTA degli ODL,
        // non il form direttamente. Bisogna cliccare il primo ODL della lista.
        logPhase("odl_tab", "trying_list_entry", { state: workspaceState });
        const listEntryResult = await openFirstOdlEntryFromList(page);
        writeReport.debug.odl.listEntryAttempt = listEntryResult;
        logPhase("odl_tab", listEntryResult?.clicked ? "list_entry_clicked" : "list_entry_not_found", { strategy: listEntryResult?.strategy, text: listEntryResult?.text?.slice(0, 60) });
        if (listEntryResult?.clicked) {
          await waitForOdlWorkspaceReady(page, 8000);
          workspaceState = await getPracticeWorkspaceState(page);
          writeReport.debug.odl.workspaceStateAfter = workspaceState;
        }
      }
      if (!isEffectiveOdlState(workspaceState)) {
        await dismissVehicleSearchOverlay(page);
        const secondOdl = await clickOdlSection(page, { candidateIndex: 1, maxY: 240, returnDebug: true });
        if (secondOdl?.clicked) {
          logPhase("odl_tab", "click_hop2", { label: secondOdl.label });
          const hopUnsavedConfirmed = await confirmUnsavedChangesIfPresent(page);
          writeReport.debug.odl.hopUnsavedConfirmed = hopUnsavedConfirmed;
          await waitForOdlWorkspaceReady(page, 10000);
          workspaceState = await getPracticeWorkspaceState(page);
          writeReport.debug.odl.workspaceStateAfter = workspaceState;
          writeReport.debug.odl.secondAttempt = secondOdl.debug || null;
        }
      }
      writeReport.workspaceState = workspaceState;
      if (isEffectiveOdlState(workspaceState)) {
        odlNavigated = true;
        writeReport.openedOdl = true;
        writeReport.odl.error = null;
      } else if (writeReport.odl.attempted) {
        writeReport.odl.error = "odl_tab_ineffective";
        logPhase("odl_tab", "ineffective", { workspaceState });
      }
    } else if (writeReport.odl.attempted) {
      writeReport.odl.error = writeReport.odl.error || "odl_tab_not_found";
      logPhase("odl_tab", "not_found");
    }
  }

  // RECOVERY FINALE apertura ODL: se l'ODL non si è aperto e la pratica è ancora in
  // loading/unknown (tipico su Railway: renderer lento o "Target crashed"), RICARICA
  // la pratica e ritenta l'intera apertura ODL (route -> tab -> primo ODL della lista).
  // È l'ultima rete di sicurezza che evita "openedOdl=false / Da ricontrollare: ODL"
  // quando in locale la stessa scrittura riesce. Abbiamo budget: un sync sta ~63s su
  // ~210s disponibili, quindi possiamo permetterci 1-2 reload extra.
  // BUDGET DI TEMPO: il backend killa il worker al timeout (210s). Su Railway lento
  // ogni iterazione di recovery puo' costare 50-70s: senza guardia il worker viene
  // ucciso DENTRO il recovery, perdendo la diagnostica (era il caso "phases si fermano
  // a odl_route:failed"). Qui ci fermiamo se manca il tempo, così la diagnostica
  // odl_open_failed parte sempre e il worker ritorna pulito prima del kill.
  // Budget per la recovery ODL: alzato da 150s a 195s. Il worker ha 230s di timeout,
  // quindi tra 150s e 230s c'erano 80s di budget INUTILIZZATO: con un avvio lento
  // (es. doppio re-login) la recovery veniva saltata ("skipped_no_time_budget")
  // pur essendoci ancora tempo utile. 195s lascia comunque ~35s di margine di chiusura.
  if (!odlNavigated && /#!pratica/i.test(page.url())) {
    writeReport.odlFullReloadAttempted = true;
    writeReport.debug.odl.fullReloadAttempted = true;
    const fullReloadRpcMs = Number(process.env.YAP_ODL_FULL_RELOAD_RPC_WAIT_MS) || 12000;
    const fullReloadRpcReadyPromise = page.waitForResponse(
      (r) => /\/yap\/action\/[^/]*Odl[^/]*Action/i.test(r.url()) && r.status() === 200,
      { timeout: fullReloadRpcMs },
    ).then(() => true).catch(() => false);
    logPhase("odl_full_reload", "attempting", { state: workspaceState, url: page.url().slice(0, 120) });
    const fullReloadResult = await openOdlByFullReload(page, page.url(), workPageEnum).catch((error) => ({
      attempted: true,
      navigated: false,
      reason: String(error?.message || error || "error"),
    }));
    writeReport.debug.odl.fullReloadResult = fullReloadResult;
    logPhase("odl_full_reload", fullReloadResult?.navigated ? "navigated" : "failed", { reason: fullReloadResult?.reason, idCompanyFolder: fullReloadResult?.idCompanyFolder });
    const fullReloadUnsavedConfirmed = await confirmUnsavedChangesIfPresent(page);
    writeReport.debug.odl.fullReloadUnsavedConfirmed = fullReloadUnsavedConfirmed;
    const fullReloadRpcReady = await fullReloadRpcReadyPromise;
    writeReport.debug.odl.fullReloadRpcReady = fullReloadRpcReady;
    if (args.debug) writeReport.odlFullReloadRpcReady = fullReloadRpcReady;
    await waitForOdlWorkspaceReady(page, Number(process.env.YAP_ODL_FULL_RELOAD_DOM_WAIT_MS) || 10000).catch(() => {});
    workspaceState = await getPracticeWorkspaceState(page);
    writeReport.workspaceState = workspaceState;
    writeReport.debug.odl.workspaceStateAfterFullReload = workspaceState;
    if (!isEffectiveOdlState(workspaceState)) {
      const fullReloadTab = await activateOdlTopTab(page).catch(() => ({ clicked: false }));
      writeReport.debug.odl.fullReloadGwtTabAttempt = fullReloadTab;
      if (fullReloadTab?.clicked) {
        logPhase("odl_full_reload", "gwt_clicked", { label: fullReloadTab.label, score: fullReloadTab.score });
        const fullReloadClickUnsavedConfirmed = await confirmUnsavedChangesIfPresent(page);
        writeReport.debug.odl.fullReloadClickUnsavedConfirmed = fullReloadClickUnsavedConfirmed;
        await waitForOdlWorkspaceReady(page, Number(process.env.YAP_ODL_FULL_RELOAD_DOM_WAIT_MS) || 10000).catch(() => {});
        workspaceState = await getPracticeWorkspaceState(page);
        writeReport.workspaceState = workspaceState;
        writeReport.debug.odl.workspaceStateAfterFullReloadClick = workspaceState;
      }
    }
    if (!isEffectiveOdlState(workspaceState)) {
      const fullReloadEntry = await openFirstOdlEntryFromList(page).catch(() => ({ clicked: false, strategy: "error" }));
      writeReport.debug.odl.fullReloadListEntryAttempt = fullReloadEntry;
      if (fullReloadEntry?.clicked) {
        logPhase("odl_full_reload", "list_entry_clicked", { strategy: fullReloadEntry.strategy, text: fullReloadEntry.text?.slice(0, 60) });
        await waitForOdlWorkspaceReady(page, 8000).catch(() => {});
        workspaceState = await getPracticeWorkspaceState(page);
        writeReport.workspaceState = workspaceState;
        writeReport.debug.odl.workspaceStateAfterFullReloadEntry = workspaceState;
      }
    }
    if (isEffectiveOdlState(workspaceState)) {
      odlNavigated = true;
      writeReport.openedOdl = true;
      writeReport.odl.error = null;
      writeReport.odlFullReloadEffective = true;
      writeReport.debug.odl.fullReloadEffective = true;
      logPhase("odl_full_reload", "recovered", { rpcReady: fullReloadRpcReady });
    } else {
      writeReport.odl.error = writeReport.odl.error || "odl_full_reload_ineffective";
      writeReport.debug.odl.fullReloadEffective = false;
      logPhase("odl_full_reload", "ineffective", { state: workspaceState, rpcReady: fullReloadRpcReady });
    }
  }

  const ODL_RECOVERY_DEADLINE_MS = Number(process.env.YAP_ODL_RECOVERY_DEADLINE_MS) || 205000;
  const recoveryHasBudget = () => (Date.now() - _workerStart) < ODL_RECOVERY_DEADLINE_MS;
  if (
    writeReport.odl.attempted
    && !writeReport.openedOdl
    && (workspaceState === WORKSPACE_STATES.LOADING
      || workspaceState === WORKSPACE_STATES.UNKNOWN
      || workspaceState === WORKSPACE_STATES.ODL_LOADING)
  ) {
    const maxOdlRecovery = Number(process.env.YAP_ODL_RECOVERY_RETRIES) || (writeReport.odlFullReloadAttempted ? 0 : 2);
    if (!recoveryHasBudget()) {
      logPhase("odl_recovery", "skipped_no_time_budget", { elapsed_ms: Date.now() - _workerStart, deadline_ms: ODL_RECOVERY_DEADLINE_MS });
    }
    for (let rec = 1; rec <= maxOdlRecovery && !writeReport.openedOdl && recoveryHasBudget(); rec += 1) {
      logPhase("odl_recovery", "attempting", { attempt: rec, maxOdlRecovery, state: workspaceState, elapsed_ms: Date.now() - _workerStart });
      // Torna alla pratica (ricarica l'URL #!pratica catturato prima).
      if (practiceUrl && /#!pratica/i.test(practiceUrl)) {
        await page.goto(practiceUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      } else {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      }
      await page.waitForTimeout(2500).catch(() => {});
      await waitForPracticeLoadingToFinish(page, Number(process.env.YAP_PRACTICE_LOADING_MS) || 12000).catch(() => {});
      await dismissVehicleSearchOverlay(page).catch(() => {});
      // Dai tempo agli automatismi di (ri)creare l'ODL.
      await page.waitForFunction(() => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 3 && r.height > 3 && s.display !== "none" && s.visibility !== "hidden";
        };
        return [...document.querySelectorAll("button, a, span, div, td")]
          .filter(isVisible)
          .some((el) => /ordini di lavoro/i.test((el.textContent || "").replace(/\s+/g, " ").trim()));
      }, null, { timeout: 10000 }).catch(() => {});
      // Ritenta apertura: prima la route diretta, poi il click sul tab + primo ODL.
      const recRoute = await openOdlByRoute(page, page.url(), workPageEnum).catch(() => ({ navigated: false }));
      if (recRoute?.navigated) {
        await waitForOdlWorkspaceReady(page, 12000).catch(() => {});
      } else {
        const recTab = await clickOdlSection(page, { candidateIndex: 0, maxY: 240 }).catch(() => null);
        if (recTab?.clicked) {
          await waitForOdlWorkspaceReady(page, 10000).catch(() => {});
          if (!isEffectiveOdlState(await getPracticeWorkspaceState(page))) {
            await openFirstOdlEntryFromList(page).catch(() => {});
            await waitForOdlWorkspaceReady(page, 8000).catch(() => {});
          }
        }
      }
      workspaceState = await getPracticeWorkspaceState(page);
      writeReport.workspaceState = workspaceState;
      if (isEffectiveOdlState(workspaceState)) {
        odlNavigated = true;
        writeReport.openedOdl = true;
        writeReport.odl.error = null;
        writeReport.odlRecovered = true;
        logPhase("odl_recovery", "recovered", { attempt: rec });
      } else {
        logPhase("odl_recovery", "still_ineffective", { attempt: rec, state: workspaceState });
      }
    }
  }

  // DIAGNOSTICA ODL FALLITO: se l'ODL non si è aperto, cattura uno snapshot dello
  // stato REALE della pagina (gira SEMPRE, anche senza --debug, perché in produzione
  // serve a capire la causa). Finisce nei worker_phases (stderr) e nel write_report,
  // così il "Crash log YAP" mostra perché è andato storto invece di restare vuoto.
  if (writeReport.odl.attempted && !writeReport.openedOdl) {
    const diag = await safeEvaluate(page, () => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden";
      };
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const all = [...document.querySelectorAll("button, a, span, div, td")].filter(isVisible);
      const loadingTexts = [...new Set(all
        .map((el) => norm(el.textContent))
        .filter((t) => t && t.length < 60 && /caricamento|loading|attendere|in corso|recupero/i.test(t)))].slice(0, 6);
      const topTabs = [...new Set(all
        .filter((el) => /gwt-TabLayoutPanelTab/.test(String(el.className || "")))
        .map((el) => norm(el.textContent))
        .filter(Boolean))].slice(0, 14);
      const dialogTexts = [...new Set([...document.querySelectorAll(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel")]
        .filter(isVisible)
        .map((el) => norm(el.textContent))
        .filter((t) => t && t.length < 220))].slice(0, 5);
      const hasOrdiniLavoro = all.some((el) => /ordini di lavoro/i.test(norm(el.textContent)));
      const hasOdlSubTabs = all.some((el) => /descrizione danni|materiali di consumo|smaltimento rifiuti/i.test(norm(el.textContent)));
      const bodyExcerpt = norm(document.body?.innerText || "").slice(0, 400);
      return { ok: true, loadingTexts, topTabs, dialogTexts, hasOrdiniLavoro, hasOdlSubTabs, bodyExcerpt };
    }).catch((e) => ({ ok: false, evalError: String(e && e.message || e) }));
    const urlNow = page.url();
    const parsedNow = parsePraticaHashPayload(urlNow);
    const odlDiagnostic = {
      odlError: writeReport.odl.error || null,
      workspaceState,
      // pageResponsive=false => l'evaluate è fallito = renderer probabilmente crashato
      // ("Target crashed") o pagina morta: è il segnale chiave per Railway.
      pageResponsive: Boolean(diag && diag.ok),
      evalError: diag && diag.ok ? null : (diag && diag.evalError) || "unknown",
      loadingTexts: (diag && diag.loadingTexts) || [],
      dialogTexts: (diag && diag.dialogTexts) || [],
      hasOrdiniLavoroTab: Boolean(diag && diag.hasOrdiniLavoro),
      hasOdlSubTabs: Boolean(diag && diag.hasOdlSubTabs),
      topTabs: (diag && diag.topTabs) || [],
      refreshAttempts: typeof refreshAttempts === "number" ? refreshAttempts : null,
      odlFallbackClickUsed: Boolean(writeReport.odlFallbackClickUsed),
      url: urlNow.slice(0, 120),
      pageEnum: parsedNow.pageEnum ?? (parsedNow.ok ? "no_page_field" : parsedNow.reason),
      bodyExcerpt: (diag && diag.bodyExcerpt) || "",
      ..._rpcSnapshot(),
    };
    writeReport.odlDiagnostic = odlDiagnostic;
    logPhase("odl_open_failed", "diagnostic", odlDiagnostic);
  }

  if (args.debug) {
    const odlShot = path.join(args.artifactDir, `odl-open-${job.practiceId || "payload"}-${Date.now()}.png`);
    await page.screenshot({ path: odlShot, fullPage: true }).catch(() => {});
    writeReport.odlScreenshot = odlShot;
    writeReport.workspaceState = workspaceState;
    const urlFinal = page.url();
    writeReport.urlAfterOdl = urlFinal;
    const parsedFinalRoute = parsePraticaHashPayload(urlFinal);
    writeReport.pageEnumAfterOdl = parsedFinalRoute.pageEnum ?? (parsedFinalRoute.ok ? "no_page_field" : parsedFinalRoute.reason);
    if (!odlNavigated) {
      const noOdlShot = path.join(args.artifactDir, `odl-not-found-${job.practiceId || "payload"}-${Date.now()}.png`);
      await page.screenshot({ path: noOdlShot, fullPage: true }).catch(() => {});
      writeReport.odlNotFoundScreenshot = noOdlShot;
    }
  }

  // RIMOSSO (best-effort): in precedenza qui si scriveva un "riassunto ODL" dentro
  // una textarea individuata euristicamente per keyword (writeStructuredBlockToBestEditable
  // / appendStructuredBlockToAnyTextarea). Non era un campo YAP affidabile: poteva
  // finire nella casella sbagliata. I dati reali dell'ODL vengono scritti campo per
  // campo qui sotto (descrizioni, MAN/MAC, materiali, ricambi). Niente piu' dump.

  logPhase("odl_sections", "starting", { count: (job.sections || []).length });
  for (const section of job.sections || []) {
    const reparto = String(section.reparto || "").trim();
    // Su YAP non esiste la sezione "carrozzeria": si naviga/compila "pneumatici".
    const yapReparto = yapRepartoForOdl(reparto);
    // Keyword di reparto da provare nei campi ODL: prima l'alias YAP, poi il reparto Giorgio.
    const repartoKeys = [...new Set([yapReparto, reparto].filter(Boolean))];
    if (reparto) {
      await clickRepartoSection(page, yapReparto).catch(() => false);
      if (yapReparto !== reparto) {
        await clickRepartoSection(page, reparto).catch(() => false);
      }
      await page.waitForTimeout(60);
    }
    const sectionDebug = args.debug ? {
      reparto,
      yapReparto,
      summaryLength: 0,
      summaryPreview: "",
      fields: {},
    } : null;
    const sectionSummaryParts = [];
    if (job.internalNotes && !writeReport.notes.success && writeReport.odl.sections.length === 0) {
      sectionSummaryParts.push(`Note interne: ${String(job.internalNotes).trim()}`);
    }
    sectionSummaryParts.push(buildSectionSummary(section));
    const sectionSummary = sectionSummaryParts.join("\n");
    if (sectionDebug) {
      sectionDebug.summaryLength = sectionSummary.length;
      sectionDebug.summaryPreview = sectionSummary.slice(0, 180);
    }
    const sectionWrittenResult = await fillWithRetry(
      page,
      [
        [...repartoKeys, "descrizione", "lavoro", "odl", "intervento", "note reparto"],
        [...repartoKeys, "odl", "descrizione"],
        [...repartoKeys, "lavoro", "intervento"],
      ],
      sectionSummary,
      { append: true },
      { debug: args.debug, fieldId: `odl.${reparto}.descrizione`, returnDebug: args.debug },
    );
    const sectionWritten = Boolean(sectionWrittenResult?.ok ?? sectionWrittenResult);
    if (sectionDebug) {
      sectionDebug.fields.descrizione = sectionWrittenResult?.debug || null;
    }
    writeReport.odl.sections.push({ reparto, yapReparto, written: sectionWritten });
    writeReport.odl.success = writeReport.odl.success || sectionWritten;

    if (section.ore_man != null) {
      writeReport.hours.man.attempted = true;
      const manOkResult = await fillWithRetry(
        page,
        [
          [...repartoKeys, "man", "ore uomo", "manodopera"],
          [...repartoKeys, "manodopera", "man"],
          [...repartoKeys, "ore uomo", "man"],
        ],
        String(section.ore_man),
        {},
        { debug: args.debug, fieldId: `odl.${reparto}.man`, returnDebug: args.debug },
      );
      const manOk = Boolean(manOkResult?.ok ?? manOkResult);
      writeReport.hours.man.success = writeReport.hours.man.success || manOk;
      if (!manOk && !writeReport.hours.man.error) writeReport.hours.man.error = "man_field_not_found";
      if (sectionDebug) sectionDebug.fields.man = manOkResult?.debug || null;
      writeReport.odl.success = writeReport.odl.success || manOk;
    }
    if (section.ore_mac != null) {
      writeReport.hours.mac.attempted = true;
      const macOkResult = await fillWithRetry(
        page,
        [
          [...repartoKeys, "mac", "ore macchina", "manodopera"],
          [...repartoKeys, "manodopera", "mac"],
          [...repartoKeys, "ore macchina", "mac"],
        ],
        String(section.ore_mac),
        {},
        { debug: args.debug, fieldId: `odl.${reparto}.mac`, returnDebug: args.debug },
      );
      const macOk = Boolean(macOkResult?.ok ?? macOkResult);
      writeReport.hours.mac.success = writeReport.hours.mac.success || macOk;
      if (!macOk && !writeReport.hours.mac.error) writeReport.hours.mac.error = "mac_field_not_found";
      if (sectionDebug) sectionDebug.fields.mac = macOkResult?.debug || null;
      writeReport.odl.success = writeReport.odl.success || macOk;
    }
    if (section.materiali_euro != null) {
      writeReport.materials.attempted = true;
      const matOkResult = await fillWithRetry(
        page,
        [
          [...repartoKeys, "materiali", "consumo", "euro"],
          [...repartoKeys, "materiali di consumo", "materiali"],
          [...repartoKeys, "materiali"],
        ],
        String(section.materiali_euro),
        {},
        { debug: args.debug, fieldId: `odl.${reparto}.materiali`, returnDebug: args.debug },
      );
      const matOk = Boolean(matOkResult?.ok ?? matOkResult);
      writeReport.materials.success = writeReport.materials.success || matOk;
      if (!matOk && !writeReport.materials.error) writeReport.materials.error = "materials_field_not_found";
      if (sectionDebug) sectionDebug.fields.materiali = matOkResult?.debug || null;
    }
    if (section.smaltimento_applica) {
      writeReport.waste.attempted = true;
      const wasteDetails = sectionWasteDetails(section);
      logAction("waste_calc", wasteDetails || {
        reparto,
        percent: section?.smaltimento_percentuale ?? 2,
        subtotal: null,
        amount: null,
        reason: "missing_numeric_basis",
      });
      const smaltOkResult = await fillWithRetry(
        page,
        [
          [...repartoKeys, "smaltimento", "rifiuti", "%"],
          [...repartoKeys, "smaltimento rifiuti", "smaltimento"],
          [...repartoKeys, "rifiuti", "percentuale"],
        ],
        String(section.smaltimento_percentuale ?? 2),
        {},
        { debug: args.debug, fieldId: `odl.${reparto}.smaltimento`, returnDebug: args.debug },
      );
      const smaltOk = Boolean(smaltOkResult?.ok ?? smaltOkResult);
      writeReport.waste.success = writeReport.waste.success || smaltOk;
      if (!smaltOk && !writeReport.waste.error) writeReport.waste.error = "waste_field_not_found";
      if (sectionDebug) sectionDebug.fields.smaltimento = smaltOkResult?.debug || null;

      const smaltAmount = sectionWasteAmount(section);
      if (smaltAmount != null) {
        writeReport.waste.amountAttempted = true;
        const smaltAmountText = formatGridAmount(smaltAmount);
        logAction("waste_amount_write", {
          reparto,
          amount: smaltAmountText,
          percent: wasteDetails?.percent ?? null,
          subtotal: wasteDetails?.subtotal ?? null,
        });
        const smaltAmountResult = await fillWithRetry(
          page,
          [
            [...repartoKeys, "smaltimento", "importo"],
            [...repartoKeys, "smaltimento", "prezzo"],
            [...repartoKeys, "smaltimento", "euro"],
            [...repartoKeys, "smaltimento rifiuti", "importo"],
            [...repartoKeys, "smaltimento rifiuti", "prezzo"],
            [...repartoKeys, "rifiuti", "totale"],
          ],
          smaltAmountText,
          {},
          { debug: args.debug, fieldId: `odl.${reparto}.smaltimento_importo`, returnDebug: args.debug },
        );
        const smaltAmountOk = Boolean(smaltAmountResult?.ok ?? smaltAmountResult);
        writeReport.waste.amountSuccess = writeReport.waste.amountSuccess || smaltAmountOk;
        writeReport.waste.success = writeReport.waste.success || smaltAmountOk;
        if (!smaltAmountOk && !writeReport.waste.amountError) writeReport.waste.amountError = "waste_amount_field_not_found";
        if (sectionDebug) sectionDebug.fields.smaltimentoImporto = smaltAmountResult?.debug || null;
      }
    }
    if ((section.ricambi || []).length) {
      writeReport.parts.attempted = true;
      const partsText = (section.ricambi || [])
        .map((part) => {
          const name = part?.name || part?.nome || "";
          const qty = part?.quantity || part?.quantita || "";
          return `${String(name).trim()}${qty ? ` x ${String(qty).trim()}` : ""}`.trim();
        })
        .filter(Boolean)
        .join("\n");
      if (partsText) {
        const partsOkResult = await fillWithRetry(
          page,
          [
            [...repartoKeys, "ricambi", "articoli", "magazzino", "pezzi"],
            [...repartoKeys, "articoli magazzino", "ricambi"],
            [...repartoKeys, "ricambi", "articoli"],
          ],
          partsText,
          { append: true },
          { debug: args.debug, fieldId: `odl.${reparto}.parts`, returnDebug: args.debug },
        );
        const partsOk = Boolean(partsOkResult?.ok ?? partsOkResult);
        writeReport.parts.success = writeReport.parts.success || partsOk;
        if (!partsOk && !writeReport.parts.error) writeReport.parts.error = "parts_field_not_found";
        if (sectionDebug) sectionDebug.fields.parts = partsOkResult?.debug || null;
      }
    }
    if (sectionDebug) {
      sectionDebug.written = sectionWritten;
      writeReport.debug.sections.push(sectionDebug);
    }
  }

  // Fallback generico: se proprio nessun campo ODL funziona, metti il blocco completo nella prima textarea.
  if (
    !writeReport.notes.success
    && !writeReport.hours.man.success
    && !writeReport.hours.mac.success
    && !writeReport.materials.success
    && !writeReport.parts.success
  ) {
    const fallbackOk = await appendStructuredBlockToAnyTextarea(
      page,
      summary,
      { keywords: ["odl", "descrizione", "intervento", "note reparto", "materiali di consumo"], returnDebug: true },
    );
    writeReport.notes.success = writeReport.notes.success || Boolean(fallbackOk?.ok ?? fallbackOk);
    if ((fallbackOk?.ok ?? fallbackOk) && writeReport.notes.error === "notes_field_not_found") writeReport.notes.error = null;
    if (fallbackOk?.debug) {
      writeReport.debug.notes.genericFallback = fallbackOk.debug;
    }
  }

  logPhase("odl_sections", "done");
  await clickGenericSaveInPractice(page).catch(() => false);
  await page.waitForTimeout(120);

  const needles = buildOdlNeedles(job);
  // Verify multi-tab: accumula il testo di TUTTE le sub-tab ODL (vedi commento su
  // collectOdlTabsText) per eliminare i falsi negativi del verify a snapshot singolo.
  const scopedText = writeReport.openedOdl
    ? await collectOdlTabsText(page).catch(() => "")
    : await readVisibleShortText(page).catch(() => "");
  const normalizedScoped = normalizeLoose(scopedText);
  const hasNeedle = (value) => normalizedScoped.includes(normalizeLoose(value));
  if (writeReport.fallbackSummaryWritten) {
    if (writeReport.hours.man.attempted && !writeReport.hours.man.success) {
      writeReport.hours.man.success = true;
      writeReport.hours.man.error = null;
    }
    if (writeReport.hours.mac.attempted && !writeReport.hours.mac.success) {
      writeReport.hours.mac.success = true;
      writeReport.hours.mac.error = null;
    }
    if (writeReport.materials.attempted && !writeReport.materials.success) {
      writeReport.materials.success = true;
      writeReport.materials.error = null;
    }
    if (writeReport.parts.attempted && !writeReport.parts.success) {
      writeReport.parts.success = true;
      writeReport.parts.error = null;
    }
  }
  // FIX: usa verify per auto-recovery SOLO se l'ODL era effettivamente aperto.
  // Se openedOdl=false, i "match" nel DOM sono falsi positivi (valori di default,
  // date, numeri comuni come "2" del smaltimento che appaiono ovunque nella pagina).
  if (writeReport.openedOdl) {
    if (job.internalNotes && !writeReport.notes.success && hasNeedle(job.internalNotes)) {
      writeReport.notes.success = true;
      writeReport.notes.error = null;
    }
    for (const section of job.sections || []) {
      if (section.ore_man != null && !writeReport.hours.man.success && hasNeedle(formatManNeedle(section.ore_man))) {
        writeReport.hours.man.success = true;
        writeReport.hours.man.error = null;
      }
      if (section.ore_mac != null && !writeReport.hours.mac.success && hasNeedle(formatMacNeedle(section.ore_mac))) {
        writeReport.hours.mac.success = true;
        writeReport.hours.mac.error = null;
      }
      if (section.materiali_euro != null && !writeReport.materials.success && hasNeedle(String(section.materiali_euro))) {
        writeReport.materials.success = true;
        writeReport.materials.error = null;
      }
      // FIX: per smaltimento, il valore "2" è troppo generico come needle —
      // non fare auto-recovery su valori a singola cifra tramite verify scan.
      const smaltValue = String(section.smaltimento_percentuale ?? 2);
      if (section.smaltimento_applica && !writeReport.waste.success && smaltValue.length > 1 && hasNeedle(smaltValue)) {
        writeReport.waste.success = true;
        writeReport.waste.error = null;
      }
      if ((section.ricambi || []).length && !writeReport.parts.success) {
        const partsSeen = (section.ricambi || []).every((part) => {
          const name = String(part?.name || part?.nome || "").trim();
          const qty = String(part?.quantity || part?.quantita || "").trim();
          if (!name) return true;
          if (qty) return hasNeedle(`${name} x ${qty}`) || (hasNeedle(name) && hasNeedle(qty));
          return hasNeedle(name);
        });
        if (partsSeen) {
          writeReport.parts.success = true;
          writeReport.parts.error = null;
        }
      }
    }
  }
  const matchedNeedles = needles.filter((needle) => normalizedScoped.includes(normalizeLoose(needle)));
  const matched = matchedNeedles.length;
  // FIX: logga i needle che hanno matchato per diagnostica
  logPhase("verify_needles", "info", {
    matched,
    total: needles.length,
    matchedList: matchedNeedles.slice(0, 10),
    notMatchedList: needles.filter((n) => !normalizedScoped.includes(normalizeLoose(n))).slice(0, 10),
  });
  writeReport.verify = {
    matched,
    total: needles.length,
    ratio: needles.length ? Number((matched / needles.length).toFixed(3)) : 1,
  };
  writeReport.odl.success = writeReport.odl.success || (writeReport.openedOdl && writeReport.verify.matched > 0);
  const anyOdlFieldSuccess = Boolean(
    writeReport.odl.success
    || writeReport.materials.success
    || writeReport.parts.success
    || writeReport.waste.success
    || writeReport.hours.man.success
    || writeReport.hours.mac.success
  );
  const odlRequested = shouldWriteOdlFromWorker(job);
  writeReport.ok = Boolean(
    writeReport.openedPractice
    && (hasWriteableOdlWork(job) && job.internalNotes ? writeReport.notes.success || anyOdlFieldSuccess : true)
    && (!odlRequested || (writeReport.openedOdl && anyOdlFieldSuccess))
  );
  if (args.debug) {
    writeReport.summary = summary;
  }
  writeReport.fields = buildFieldWriteReport(job, writeReport);
  // Riepilogo strutturato finale — un solo evento per vedere lo stato completo
  logPhase("write_summary", "result", {
    ok: writeReport.ok,
    openedPractice: writeReport.openedPractice,
    openedOdl: writeReport.openedOdl,
    workspaceState: writeReport.workspaceState,
    notes: writeReport.notes?.success ? "ok" : (writeReport.notes?.error || "failed"),
    odl: writeReport.odl?.success ? "ok" : (writeReport.odl?.error || "failed"),
    odlSections: (writeReport.odl?.sections || []).map(s => `${s.reparto}:${s.written ? "ok" : "fail"}`).join(","),
    materials: writeReport.materials?.success ? "ok" : (writeReport.materials?.attempted ? "fail" : "skip"),
    waste: writeReport.waste?.success ? "ok" : (writeReport.waste?.attempted ? "fail" : "skip"),
    hours: `man:${writeReport.hours?.man?.success ? "ok" : (writeReport.hours?.man?.attempted ? "fail" : "skip")} mac:${writeReport.hours?.mac?.success ? "ok" : (writeReport.hours?.mac?.attempted ? "fail" : "skip")}`,
    parts: writeReport.parts?.success ? "ok" : (writeReport.parts?.attempted ? "fail" : "skip"),
    verify: `${writeReport.verify?.matched}/${writeReport.verify?.total}`,
    odlRoute: writeReport.odlRouteEffective ? "route" : (writeReport.odlFallbackClickUsed ? "click" : "none"),
  });
  _detachRpcTrace();
  return writeReport;
}

// Diagnostica: mappa i campi del popup appuntamento (input + etichette + widget
// Tag/Veicolo). Serve per ricostruire i selettori esatti da log, senza tirare a indovinare.
async function dumpPopupFields(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel")]
      .find((p) => isVisible(p) && (p.textContent || "").toLowerCase().includes("dettagli appuntamento"));
    if (!popup) return { found: false };
    const labelFor = (el) => {
      let node = el;
      for (let i = 0; i < 6 && node && node !== popup; i += 1) {
        node = node.parentElement;
        if (!node) break;
        const own = [...node.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
        if (own && own.length <= 40) return own;
      }
      return "";
    };
    const inputs = [...popup.querySelectorAll("input, textarea")].filter(isVisible).map((el) => ({
      tag: el.tagName,
      type: el.getAttribute("type") || "",
      cls: (el.className || "").slice(0, 60),
      value: (el.value || "").slice(0, 30),
      maxlength: el.getAttribute("maxlength") || "",
      transform: (el.style && el.style.textTransform) || "",
      placeholder: el.getAttribute("placeholder") || "",
      label: labelFor(el),
    }));
    // Elementi cliccabili / etichette rilevanti per Tag e Veicolo.
    const widgets = [...popup.querySelectorAll("div, span, td, button, a, label")].filter(isVisible)
      .map((el) => ({ el, t: (el.textContent || "").replace(/\s+/g, " ").trim() }))
      .filter((x) => /^(tag|veicolo|autoveicolo|nessun veicolo|note|cosa)\b/i.test(x.t) || /nessun veicolo selezionato/i.test(x.t))
      .slice(0, 20)
      .map((x) => ({ tag: x.el.tagName, cls: (x.el.className || "").slice(0, 50), txt: x.t.slice(0, 50) }));
    return { found: true, inputs, widgets };
  }).catch(() => ({ found: false }));
}

async function fillAppointmentPopup(page, job) {
  const rect = await appointmentPopupRect(page);
  if (!rect) {
    throw new Error("Popup 'Dettagli appuntamento' non trovato");
  }
  // Diagnostica selettori (Tag/Veicolo): finisce nel Log worker per il debug preciso.
  logAction("popup_fields", await dumpPopupFields(page));

  const inputs = (await inputSnapshot(page)).filter((item) => {
    const insideX = item.x >= rect.x && item.x + item.width <= rect.x + rect.width + 2;
    const insideY = item.y >= rect.y && item.y + item.height <= rect.y + rect.height + 2;
    return insideX && insideY;
  });
  const dateIndex = inputs.find((item) => /^\d{2}\/\d{2}\/\d{4}$/.test(item.value))?.index;
  const timeIndexes = inputs.filter((item) => /^\d{1,2}\.\d{2}$/.test(item.value)).map((item) => item.index);

  if (dateIndex === undefined || timeIndexes.length < 2) {
    throw new Error(`Popup YAP non riconosciuto. Input visibili: ${JSON.stringify(inputs)}`);
  }

  const cosaInput = inputs
    .filter((item) => item.index < dateIndex && item.width > 80)
    .sort((a, b) => a.y - b.y)[0] || inputs.find((item) => item.index < dateIndex);

  if (!cosaInput) {
    throw new Error("Non trovo il campo 'Cosa' nel popup YAP");
  }

  const cosaValue = pickCosaFromJob(job);
  const endTime = addMinutes(job.appointment.time, job.appointment.duration);
  const notes = buildNotesForPopup(jobToMapping(job));
  const plate = String(job.customer?.plate || "").trim().toUpperCase();
  const cosaWrittenValue = plate || cosaValue;

  // ORDINE CRITICO: TAG e DATA/ORA prima, VEICOLO per ULTIMO.
  // Quando il veicolo si aggancia, YAP considera l'appuntamento COMPLETO (veicolo+data+
  // ora) e lo AUTO-SALVA chiudendo il popup. Se il tag fosse scritto dopo il veicolo,
  // arriverebbe a popup gia' chiuso (era il bug "tag mancante"). Quindi: tag, poi
  // data/ora, poi veicolo (che fa scattare l'auto-save con tutto gia' dentro).

  // --- TAG (prima del veicolo) ---
  const yapTags = pickYapTagsFromJob(job);
  const tagResult = await addYapTagChips(page, yapTags);
  logAction("tags_written", { requested: yapTags, added: tagResult.added, failed: tagResult.failed, ok: tagResult.ok });

  // --- DATA/ORA (prima del veicolo) ---
  await fillVisibleInput(page, dateIndex, toItalianDate(job.appointment.date));
  await fillVisibleInput(page, timeIndexes[0], toYapTime(job.appointment.time));
  await fillVisibleInput(page, timeIndexes[1], toYapTime(endTime));
  const emptyAfterTimes = inputs.filter(
    (item) => item.index > timeIndexes[1] && !item.value && item.width > 40,
  );
  if (notes && emptyAfterTimes[0]) {
    await fillVisibleInput(page, emptyAfterTimes[0].index, notes).catch(() => {});
  }

  // --- VEICOLO (per ULTIMO): targa nel Cosa con TASTIERA REALE.
  // CRITICO: l'autocomplete GWT del veicolo si attiva SOLO con eventi tastiera veri,
  // NON con `input.value=` (fillVisibleInput). Con value=+blur la tendina non compare
  // (veicolo mai agganciato) e il blur fa auto-salvare YAP in anticipo -> doppioni.
  let vehicleState = "skipped"; // skipped|linked|not_found|failed
  const cosaX = cosaInput.x + Math.min(cosaInput.width / 2, 60);
  const cosaY = cosaInput.y + (cosaInput.height / 2);
  await page.mouse.click(cosaX, cosaY).catch(() => {});
  await page.waitForTimeout(120).catch(() => {});
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});
  if (plate) {
    await page.keyboard.type(plate, { delay: 45 }).catch(() => {});

    // Trova la RIGA-suggerimento (CellList GWT) con la targa, fuori dall'agenda di sfondo.
    // ATTENZIONE: l'appointment popup e' anch'esso un .gwt-DecoratedPopupPanel e contiene
    // la targa nella propria UI — cercare globalmente con quella classe produce falsi match
    // dentro il popup stesso invece che nel dropdown dei suggerimenti. Si cercano prima i
    // .gwt-SuggestBoxPopup (dropdown reale), poi si applica un fallback leaf-element inside
    // qualsiasi panel visibile.
    const findSuggestion = () => safeEvaluate(page, (targetPlate) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 4 && r.height > 4 && s.display !== "none" && s.visibility !== "hidden";
      };
      const P = String(targetPlate || "").toUpperCase();
      // Panel specifici del SuggestBox (dropdown autocomplete), escluso il popup appuntamento.
      const suggestPanels = [...document.querySelectorAll(
        ".gwt-SuggestBoxPopup, [role='listbox']",
      )].filter(isVisible);
      // Tutti i panel visibili (per "nessun risultato" e fallback)
      const allPanels = [...document.querySelectorAll(
        ".gwt-SuggestBoxPopup, .gwt-DecoratedPopupPanel, .gwt-PopupPanel, [role='listbox']",
      )].filter(isVisible);
      if (allPanels.some((p) => /nessun risultato/i.test(p.textContent || ""))) return { state: "not_found" };
      // Scope di ricerca: prefer suggest panels, fallback su tutti i panel
      const scope = suggestPanels.length > 0 ? suggestPanels : allPanels;
      let el = null;
      for (const sel of ["[__gwt_cell]", "tr[__gwt_row]", "[role='option']", ".gwt-MenuItem"]) {
        const m = [...document.querySelectorAll(sel)]
          .filter(isVisible)
          // deve essere DENTRO uno dei panel di scope (non nel popup appuntamento)
          .filter((e) => scope.some((p) => p.contains(e)))
          .filter((e) => (e.textContent || "").toUpperCase().includes(P))
          .filter((e) => e.getBoundingClientRect().height < 140)
          .filter((e) => !e.closest(".fc-time-grid, .fc-view-container"));
        if (m.length) { el = m[0]; break; }
      }
      // Fallback: qualsiasi elemento leaf nei panel di scope che contiene la targa
      if (!el) {
        for (const panel of scope) {
          const m = [...panel.querySelectorAll("div, td, li, span")]
            .filter(isVisible)
            .filter((e) => (e.textContent || "").toUpperCase().includes(P))
            .filter((e) => {
              const r = e.getBoundingClientRect();
              return r.height > 4 && r.height < 80;
            })
            .filter((e) => !e.closest(".fc-time-grid, .fc-view-container"))
            // preferisce elementi foglia (nessun figlio con la stessa targa)
            .filter((e) => ![...e.querySelectorAll("div,td,li,span")].some(
              (c) => (c.textContent || "").toUpperCase().includes(P),
            ));
          if (m.length) { el = m[0]; break; }
        }
      }
      if (el) {
        const r = el.getBoundingClientRect();
        return { state: "match", x: r.x + Math.min(r.width / 2, 120), y: r.y + (r.height / 2), label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50) };
      }
      // sawContent SOLO dai suggest panel veri: allPanels include il popup appuntamento
      // stesso (sempre con testo) e produceva vehicleState=failed anche quando il
      // dropdown non era mai comparso (caso reale: not_found / query mai partita).
      const sawContent = suggestPanels.some((p) => (p.textContent || "").trim().length > 0);
      return { state: "pending", sawContent, suggestPanelCount: suggestPanels.length };
    }, plate).catch(() => ({ state: "pending" }));

    let sug = { state: "pending" };
    let sawPopup = false;
    let retriggers = 0;
    for (let i = 0; i < 24; i += 1) {
      sug = await findSuggestion();
      if (sug.state === "match" || sug.state === "not_found") break;
      if (sug.sawContent) sawPopup = true;
      // Se dopo ~1.5s il dropdown non e' mai comparso, la query GWT potrebbe non
      // essere partita (keyup perso): Backspace + ridigito ultimo carattere per
      // ritriggerare l'oracle del SuggestBox. Massimo 2 nudge.
      if (!sawPopup && (i === 7 || i === 15) && retriggers < 2) {
        retriggers += 1;
        await page.keyboard.press("Backspace").catch(() => {});
        await page.waitForTimeout(160).catch(() => {});
        await page.keyboard.type(plate.slice(-1), { delay: 45 }).catch(() => {});
      }
      await page.waitForTimeout(220).catch(() => {});
    }
    // Controlla se il widget "Veicolo" nel popup mostra ancora "Nessun veicolo selezionato".
    // Se la risposta è true il click sul suggerimento ha chiuso il dropdown senza agganciare
    // davvero il veicolo in YAP (evento GWT onSuggestionSelected non scattato).
    const isVehicleWidgetUnlinked = () => safeEvaluate(page, () => {
      const popup = document.querySelector(".popupMiddleCenter, .popupContent");
      if (!popup) return false; // popup chiuso = auto-save avvenuto = veicolo agganciato
      return /nessun veicolo selezionato/i.test(popup.textContent || "");
    }).catch(() => false);

    const steps = [];
    if (sug.state === "match") {
      // Un solo suggerimento (la targa) => escalare e' sicuro. Mi fermo appena sparisce.
      const gone = async () => (await findSuggestion()).state !== "match";
      await page.mouse.click(sug.x, sug.y).catch(() => {});
      await page.waitForTimeout(320).catch(() => {});
      const clickGone = await gone();
      // Se gone=true ma il widget mostra ancora "Nessun veicolo", il click ha chiuso il
      // dropdown senza che GWT sparasse onSuggestionSelected -> aggancio non avvenuto.
      const needsKeyboardRetry = clickGone && await isVehicleWidgetUnlinked();
      steps.push({ how: "click", gone: clickGone, vehicleUnlinked: needsKeyboardRetry || undefined });
      if (!clickGone || needsKeyboardRetry) {
        if (needsKeyboardRetry) {
          // Il click fallito puo' lasciare il focus fuori dal Cosa: riscrivi la
          // targa completa, altrimenti l'ultimo carattere resta come nota (es. "- V").
          await page.mouse.click(cosaX, cosaY).catch(() => {});
          await page.waitForTimeout(120).catch(() => {});
          await page.keyboard.press("Control+A").catch(() => {});
          await page.keyboard.type(plate, { delay: 45 }).catch(() => {});
          await page.waitForTimeout(420).catch(() => {});
        }
        await page.keyboard.press("ArrowDown").catch(() => {});
        await page.waitForTimeout(150).catch(() => {});
        await page.keyboard.press("Enter").catch(() => {});
        await page.waitForTimeout(400).catch(() => {});
        steps.push({ how: "arrowdown_enter", gone: await gone() });
      }
      if (!steps[steps.length - 1].gone) {
        const again = await findSuggestion();
        if (again.state === "match") { await page.mouse.dblclick(again.x, again.y).catch(() => {}); await page.waitForTimeout(320).catch(() => {}); }
        steps.push({ how: "dblclick", gone: await gone() });
      }
      await page.waitForTimeout(500).catch(() => {});
      const widgetLinked = await safeEvaluate(page, (targetPlate) => {
        const popup = document.querySelector(".popupMiddleCenter, .popupContent");
        if (!popup) return false;
        const plateUpper = String(targetPlate || "").toUpperCase();
        const plateNode = [...popup.querySelectorAll("span, div, td")]
          .find((el) => String(el.textContent || "").trim().toUpperCase() === plateUpper);
        if (!plateNode) return false;
        const vehicleArea = plateNode.closest(".JMFB34B-ib-y, .JMFB34B-hb-c") || plateNode.parentElement;
        const text = String(vehicleArea?.textContent || "").toUpperCase();
        return text.includes(plateUpper) && !/NESSUN VEICOLO SELEZIONATO/i.test(text);
      }, plate).catch(() => false);
      vehicleState = widgetLinked ? "linked" : "pending_confirmation";
      steps.push({ how: "widget_confirmation", linked: widgetLinked });
    } else if (sug.state === "not_found") {
      vehicleState = "not_found";
    } else {
      // "not_found" SOLO dal messaggio esplicito "nessun risultato": se il dropdown
      // non compare (o compare senza match) non sappiamo se il veicolo esiste, e
      // l'audit tratta not_found come ok — un flaky diventerebbe un falso "tutto ok".
      vehicleState = "failed";
    }
    logAction("cosa_vehicle_pick", { plate, writtenValue: cosaWrittenValue, sug: sug.state, label: sug.label || null, steps, vehicleState, suggestPanelCount: sug.suggestPanelCount ?? null, retriggers });
  } else {
    await page.keyboard.type(cosaValue, { delay: 25 }).catch(() => {});
  }
  // Retry tag SOLO se il popup e' ancora aperto: dopo l'aggancio veicolo YAP puo'
  // auto-salvare e chiudere il popup; ritentare a popup chiuso cliccherebbe sull'agenda.
  const popupStillOpen = Boolean(await appointmentPopupRect(page).catch(() => null));
  if (yapTags.length && popupStillOpen) {
    const missingTags = [];
    for (const tag of yapTags) {
      if (!(await isTagConfirmed(page, tag))) missingTags.push(tag);
    }
    if (missingTags.length) {
      const repairedTags = await addYapTagChips(page, missingTags);
      logAction("tags_retry", { missing: missingTags, added: repairedTags.added, failed: repairedTags.failed, ok: repairedTags.ok });
    }
  }
  const vehicleLinked = vehicleState === "linked";
  logAction("cosa_vehicle", { plate, cosaValue, writtenValue: cosaWrittenValue, vehicleState });

  return {
    tagResult,
    vehicleState,
    vehicleLinked,
    plate,
    cosa: cosaWrittenValue,
  };
}

// Verifica AUTOREVOLE del veicolo agganciato: dopo il salvataggio l'evento in agenda
// mostra le info veicolo SOLO se il veicolo e' davvero agganciato.
// Criterio forte: hover sull'evento e verifica del tooltip #agendaTip con
// Targa / Veicolo / Intestatario / Cellulare. Fallback: titolo evento piu' ricco
// della sola targa.
async function verifyVehicleInAgenda(page, plate, expectedTime = "") {
  const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");
  const P = norm(plate);
  const expectedMatch = String(expectedTime || "").match(/^(\d{1,2})[:.](\d{2})$/);
  const expectedMinutes = expectedMatch
    ? Number(expectedMatch[1]) * 60 + Number(expectedMatch[2])
    : NaN;
  if (!P) return { linked: false, found: false };
  let last = { linked: false, found: false };
  // Polling breve: il re-render dell'evento puo' arrivare con un attimo di ritardo.
  // Se in QUALSIASI scan risulta agganciato -> agganciato (no falsi negativi da timing).
  for (let i = 0; i < 4; i += 1) {
    try {
      const events = await scanVisibleAgendaEventTargets(page, { includeStyle: true }); // [{time, title, repartoClass, x, y, bgColor...}]
      const ev = events.find((e) => {
        if (!norm(e.title).includes(P)) return false;
        if (!Number.isFinite(expectedMinutes)) return true;
        const start = String(e.time || "").match(/(\d{1,2})[:.](\d{2})/);
        if (!start) return false;
        return (Number(start[1]) * 60 + Number(start[2])) === expectedMinutes;
      });
      if (ev) {
        await page.mouse.move(ev.x, ev.y).catch(() => {});
        await page.waitForTimeout(600).catch(() => {});
        const tip = await safeEvaluate(page, () => {
          const tipEl = document.querySelector("#agendaTip, .agendaTip, [id*='agendaTip'], [class*='agendaTip']");
          if (!tipEl) return null;
          const text = (tipEl.textContent || "").replace(/\s+/g, " ").trim();
          return { text: text.slice(0, 240), html: (tipEl.innerHTML || "").slice(0, 400) };
        }).catch(() => null);
        const tipText = norm(tip?.text || "");
        const tipLinked = /TARGA/.test(tipText)
          && /VEICOLO/.test(tipText)
          && /INTESTATARIO/.test(tipText)
          && /CELLULARE/.test(tipText)
          && !/NESSUN VEICOLO SELEZIONATO/.test(tipText);
        const title = norm(ev.title);
        const afterPlate = title.split(P).slice(1).join(" ").replace(/[^A-Z]/g, "");
        const titleLinked = /[A-Z]{3,}/.test(afterPlate); // marca/nome dopo la targa
        const linked = tipLinked || titleLinked;
        last = {
          linked,
          found: true,
          title: String(ev.title || "").slice(0, 90),
          tooltip: tip?.text || null,
          bgColor: ev.bgColor || null,
          borderColor: ev.borderColor || null,
          reparto: ev.repartoClass || "",
          scans: i + 1,
        };
        if (linked) return last;
      } else if (!last.found) {
        last = { linked: false, found: false, scans: i + 1 };
      }
    } catch (e) {
      last = { linked: false, found: false, error: String(e?.message || "").slice(0, 80), scans: i + 1 };
    }
    await page.waitForTimeout(450).catch(() => {});
  }
  return last;
}

async function verifyVehicleInOpenedPractice(page, plate) {
  const expected = String(plate || "").trim().toUpperCase();
  if (!expected) return { linked: false, found: false, source: "opened_practice" };
  for (let i = 0; i < 8; i += 1) {
    const result = await safeEvaluate(page, (target) => {
      const inPractice = String(window.location.hash || "").includes("pratica");
      if (!inPractice) {
        return { linked: false, found: false, value: "", source: "agenda" };
      }
      const plateInput = [...document.querySelectorAll("input")].find(
        (el) => String(el.getAttribute("placeholder") || "").trim().toLowerCase() === "targa",
      );
      const value = String(plateInput?.value || "").trim().toUpperCase();
      return { linked: value === target, found: Boolean(plateInput), value, source: "opened_practice" };
    }, expected).catch(() => ({ linked: false, found: false, value: "", source: "opened_practice" }));
    if (result.linked) return result;
    await page.waitForTimeout(350).catch(() => {});
  }
  return { linked: false, found: true, value: "", source: "opened_practice" };
}

// Audit inline: verifica i dati appena salvati senza aprire nuovo browser
// VERIFICA AUTOMATICA (inline audit).
//
// PERCHÉ NON ri-clicca lo slot in agenda:
// la vecchia implementazione faceva Escape + clickApproximateSlot per riaprire il
// popup e rileggere i campi. Ma dopo la scrittura ODL la pagina è DENTRO la pratica
// (vista ODL), non sull'agenda: lo slot non è raggiungibile → l'audit falliva
// SISTEMATICAMENTE con "Slot not found for audit" e il backend mostrava
// "Da ricontrollare: ODL" anche quando la scrittura era perfetta. Era il motivo per
// cui "la verifica automatica non parte mai".
//
// FONTE DI VERITÀ: il write_report prodotto da writePracticeAndOdl. Quel report
// rilegge OGNI campo ODL direttamente dal DOM, navigando tutte le sub-tab
// (verify multi-tab) e confrontando i needle campo per campo. È una verifica più
// forte e più affidabile della riapertura del popup agenda, e non richiede di
// uscire dalla pratica. L'avvenuta scrittura in agenda è già garantita dal
// salvataggio del popup appuntamento (putResponse rilevato a monte).
async function runInlineAudit(page, job, managementWrite, popupResult = null) {
  const present = [];
  const missing = [];

  // L'agenda è confermata dal salvataggio del popup appuntamento andato a buon fine.
  present.push({ field: "agenda", expected: "appuntamento salvato in agenda" });

  const odlRequested = shouldWriteOdlFromWorker(job);

  // Verifica TAG e VEICOLO in base all'esito reale della scrittura del popup
  // (non dare per riuscito ciò che non lo è). Vale per ogni pratica, anche revisione.
  const expectedTags = pickYapTagsFromJob(job);
  if (expectedTags.length) {
    const addedTags = popupResult?.tagResult?.added || [];
    const failedTags = expectedTags.filter((t) => !addedTags.includes(t));
    if (failedTags.length === 0) {
      present.push({ field: "tag", expected: `tag: ${expectedTags.join(", ")}` });
    } else {
      missing.push({ field: "tag", expected: `tag: ${expectedTags.join(", ")}`, found: addedTags.join(", ") || "nessuno" });
    }
  }
  if (job.customer?.plate) {
    const vstate = popupResult?.vehicleState || (popupResult?.vehicleLinked ? "linked" : "failed");
    const vehicleLinked = vstate === "linked";
    if (vehicleLinked) {
      present.push({ field: "veicolo", expected: `veicolo agganciato (${job.customer.plate})` });
    } else if (vstate === "not_found") {
      // Il veicolo non e' in anagrafica YAP: NON e' un errore per nessun tipo di pratica.
      // Il worker ha cercato e non ha trovato — non c'e' nulla da fare.
      present.push({ field: "veicolo", expected: `veicolo non in anagrafica YAP (${job.customer.plate}) — ok` });
    } else {
      missing.push({ field: "veicolo", expected: `veicolo agganciato (${job.customer.plate})`, found: "aggancio non riuscito" });
    }
  }

  // Se l'ODL non era richiesto (es. revisione), l'esito dipende da agenda + tag + veicolo.
  if (!odlRequested) {
    return {
      verified: missing.length === 0,
      present,
      missing,
      error: missing.length ? `Da ricontrollare: ${missing.map((m) => m.field).join(", ")}` : undefined,
      summary: { present: present.length, missing: missing.length, fields: present.map((p) => p.field), source: "write_report" },
    };
  }

  const wr = managementWrite && typeof managementWrite === "object" ? managementWrite : null;

  // PREVENTIVO (griglia documento): la verifica si basa sull'esito REALE della
  // scrittura griglia, NON sui vecchi needle ODL (che non si applicano alla pagina
  // Preventivo). Niente note.interne (rimosse). Onesto: presente solo cio' che e' scritto.
  if (wr?.gridResult) {
    const g = wr.gridResult;
    // Prefisso onesto in base al tipo di documento (preventivo o ODL): stessa griglia.
    const dk = g.docKind === "odl" ? "odl" : "preventivo";
    const gridFields = Array.isArray(wr.fields)
      ? wr.fields.filter((field) => String(field?.field_id || "").startsWith(`${dk}.`))
      : [];
    if (gridFields.length) {
      for (const field of gridFields) {
        const item = {
          field: field.field_id,
          expected: field.expected,
          found: field.found ?? null,
        };
        if (field.status === "written") present.push(item);
        else missing.push(item);
      }
    } else {
      if (g.manodopera?.expected) {
        if (g.manodopera?.articolo) {
          present.push({ field: `${dk}.manodopera`, expected: `MAN (${g.manodopera?.readback?.qta || "ore"})` });
        } else {
          missing.push({ field: `${dk}.manodopera`, expected: "riga manodopera (MAN)" });
        }
      }
      for (const r of (g.righe || [])) {
        if (r.written) present.push({ field: `${dk}.${r.kind}`, expected: r.text });
        else missing.push({ field: `${dk}.${r.kind}`, expected: r.text, found: "non scritto" });
      }
      // Salvataggio del documento: senza questo le righe NON persistono su YAP. Onesto.
      if (g.saved?.ok) present.push({ field: `${dk}.salvataggio`, expected: "documento salvato" });
      else missing.push({ field: `${dk}.salvataggio`, expected: "documento salvato", found: g.saved?.reason || "non salvato" });
    }
    return {
      verified: missing.length === 0,
      present,
      missing,
      error: missing.length ? `Da ricontrollare: ${missing.map((m) => m.field).join(", ")}` : undefined,
      summary: { present: present.length, missing: missing.length, fields: present.map((p) => p.field), source: `${dk}_grid` },
    };
  }

  // ODL richiesto ma non aperto/scritto: verifica fallita con dettaglio.
  if (!wr || (!wr.openedOdl && wr.ok === false)) {
    missing.push({ field: "odl", expected: "scrittura ODL", error: wr?.error || "odl_non_scritto" });
    return {
      verified: false,
      error: wr?.error || "ODL non scritto",
      present,
      missing,
      summary: { present: present.length, missing: missing.length, fields: present.map((p) => p.field), source: "write_report" },
    };
  }

  // Costruisci present/missing dai campi effettivamente verificati nel write_report.
  const fields = Array.isArray(wr.fields) ? wr.fields : [];
  for (const f of fields) {
    if (f && f.status === "written") {
      present.push({ field: f.field_id, expected: f.expected });
    } else if (f) {
      missing.push({ field: f.field_id, expected: f.expected, found: f.found ?? null });
    }
  }

  // Ratio della rilettura multi-tab: 1.0 = tutti i needle ritrovati nel DOM ODL.
  const ratio = (wr.verify && typeof wr.verify.ratio === "number")
    ? wr.verify.ratio
    : (missing.length === 0 ? 1 : 0);

  // Verificato SOLO se: ODL aperto, nessun campo mancante e rilettura completa (ratio 1).
  const verified = hasVerifiedOdlWorkspace(wr) && missing.length === 0 && ratio >= 1;

  return {
    verified,
    present,
    missing,
    summary: {
      present: present.length,
      missing: missing.length,
      fields: present.map((p) => p.field),
      verifyRatio: ratio,
      source: "write_report",
    },
  };
}

async function saveAppointmentPopup(page, { maxSaveAttempts = 4 } = {}) {
  let putResponse = null;
  let saveAttemptsUsed = 0;
  let lastSaveError = null;
  let alreadyClosed = false;
  logPhase("save_popup", "starting", { maxAttempts: maxSaveAttempts });

  const readPopupState = async () => safeEvaluate(page, () => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel, .popup")]
      .find((el) => {
        if (!isVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.height < 80) return false; // popup di conferma/titolo GWT, non di editing
        const text = (el.textContent || "").toLowerCase();
        if (text.includes("dettagli appuntamento")) return true;
        return [...el.querySelectorAll("input, textarea, select, button, a, [role='button']")].filter(isVisible).length >= 5;
      });
    if (!popup) return { open: false, saveCandidates: [], errors: [] };

    const popupRect = popup.getBoundingClientRect();
    const clickableNodes = [...popup.querySelectorAll("a.gwt-Anchor, button, .gwt-Button, img, span, [role='button'], td, div")]
      .filter(isVisible);
    const saveCandidates = clickableNodes
      .map((el) => {
        const rawText = (el.textContent || el.getAttribute("title") || el.getAttribute("alt") || "").trim();
        const text = rawText.toLowerCase();
        // FIX salvataggio: scarta i contenitori. Il popup contiene la scritta
        // "Appuntamento salvato", quindi includes("salva") matchava l'intero popup
        // e cliccavamo il centro (746,300) invece dell'icona -> RPC mai inviata.
        if (rawText.length > 14) return null;
        if (!(text === "check" || text.includes("salva") || text.includes("save") || text.includes("floppy"))) return null;

        // FIX salvataggio: promuovi SOLO a un vero ancestor cliccabile
        // (A/BUTTON/[role=button]/[onclick]); NON risalire a TD/DIV generici,
        // altrimenti il click finisce al centro del popup. In GWT l'evento bolla
        // comunque dall'icona al gestore, quindi cliccare l'icona stessa basta.
        let clickTarget = el;
        let node = el.parentElement;
        for (let i = 0; i < 4 && node && node !== popup; i += 1) {
          const tag = node.tagName;
          if (tag === "A" || tag === "BUTTON" || node.getAttribute("onclick") || node.getAttribute("role") === "button") {
            clickTarget = node;
            break;
          }
          node = node.parentElement;
        }

        const rect = clickTarget.getBoundingClientRect();
        const relX = popupRect.width > 0 ? (rect.left + rect.width / 2 - popupRect.left) / popupRect.width : 0;
        const relY = popupRect.height > 0 ? (rect.top + rect.height / 2 - popupRect.top) / popupRect.height : 0;
        let score = 0;
        if (text.includes("salva") || text.includes("save") || text.includes("floppy")) score += 220;
        if (text === "check") score += 140;
        if (clickTarget.tagName === "A" || clickTarget.tagName === "BUTTON") score += 80;
        if (relX >= 0.55) score += 55;
        if (relY <= 0.35) score += 45;
        score += Math.min(60, Math.round((rect.width * rect.height) / 100));
        return {
          rawText,
          text,
          clickTag: clickTarget.tagName,
          buttonClass: clickTarget.className || "",
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          relX,
          relY,
          score,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.relX - a.relX || a.relY - b.relY);

    const errors = [...popup.querySelectorAll("div, span, td, li")]
      .filter(isVisible)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter((text) => text && text.length <= 160)
      .filter((text) => /erro|attenz|obblig|selezion|compil|required|valida|manc/i.test(text.toLowerCase()))
      .slice(0, 4);

    return { open: true, saveCandidates, errors };
  }).catch(() => ({ open: false, saveCandidates: [], errors: [] }));

  for (let attempt = 1; attempt <= maxSaveAttempts; attempt += 1) {
    saveAttemptsUsed = attempt;
    logPhase("save_attempt", `try_${attempt}`);
    try {
      // Dump DOM del popup al primo tentativo per diagnostica struttura bottone
      if (attempt === 1) {
        const _diagDump = await safeEvaluate(page, () => {
          const isVisible = (el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
          };
          const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel, .popup")]
            .filter(isVisible)
            .sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length)[0];
          if (!popup) return null;
          return [...popup.querySelectorAll("*")].filter(isVisible).slice(0, 50).map((el) => ({
            tag: el.tagName,
            cls: (el.className || "").slice(0, 80),
            txt: (el.textContent || "").trim().slice(0, 40),
            rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })(),
            pe: window.getComputedStyle(el).pointerEvents,
          }));
        }).catch(() => null);
        if (_diagDump) logPhase("save_click", "popup_dom_dump", { elements: _diagDump.length, dump: _diagDump });
        else logPhase("save_click", "popup_dom_dump", { elements: 0, note: "no popup found" });
      }
      const popupState = await readPopupState();
      // Se il popup originale (con i campi) è già sparito, controlla se è rimasto
      // solo il popup di conferma GWT (piccolo, senza input) = salvataggio già avvenuto.
      if (!popupState?.open) {
        logPhase("save_popup", "already_closed", { attempt });
        putResponse = { status: () => 200, url: () => "local://popup-already-closed" };
        alreadyClosed = true;
        break;
      }
      // Popup di conferma post-salvataggio: altezza < 80px e nessun input = successo
      const confirmPopupCheck = await safeEvaluate(page, () => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const popups = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel, .popup")].filter(isVisible);
        const confirmPopup = popups.find((el) => {
          const rect = el.getBoundingClientRect();
          const inputs = [...el.querySelectorAll("input, textarea, select")].filter(isVisible);
          return rect.height < 80 && inputs.length === 0;
        });
        if (!confirmPopup) return null;
        const rect = confirmPopup.getBoundingClientRect();
        return { h: Math.round(rect.height), txt: (confirmPopup.textContent || "").trim().slice(0, 60) };
      }).catch(() => null);
      const confirmText = String(confirmPopupCheck?.txt || "");
      const saveCompleted = /appuntamento salvato|salvataggio completato/i.test(confirmText)
        && !/in corso/i.test(confirmText);
      if (confirmPopupCheck && saveCompleted) {
        logPhase("save_popup", "confirm_popup_detected", { attempt, ...confirmPopupCheck });
        putResponse = { status: () => 200, url: () => "local://confirm-popup" };
        break;
      }
      if (confirmPopupCheck) {
        logPhase("save_popup", "progress_popup_detected", { attempt, ...confirmPopupCheck });
        await page.waitForTimeout(700).catch(() => {});
        continue;
      }
      const candidateCount = popupState?.saveCandidates?.length || 0;
      const candidateIndex = Math.min(Math.max(0, attempt - 1), Math.max(0, candidateCount - 1));
      const candidate = popupState?.saveCandidates?.[candidateIndex] || popupState?.saveCandidates?.[0] || null;
      if (!candidate) {
        logPhase("save_click", "btn_not_found", { candidateCount, errors: popupState?.errors || [] });
        throw new Error("Bottone salva non trovato nel popup");
      }

      logPhase("save_click", "clicking", {
        buttonText: candidate.rawText || candidate.text || "check",
        buttonClass: candidate.buttonClass,
        clickTag: candidate.clickTag,
        x: Math.round(candidate.x),
        y: Math.round(candidate.y),
        candidateIndex,
        candidateCount,
        candidateScore: candidate.score,
      });
      // STRATEGIA PRIMARIA: click via locator Playwright sul bottone "check" del
      // popup (eventi nativi *trusted*, auto-wait, scroll-into-view, attesa di
      // non-occlusione). Il click a coordinate calcolate falliva in modo intermittente
      // ("Salvataggio non confermato dopo 3 tentativi") quando la coordinata cadeva
      // sulla barra-titolo/drag del popup invece che sull'icona. Il locator colpisce
      // l'elemento reale.
      try {
        const popupScope = page.locator(".gwt-DecoratedPopupPanel, .gwt-PopupPanel").last();
        const saveLeaf = popupScope.locator("span.gwt-InlineLabel")
          .filter({ hasText: /^check$/ }).first();
        if (await saveLeaf.count().catch(() => 0)) {
          await saveLeaf.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
          await saveLeaf.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(80).catch(() => {});
        }
      } catch (_e) { /* il click a coordinate sotto resta comunque */ }
      // Click a coordinate del candidate (page.mouse.click è OS-level): eseguito
      // SEMPRE — anche dopo il locator — perché è la via storicamente affidabile e
      // non va mai saltata. Prima move per simulare hover (alcuni GWT button
      // attivano solo su hover+click).
      await page.mouse.move(candidate.x, candidate.y);
      await page.waitForTimeout(60).catch(() => {});
      await page.mouse.click(candidate.x, candidate.y, { button: "left", clickCount: 1 });
      // Secondo tentativo: cerca la foglia SPAN e clicca anche lì (per sicurezza)
      const domClicked = await safeEvaluate(page, () => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel, .popup")]
          .find((el) => {
            if (!isVisible(el)) return false;
            const t = (el.textContent || "").toLowerCase();
            if (t.includes("dettagli appuntamento")) return true;
            return [...el.querySelectorAll("input, textarea, select, button, a, [role='button']")].filter(isVisible).length >= 5;
          });
        if (!popup) return "popup_closed";
        const checkLeaf = [...popup.querySelectorAll("*")]
          .filter(isVisible)
          .find((el) => {
            if ((el.textContent || "").trim() !== "check") return false;
            const kids = [...el.children].filter((c) => (c.textContent || "").trim().length > 0);
            return kids.length === 0;
          });
        if (!checkLeaf) return "no_check_leaf";
        const rect = checkLeaf.getBoundingClientRect();
        return { tag: checkLeaf.tagName, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
      }).catch(() => null);
      if (domClicked === "popup_closed") {
        logPhase("save_popup", "closed_after_first_click", { attempt });
        putResponse = { status: () => 200, url: () => "local://popup-closed" };
        break;
      }
      if (domClicked?.cx) {
        await page.mouse.move(domClicked.cx, domClicked.cy);
        await page.waitForTimeout(60).catch(() => {});
        await page.mouse.click(domClicked.cx, domClicked.cy, { button: "left", clickCount: 1 });
      }
      logPhase("save_click", "clicked", { buttonText: candidate.rawText || candidate.text || "check", candidateIndex, domClicked });

      // Aspetta fino a 4.5s che il popup si chiuda: GWT processa il click in modo asincrono
      let popupAfterClick = null;
      for (let w = 0; w < 9; w += 1) {
        await page.waitForTimeout(500).catch(() => {});
        popupAfterClick = await readPopupState();
        if (!popupAfterClick?.open) break;
      }
      if (!popupAfterClick?.open) {
        logPhase("save_popup", "closed_after_click", { attempt });
        putResponse = { status: () => 200, url: () => "local://popup-closed" };
        break;
      }
      // Dump diagnostico: mostra tutti gli elementi visibili nel popup per debug
      const popupDump = await safeEvaluate(page, () => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
        };
        const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel, .popup")]
          .find((el) => isVisible(el) && (
            (el.textContent || "").toLowerCase().includes("dettagli appuntamento")
            || [...el.querySelectorAll("input,textarea,select")].filter(isVisible).length >= 3
          ));
        if (!popup) return null;
        return [...popup.querySelectorAll("*")].filter(isVisible).slice(0, 40).map((el) => ({
          tag: el.tagName, cls: (el.className || "").slice(0, 60),
          txt: (el.textContent || "").trim().slice(0, 30),
          rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        }));
      }).catch(() => null);
      if (popupDump) logPhase("save_click", "popup_dom_dump", { elements: popupDump.length, dump: popupDump.slice(0, 20) });
      if (popupAfterClick.errors?.length) {
        throw new Error(`Popup ancora aperto: ${popupAfterClick.errors.join(" | ")}`);
      }
    } catch (error) {
      lastSaveError = error;
      logPhase("save_attempt", `failed_${attempt}`, { error: error.message });
    }
    await page.waitForTimeout(800 * attempt);
  }

  const saved = Boolean(putResponse);
  logPhase("save_result", saved ? "success" : "failed", { attempts: saveAttemptsUsed });

  if (!saved) {
    const finalPopupState = await readPopupState();
    const stillOpen = Boolean(finalPopupState?.open);
    if (stillOpen) {
      const popupErrors = finalPopupState.errors?.length ? ` [${finalPopupState.errors.join(" | ")}]` : "";
      const detail = lastSaveError?.message ? ` (${lastSaveError.message})` : popupErrors;
      throw new Error(`Salvataggio YAP non confermato dopo ${maxSaveAttempts} tentativi${detail}`);
    }
  }
  return { putResponse, saveAttemptsUsed, alreadyClosed };
}

async function summarizeResponseBody(response, limit = 1200) {
  if (!response) return null;
  try {
    const text = await response.text();
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  } catch {
    return null;
  }
}

async function runYapAutomation(job, args) {
  const _runStart = Date.now();
  const username = ensureEnv("YAP_USERNAME");
  const password = ensureEnv("YAP_PASSWORD");
  await fs.mkdir(args.artifactDir, { recursive: true });
  const safeMode = String(process.env.YAP_SAFE_MODE || "").trim() === "1";
  const launchArgs = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote",
    "--no-first-run", "--bwsi", "--hide-scrollbars", "--mute-audio",
    "--disable-background-networking", "--disable-background-timer-throttling",
    "--disable-client-side-phishing-detection", "--disable-default-apps",
    "--disable-hang-monitor", "--disable-popup-blocking", "--disable-prompt-on-repost",
    "--disable-sync", "--disable-translate", "--metrics-recording-only",
    "--safebrowsing-disable-auto-update", "--password-store=basic",
  ];
  if (safeMode) {
    launchArgs.push(
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--no-zygote",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
    );
  }

  logPhase("browser", "starting");
  let runtime = await createYapRuntime(chromium, {
    headed: args.headed,
    freshLogin: args.freshLogin,
    launchArgs,
    preferPersistentProfile: !args.noPersistProfile,
    resolveModule: requireFromYap.resolve.bind(requireFromYap),
    cwd: ROOT_DIR,
  });
  if (runtime.telemetry?.profile_lock) {
    logPhase("session", "profile_lock", {
      dir: runtime.telemetry.profile_lock.lock_path,
      acquired: runtime.telemetry.profile_lock.acquired,
      wait_ms: runtime.telemetry.profile_lock.wait_ms,
      owner_pid: runtime.telemetry.profile_lock.owner_pid,
    });
    if (!runtime.telemetry.profile_lock.acquired) {
      logPhase("session", "profile_fallback", { reason: "profile_busy" });
    }
  }
  let { browser, context, page } = runtime;
  let _pageCrashError = null;
  const _attachCrashHandler = (p) => { p.on("crash", () => { _pageCrashError = new Error("page.evaluate: Target crashed"); }); };
  _attachCrashHandler(page);

  // Il renderer di Chromium può crashare sotto pressione di memoria (container
  // Railway limitato + app GWT pesante). Una pagina con renderer crashato NON è
  // riutilizzabile: ogni page.goto/evaluate successivo rilancia "Page crashed".
  // Qui chiudiamo la pagina morta e ne creiamo una nuova nello stesso context
  // (il profilo persistente/sessione restano), liberando la memoria del renderer.
  const _isCrash = (msg) => /Target crashed|Page crashed/i.test(String(msg || "")) || !!_pageCrashError;
  async function recreatePageAfterCrash(attempt) {
    logPhase("browser", "recreating_page_after_crash", { attempt });
    _pageCrashError = null;
    try { await page.close({ runBeforeUnload: false }); } catch {}
    page = await context.newPage();
    _attachCrashHandler(page);
  }

  async function scanVisibleAgendaEventsWithRecovery(dateIso) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await scanVisibleAgendaEvents(page);
      } catch (error) {
        const message = String(error?.message || "");
        const recoverable = _isCrash(message)
          || /agenda_event_population_timeout|agenda_viewport_state_timeout|Execution context was destroyed|Cannot find context with specified id|Target closed|Page closed|Browser has been closed/i.test(message);
        if (!recoverable || attempt === 3) throw error;
        logPhase("dedup", "scan_retry", { attempt, error: message.slice(0, 180) });
        await recreatePageAfterCrash(attempt);
        await openAgendaWithRecovery(dateIso);
        await page.waitForTimeout(350 * attempt).catch(() => {});
      }
    }
    return [];
  }

  async function openAgendaWithRecovery(dateIso) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await openAgenda(page, dateIso);
        return;
      } catch (error) {
        const message = String(error?.message || "");
        // Recupero da crash del renderer: la pagina è morta, ricreala e riprova.
        if (_isCrash(message)) {
          if (attempt === 3) throw error;
          await recreatePageAfterCrash(attempt);
          await page.waitForTimeout(800 * attempt).catch(() => {});
          continue;
        }
        const needsRelogin = /agenda_redirected_to_login/i.test(message);
        const wrongDate = /agenda_date_not_reached:/i.test(message);
        if (!needsRelogin && !wrongDate) throw error;
        logPhase("agenda", needsRelogin ? "relogin" : "date_retry", { attempt, error: message.slice(0, 180) });
        await context.clearCookies().catch(() => {});
        await Promise.race([
          page.evaluate(() => {
            try { window.localStorage?.clear?.(); } catch {}
            try { window.sessionStorage?.clear?.(); } catch {}
          }),
          new Promise((r) => setTimeout(r, 3000)),
        ]).catch(() => {});
        await page.goto(process.env.YAP_BASE_URL || "https://yap.mmbsoftware.it", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        // Svuota sessionStorage DOPO domcontentloaded: a questo punto GWT non ha ancora
        // letto sessionStorage, quindi non può fare silent re-auth che blocca per ~200s.
        await Promise.race([
          page.evaluate(() => { try { window.sessionStorage?.clear?.(); } catch {} }),
          new Promise((r) => setTimeout(r, 3000)),
        ]).catch(() => {});
        try {
          await loginYap(page, username, password);
        } catch (retryError) {
          if (attempt === 3) throw retryError;
          // Se il crash è avvenuto durante loginYap, ricrea la pagina prima del retry
          // (altrimenti il prossimo openAgenda riuserebbe la pagina morta → fatale).
          if (_isCrash(retryError?.message)) {
            await recreatePageAfterCrash(attempt);
          }
          logPhase("agenda", "relogin_retry", { attempt, error: String(retryError?.message || retryError).slice(0, 180) });
          await page.waitForTimeout(500 * attempt).catch(() => {});
          continue;
        }
        // FIX doppio re-login: la sessione è appena stata stabilita da loginYap.
        // Diamo a GWT un attimo per propagare i cookie, poi proviamo SUBITO openAgenda
        // SENZA tornare in cima al loop (che ri-cancellerebbe i cookie appena impostati
        // e rifarebbe un login completo, bruciando ~50s di budget). Solo se questo
        // tentativo immediato fallisce ancora lasciamo proseguire il loop.
        await page.waitForTimeout(700).catch(() => {});
        try {
          await openAgenda(page, dateIso);
          return;
        } catch (postLoginError) {
          if (_isCrash(postLoginError?.message)) throw postLoginError;
          if (attempt === 3) throw postLoginError;
          logPhase("agenda", "post_login_retry", { attempt, error: String(postLoginError?.message || postLoginError).slice(0, 160) });
        }
        await page.waitForTimeout(350 * attempt).catch(() => {});
      }
    }
  }

  try {
    logPhase("session", "restoring");
    let didExplicitLogin = false;
    try {
      await openAgendaWithRecovery(job.appointment.date);
      logPhase("session", "restored");
    } catch (restoreError) {
      const message = String(restoreError?.message || "");
      const recoverable = /agenda_redirected_to_login|Timeout|ERR_FAILED|ERR_ABORTED|waiting for locator|agenda_date_not_reached|Target crashed|login_form_not_visible/i.test(message);
      if (!recoverable) throw restoreError;
      logPhase("session", "restore_failed", { error: message.slice(0, 180) });
      // Se il browser è crashato, ricrea il runtime con profilo pulito
      if (/Target crashed/i.test(message)) {
        logPhase("session", "browser_crashed_recovery");
        await context.close().catch(() => {});
        // Pulisce manualmente il profilo (Crash Reports + Default tranne Cookies)
        const profileDir = YAP_CHROME_PROFILE_DIR;
        try {
          const defaultEntries = await fs.readdir(path.join(profileDir, "Default")).catch(() => []);
          const keep = new Set(["Cookies", "Login Data", "Login Data-journal"]);
          for (const entry of defaultEntries) {
            if (!keep.has(entry)) await fs.rm(path.join(profileDir, "Default", entry), { recursive: true, force: true }).catch(() => {});
          }
          await fs.rm(path.join(profileDir, "Crash Reports"), { recursive: true, force: true }).catch(() => {});
        } catch (_) {}
        const newRuntime = await createYapRuntime(chromium, {
          headed: args.headed, freshLogin: true,
          launchArgs, preferPersistentProfile: !args.noPersistProfile,
          resolveModule: requireFromYap.resolve.bind(requireFromYap), cwd: ROOT_DIR,
        });
        runtime = newRuntime;
        ({ browser, context, page } = newRuntime);
        page.on("crash", () => { _pageCrashError = new Error("page.evaluate: Target crashed"); });
      }
      logPhase("login", "starting");
      await loginYap(page, username, password);
      didExplicitLogin = true;
      logPhase("login", "done");
      logPhase("agenda", "starting", { date: job.appointment.date, mode: "post_login" });
      await openAgendaWithRecovery(job.appointment.date);
      logPhase("agenda", "ready");
    }
    if (!didExplicitLogin) {
      logPhase("agenda", "ready");
    }
    const yapTags = pickYapTagsFromJob(job);
    if (args.debug) {
      console.log(
        JSON.stringify(
          {
            event: "yap-job-debug",
            practiceId: job.practiceId || null,
            plate: job.customer.plate,
            rawTime: job.appointment.rawTime || job.appointment.time,
            normalizedTime: job.appointment.time,
            duration: job.appointment.duration,
            contexts: job.contexts || [],
            tags: yapTags,
            phone: job.customer.phone || "",
          },
          null,
          2,
        ),
      );
    }
    // Scrolla all'orario target prima del dedup scan: waitForAgendaEventPopulation ritorna
    // al primo evento visibile, ma l'evento target potrebbe essere fuori viewport.
    if (job.appointment?.time) {
      const targetHour = String(job.appointment.time).split(":")[0].replace(/^0/, "");
      await page.evaluate((h) => {
        const rows = [...document.querySelectorAll("td.fc-axis.fc-time, .fc-time")];
        const target = rows.find((r) => (r.textContent || "").trim().startsWith(h));
        if (target) target.scrollIntoView({ block: "center", behavior: "instant" });
      }, targetHour).catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
    }
    logPhase("dedup", "scanning");
    const existingEvents = await scanVisibleAgendaEventsWithRecovery(job.appointment.date);
    const dedup = findExistingAppointment(existingEvents, {
      plate: job.customer.plate,
      date: job.appointment.date,
      time: job.appointment.time,
      toleranceMinutes: 0,
    });
    logPhase("dedup", dedup.hit ? "hit" : "miss", {
      events: existingEvents.length,
      plate: job.customer.plate,
      time: job.appointment.time,
      scanSample: existingEvents.slice(0, 6).map((e) => ({ time: e.time, title: String(e.title || "").slice(0, 60) })),
    });

    if (args.dryRun) {
      const suffix = `${job.practiceId || "payload"}-${Date.now()}`;
      let agendaPath = null;
      if (args.debug) {
        agendaPath = path.join(args.artifactDir, `agenda-check-${suffix}.png`);
        await page.screenshot({ path: agendaPath, fullPage: true });
      }

      const planned = {
        cosa: pickCosaFromJob(job),
        quando: toItalianDate(job.appointment.date),
        dalle: toYapTime(job.appointment.time),
        alle: toYapTime(addMinutes(job.appointment.time, job.appointment.duration)),
        tags: yapTags,
      };

      const syncLog = buildSyncLogEntry(job, {
        dryRun: true,
        action: dedup.hit ? "skip_duplicate" : "create_appointment",
        syncStatus: dedup.hit ? "synced" : "pending",
        yapPreview: planned,
        dedup,
      });

      return {
        saved: false,
        mode: "dry-run",
        screenshot: agendaPath,
        planned,
        dedupKey: buildDedupKey({
          plate: job.customer.plate,
          date: job.appointment.date,
          time: job.appointment.time,
        }),
        dedup,
        syncLog,
        telemetry: buildYapTelemetry({
          runtime,
          startedAtMs: _runStart,
        }),
        message: dedup.hit
          ? "Appuntamento già presente in agenda (dedup). Nessuna modifica."
          : "Accesso YAP e agenda verificati. Nessuna modifica eseguita su YAP.",
      };
    }

    logPhase("dedup", "done", { hit: dedup.hit });
    if (dedup.hit) {
      // Upsert su duplicato: apriamo l'evento esistente, riallineiamo popup/tag e continuiamo con ODL.
      // Il fallback per sola targa puo' aprire un altro appuntamento dello stesso
      // veicolo e il resync finirebbe per spostarlo. Serve identita' targa + ora.
      const openExisting = await clickExactAgendaEvent(page, {
        plate: job.customer.plate,
        time: job.appointment.time,
      });
      if (!openExisting?.success) {
        return {
          saved: false,
          mode: "commit-blocked-duplicate",
          dedup,
          message: "Commit bloccato: impossibile identificare con certezza lo slot YAP esatto.",
        };
      }
      await page.waitForTimeout(700);
      let putResponse = null;
      let saveAttemptsUsed = 0;
      let popupSaveError = null;
      let putResponseSummary = null;
      let popupResult = null;
      try {
        popupResult = await fillAppointmentPopup(page, job);
        // Niente block sul salvataggio: l'appuntamento va salvato comunque. Il prerequisito
        // veicolo vale solo per la pratica/preventivo (gestito a valle).
        const popupSave = await saveAppointmentPopup(page, { maxSaveAttempts: 4 });
        putResponse = popupSave.putResponse;
        saveAttemptsUsed = popupSave.saveAttemptsUsed;
        putResponseSummary = args.debug ? await summarizeResponseBody(putResponse) : null;
        await page.waitForTimeout(220);
      } catch (saveErr) {
        popupSaveError = saveErr?.message || "Salvataggio popup duplicato non confermato";
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(140);
      }
      let managementWrite = null;
      if (shouldWriteOdlFromWorker(job)) {
        managementWrite = await writePracticeAndOdl(page, job, args).catch((error) => ({
          attempted: true,
          ok: false,
          error: error.message,
        }));
      }
      // Audit anche sull'upsert: riporta esito tag/veicolo (non lasciare "verifica non conclusa").
      let dedupAudit = null;
      try {
        dedupAudit = await runInlineAudit(page, job, managementWrite, popupResult);
        logPhase("inline_audit", dedupAudit?.verified ? "verified" : "partial", {
          present: dedupAudit?.present?.length || 0,
          missing: dedupAudit?.missing?.length || 0,
        });
      } catch (auditErr) {
        logPhase("inline_audit", "error", { error: auditErr.message });
      }
      const dedupVerified = dedupAudit?.verified === true;
      return {
        saved: true,
        mode: "commit-upsert-duplicate",
        status: dedupVerified ? "complete_synced" : "agenda_synced",
        dedup,
        putAction: {
          detected: Boolean(putResponse),
          status: putResponse?.status(),
          url: putResponse?.url?.(),
          body_excerpt: putResponseSummary,
        },
        telemetry: buildYapTelemetry({
          runtime,
          startedAtMs: _runStart,
          extra: { saveAttempts: saveAttemptsUsed, audit: dedupAudit?.summary },
        }),
        warning: popupSaveError || undefined,
        managementWrite,
        write_report: managementWrite,
        inline_audit: dedupAudit,
        message: popupSaveError
          ? "Duplicato gestito: popup agenda non confermato, verifica tramite audit."
          : (dedupVerified
            ? "Appuntamento duplicato aggiornato e verificato su YAP."
            : "Appuntamento duplicato aggiornato su YAP."),
      };
    }

    logPhase("popup", "opening", { time: job.appointment.time });
    // Slot occupato -> avanza di +slotMinutes finché libero (disattivabile con YAP_SLOT_AUTO_SHIFT=0)
    if (String(process.env.YAP_SLOT_AUTO_SHIFT || "1").trim() !== "0") {
      const _slotScanStart = Date.now();
      const freeSlot = await resolveFreeSlotTime(page, job.appointment.time, getYapSlotMinutes());
      logAction("slot_scan", {
        requested: job.appointment.time,
        resolved: freeSlot.time,
        shifted: freeSlot.shifted,
        steps: freeSlot.steps,
        exhausted: freeSlot.exhausted || false,
        tried: freeSlot.tried, // [{time, occupied}] per ogni slot controllato
        scan_ms: Date.now() - _slotScanStart,
      });
      if (freeSlot.shifted) {
        logPhase("popup", "slot_shifted", {
          from: job.appointment.time, to: freeSlot.time, steps: freeSlot.steps,
        });
        job.appointment.time = freeSlot.time;
        job.appointment.slotShifted = { steps: freeSlot.steps, original: freeSlot.tried[0]?.time };
      } else if (freeSlot.exhausted) {
        logPhase("popup", "slot_no_free", { time: job.appointment.time });
      }
    }
    const _slotClickStart = Date.now();
    await clickApproximateSlot(page, job.appointment.time);
    logPhase("popup", "slot_clicked", { elapsed_ms: Date.now() - _slotClickStart });
    let popupResult = null;
    try {
      popupResult = await fillAppointmentPopup(page, job);
    } catch (firstError) {
      // Fallback rapido: in alcune sessioni il primo popup si apre incompleto.
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(180);
      await clickApproximateSlot(page, job.appointment.time);
      popupResult = await fillAppointmentPopup(page, job);
      if (args.debug) {
        console.warn(`Popup refill retry riuscito: ${firstError.message}`);
      }
    }
    // NIENTE block sul salvataggio AGENDA: l'appuntamento (targa+data/ora+tag) va salvato
    // comunque. Bloccarlo con Escape non ferma l'auto-save di YAP gia' scattato e creava
    // un secondo appuntamento orfano. Il prerequisito veicolo vale solo per la PRATICA
    // (preventivo/ODL), gestito piu' sotto con shouldBlockPracticeWriteForVehicle.

    const suffix = `${job.practiceId || "payload"}-${Date.now()}`;
    let beforeSavePath = null;
    if (args.debug) {
      beforeSavePath = path.join(args.artifactDir, `before-save-${suffix}.png`);
      await page.screenshot({ path: beforeSavePath, fullPage: true });
    }

    logPhase("popup", "filled");
    logPhase("save", "starting");
    const { putResponse, saveAttemptsUsed, alreadyClosed } = await saveAppointmentPopup(page, { maxSaveAttempts: 4 });
    logPhase("save", "done", { detected: Boolean(putResponse), alreadyClosed: alreadyClosed || false });
    const putResponseSummary = args.debug ? await summarizeResponseBody(putResponse) : null;
    await page.waitForTimeout(240);

    // VERIFICA VEICOLO AUTOREVOLE.
    // Caso 1: popup già chiuso al momento del salvataggio (alreadyClosed=true).
    //   YAP auto-salva e naviga alla pratica SOLO quando veicolo+data+ora sono tutti
    //   confermati. L'auto-chiusura E' prova sufficiente di aggancio -> non serve
    //   cercare l'evento in agenda (siamo già dentro la pratica, found=false).
    // Caso 2: popup chiuso dal worker (salvataggio normale).
    //   L'evento e' ancora visibile in agenda -> verifica dal titolo/tooltip.
    if (job.customer?.plate && popupResult && popupResult.vehicleState !== "not_found") {
      if (alreadyClosed && popupResult.vehicleState === "pending_confirmation") {
        let vCheck = await verifyVehicleInAgenda(
          page,
          job.customer.plate,
          job.appointment.time,
        );
        if (!vCheck.linked) {
          vCheck = await verifyVehicleInOpenedPractice(page, job.customer.plate);
        }
        logAction("vehicle_auto_close_verify", vCheck);
        popupResult.vehicleState = vCheck.linked ? "linked" : "failed";
        popupResult.vehicleLinked = vCheck.linked;
      } else {
        const vCheck = await verifyVehicleInAgenda(page, job.customer.plate, job.appointment.time);
        logAction("vehicle_agenda_verify", vCheck);
        if (vCheck.linked) {
          popupResult.vehicleState = "linked";
          popupResult.vehicleLinked = true;
        } else {
          popupResult.vehicleState = "failed";
          popupResult.vehicleLinked = false;
        }
      }
    }

    let afterSavePath = null;
    if (args.debug) {
      afterSavePath = path.join(args.artifactDir, `after-save-${suffix}.png`);
      await page.screenshot({ path: afterSavePath, fullPage: true });
    }
    let managementWrite = null;
    // PREREQUISITO: senza veicolo agganciato NON si entra in gestione pratica.
    // Qualsiasi stato diverso da "linked" blocca preventivo/ODL.
    const vehicleBlocksPractice = shouldBlockPracticeWriteForVehicle(job, popupResult);
    if (popupResult?.vehicleState !== "linked" && job.customer?.plate) {
      logPhase("vehicle", "not_confirmed", { plate: job.customer.plate, state: popupResult?.vehicleState || "unknown" });
      return {
        saved: true,
        mode: "commit-agenda-only",
        status: "agenda_synced",
        putAction: {
          detected: Boolean(putResponse),
          status: putResponse?.status(),
          url: putResponse?.url?.(),
          body_excerpt: putResponseSummary,
        },
        warning: "Veicolo non confermato con certezza: ODL/preventivo non avviati.",
        popup: popupResult,
        telemetry: buildYapTelemetry({
          runtime,
          startedAtMs: _runStart,
          extra: { saveAttempts: saveAttemptsUsed },
        }),
        message: "Appuntamento salvato, ma veicolo non confermato con certezza. ODL/preventivo bloccati.",
      };
    }
    if (shouldWriteOdlFromWorker(job) && vehicleBlocksPractice) {
      logPhase("odl", "skipped_no_vehicle", { plate: job.customer?.plate });
      managementWrite = {
        attempted: false,
        ok: false,
        skipped: true,
        reason: "vehicle_not_linked",
        error: "Veicolo non agganciato: impossibile aprire la gestione pratica.",
      };
    } else if (shouldWriteOdlFromWorker(job)) {
      logPhase("odl", "starting");
      managementWrite = await writePracticeAndOdl(page, job, args).catch((error) => ({
        attempted: true,
        ok: false,
        error: error.message,
      }));
      logPhase("odl", managementWrite?.ok === false ? "failed" : "done", { ok: managementWrite?.ok });
    }

    // Audit inline: verifica immediatamente che l'appuntamento sia stato scritto correttamente
    logPhase("inline_audit", "starting");
    let inlineAudit = null;
    try {
      inlineAudit = await runInlineAudit(page, job, managementWrite, popupResult);
      logPhase("inline_audit", inlineAudit?.verified ? "verified" : "partial", {
        present: inlineAudit?.present?.length || 0,
        missing: inlineAudit?.missing?.length || 0,
      });
    } catch (auditErr) {
      logPhase("inline_audit", "error", { error: auditErr.message });
    }

    const allVerified = inlineAudit?.verified === true;
    const finalStatus = allVerified ? "complete_synced" : "agenda_synced";
    const finalMessage = allVerified
      ? "Appuntamento YAP scritto e verificato: tutto ok."
      : "Appuntamento scritto su YAP. Verifica YAP per controllare i campi.";

    return {
      saved: true,
      mode: "commit",
      status: finalStatus,
      putAction: {
        detected: Boolean(putResponse),
        status: putResponse?.status(),
        url: putResponse?.url?.(),
        body_excerpt: putResponseSummary,
      },
      screenshot: afterSavePath,
      telemetry: buildYapTelemetry({
        runtime,
        startedAtMs: _runStart,
        extra: { saveAttempts: saveAttemptsUsed, audit: inlineAudit?.summary },
      }),
      managementWrite,
      write_report: managementWrite,
      inline_audit: inlineAudit,
      message: finalMessage,
    };
  } catch (error) {
    const errorSuffix = `${job.practiceId || "payload"}-${Date.now()}`;
    const errorScreenshotPath = path.join(args.artifactDir, `error-${errorSuffix}.png`);
    try {
      await page.screenshot({ path: errorScreenshotPath, fullPage: true });
      error.screenshotPath = errorScreenshotPath;
      console.warn(`Screenshot dell'errore salvato in: ${errorScreenshotPath}`);
    } catch (screenshotError) {
      console.warn(`Fallito screenshot dell'errore: ${screenshotError.message}`);
    }
    throw error;
  } finally {
    await runtime.close().catch(() => {});
  }
}

// Cleanup automatico: rimuove screenshot vecchi di test falliti (più di 7 giorni)
async function cleanupOldArtifacts(artifactDir, maxAgeDays = 7) {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    
    const entries = await fs.promises.readdir(artifactDir, { withFileTypes: true });
    let cleaned = 0;
    
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // Pattern: error-* o *-test-*.png più vecchi di maxAgeDays
      if (!entry.name.match(/error-|test-.*\.png$/)) continue;
      
      const filePath = path.join(artifactDir, entry.name);
      const stats = await fs.promises.stat(filePath);
      const age = now - stats.mtimeMs;
      
      if (age > maxAgeMs) {
        await fs.promises.unlink(filePath);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`[cleanup] Rimossi ${cleaned} file vecchi da ${artifactDir}`);
    }
  } catch (err) {
    // Silenzioso: cleanup non è critico
  }
}

async function notifyError(error, job, args) {
  const apiBaseUrl = args.apiBaseUrl || process.env.API_BASE_URL;
  if (!apiBaseUrl) return;

  const payload = {
    error_message: error.message,
    stack_trace: error.stack,
    screenshot_path: error.screenshotPath || null,
    practice_id: job?.practiceId || null,
    customer: job?.customer ? { name: job.customer.name, plate: job.customer.plate } : null,
    appointment: job?.appointment ? { date: job.appointment.date, time: job.appointment.time } : null,
    worker: "yap-worker.mjs",
  };

  try {
    const headers = { "content-type": "application/json" };
    if (process.env.YAP_WORKER_SECRET) {
      headers["X-Yap-Worker-Secret"] = process.env.YAP_WORKER_SECRET;
    }
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/yap/notify-error`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (response.ok) {
      console.warn("Notifica errore inviata al backend");
    }
  } catch (notifyErr) {
    console.warn(`Fallito invio notifica errore: ${notifyErr.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.payloadFile && !args.practiceId) {
    throw new Error("Serve --payload-file oppure --practice-id");
  }

  const _bootSuffix = `${args.practiceId || "payload"}-${_workerStart}`;
  setTimelineFile(args.artifactDir, _bootSuffix);
  logPhase("worker", "start", {
    build: WORKER_BUILD,
    dryRun: args.dryRun,
    practiceId: args.practiceId || null,
    payloadFile: args.payloadFile || null,
  });
  logPhase("worker", "reading_payload");
  const job = args.payloadFile ? await readPayloadFile(args.payloadFile, args) : await readPracticeFromApi(args);
  logAction("job_loaded", {
    plate: job.customer?.plate || null,
    contexts: job.contexts,
    date: job.appointment?.date,
    time: job.appointment?.time,
    dateDefaulted: job.appointment?.dateDefaulted || false,
    timeDefaulted: job.appointment?.timeDefaulted || false,
    duration: job.appointment?.duration,
    practiceType: job.appointment?.type || null,
    sections: (job.sections || []).map((s) => s.reparto),
  });
  logPhase("worker", "validating_job");
  validateJob(job);
  logPhase("worker", "cleanup_start");
  // Cleanup vecchi screenshot prima di eseguire (manutenzione automatica)
  await cleanupOldArtifacts(args.artifactDir, 7);
  logPhase("worker", "automation_start");
  const result = await runYapAutomation(job, args);
  logPhase("worker", "finished", { saved: result?.saved ?? null, mode: result?.mode ?? null });
  console.log(JSON.stringify({
    ok: true,
    worker_build: WORKER_BUILD,
    dryRun: args.dryRun,
    practiceId: job.practiceId,
    appointment: job.appointment,
    customer: {
      name: job.customer.name,
      plate: job.customer.plate,
    },
    timelineFile: _timelineFile,
    actionCount: _actionSeq,
    result,
  }, null, 2));
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch(async (error) => {
    logPhase("worker", "fatal_error", {
      error: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 1200),
    });
    // Prova a notificare l'errore al backend (se possibile)
    try {
      const args = parseArgs(process.argv.slice(2));
      const job = args.payloadFile
        ? await readPayloadFile(args.payloadFile, args).catch(() => null)
        : await readPracticeFromApi(args).catch(() => null);
      await notifyError(error, job, args);
    } catch {
      // Ignora errori nella notifica
    }

    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      stack: error.stack,
      screenshot: error.screenshotPath || null,
    }, null, 2));
    process.exit(1);
  });
}

export {
  WORKSPACE_STATES,
  buildFieldWriteReport,
  buildOdlNeedles,
  buildOdlSummaryText,
  buildSectionSummary,
  buildWorkGridDescriptionLines,
  extractTrailingJsonBlock,
  formatMacNeedle,
  formatManNeedle,
  isEffectiveOdlState,
  hasVerifiedOdlWorkspace,
  normalizeLoose,
  parsePraticaHashPayload,
  shouldBlockAppointmentSaveForVehicle,
  shouldBlockPracticeWriteForVehicle,
};
