#!/usr/bin/env node
import fs from "node:fs/promises";
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

const _workerStart = Date.now();
process.stderr.write(JSON.stringify({ event: "yap:phase", phase: "worker", status: "module_loaded", ts: new Date().toISOString(), pid: process.pid }) + "\n");
function logPhase(phase, status, extra = {}) {
  process.stderr.write(JSON.stringify({
    event: "yap:phase",
    phase,
    status,
    elapsed_ms: Date.now() - _workerStart,
    ts: new Date().toISOString(),
    ...extra,
  }) + "\n");
}

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
      appointment: {
        date: toIsoDate(overrides.date || input.agenda.data),
        rawTime: overrides.time || input.agenda.ora || "",
        time: (() => {
          const rawTime = overrides.time || input.agenda.ora || "";
          return rawTime ? normalizeAppointmentTime(rawTime) : "";
        })(),
        duration: Number(overrides.duration || input.agenda.durata_minuti || getYapSlotMinutes()),
        type: input.agenda.tipo_pratica || "",
      },
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
    appointment: {
      date: toIsoDate(overrides.date || appointment.date),
      rawTime: overrides.time || appointment.time || "",
      time: (() => {
        const rawTime = overrides.time || appointment.time || "";
        return rawTime ? normalizeAppointmentTime(rawTime) : "";
      })(),
      duration: Number(overrides.duration || appointment.slot_duration || getYapSlotMinutes()),
      type: appointment.practice_type || "",
    },
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

function shouldWriteOdlFromWorker() {
  return String(process.env.YAP_WRITE_ODL || "1").trim() !== "0";
}

function normalizeLoose(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
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
  if (job.internalNotes) needles.push(job.internalNotes);
  for (const section of job.sections || []) {
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
  if (job.internalNotes) {
    blocks.push(`Note interne: ${String(job.internalNotes).trim()}`);
  }
  for (const section of job.sections || []) {
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

    let best = rows[0];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const item of rows) {
      const diff = Math.abs(item.minutes - targetMinutes);
      const penalty = item.minutes < targetMinutes ? 1 : 0;
      const score = diff + penalty;
      if (score < bestScore) {
        best = item;
        bestScore = score;
      }
    }

    best.cell.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const rect = best.cell.getBoundingClientRect();
    return {
      time: best.time,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }, normalizedTarget).catch(() => null);

  if (candidate) {
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
    slot = sorted[0];
    for (const item of sorted) {
      const candidateTime = item.text || item.time;
      if (minutesOf(candidateTime) <= targetMinutes) {
        slot = item;
      }
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

async function addYapTagChips(page, tags) {
  if (!tags.length) return;

  await safeEvaluate(page, (desiredTags) => {
    const popups = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")];
    const popup = popups.find((p) => (p.textContent || "").includes("Dettagli"));
    if (!popup) return;

    const normalize = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const isPressedNode = (node) => {
      if (!node) return false;
      const pressed = node.getAttribute("aria-pressed");
      if (pressed === "true") return true;
      const cls = normalize(node.className || "");
      return /\b(active|selected|checked|on)\b/.test(cls);
    };
    const findTagHost = (tag) => {
      const tagNorm = normalize(tag);
      const candidates = [...popup.querySelectorAll("button, a, [role='button'], .gwt-ToggleButton, .gwt-Button, div, span")]
        .filter(isVisible)
        .map((el) => {
          const text = normalize(el.textContent || el.getAttribute("title") || el.getAttribute("aria-label") || "");
          return { el, text };
        })
        .filter((item) => item.text === tagNorm || item.text.includes(tagNorm));
      return candidates[0]?.el || null;
    };

    const findToggleHost = (el) => (
      el?.closest?.("[aria-pressed], .gwt-ToggleButton, [role='button'], button, a") || el
    );

    for (const tag of desiredTags) {
      const host = findToggleHost(findTagHost(tag));
      if (host) {
        if (isPressedNode(host)) continue;
        host.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        continue;
      }

      const tagInputs = [...popup.querySelectorAll("input")].filter((inp) => {
        const section = inp.closest("div");
        return section && (section.textContent || "").includes("Tag");
      });
      const tagInput = tagInputs[tagInputs.length - 1];
      if (tagInput) {
        tagInput.focus();
        tagInput.value = tag;
        tagInput.dispatchEvent(new Event("input", { bubbles: true }));
        tagInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
    }

    // Fallback robusto: prova sempre ad inserire i tag desiderati nell'input Tag.
    const tagInputs = [...popup.querySelectorAll("input")].filter((inp) => {
      const section = inp.closest("div");
      return section && /tag/i.test(section.textContent || "");
    });
    const tagInput = tagInputs[tagInputs.length - 1];
    if (tagInput) {
      for (const tag of desiredTags) {
        tagInput.focus();
        tagInput.value = tag;
        tagInput.dispatchEvent(new Event("input", { bubbles: true }));
        tagInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
    }
  }, tags);
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

async function clickOdlSection(page) {
  const candidate = await safeEvaluate(page, () => {
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
      return rect.y < 140;
    });
    const ranked = candidates
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        let score = 0;
        if (/^ordini di lavoro$/i.test(text)) score += 20;
        if (/^ordini di lavoro/i.test(text)) score += 12;
        if (/tab|item|label/i.test(String(el.className || ""))) score += 6;
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
    return ranked[0] || null;
  }).catch(() => null);
  if (!candidate) return { clicked: false, label: null };
  await page.mouse.click(candidate.x, candidate.y).catch(() => {});
  await page.waitForTimeout(120).catch(() => {});
  return { clicked: true, label: String(candidate.text || "").slice(0, 100) };
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

async function clickBottomSectionTab(page, label) {
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
      .filter((item) => item.rect.y > (window.innerHeight - 140))
      .map((item) => {
        let score = 0;
        if (item.text === target) score += 20;
        if (item.title.toLowerCase() === target) score += 8;
        if (/td|span|a|button/i.test(item.tag)) score += 4;
        if (/tab|item|label/i.test(item.cls)) score += 4;
        if (item.rect.width >= 40 && item.rect.width <= 180) score += 4;
        if (item.rect.height >= 16 && item.rect.height <= 40) score += 3;
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
    return [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")]
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
      .filter((item) => item.y > (window.innerHeight - 160))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .slice(0, 60);
  }).catch(() => []);
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

async function openPracticeFromAppointment(page, job) {
  const searchTerms = [job.customer?.plate, pickCosaFromJob(job)].filter(Boolean);
  const strategies = [
    { type: "footer", slotIndex: 2 },
    { type: "footer", slotIndex: 2, retry: true },
    { type: "text" },
  ];
  const attempts = [];

  const ensurePopup = async () => {
    const visible = await waitForAppointmentPopup(page, 600);
    if (visible) return true;
    const reopened = await clickAgendaEvent(page, searchTerms).catch(() => ({ success: false }));
    if (!reopened?.success) return false;
    return waitForAppointmentPopup(page, 1500);
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

// F3: naviga all'ODL cambiando hash in-place (niente page.goto → GWT non fa full-reload)
async function openOdlByRoute(page, currentUrl) {
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

    const token = JSON.stringify({
      IdCompanyFolder: parsed.idCompanyFolder,
      Page: "ODL",
      ShowOdlMarcatempo: true,
    });
    await page.evaluate((t) => { window.location.hash = `#!pratica|${t}`; }, token);
    return {
      attempted: true,
      navigated: true,
      reason: null,
      idCompanyFolder: parsed.idCompanyFolder,
      pageEnum: "ODL",
    };
  } catch (error) {
    return { attempted: true, navigated: false, reason: String(error?.message || "error") };
  }
}

// F2: seleziona il widget Veicolo nel popup appuntamento e collega la targa
async function selectVehicleByPlate(page, plate) {
  if (!plate) return { found: false, reason: "no_plate" };
  const cleanPlate = String(plate).trim().toUpperCase();

  // Step 1: individua l'input Veicolo nel popup tramite il contesto del DOM
  const vehicleInputCoords = await safeEvaluate(page, (targetPlate) => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.display !== "none" && s.visibility !== "hidden";
    };
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel, .gwt-PopupPanel")]
      .find((p) => isVisible(p) && (p.textContent || "").toLowerCase().includes("dettagli appuntamento"));
    if (!popup) return null;

    const inputs = [...popup.querySelectorAll("input[type='text'], input:not([type])")].filter(isVisible);
    for (const input of inputs) {
      // Cerca "veicolo" / "autoveicolo" in max 5 antenati
      let node = input;
      for (let i = 0; i < 5; i++) {
        node = node?.parentElement;
        if (!node || node === popup) break;
        const txt = ([...node.childNodes].map((n) => n.nodeType === 3 ? n.textContent : "").join("")).toLowerCase();
        if (txt.includes("veicolo") || txt.includes("autoveicolo")) {
          const r = input.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, strategy: "ancestor_text" };
        }
      }
    }
    // Fallback: cerca label "Veicolo" nel popup e poi l'input fratello
    const labels = [...popup.querySelectorAll("td, label, span, div")]
      .filter(isVisible)
      .find((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return t === "veicolo" || t === "autoveicolo";
      });
    if (labels) {
      const tr = labels.closest("tr") || labels.parentElement;
      const sibInput = tr ? [...tr.querySelectorAll("input")].find(isVisible) : null;
      if (sibInput) {
        const r = sibInput.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, strategy: "sibling_label" };
      }
    }
    return null;
  }, cleanPlate).catch(() => null);

  if (!vehicleInputCoords) return { found: false, reason: "vehicle_input_not_found" };

  // Step 2: click + type (usa keyboard per triggerare autocomplete GWT)
  await page.mouse.click(vehicleInputCoords.x, vehicleInputCoords.y).catch(() => {});
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+a").catch(() => {});
  await page.keyboard.type(cleanPlate, { delay: 55 }).catch(() => {});
  await page.waitForTimeout(700);

  // Step 3: clicca il primo suggerimento del dropdown autocomplete
  const selected = await safeEvaluate(page, (targetPlate) => {
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
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, cleanPlate).catch(() => false);

  if (!selected) {
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(250);
  return { found: true, strategy: vehicleInputCoords.strategy, selected };
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

async function fillBestEditableByKeywords(page, keywords, value, { append = false } = {}) {
  const textValue = String(value || "").trim();
  if (!textValue) return false;
  return safeEvaluate(page, ({ keywordsRaw, text, appendMode }) => {
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
    if (!target) return false;

    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    const current = isInput ? (target.value || "") : (target.innerText || target.textContent || "");
    const nextValue = appendMode && current ? `${current}\n${text}` : text;

    target.focus();
    if (isInput) target.value = nextValue;
    else target.textContent = nextValue;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.blur();
    return true;
  }, { keywordsRaw: keywords, text: textValue, appendMode: Boolean(append) }).catch(() => false);
}

async function fillWithRetry(page, attempts, value, options = {}, { debug = false, fieldId = "" } = {}) {
  const plans = Array.isArray(attempts) ? attempts : [];
  for (let i = 0; i < plans.length; i++) {
    const attempt = plans[i];
    const keywords = Array.isArray(attempt) ? attempt : (attempt?.keywords || []);
    const append = typeof attempt === "object" && "append" in attempt ? attempt.append : options.append;
    if (debug) logPhase("fill_attempt", `plan_${i}`, { fieldId, keywords: keywords.slice(0, 3), value: String(value).slice(0, 50) });
    const ok = await fillBestEditableByKeywords(page, keywords, value, { ...options, append });
    if (ok) {
      if (debug) logPhase("fill_success", fieldId, { plan: i, keywords: keywords.slice(0, 3) });
      return true;
    }
    await page.waitForTimeout(60).catch(() => {});
  }
  if (debug) logPhase("fill_failed", fieldId, { attempts: plans.length });
  return false;
}

async function appendStructuredBlockToAnyTextarea(page, text) {
  const payload = String(text || "").trim();
  if (!payload) return false;
  return safeEvaluate(page, (blockText) => {
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
    const targets = [...document.querySelectorAll(selectors.join(", "))].filter(el => {
      if (!isVisible(el)) return false;
      const ce = el.getAttribute("contenteditable");
      if (ce === "false") return false;
      return true;
    });
    if (!targets.length) return false;
    const target = targets.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
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
      target.textContent = nextValue;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.blur();
    return true;
  }, payload).catch(() => false);
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
  const pushField = (fieldId, expected, ok, hint) => {
    fields.push({
      field_id: fieldId,
      expected: expected ?? "",
      found: ok ? String(expected ?? "") : null,
      status: ok ? "written" : "missing",
      hint,
    });
  };

  if (job.internalNotes) {
    pushField("note.interne", String(job.internalNotes).trim(), Boolean(writeReport?.notes?.success), "Apri Gestione pratica e verifica note interne.");
  }

  for (const section of job.sections || []) {
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
      pushField(`odl.${reparto}.smaltimento`, String(section.smaltimento_percentuale ?? 2), Boolean(writeReport?.waste?.success), "Apri Smaltimento rifiuti e verifica percentuale.");
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

async function writePracticeAndOdl(page, job, args) {
  const summary = buildOdlSummaryText(job);
  const writeReport = {
    attempted: true,
    openedPractice: false,
    openedOdl: false,
    odlRouteAttempted: false,
    odlRouteEffective: false,
    odlFallbackClickUsed: false,
    agenda: { attempted: false, success: false, error: null },
    tags: { attempted: false, success: false, error: null },
    notes: { attempted: Boolean(job.internalNotes), success: false, error: null },
    odl: { attempted: Boolean((job.sections || []).length), success: false, error: null, sections: [] },
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
  logPhase("automatismi_wait", "starting", { state: await getPracticeWorkspaceState(page) });
  let workspaceState = await getPracticeWorkspaceState(page);
  let autoAttempts = 0;
  const autoPollMs = Number(process.env.YAP_AUTOMATISMI_POLL_MS) || 1000;
  const autoMaxMs = Math.max(4000, Number(process.env.YAP_AUTOMATISMI_MAX_MS) || 20000);
  const maxAutoAttempts = Math.ceil(autoMaxMs / autoPollMs); // default 20s / 1s = 20 tentativi, early-exit se pronto
  while ((workspaceState === "loading_shell" || workspaceState === "unknown") && autoAttempts < maxAutoAttempts) {
    await page.waitForTimeout(autoPollMs);
    workspaceState = await getPracticeWorkspaceState(page);
    autoAttempts++;
    // Early exit se ODL pronto o pratica pronta
    if (workspaceState === "odl_full" || workspaceState === "detail_form") {
      logPhase("automatismi_early_exit", workspaceState, { attempts: autoAttempts });
      break;
    }
  }
  // Se ancora loading, prova refresh e riprova
  if (workspaceState === "loading_shell" || workspaceState === "unknown") {
    logPhase("automatismi_refresh", "attempting");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(5000);
    workspaceState = await getPracticeWorkspaceState(page);
  }
  logPhase("automatismi_wait", "done", { attempts: autoAttempts, finalState: workspaceState });
  writeReport.workspaceState = workspaceState;
  if (args.debug) {
    const practiceShot = path.join(args.artifactDir, `practice-open-${job.practiceId || "payload"}-${Date.now()}.png`);
    await page.screenshot({ path: practiceShot, fullPage: true }).catch(() => {});
    writeReport.practiceScreenshot = practiceShot;
  }

  // Scrivi note interne nella tab corrente (dati pratica) PRIMA di navigare all'ODL.
  if (job.internalNotes) {
    try {
      writeReport.notes.success = await fillWithRetry(
        page,
        [
          ["note interne", "note", "pratica", "annotazioni"],
          ["note", "annotazioni"],
          ["note"],
        ],
        String(job.internalNotes).trim(),
        { append: true },
      );
      if (!writeReport.notes.success) {
        // Diagnostica: conta elementi editabili visibili per debug.
        const editableCount = await safeEvaluate(page, () => {
          const isVisible = (el) => {
            const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el);
            return r.width > 8 && r.height > 8 && s.display !== "none" && s.visibility !== "hidden";
          };
          return [...document.querySelectorAll("textarea, [contenteditable], [role='textbox']")]
            .filter(el => isVisible(el) && el.getAttribute("contenteditable") !== "false").length;
        }).catch(() => -1);
        logPhase("notes_editable_scan", "info", { editableCount });
        // Fallback: qualsiasi elemento editabile visibile nella pagina dati pratica.
        const noteFallback = await appendStructuredBlockToAnyTextarea(page, String(job.internalNotes).trim());
        writeReport.notes.success = noteFallback;
        logPhase("notes_fallback", noteFallback ? "done" : "failed");
      }
      if (!writeReport.notes.success) writeReport.notes.error = "notes_field_not_found";
    } catch (error) {
      writeReport.notes.error = error?.message || "notes_write_failed";
    }
  }

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
    return writeReport; // early return — niente da scrivere senza veicolo
  }
  // F3+F4: naviga all'ODL via hash in-place + gating su RPC
  let odlNavigated = false;
  const practiceUrl = page.url();
  if (/#!pratica/i.test(practiceUrl)) {
    writeReport.odlRouteAttempted = true;
    const odlReadyPromise = page.waitForResponse(
      (r) => /\/yap\/action\/(OdlGetAnagraficheDepositoVeicoloAction|OdlGetAction|OdlTableAction|PraticaOdlGetOverviewAction)/.test(r.url()) && r.status() === 200,
      { timeout: 20000 },
    ).then(() => true).catch(() => false);
    const routeResult = await openOdlByRoute(page, practiceUrl);
    if (args.debug) writeReport.odlRouteResult = routeResult;
    logPhase("odl_route", routeResult.navigated ? "navigated" : "failed", { reason: routeResult.reason, idCompanyFolder: routeResult.idCompanyFolder });
    if (routeResult.navigated) {
      logPhase("odl_tab", "route_navigated", { idCompanyFolder: routeResult.idCompanyFolder });
      const odlRpcReady = await odlReadyPromise;
      if (args.debug) writeReport.odlRpcReady = odlRpcReady;
      logPhase("odl_route", "waiting_ready", { rpcReady: odlRpcReady });
      await waitForOdlWorkspaceReady(page, 15000);
      await page.waitForTimeout(400);
      workspaceState = await getPracticeWorkspaceState(page);
      let odlWaitAttempts = 0;
      while ((workspaceState === WORKSPACE_STATES.LOADING || workspaceState === WORKSPACE_STATES.UNKNOWN || workspaceState === WORKSPACE_STATES.ODL_LOADING) && odlWaitAttempts < 10) {
        await page.waitForTimeout(800);
        workspaceState = await getPracticeWorkspaceState(page);
        odlWaitAttempts++;
      }
      if (args.debug) writeReport.odlWaitAttempts = odlWaitAttempts;
      writeReport.workspaceState = workspaceState;
      const urlAfterRoute = page.url();
      writeReport.urlAfterOdlRoute = urlAfterRoute;
      const parsedAfterRoute = parsePraticaHashPayload(urlAfterRoute);
      writeReport.pageEnumAfterRoute = parsedAfterRoute.pageEnum ?? (parsedAfterRoute.ok ? "no_page_field" : parsedAfterRoute.reason);
      if (isEffectiveOdlState(workspaceState)) {
        odlNavigated = true;
        writeReport.odlRouteEffective = true;
        writeReport.openedOdl = true;
      } else {
        writeReport.odlRouteEffective = false;
        writeReport.odl.error = "odl_route_ineffective";
        writeReport.odlRouteReason = `state_after_route:${workspaceState}`;
        logPhase("odl_route", "ineffective", { workspaceState, pageEnum: writeReport.pageEnumAfterRoute });
      }
    } else {
      writeReport.odlRouteReason = routeResult.reason || "odl_route_failed";
    }
  }

  // Fallback: click sul tab (se la route non era disponibile o la navigazione è fallita)
  if (!odlNavigated) {
    writeReport.odlFallbackClickUsed = true;
    let odlTab = await clickOdlSection(page);
    if (!odlTab?.clicked) {
      if (args.debug) writeReport.odlTopCandidatesBeforeRetry = await snapshotTopOdlCandidates(page);
      await dismissVehicleSearchOverlay(page);
      await page.waitForTimeout(200);
      odlTab = await clickOdlSection(page);
    }
    if (!odlTab?.clicked) {
      const fallbackOdl = page.locator("button, a, [role='button'], .gwt-Label, span, div, td").filter({ hasText: /ordini di lavoro|\bodl\b/i }).first();
      if (await fallbackOdl.count()) {
        await fallbackOdl.click().catch(() => {});
        odlTab = { clicked: true, label: "fallback:odl" };
      }
    }
    if (odlTab?.clicked) {
      if (args.debug) writeReport.odlTopCandidates = await snapshotTopOdlCandidates(page);
      logPhase("odl_tab", "click_opened", { label: odlTab.label });
      await waitForOdlWorkspaceReady(page, 10000);
      workspaceState = await getPracticeWorkspaceState(page);
      if (!isEffectiveOdlState(workspaceState)) {
        await dismissVehicleSearchOverlay(page);
        const secondOdl = await clickOdlSection(page);
        if (secondOdl?.clicked) {
          logPhase("odl_tab", "click_hop2", { label: secondOdl.label });
          await waitForOdlWorkspaceReady(page, 10000);
          workspaceState = await getPracticeWorkspaceState(page);
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

  const noteSummaryBlock = buildOdlSummaryText(job);
  if (writeReport.openedOdl) {
    if (args.debug) {
      writeReport.bottomTabsBeforeNote = await snapshotBottomSectionTabs(page);
    }
    logPhase("odl_notes_tab", "opening");
    const noteTabOpened = await clickBottomSectionTab(page, "Note interne");
    if (noteTabOpened) {
      await page.waitForTimeout(120);
      if (args.debug) {
        writeReport.bottomTabsAfterNote = await snapshotBottomSectionTabs(page);
      }
      if (args.debug) {
        const noteTabShot = path.join(args.artifactDir, `note-tab-${job.practiceId || "payload"}-${Date.now()}.png`);
        await page.screenshot({ path: noteTabShot, fullPage: true }).catch(() => {});
        writeReport.noteTabScreenshot = noteTabShot;
      }
      const noteSummaryOk = await appendStructuredBlockToAnyTextarea(page, noteSummaryBlock);
      if (noteSummaryOk) {
        writeReport.notes.success = true;
        writeReport.notes.error = null;
        writeReport.fallbackSummaryWritten = true;
      }
    }
  }

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
    const sectionSummaryParts = [];
    if (job.internalNotes && !writeReport.notes.success && writeReport.odl.sections.length === 0) {
      sectionSummaryParts.push(`Note interne: ${String(job.internalNotes).trim()}`);
    }
    sectionSummaryParts.push(buildSectionSummary(section));
    const sectionSummary = sectionSummaryParts.join("\n");
    const sectionWritten = await fillWithRetry(
      page,
      [
        [...repartoKeys, "descrizione", "lavoro", "odl", "intervento", "note reparto"],
        [...repartoKeys, "odl", "descrizione"],
        [...repartoKeys, "lavoro", "intervento"],
      ],
      sectionSummary,
      { append: true },
    );
    writeReport.odl.sections.push({ reparto, yapReparto, written: sectionWritten });
    writeReport.odl.success = writeReport.odl.success || sectionWritten;

    if (section.ore_man != null) {
      writeReport.hours.man.attempted = true;
      const manOk = await fillWithRetry(
        page,
        [
          [...repartoKeys, "man", "ore uomo", "manodopera"],
          [...repartoKeys, "manodopera", "man"],
          [...repartoKeys, "ore uomo", "man"],
        ],
        String(section.ore_man),
      );
      writeReport.hours.man.success = writeReport.hours.man.success || manOk;
      if (!manOk && !writeReport.hours.man.error) writeReport.hours.man.error = "man_field_not_found";
      writeReport.odl.success = writeReport.odl.success || manOk;
    }
    if (section.ore_mac != null) {
      writeReport.hours.mac.attempted = true;
      const macOk = await fillWithRetry(
        page,
        [
          [...repartoKeys, "mac", "ore macchina", "manodopera"],
          [...repartoKeys, "manodopera", "mac"],
          [...repartoKeys, "ore macchina", "mac"],
        ],
        String(section.ore_mac),
      );
      writeReport.hours.mac.success = writeReport.hours.mac.success || macOk;
      if (!macOk && !writeReport.hours.mac.error) writeReport.hours.mac.error = "mac_field_not_found";
      writeReport.odl.success = writeReport.odl.success || macOk;
    }
    if (section.materiali_euro != null) {
      writeReport.materials.attempted = true;
      const matOk = await fillWithRetry(
        page,
        [
          [...repartoKeys, "materiali", "consumo", "euro"],
          [...repartoKeys, "materiali di consumo", "materiali"],
          [...repartoKeys, "materiali"],
        ],
        String(section.materiali_euro),
      );
      writeReport.materials.success = writeReport.materials.success || matOk;
      if (!matOk && !writeReport.materials.error) writeReport.materials.error = "materials_field_not_found";
    }
    if (section.smaltimento_applica) {
      writeReport.waste.attempted = true;
      const smaltOk = await fillWithRetry(
        page,
        [
          [...repartoKeys, "smaltimento", "rifiuti", "%"],
          [...repartoKeys, "smaltimento rifiuti", "smaltimento"],
          [...repartoKeys, "rifiuti", "percentuale"],
        ],
        String(section.smaltimento_percentuale ?? 2),
      );
      writeReport.waste.success = writeReport.waste.success || smaltOk;
      if (!smaltOk && !writeReport.waste.error) writeReport.waste.error = "waste_field_not_found";
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
        const partsOk = await fillWithRetry(
          page,
          [
            [...repartoKeys, "ricambi", "articoli", "magazzino", "pezzi"],
            [...repartoKeys, "articoli magazzino", "ricambi"],
            [...repartoKeys, "ricambi", "articoli"],
          ],
          partsText,
          { append: true },
        );
        writeReport.parts.success = writeReport.parts.success || partsOk;
        if (!partsOk && !writeReport.parts.error) writeReport.parts.error = "parts_field_not_found";
      }
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
    const fallbackOk = await appendStructuredBlockToAnyTextarea(page, summary);
    writeReport.notes.success = writeReport.notes.success || fallbackOk;
    if (fallbackOk && writeReport.notes.error === "notes_field_not_found") writeReport.notes.error = null;
  }

  logPhase("odl_sections", "done");
  await clickGenericSaveInPractice(page).catch(() => false);
  await page.waitForTimeout(120);

  const needles = buildOdlNeedles(job);
  const scopedText = await safeEvaluate(page, () => {
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
    if (section.smaltimento_applica && !writeReport.waste.success && hasNeedle(String(section.smaltimento_percentuale ?? 2))) {
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
  const matched = needles.filter((needle) => normalizedScoped.includes(normalizeLoose(needle))).length;
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
  const odlRequested = shouldWriteOdlFromWorker() && Boolean((job.sections || []).length);
  writeReport.ok = Boolean(
    writeReport.openedPractice
    && (job.internalNotes ? writeReport.notes.success || anyOdlFieldSuccess : true)
    && (!odlRequested || (writeReport.openedOdl && anyOdlFieldSuccess))
  );
  if (args.debug) {
    writeReport.summary = summary;
  }
  writeReport.fields = buildFieldWriteReport(job, writeReport);
  return writeReport;
}

async function fillAppointmentPopup(page, job) {
  const rect = await appointmentPopupRect(page);
  if (!rect) {
    throw new Error("Popup 'Dettagli appuntamento' non trovato");
  }

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

  await fillVisibleInput(page, cosaInput.index, cosaValue);

  // F2-bis: gestione dropdown autocomplete veicolo dopo aver scritto la targa in "Cosa"
  if (job.customer?.plate) {
    await page.waitForTimeout(300).catch(() => {});
    const plateSelected = await safeEvaluate(page, (targetPlate) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 8 && r.height > 8 && s.display !== "none" && s.visibility !== "hidden";
      };
      // Cerca dropdown di autocomplete (suggestion popup o lista risultati)
      const suggestions = [...document.querySelectorAll(".gwt-SuggestBoxPopup, .gwt-PopupPanel, [role='listbox'], .dropdown, .autocomplete")]
        .filter(isVisible);
      for (const popup of suggestions) {
        const items = [...popup.querySelectorAll("div, span, td, tr, li, [role='option']")]
          .filter(isVisible)
          .filter((el) => el.textContent.toUpperCase().includes(targetPlate.toUpperCase()));
        if (items.length > 0) {
          items[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          return { selected: true, match: items[0].textContent.trim() };
        }
      }
      // Fallback: cerca qualsiasi elemento visibile con la targa (risultato ricerca)
      const matches = [...document.querySelectorAll("div, span, td, tr")]
        .filter(isVisible)
        .filter((el) => el.textContent.toUpperCase().includes(targetPlate.toUpperCase()));
      if (matches.length > 0) {
        const best = matches.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
        best.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return { selected: true, match: best.textContent.trim() };
      }
      return { selected: false };
    }, job.customer.plate).catch(() => ({ selected: false }));
    if (plateSelected?.selected) {
      await page.waitForTimeout(200).catch(() => {});
    }
  }

  await fillVisibleInput(page, dateIndex, toItalianDate(job.appointment.date));
  await fillVisibleInput(page, timeIndexes[0], toYapTime(job.appointment.time));
  await fillVisibleInput(page, timeIndexes[1], toYapTime(endTime));

  const emptyAfterTimes = inputs.filter(
    (item) => item.index > timeIndexes[1] && !item.value && item.width > 40,
  );
  if (notes && emptyAfterTimes[0]) {
    await fillVisibleInput(page, emptyAfterTimes[0].index, notes).catch(() => {});
  }

  const yapTags = pickYapTagsFromJob(job);
  await addYapTagChips(page, yapTags);

  // F2: prova a selezionare il veicolo tramite il widget Veicolo del popup (non-fatal)
  if (job.customer?.plate) {
    await selectVehicleByPlate(page, job.customer.plate).catch(() => {});
  }
}

async function saveAppointmentPopup(page, { maxSaveAttempts = 3 } = {}) {
  let putResponse = null;
  let saveAttemptsUsed = 0;
  let lastSaveError = null;
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
      if (confirmPopupCheck) {
        logPhase("save_popup", "confirm_popup_detected", { attempt, ...confirmPopupCheck });
        putResponse = { status: () => 200, url: () => "local://confirm-popup" };
        break;
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
      // Usa le coordinate del candidate (già promosso al DIV/clickTarget da readPopupState).
      // page.mouse.click è un evento OS-level che GWT non può ignorare.
      // Prima move per simulare hover (alcuni GWT button attivano solo su hover+click).
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

      // Aspetta fino a 3s che il popup si chiuda: GWT processa il click in modo asincrono
      let popupAfterClick = null;
      for (let w = 0; w < 6; w += 1) {
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
  return { putResponse, saveAttemptsUsed };
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
  const runtime = await createYapRuntime(chromium, {
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
  page.on("crash", () => { _pageCrashError = new Error("page.evaluate: Target crashed"); });

  async function openAgendaWithRecovery(dateIso) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await openAgenda(page, dateIso);
        return;
      } catch (error) {
        const message = String(error?.message || "");
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
          logPhase("agenda", "relogin_retry", { attempt, error: String(retryError?.message || retryError).slice(0, 180) });
          await page.waitForTimeout(500 * attempt).catch(() => {});
          continue;
        }
        if (attempt === 3) {
          await openAgenda(page, dateIso);
          return;
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
      const recoverable = /agenda_redirected_to_login|Timeout|ERR_FAILED|ERR_ABORTED|waiting for locator|agenda_date_not_reached|Target crashed/i.test(message);
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
    logPhase("dedup", "scanning");
    const existingEvents = await scanVisibleAgendaEvents(page);
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
      const dedupTitle = dedup?.event?.title || "";
      const dedupTime = dedup?.event?.time || "";
      const preferredTerms = [
        job.customer.plate,
        dedupTitle,
        pickCosaFromJob(job),
        job.customer.name,
        dedupTime,
      ].filter(Boolean);
      let openExisting = await clickAgendaEvent(page, preferredTerms);
      if (!openExisting?.success) {
        openExisting = await clickAgendaEvent(page, [job.customer.plate].filter(Boolean));
      }
      if (!openExisting?.success) {
        return {
          saved: false,
          mode: "commit-blocked-duplicate",
          dedup,
          message: "Commit bloccato: appuntamento duplicato rilevato in agenda.",
        };
      }
      await page.waitForTimeout(700);
      let putResponse = null;
      let saveAttemptsUsed = 0;
      let popupSaveError = null;
      let putResponseSummary = null;
      try {
        await fillAppointmentPopup(page, job);
        const popupSave = await saveAppointmentPopup(page, { maxSaveAttempts: 3 });
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
      if (shouldWriteOdlFromWorker()) {
        managementWrite = await writePracticeAndOdl(page, job, args).catch((error) => ({
          attempted: true,
          ok: false,
          error: error.message,
        }));
      }
      return {
        saved: true,
        mode: "commit-upsert-duplicate",
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
          extra: { saveAttempts: saveAttemptsUsed },
        }),
        warning: popupSaveError || undefined,
        managementWrite,
        write_report: managementWrite,
        message: popupSaveError
          ? "Duplicato gestito: popup agenda non confermato, verifica tramite audit."
          : "Appuntamento duplicato aggiornato su YAP.",
      };
    }

    logPhase("popup", "opening", { time: job.appointment.time });
    const _slotClickStart = Date.now();
    await clickApproximateSlot(page, job.appointment.time);
    logPhase("popup", "slot_clicked", { elapsed_ms: Date.now() - _slotClickStart });
    try {
      await fillAppointmentPopup(page, job);
    } catch (firstError) {
      // Fallback rapido: in alcune sessioni il primo popup si apre incompleto.
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(180);
      await clickApproximateSlot(page, job.appointment.time);
      await fillAppointmentPopup(page, job);
      if (args.debug) {
        console.warn(`Popup refill retry riuscito: ${firstError.message}`);
      }
    }

    const suffix = `${job.practiceId || "payload"}-${Date.now()}`;
    let beforeSavePath = null;
    if (args.debug) {
      beforeSavePath = path.join(args.artifactDir, `before-save-${suffix}.png`);
      await page.screenshot({ path: beforeSavePath, fullPage: true });
    }

    logPhase("popup", "filled");
    logPhase("save", "starting");
    const { putResponse, saveAttemptsUsed } = await saveAppointmentPopup(page, { maxSaveAttempts: 3 });
    logPhase("save", "done", { detected: Boolean(putResponse) });
    const putResponseSummary = args.debug ? await summarizeResponseBody(putResponse) : null;
    await page.waitForTimeout(240);
    let afterSavePath = null;
    if (args.debug) {
      afterSavePath = path.join(args.artifactDir, `after-save-${suffix}.png`);
      await page.screenshot({ path: afterSavePath, fullPage: true });
    }
    let managementWrite = null;
    if (shouldWriteOdlFromWorker()) {
      logPhase("odl", "starting");
      managementWrite = await writePracticeAndOdl(page, job, args).catch((error) => ({
        attempted: true,
        ok: false,
        error: error.message,
      }));
      logPhase("odl", managementWrite?.ok === false ? "failed" : "done", { ok: managementWrite?.ok });
    }
    return {
      saved: true,
      mode: "commit",
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
        extra: { saveAttempts: saveAttemptsUsed },
      }),
      managementWrite,
      write_report: managementWrite,
      message: "Appuntamento salvato su YAP.",
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

  logPhase("worker", "reading_payload");
  const job = args.payloadFile ? await readPayloadFile(args.payloadFile, args) : await readPracticeFromApi(args);
  logPhase("worker", "validating_job");
  validateJob(job);
  logPhase("worker", "cleanup_start");
  // Cleanup vecchi screenshot prima di eseguire (manutenzione automatica)
  await cleanupOldArtifacts(args.artifactDir, 7);
  logPhase("worker", "automation_start");
  const result = await runYapAutomation(job, args);
  console.log(JSON.stringify({
    ok: true,
    dryRun: args.dryRun,
    practiceId: job.practiceId,
    appointment: job.appointment,
    customer: {
      name: job.customer.name,
      plate: job.customer.plate,
    },
    result,
  }, null, 2));
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch(async (error) => {
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
  extractTrailingJsonBlock,
  formatMacNeedle,
  formatManNeedle,
  isEffectiveOdlState,
  normalizeLoose,
  parsePraticaHashPayload,
};
