#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  clickAgendaEvent,
  toItalianDate,
  toYapTime,
  addMinutes,
  normalizeAppointmentTime,
  getYapSlotMinutes,
  yapContextOptions,
  waitForAgendaReady,
  waitForYapAction,
  launchChromiumWithFallback,
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

const requireFromMiniApp = createRequire(new URL("../../mini-app/package.json", import.meta.url));
const { chromium } = requireFromMiniApp("@playwright/test");

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ARTIFACT_DIR = path.join(ROOT_DIR, "automation", "artifacts", "yap");

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

function buildOdlNeedles(job) {
  const needles = [];
  if (job.internalNotes) needles.push(job.internalNotes);
  for (const section of job.sections || []) {
    const reparto = String(section.reparto || "").trim();
    if (reparto) needles.push(reparto);
    for (const row of section.descrizioni || []) {
      if (row) needles.push(String(row));
    }
    if (section.ore_man != null) needles.push(`MAN ${section.ore_man}`);
    if (section.ore_mac != null) needles.push(`MAC ${section.ore_mac}`);
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
  if (section.ore_man != null) lines.push(`MAN: ${section.ore_man}`);
  if (section.ore_mac != null) lines.push(`MAC: ${section.ore_mac}`);
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
      const recoverable = /Target crashed|Target closed|Execution context was destroyed|Page closed|Browser has been closed|Cannot find context with specified id/i.test(message);
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

    best.cell.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = best.cell.getBoundingClientRect();
    return {
      time: best.time,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }, normalizedTarget).catch(() => null);

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
    const clicked = await safeEvaluate(page, ({ x, y }) => {
      const dispatch = (type) => {
        const target = document.elementFromPoint(x, y);
        if (!target) return false;
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
        }));
        return true;
      };
      const first = dispatch("click");
      if (!first) return false;
      dispatch("click");
      dispatch("dblclick");
      return true;
    }, point).catch(() => false);
    if (!clicked) continue;
    const opened = await waitForAppointmentPopup(page, 1800);
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

async function clickOdlSection(page) {
  return safeEvaluate(page, () => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")].filter((el) => {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return (t.includes("ordini di lavoro") || t === "odl" || t.startsWith("ordini di lavoro")) && t.length < 60;
    });
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100) };
    }
    return { clicked: false, label: null };
  }).catch(() => ({ clicked: false, label: null }));
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

async function fillWithRetry(page, attempts, value, options = {}) {
  const plans = Array.isArray(attempts) ? attempts : [];
  for (const attempt of plans) {
    const keywords = Array.isArray(attempt) ? attempt : (attempt?.keywords || []);
    const append = typeof attempt === "object" && "append" in attempt ? attempt.append : options.append;
    const ok = await fillBestEditableByKeywords(page, keywords, value, { ...options, append });
    if (ok) return true;
    await page.waitForTimeout(120).catch(() => {});
  }
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
    const targets = [...document.querySelectorAll("textarea, [contenteditable='true']")].filter(isVisible);
    if (!targets.length) return false;
    const target = targets.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
    const isInput = target.tagName === "TEXTAREA";
    const current = isInput ? (target.value || "") : (target.innerText || target.textContent || "");
    const nextValue = current ? `${current}\n${blockText}` : blockText;
    target.focus();
    if (isInput) target.value = nextValue;
    else target.textContent = nextValue;
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
      pushField(`odl.${reparto}.man`, `MAN ${section.ore_man}`, Boolean(writeReport?.hours?.man?.success), "Apri ODL e verifica MAN.");
    }
    if (section.ore_mac != null) {
      pushField(`odl.${reparto}.mac`, `MAC ${section.ore_mac}`, Boolean(writeReport?.hours?.mac?.success), "Apri ODL e verifica MAC.");
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
      const expected = [name, qty].filter(Boolean).join(" ").trim();
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
  };

  let practiceLink = await clickAppointmentPopupPractice(page);
  if (!practiceLink?.clicked) {
    const fallbackPractice = page.locator(".gwt-DecoratedPopupPanel button, .gwt-DecoratedPopupPanel a, .gwt-DecoratedPopupPanel [role='button']").filter({ hasText: /gestione pratica|apri pratica|\bpratica\b/i }).first();
    if (await fallbackPractice.count()) {
      await fallbackPractice.click().catch(() => {});
      practiceLink = { clicked: true, label: "fallback:gestione_pratica" };
    }
  }
  if (!practiceLink?.clicked) {
    writeReport.attempted = false;
    writeReport.reason = "practice_link_not_found";
    return writeReport;
  }
  writeReport.openedPractice = true;
  await page.waitForTimeout(2200);

  let odlTab = await clickOdlSection(page);
  if (!odlTab?.clicked) {
    const fallbackOdl = page.locator("button, a, [role='button'], .gwt-Label, span, div, td").filter({ hasText: /ordini di lavoro|\bodl\b/i }).first();
    if (await fallbackOdl.count()) {
      await fallbackOdl.click().catch(() => {});
      odlTab = { clicked: true, label: "fallback:odl" };
    }
  }
  if (odlTab?.clicked) {
    writeReport.openedOdl = true;
    await page.waitForTimeout(1600);
  } else if (writeReport.odl.attempted) {
    writeReport.odl.error = "odl_tab_not_found";
  }

  if (job.internalNotes) {
    try {
      writeReport.notes.success = await fillWithRetry(
        page,
        [
          ["note interne", "note", "pratica", "annotazioni"],
          ["note", "annotazioni", "odl"],
          ["note", "pratica"],
        ],
        String(job.internalNotes).trim(),
        { append: true },
      );
      if (!writeReport.notes.success) writeReport.notes.error = "notes_field_not_found";
    } catch (error) {
      writeReport.notes.error = error?.message || "notes_write_failed";
    }
  }

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
      await page.waitForTimeout(180);
    }
    const sectionSummary = buildSectionSummary(section);
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

  // Fallback unico: se non troviamo campi specifici, mettiamo il blocco completo in una textarea visibile.
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

  await clickGenericSaveInPractice(page).catch(() => false);
  await page.waitForTimeout(500);

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
  const matched = needles.filter((needle) => normalizedScoped.includes(normalizeLoose(needle))).length;
  writeReport.verify = {
    matched,
    total: needles.length,
    ratio: needles.length ? Number((matched / needles.length).toFixed(3)) : 1,
  };
  writeReport.odl.success = writeReport.odl.success || writeReport.verify.matched > 0;
  writeReport.ok = Boolean(
    writeReport.openedPractice
    && (
      writeReport.odl.success
      || writeReport.notes.success
      || writeReport.materials.success
      || writeReport.parts.success
      || writeReport.waste.success
    )
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
}

async function scanAgendaEvents(page) {
  return safeEvaluate(page, () => {
    const rows = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(".fc-time-grid-event, .fc-event")) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2) continue;
      const title = (el.querySelector(".fc-title") || el).textContent.replace(/\s+/g, " ").trim();
      const time = (el.querySelector(".fc-time")?.textContent || "").trim();
      const key = `${time}|${title}`;
      if (!title || seen.has(key)) continue;
      seen.add(key);
      rows.push({ time, title });
    }
    return rows;
  });
}

async function saveAppointmentPopup(page, { maxSaveAttempts = 2 } = {}) {
  let putResponse = null;
  let saveAttemptsUsed = 0;
  let lastSaveError = null;
  for (let attempt = 1; attempt <= maxSaveAttempts; attempt += 1) {
    saveAttemptsUsed = attempt;
    try {
      putResponse = await waitForYapAction(page, "PrenotazionePutAction", async () => {
        const saved = await safeEvaluate(page, () => {
          const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")]
            .find((el) => (el.textContent || "").includes("Dettagli appuntamento"));
          if (!popup) return false;
          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          const btns = [...popup.querySelectorAll("a.gwt-Anchor, button, .gwt-Button, img, span, [role='button']")]
            .filter(isVisible)
            .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
          const saveBtn = btns.find((el) => {
            const text = (el.textContent || el.getAttribute("title") || el.getAttribute("alt") || "").toLowerCase();
            return text.includes("salva") || text.includes("save") || text.includes("floppy") || text.includes("done") || text.includes("check");
          }) || btns[0];
          if (saveBtn) { saveBtn.click(); return true; }
          return false;
        });
        if (!saved) {
          throw new Error("Bottone salva non trovato nel popup YAP");
        }
      }, 7000 + (attempt - 1) * 2500);
      if (putResponse) break;
      const stillOpenAttempt = await page.getByText("Dettagli appuntamento").first().isVisible({ timeout: 1200 }).catch(() => false);
      if (!stillOpenAttempt) break;
    } catch (error) {
      lastSaveError = error;
    }
    await page.waitForTimeout(500 * attempt);
  }
  const saved = Boolean(putResponse);
  if (!saved) {
    const stillOpen = await page.getByText("Dettagli appuntamento").first().isVisible({ timeout: 1000 }).catch(() => false);
    if (stillOpen) {
      const detail = lastSaveError?.message ? ` (${lastSaveError.message})` : "";
      throw new Error(`Salvataggio YAP non confermato dopo ${maxSaveAttempts} tentativi${detail}`);
    }
  }
  return { putResponse, saveAttemptsUsed };
}

async function runYapAutomation(job, args) {
  const username = ensureEnv("YAP_USERNAME");
  const password = ensureEnv("YAP_PASSWORD");
  await fs.mkdir(args.artifactDir, { recursive: true });
  const safeMode = String(process.env.YAP_SAFE_MODE || "").trim() === "1";
  const launchArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
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

  const browser = await launchChromiumWithFallback(
    chromium,
    {
      headless: !args.headed,
      args: launchArgs,
    },
    { resolveModule: requireFromMiniApp.resolve.bind(requireFromMiniApp), cwd: ROOT_DIR },
  );
  const context = await browser.newContext(await yapContextOptions({ freshLogin: args.freshLogin }));
  const page = await context.newPage();

  try {
    await loginYap(page, username, password);
    await openAgenda(page, job.appointment.date);

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
    const existingEvents = await scanAgendaEvents(page);
    const dedup = findExistingAppointment(existingEvents, {
      plate: job.customer.plate,
      date: job.appointment.date,
      time: job.appointment.time,
      toleranceMinutes: 0,
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
        message: dedup.hit
          ? "Appuntamento già presente in agenda (dedup). Nessuna modifica."
          : "Accesso YAP e agenda verificati. Nessuna modifica eseguita su YAP.",
      };
    }

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
      try {
        await fillAppointmentPopup(page, job);
        const popupSave = await saveAppointmentPopup(page, { maxSaveAttempts: 2 });
        putResponse = popupSave.putResponse;
        saveAttemptsUsed = popupSave.saveAttemptsUsed;
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
        },
        telemetry: {
          saveAttempts: saveAttemptsUsed,
        },
        warning: popupSaveError || undefined,
        managementWrite,
        write_report: managementWrite,
        message: popupSaveError
          ? "Duplicato gestito: popup agenda non confermato, verifica tramite audit."
          : "Appuntamento duplicato aggiornato su YAP.",
      };
    }

    await clickApproximateSlot(page, job.appointment.time);
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

    const { putResponse, saveAttemptsUsed } = await saveAppointmentPopup(page, { maxSaveAttempts: 2 });
    await page.waitForTimeout(240);
    let afterSavePath = null;
    if (args.debug) {
      afterSavePath = path.join(args.artifactDir, `after-save-${suffix}.png`);
      await page.screenshot({ path: afterSavePath, fullPage: true });
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
      mode: "commit",
      putAction: {
        detected: Boolean(putResponse),
        status: putResponse?.status(),
      },
      screenshot: afterSavePath,
      telemetry: {
        saveAttempts: saveAttemptsUsed,
      },
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
    await context.close();
    await browser.close();
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

  const job = args.payloadFile ? await readPayloadFile(args.payloadFile, args) : await readPracticeFromApi(args);
  validateJob(job);

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
