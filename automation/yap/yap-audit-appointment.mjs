#!/usr/bin/env node
/**
 * Read-only audit YAP: verifica cosa esiste davvero dopo una sync.
 * Non salva e non modifica dati; produce present/missing/mismatch.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  clickAgendaEvent,
  toItalianDate,
  toYapTime,
  addMinutes,
  normalizeAppointmentTime,
  normalize,
  getYapSlotMinutes,
  yapContextOptions,
  ROOT_DIR,
} from "./lib/yap-shared.mjs";
import { buildManagementPlan, normalizeMappingInput } from "./lib/yap-mapping.mjs";

const requireFromMiniApp = createRequire(new URL("../../mini-app/package.json", import.meta.url));
const { chromium } = requireFromMiniApp("@playwright/test");

const DEFAULT_ARTIFACT_DIR = path.join(ROOT_DIR, "automation", "artifacts", "yap-audit");
const KNOWN_TAGS = ["officina", "pneumatici", "preventivo", "revisione", "comunicato", "carrozzeria"];

function parseArgs(argv) {
  const args = {
    headed: false,
    debug: false,
    freshLogin: false,
    artifactDir: process.env.YAP_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (!argv[i]) throw new Error(`Valore mancante per ${arg}`);
      return argv[i];
    };

    if (arg === "--payload-file") args.payloadFile = next();
    else if (arg === "--date") args.date = next();
    else if (arg === "--time") args.time = next();
    else if (arg === "--duration") args.duration = Number(next());
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--debug") args.debug = true;
    else if (arg === "--fresh-login") args.freshLogin = true;
    else if (arg === "--artifact-dir") args.artifactDir = next();
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Argomento non riconosciuto: ${arg}`);
  }

  if (!args.payloadFile && !args.help) throw new Error("Serve --payload-file");
  return args;
}

function ensureEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Variabile ambiente obbligatoria mancante: ${name}`);
  return value.trim();
}

async function readMapping(args) {
  const raw = JSON.parse(await fs.readFile(path.resolve(args.payloadFile), "utf8"));
  const mapping = normalizeMappingInput(raw);
  if (args.date) mapping.agenda.data = args.date;
  if (args.time) mapping.agenda.ora = normalizeAppointmentTime(args.time);
  if (args.duration) mapping.agenda.durata_minuti = args.duration;
  return mapping;
}

function buildExpected(mapping) {
  const plan = buildManagementPlan({ mapping });
  const agenda = plan.agenda;
  const fields = [
    { group: "agenda", field: "agenda.cosa", label: "Cosa", expected: agenda.cosa, kind: "exact" },
    { group: "agenda", field: "agenda.quando", label: "Quando", expected: agenda.quando, kind: "date" },
    { group: "agenda", field: "agenda.dalle", label: "Dalle", expected: agenda.dalle, kind: "time" },
    { group: "agenda", field: "agenda.alle", label: "Alle", expected: agenda.alle, kind: "time" },
  ];

  for (const tag of agenda.tag || []) {
    fields.push({ group: "tags", field: `tag.${tag}`, label: `Tag ${tag}`, expected: tag, kind: "contains" });
  }

  if (mapping.note_interne) {
    fields.push({
      group: "notes",
      field: "note.interne",
      label: "Note interne",
      expected: mapping.note_interne,
      kind: "contains",
    });
  }

  for (const lav of plan.odl?.lavorazioniGiorgio || []) {
    const rep = lav.reparto || "reparto";
    for (const [idx, row] of (lav.descrizioni || []).entries()) {
      fields.push({
        group: "odl",
        field: `odl.${rep}.riga.${idx + 1}`,
        label: `ODL ${rep}`,
        expected: row,
        kind: "contains",
      });
    }
    if (lav.ore_man != null) fields.push({ group: "odl", field: `odl.${rep}.man`, label: `MAN ${rep}`, expected: `MAN ${lav.ore_man}`, kind: "contains" });
    if (lav.ore_mac != null) fields.push({ group: "odl", field: `odl.${rep}.mac`, label: `MAC ${rep}`, expected: `MAC ${lav.ore_mac}`, kind: "contains" });
    if (lav.materiali_euro != null) fields.push({ group: "materials", field: `odl.${rep}.materiali`, label: `Materiali ${rep}`, expected: String(lav.materiali_euro), kind: "contains" });
    if (lav.smaltimento?.applica) fields.push({ group: "waste", field: `odl.${rep}.smaltimento`, label: `Smaltimento ${rep}`, expected: String(lav.smaltimento.percentuale ?? 2), kind: "contains" });
    for (const part of lav.ricambi || []) {
      const name = part.name || part.nome || "";
      const qty = part.quantity || part.quantita || "";
      fields.push({
        group: "parts",
        field: `odl.${rep}.ricambio.${name}`,
        label: `Ricambio ${rep}`,
        expected: [name, qty].filter(Boolean).join(" "),
        kind: "contains",
      });
    }
    if (lav.noteReparto) fields.push({ group: "notes", field: `note.${rep}`, label: `Note ${rep}`, expected: lav.noteReparto, kind: "contains" });
  }

  return { plan, fields };
}

function comparable(value) {
  return normalize(String(value || "").replace(/[€%]/g, " "));
}

function normalizeTimeValue(value) {
  const raw = String(value || "").trim().replace(":", ".");
  const match = raw.match(/(\d{1,2})\.(\d{2})/);
  if (!match) return comparable(value);
  return `${Number(match[1])}.${match[2]}`;
}

function valueMatches(expected, found, kind) {
  if (!expected) return true;
  if (!found) return false;
  if (kind === "time") return normalizeTimeValue(expected) === normalizeTimeValue(found);
  if (kind === "date") return comparable(expected) === comparable(found);
  if (kind === "contains") return comparable(found).includes(comparable(expected));
  return comparable(expected) === comparable(found);
}

async function scanAgendaEvents(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll(".fc-time-grid-event, .fc-event")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          title: ((el.querySelector(".fc-title") || el).textContent || "").replace(/\s+/g, " ").trim(),
          time: (el.querySelector(".fc-time")?.textContent || "").trim(),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      })
      .filter((event) => event.title);
  });
}

async function extractAgendaToolbar(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll(".gwt-ToggleButton[aria-pressed]")]
      .filter(isVisible)
      .map((btn, index) => {
        const icon = [...btn.querySelectorAll("div")]
          .map((el) => String(el.className || ""))
          .find((className) => /LCWVQRD-f-[a-z]/.test(className)) || "";
        return {
          index,
          pressed: btn.getAttribute("aria-pressed") === "true",
          iconClass: icon,
          title: btn.getAttribute("title") || "",
        };
      });
  }).catch(() => []);
}

async function extractPopup(page) {
  return page.evaluate((knownTags) => {
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
        return [...element.querySelectorAll("input, textarea, select, button, a, [role='button']")].filter(isVisible).length >= 5;
      });
    if (!popup) return { found: false };

    const rect = popup.getBoundingClientRect();
    const inputs = [...document.querySelectorAll("input, textarea")]
      .filter(isVisible)
      .map((node, index) => {
        const r = node.getBoundingClientRect();
        return {
          index,
          value: node.value || "",
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
      })
      .filter((item) => item.x >= rect.x && item.x + item.width <= rect.x + rect.width + 2 && item.y >= rect.y && item.y + item.height <= rect.y + rect.height + 2);

    const dateInput = inputs.find((item) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(item.value));
    const timeInputs = inputs.filter((item) => /^\d{1,2}[\.:]\d{2}$/.test(item.value)).sort((a, b) => a.x - b.x);
    const cosaInput = dateInput
      ? inputs.filter((item) => item.index < dateInput.index && item.width > 60).sort((a, b) => a.y - b.y)[0]
      : inputs[0];
    const noteValues = inputs
      .filter((item) => timeInputs[1] && item.index > timeInputs[1].index && item.value)
      .map((item) => item.value);

    const text = (popup.innerText || popup.textContent || "").replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();
    const tags = knownTags.filter((tag) => lower.includes(tag.toLowerCase()));

    return {
      found: true,
      text,
      inputs,
      agenda: {
        cosa: cosaInput?.value || "",
        quando: dateInput?.value || "",
        dalle: timeInputs[0]?.value || "",
        alle: timeInputs[1]?.value || "",
      },
      tags,
      notesText: noteValues.join(" | "),
    };
  }, KNOWN_TAGS);
}

async function tryOpenPracticeAndOdl(page) {
  const result = {
    openedPractice: false,
    openedOdl: false,
    text: "",
    clickLabels: [],
  };

  const clickPractice = await page.evaluate(() => {
    const popup = document.querySelector(".gwt-DecoratedPopupPanel, .gwt-PopupPanel, .popup") || document.body;
    const candidates = [...popup.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div")]
      .filter((el) => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const rect = el.getBoundingClientRect();
        return rect.width > 3 && rect.height > 3 && text.length < 80 && /gestione pratica|apri pratica|\bpratica\b/.test(text) && !text.includes("prenotazione");
      });
    const el = candidates[0];
    if (!el) return { clicked: false };
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, label: (el.textContent || "").replace(/\s+/g, " ").trim() };
  }).catch(() => ({ clicked: false }));

  if (clickPractice.clicked) {
    result.openedPractice = true;
    result.clickLabels.push(clickPractice.label);
    await page.waitForTimeout(3500);
  }

  const clickOdl = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")]
      .filter((el) => {
        const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const rect = el.getBoundingClientRect();
        return rect.width > 3 && rect.height > 3 && text.length < 60 && (/ordini di lavoro/.test(text) || text === "odl");
      });
    const el = candidates[0];
    if (!el) return { clicked: false };
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return { clicked: true, label: (el.textContent || "").replace(/\s+/g, " ").trim() };
  }).catch(() => ({ clicked: false }));

  if (clickOdl.clicked) {
    result.openedOdl = true;
    result.clickLabels.push(clickOdl.label);
    await page.waitForTimeout(2500);
  }

  result.text = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").trim()).catch(() => "");
  return result;
}

function resolveFoundValue(field, found) {
  if (field.field === "agenda.cosa") return found.popup?.agenda?.cosa || found.event?.title || "";
  if (field.field === "agenda.quando") return found.popup?.agenda?.quando || "";
  if (field.field === "agenda.dalle") return found.popup?.agenda?.dalle || found.event?.time || "";
  if (field.field === "agenda.alle") return found.popup?.agenda?.alle || "";
  if (field.group === "tags") return [...(found.popup?.tags || []), found.popup?.text || ""].join(" ");
  if (field.group === "notes") return [found.popup?.notesText, found.popup?.text, found.practice?.text].filter(Boolean).join(" ");
  return [found.practice?.text, found.popup?.text].filter(Boolean).join(" ");
}

function classifyAudit(fields, found) {
  const present = [];
  const missing = [];
  const mismatch = [];

  for (const field of fields) {
    const actual = resolveFoundValue(field, found);
    if (valueMatches(field.expected, actual, field.kind)) {
      present.push({ ...field, found: actual });
      continue;
    }
    if (actual && field.group === "agenda") {
      mismatch.push({ ...field, found: actual });
    } else {
      missing.push({ ...field, found: actual || null });
    }
  }

  const agendaFields = fields.filter((field) => field.group === "agenda");
  const agendaPresent = agendaFields.every((field) => present.some((item) => item.field === field.field));
  let status = "sync_failed";
  let message = "Appuntamento YAP non verificato.";

  if (agendaPresent && !missing.length && !mismatch.length) {
    status = "complete_synced";
    message = "YAP completo: agenda, note, ODL, materiali e ricambi verificati.";
  } else if (agendaPresent) {
    status = missing.some((item) => item.group !== "agenda") || mismatch.length ? "partial_synced" : "agenda_synced";
    message = status === "partial_synced"
      ? "Agenda presente, mancano ODL/materiali/ricambi/note."
      : "Agenda verificata.";
  }

  return { status, message, present, missing, mismatch };
}

async function runAudit(mapping, args) {
  const username = ensureEnv("YAP_USERNAME");
  const password = ensureEnv("YAP_PASSWORD");
  const { plan, fields } = buildExpected(mapping);
  const plate = String(mapping.anagrafica?.targa || "").trim().toUpperCase();
  const searchTerms = [plate, plan.agenda.cosa, mapping.anagrafica?.cliente_nome].filter(Boolean);

  await fs.mkdir(args.artifactDir, { recursive: true });
  const browser = await chromium.launch({
    headless: !args.headed,
    executablePath: process.env.YAP_CHROMIUM_EXECUTABLE || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext(await yapContextOptions({ freshLogin: args.freshLogin }));
  const page = await context.newPage();

  let screenshot = null;
  try {
    await loginYap(page, username, password);
    await openAgendaInApp(page);
    await gotoAgendaDate(page, mapping.agenda.data);

    const events = await scanAgendaEvents(page);
    const click = await clickAgendaEvent(page, searchTerms);
    await page.waitForTimeout(1800);
    const popup = await extractPopup(page);
    const toolbar = await extractAgendaToolbar(page);
    let practice = { openedPractice: false, openedOdl: false, text: "", clickLabels: [] };
    if (popup.found) {
      practice = await tryOpenPracticeAndOdl(page);
    }

    if (args.debug) {
      screenshot = path.join(args.artifactDir, `audit-${plate || "practice"}-${Date.now()}.png`);
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    }

    const event = events.find((ev) => searchTerms.some((term) => normalize(ev.title).includes(normalize(term)))) || null;
    const found = { event: event || (click.success ? { title: click.text, time: "" } : null), popup, toolbar, practice };
    const outcome = classifyAudit(fields, found);

    return {
      ok: outcome.status !== "sync_failed",
      checkedAt: new Date().toISOString(),
      mode: "readonly_yap_audit",
      status: outcome.status,
      message: outcome.message,
      expected: {
        agenda: plan.agenda,
        fieldCount: fields.length,
        fields,
      },
      found,
      present: outcome.present,
      missing: outcome.missing,
      mismatch: outcome.mismatch,
      screenshot,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Uso: node automation/yap/yap-audit-appointment.mjs --payload-file payload.json [--debug]");
    return;
  }
  const mapping = await readMapping(args);
  const result = await runAudit(mapping, args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    status: "sync_failed",
    message: "Audit YAP non completato.",
    error: error.message,
    stack: error.stack,
  }, null, 2));
  process.exit(1);
});
