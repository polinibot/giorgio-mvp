#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromMiniApp = createRequire(new URL("../../mini-app/package.json", import.meta.url));
const { chromium } = requireFromMiniApp("playwright");

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_ARTIFACT_DIR = path.join(ROOT_DIR, "automation", "artifacts", "yap");
const YAP_BASE_URL = process.env.YAP_BASE_URL || "https://yap.mmbsoftware.it";

function parseArgs(argv) {
  const args = {
    dryRun: true,
    headed: false,
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

function toItalianDate(isoDate) {
  const [year, month, day] = String(isoDate).slice(0, 10).split("-");
  if (!year || !month || !day) {
    throw new Error(`Data non valida per YAP: ${isoDate}`);
  }
  return `${day}/${month}/${year}`;
}

function toYapTime(time) {
  const raw = String(time || "").trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`Ora non valida: ${raw}. Atteso formato HH:MM`);
  }
  return raw.replace(":", ".");
}

function addMinutes(time, minutes) {
  const [hours, mins] = time.split(":").map(Number);
  const date = new Date(Date.UTC(2000, 0, 1, hours, mins + minutes, 0));
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function normalizeContext(context) {
  return String(context || "").trim().toLowerCase();
}

function contextLabel(context) {
  const normalized = normalizeContext(context);
  if (normalized === "officina") return "OFFICINA";
  if (normalized === "carrozzeria") return "CARROZZERIA";
  if (normalized === "revisione") return "REVISIONE";
  return normalized.toUpperCase();
}

function pickTag(contexts) {
  const normalized = contexts.map(normalizeContext);
  if (normalized.includes("officina")) return "officina";
  if (normalized.includes("carrozzeria")) return "carrozzeria";
  if (normalized.includes("revisione")) return "revisione";
  return process.env.YAP_DEFAULT_TAG || "officina";
}

function buildAgendaTitle(job) {
  const parts = [
    job.customer.name,
    job.customer.plate,
    job.contexts.map(contextLabel).join("+"),
  ].filter(Boolean);

  return parts.join(" - ").slice(0, 120);
}

function normalizeJob(rawInput, overrides = {}) {
  const input = rawInput?.data?.mapping || rawInput?.mapping || rawInput?.data?.payload || rawInput?.payload || rawInput;

  if (input?.anagrafica && input?.agenda) {
    const contexts = (input.lavorazioni || []).map((item) => item.reparto).filter(Boolean);
    return {
      practiceId: input.meta?.practice_id || rawInput?.practice_id || null,
      customer: {
        name: input.anagrafica.cliente_nome || "",
        phone: input.anagrafica.cliente_telefono || "",
        plate: input.anagrafica.targa || "",
        type: input.anagrafica.cliente_tipo || "",
      },
      appointment: {
        date: toIsoDate(overrides.date || input.agenda.data),
        time: overrides.time || input.agenda.ora,
        duration: Number(overrides.duration || input.agenda.durata_minuti || 30),
        type: input.agenda.tipo_pratica || "",
      },
      contexts,
      sections: input.lavorazioni || [],
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
    customer: {
      name: customer.name || "",
      phone: customer.phone || "",
      plate: customer.plate || "",
      type: customer.type || "",
    },
    appointment: {
      date: toIsoDate(overrides.date || appointment.date),
      time: overrides.time || appointment.time,
      duration: Number(overrides.duration || appointment.slot_duration || 30),
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

async function updatePracticeSynced(args, job) {
  if (!args.practiceId && !job.practiceId) return;
  const apiBaseUrl = args.apiBaseUrl || process.env.API_BASE_URL;
  const telegramUserId = args.telegramUserId || process.env.GIORGIO_TELEGRAM_USER_ID;
  if (!apiBaseUrl || !telegramUserId) return;

  const practiceId = args.practiceId || job.practiceId;
  const url = withUserId(`${apiBaseUrl.replace(/\/$/, "")}/api/practices/${practiceId}/sync`, telegramUserId);
  await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ synced: true }),
  });
}

async function clickIfVisible(locator, timeout = 1500) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

async function login(page, username, password) {
  await page.goto(YAP_BASE_URL, { waitUntil: "domcontentloaded" });
  await clickIfVisible(page.getByRole("button", { name: /^OK$/i }), 3000)
    || await clickIfVisible(page.getByText("OK", { exact: true }).last(), 1000);
  await page.keyboard.press("Escape").catch(() => {});

  await page.locator('input[name="u"]').fill(username);
  await page.locator('input[name="pw"]').fill(password);
  const submitButton = page.getByTestId("loginSubmitButton").or(page.getByRole("button", { name: /acc[ée]di/i }));
  await submitButton.first().click();

  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.getByText("Agenda", { exact: true }).waitFor({ state: "visible", timeout: 45000 });
}

async function openAgenda(page) {
  await page.goto(`${YAP_BASE_URL}/#!agenda`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.getByText("Agenda", { exact: true }).first().waitFor({ state: "visible", timeout: 45000 });
  await page.locator(".fc-time-grid").first().waitFor({
    state: "visible",
    timeout: 45000,
  });
}

async function visibleTimeLabels(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll("td.fc-axis.fc-time, .fc-time")]
      .map((node) => {
        const text = (node.textContent || "").trim();
        const rect = node.getBoundingClientRect();
        return { text, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
      .filter((item) => /^\d{2}:\d{2}$/.test(item.text) && item.height > 0 && item.width > 0);
  });
}

function minutesOf(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

async function clickApproximateSlot(page, targetTime) {
  const rows = await page.evaluate(() => {
    return [...document.querySelectorAll(".fc-slats tr")]
      .map((row) => {
        const cell = row.querySelector("td:not(.fc-axis)");
        const rect = cell?.getBoundingClientRect();
        const time = row.getAttribute("data-time");
        return rect && time
          ? { time: time.slice(0, 5), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;
      })
      .filter(Boolean)
      .filter((item) => item.height > 0 && item.width > 0);
  });

  const labels = rows.length ? rows : await visibleTimeLabels(page);
  if (!labels.length) {
    throw new Error("Non trovo la griglia oraria YAP");
  }

  const targetMinutes = minutesOf(targetTime);
  const sorted = labels.sort((a, b) => minutesOf(a.text || a.time) - minutesOf(b.text || b.time));
  let label = sorted[0];
  for (const candidate of sorted) {
    const candidateTime = candidate.text || candidate.time;
    if (minutesOf(candidateTime) <= targetMinutes) {
      label = candidate;
    }
  }

  const clickX = label.text
    ? label.x + label.width + 260
    : label.x + Math.min(220, label.width / 2);
  const clickY = label.y + Math.max(8, label.height / 2);
  await page.mouse.dblclick(clickX, clickY);
  await page.getByText("Dettagli appuntamento").first().waitFor({ state: "visible", timeout: 15000 });
}

async function inputSnapshot(page) {
  return page.evaluate(() => {
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
  return page.evaluate(() => {
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")]
      .find((element) => (element.textContent || "").includes("Dettagli appuntamento"));
    if (!popup) return null;
    const rect = popup.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

async function fillVisibleInput(page, index, value) {
  await page.evaluate(({ index: targetIndex, value: nextValue }) => {
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

  const titleInput = inputs
    .filter((item) => item.index < dateIndex && !item.value && item.width > 120)
    .sort((a, b) => b.y - a.y)[0] || inputs.find((item) => !item.value && item.width > 120);

  if (!titleInput) {
    throw new Error("Non trovo il campo 'Cosa' nel popup YAP");
  }

  const title = buildAgendaTitle(job);
  const endTime = addMinutes(job.appointment.time, job.appointment.duration);

  await fillVisibleInput(page, titleInput.index, title);
  await fillVisibleInput(page, dateIndex, toItalianDate(job.appointment.date));
  await fillVisibleInput(page, timeIndexes[0], toYapTime(job.appointment.time));
  await fillVisibleInput(page, timeIndexes[1], toYapTime(endTime));

  const tag = pickTag(job.contexts);
  const afterTimeIndex = timeIndexes[1];
  const tagCandidate = (await inputSnapshot(page)).find((item) => item.index > afterTimeIndex && item.value && !/^\d/.test(item.value));
  if (tagCandidate && tagCandidate.value.toLowerCase() !== tag) {
    await fillVisibleInput(page, tagCandidate.index, tag).catch(() => {});
  }
}

async function runYapAutomation(job, args) {
  const username = ensureEnv("YAP_USERNAME");
  const password = ensureEnv("YAP_PASSWORD");
  await fs.mkdir(args.artifactDir, { recursive: true });

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    locale: "it-IT",
  });
  const page = await context.newPage();

  try {
    await login(page, username, password);
    await openAgenda(page);

    if (args.dryRun) {
      const suffix = `${job.practiceId || "payload"}-${Date.now()}`;
      const agendaPath = path.join(args.artifactDir, `agenda-check-${suffix}.png`);
      await page.screenshot({ path: agendaPath, fullPage: true });

      return {
        saved: false,
        mode: "dry-run",
        screenshot: agendaPath,
        message: "Accesso YAP e agenda verificati. Nessuna modifica eseguita su YAP.",
      };
    }

    await clickApproximateSlot(page, job.appointment.time);
    await fillAppointmentPopup(page, job);

    const suffix = `${job.practiceId || "payload"}-${Date.now()}`;
    const beforeSavePath = path.join(args.artifactDir, `before-save-${suffix}.png`);
    await page.screenshot({ path: beforeSavePath, fullPage: true });

    await page.getByText("Salva appuntamento", { exact: true }).click();
    await page.waitForTimeout(1500);
    const afterSavePath = path.join(args.artifactDir, `after-save-${suffix}.png`);
    await page.screenshot({ path: afterSavePath, fullPage: true });
    await updatePracticeSynced(args, job).catch(() => {});

    return {
      saved: true,
      mode: "commit",
      screenshot: afterSavePath,
      message: "Appuntamento salvato su YAP.",
    };
  } finally {
    await context.close();
    await browser.close();
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

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
  }, null, 2));
  process.exit(1);
});
