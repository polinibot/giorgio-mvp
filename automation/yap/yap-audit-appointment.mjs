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
  launchChromiumWithFallback,
} from "./lib/yap-shared.mjs";
import { buildManagementPlan, normalizeMappingInput } from "./lib/yap-mapping.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const DEFAULT_ARTIFACT_DIR = path.join(ROOT_DIR, "automation", "artifacts", "yap-audit");
const KNOWN_TAGS = ["officina", "pneumatici", "preventivo", "revisione", "comunicato", "carrozzeria"];

function parseArgs(argv) {
  const args = {
    headed: false,
    debug: false,
    freshLogin: false,
    quick: false,
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
    else if (arg === "--quick") args.quick = true;
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
    if (lav.materiali_euro != null) fields.push({ group: "materials", field: `odl.${rep}.materiali`, label: `Materiali ${rep}`, expected: String(lav.materiali_euro), kind: "number_contains" });
    if (lav.smaltimento?.applica) fields.push({ group: "waste", field: `odl.${rep}.smaltimento`, label: `Smaltimento ${rep}`, expected: String(lav.smaltimento.percentuale ?? 2), kind: "number_contains" });
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

function extractEventTimes(value) {
  const matches = [...String(value || "").matchAll(/(\d{1,2})[\.:](\d{2})/g)]
    .map((match) => `${String(Number(match[1])).padStart(2, "0")}.${match[2]}`);
  return { start: matches[0] || "", end: matches[1] || "" };
}

function toMinutes(timeValue) {
  const normalized = normalizeTimeValue(timeValue || "");
  const match = normalized.match(/^(\d{1,2})\.(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return (hours * 60) + minutes;
}

function enrichAgendaEvent(event, plan, dateIso) {
  if (!event) return null;
  const times = extractEventTimes(event.time);
  return {
    ...event,
    startTime: times.start || event.time || "",
    endTime: times.end || "",
    date: plan?.agenda?.quando || (dateIso ? toItalianDate(dateIso) : ""),
  };
}

function normalizeDateValue(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})/);
  if (!match) return comparable(value);
  const day = String(Number(match[1])).padStart(2, "0");
  const month = String(Number(match[2])).padStart(2, "0");
  const year = String(match[3]).length === 2 ? `20${match[3]}` : String(match[3]);
  return `${day}/${month}/${year}`;
}

function parseNumeric(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, "").replace(",", ".");
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number.parseFloat(match[0]);
  return Number.isFinite(num) ? num : null;
}

function numericContains(expected, found) {
  const expectedNum = parseNumeric(expected);
  if (expectedNum == null) return false;
  const values = String(found || "")
    .replace(/,/g, ".")
    .match(/-?\d+(?:\.\d+)?/g);
  if (!values?.length) return false;
  return values.some((candidate) => {
    const num = Number.parseFloat(candidate);
    return Number.isFinite(num) && Math.abs(num - expectedNum) <= 0.01;
  });
}

function valueMatches(expected, found, kind) {
  if (!expected) return true;
  if (!found) return false;
  if (kind === "time") return normalizeTimeValue(expected) === normalizeTimeValue(found);
  if (kind === "date") return normalizeDateValue(expected) === normalizeDateValue(found);
  if (kind === "number_contains") return numericContains(expected, found);
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

function eventScore(event, searchTerms, expectedTime) {
  const title = String(event?.title || "");
  const hay = normalize(title);
  const normalizedTerms = (searchTerms || []).map((term) => normalize(term)).filter(Boolean);
  const eventStart = extractEventTimes(event?.time).start;
  const eventMinutes = toMinutes(eventStart || event?.time || "");
  const expectedMinutes = toMinutes(expectedTime || "");
  let score = 0;
  for (const term of normalizedTerms) {
    if (!term) continue;
    if (hay.includes(term)) score += term.length;
    if (/^[a-z]{2}\d{3}[a-z]{2}$/i.test(term) && hay.includes(term)) score += 120;
    if (hay.startsWith(term)) score += 20;
  }
  if (expectedMinutes != null && eventMinutes != null) {
    const diff = Math.abs(eventMinutes - expectedMinutes);
    if (diff === 0) score += 70;
    else if (diff <= 10) score += 55;
    else if (diff <= 20) score += 40;
    else if (diff <= 40) score += 20;
    else if (diff <= 90) score += 8;
  }
  return score;
}

function rankAgendaEvents(events, searchTerms, expectedTime) {
  const ranked = [...(events || [])]
    .map((event) => ({ event, score: eventScore(event, searchTerms, expectedTime) }))
    .sort((a, b) => b.score - a.score);
  return ranked;
}

async function appointmentPopupVisible(page, timeout = 1800) {
  const titleVisible = await page
    .getByText("Dettagli appuntamento")
    .first()
    .isVisible({ timeout })
    .catch(() => false);
  if (titleVisible) return true;
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
      const visibleControls = [...popup.querySelectorAll("input, textarea, select, button, a, [role='button']")].filter(isVisible);
      return text.includes("dettagli appuntamento") || visibleControls.length >= 5;
    });
  }, null, { timeout }).then(() => true).catch(() => false);
}

async function clickAgendaEventRobust(page, searchTerms, expectedTime, dateIso) {
  let lastEvents = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await openAgendaInApp(page).catch(() => {});
      await gotoAgendaDate(page, dateIso).catch(() => {});
      await page.waitForTimeout(600);
    }

    // Scrolla verso l'orario atteso prima di cercare eventi (fix per orari pomeridiani fuori viewport)
    if (expectedTime) {
      await page.evaluate((t) => {
        const rows = [...document.querySelectorAll("td.fc-axis.fc-time, .fc-time")];
        const target = rows.find(r => (r.textContent || '').trim().startsWith(t.slice(0,2)));
        if (target) target.scrollIntoView({ block: 'center', behavior: 'instant' });
      }, expectedTime).catch(() => {});
      await page.waitForTimeout(300);
    }
    lastEvents = await scanAgendaEvents(page).catch(() => []);
    const ranked = rankAgendaEvents(lastEvents, searchTerms, expectedTime);

    const best = ranked[0]?.event || null;
    if (best && Number.isFinite(best.x) && Number.isFinite(best.y)) {
      await page.mouse.dblclick(best.x, best.y).catch(() => {});
      await page.waitForTimeout(800);
      if (await appointmentPopupVisible(page)) {
        return { success: true, text: best.title, time: best.time, method: "mouse_best_event", score: ranked[0]?.score || 0, events: lastEvents };
      }
    }

    const fallback = await clickAgendaEvent(page, searchTerms).catch(() => ({ success: false }));
    await page.waitForTimeout(800);
    if (fallback?.success && await appointmentPopupVisible(page)) {
      return { ...fallback, method: "dom_term_match", events: lastEvents };
    }
  }
  return { success: false, method: "not_found", events: lastEvents };
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
    const tagNodes = [...popup.querySelectorAll("span,div,a,button,label")]
      .filter(isVisible)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase())
      .filter((value) => value && value.length <= 24);
    const tags = [...new Set(knownTags.filter((tag) => {
      const needle = tag.toLowerCase();
      return tagNodes.some((nodeText) => nodeText === needle || nodeText.includes(needle));
    }))];

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
    notesText: "",
    odlText: "",
    materialsText: "",
    partsText: "",
    wasteText: "",
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

  const scoped = await page.evaluate(() => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isBoilerplate = (value) =>
      /dettagli pratica preventivi ordini di lavoro documenti fiscali ddt di uscita ordini a fornitore notifiche firme/i.test(
        clean(value).toLowerCase(),
      );
    const sectionTextFromKeyword = (keywordRegex) => {
      const anchors = [...document.querySelectorAll("h1,h2,h3,h4,label,span,div,td,th,a,button")]
        .filter(isVisible)
        .filter((el) => keywordRegex.test(clean(el.textContent || "").toLowerCase()));
      const sections = anchors
        .map((el) => el.closest("tr, .gwt-DecoratorPanel, .gwt-DialogBox, .gwt-PopupPanel, .gwt-TabLayoutPanel, .gwt-TabPanel, .gwt-StackPanel, table, form, section, article, .panel, .content, .container"))
        .filter(Boolean);
      const uniqueSections = [...new Set(sections)];
      const text = uniqueSections
        .map((section) => clean(section.innerText || section.textContent || ""))
        .filter((chunk) => chunk && chunk.length <= 1600 && !isBoilerplate(chunk))
        .join(" | ");
      return text.slice(0, 12000);
    };
    const readValues = (selector) =>
      [...document.querySelectorAll(selector)]
        .filter(isVisible)
        .map((el) => clean(el.value || el.textContent || ""))
        .filter(Boolean)
        .join(" | ")
        .slice(0, 12000);

    const allText = [...document.querySelectorAll("textarea,input[type='text'],input[type='number'],[contenteditable='true'],td,th,label,span,div")]
      .filter(isVisible)
      .map((el) => clean(el.value || el.innerText || el.textContent || ""))
      .filter((chunk) => chunk && chunk.length <= 300 && !isBoilerplate(chunk))
      .join(" | ")
      .slice(0, 30000);

    return {
      notesText: [sectionTextFromKeyword(/\bnote\b/i), readValues("textarea")].filter(Boolean).join(" | "),
      odlText: sectionTextFromKeyword(/\bordini?\s+di\s+lavoro\b|\bodl\b|\bman\b|\bmac\b/i),
      materialsText: sectionTextFromKeyword(/\bmateriali\b|\bconsumo\b/i),
      partsText: sectionTextFromKeyword(/\bricambi\b|\barticoli\b|\bmagazzino\b/i),
      wasteText: sectionTextFromKeyword(/\bsmaltimento\b|\brifiuti\b|%/i),
      allText,
    };
  }).catch(() => null);
  if (scoped && typeof scoped === "object") {
    result.notesText = scoped.notesText || "";
    result.odlText = scoped.odlText || "";
    result.materialsText = scoped.materialsText || "";
    result.partsText = scoped.partsText || "";
    result.wasteText = scoped.wasteText || "";
    result.allText = scoped.allText || "";
  }
  return result;
}

function resolveFoundValue(field, found) {
  if (field.field === "agenda.cosa") return found.popup?.agenda?.cosa || found.event?.title || "";
  if (field.field === "agenda.quando") return found.popup?.agenda?.quando || found.event?.date || "";
  if (field.field === "agenda.dalle") return found.popup?.agenda?.dalle || found.event?.startTime || found.event?.time || "";
  if (field.field === "agenda.alle") return found.popup?.agenda?.alle || found.event?.endTime || "";
  if (field.group === "tags") return [...(found.popup?.tags || [])].join(" ");
  if (field.group === "notes") return [found.popup?.notesText, found.practice?.notesText, found.practice?.allText].filter(Boolean).join(" ");
  if (field.group === "odl") return [found.practice?.odlText, found.practice?.allText].filter(Boolean).join(" ");
  if (field.group === "materials") return [found.practice?.materialsText, found.practice?.allText].filter(Boolean).join(" ");
  if (field.group === "parts") return [found.practice?.partsText, found.practice?.allText].filter(Boolean).join(" ");
  if (field.group === "waste") return [found.practice?.wasteText, found.practice?.allText].filter(Boolean).join(" ");
  return "";
}

function sanitizeFoundValue(field, value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase();
  const isPracticeBoilerplate = /dettagli pratica preventivi ordini di lavoro documenti fiscali ddt di uscita ordini a fornitore notifiche firme/.test(
    normalized,
  );
  if (isPracticeBoilerplate && ["notes", "odl", "materials", "parts", "waste"].includes(field.group)) {
    return "";
  }
  return raw;
}

function buildAuditHint(field) {
  if (field.group === "agenda") return "Apri popup appuntamento e verifica Cosa/Quando/Dalle/Alle.";
  if (field.group === "tags") return "Apri popup appuntamento e riallinea i tag richiesti.";
  if (field.group === "notes") return "Apri Gestione pratica e controlla note interne/reparto.";
  if (field.group === "odl") return "Apri Gestione pratica > Ordini di lavoro e verifica descrizioni/MAN/MAC.";
  if (field.group === "materials") return "Apri Ordini di lavoro > Materiali di consumo e verifica importo.";
  if (field.group === "parts") return "Apri Ordini di lavoro > Ricambi/Articoli e verifica nome + quantita'.";
  if (field.group === "waste") return "Apri Gestione pratica > Smaltimento rifiuti e verifica percentuale.";
  return "Verifica il campo in YAP.";
}

function buildMismatchReason(field, expected, actual) {
  if (!actual) return "campo_non_rilevato";
  if (field.kind === "time") return "orario_diverso";
  if (field.kind === "date") return "data_diversa";
  if (field.kind === "number_contains") return "valore_numerico_diverso";
  if (field.kind === "contains") return "testo_atteso_non_trovato";
  return "valore_diverso";
}

function previewValue(value, maxLen = 180) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen)}...`;
}

function issuePriority(issue) {
  const group = String(issue?.group || "").toLowerCase();
  const table = {
    tags: 1,
    agenda: 2,
    odl: 3,
    notes: 4,
    materials: 5,
    parts: 6,
    waste: 7,
  };
  return table[group] || 99;
}

function buildGroupStats(present, missing, mismatch) {
  const allGroups = new Set([
    ...(present || []).map((item) => item.group),
    ...(missing || []).map((item) => item.group),
    ...(mismatch || []).map((item) => item.group),
  ]);
  const stats = {};
  for (const group of allGroups) {
    const key = String(group || "other");
    stats[key] = {
      present: (present || []).filter((item) => item.group === group).length,
      missing: (missing || []).filter((item) => item.group === group).length,
      mismatch: (mismatch || []).filter((item) => item.group === group).length,
    };
  }
  return stats;
}

function buildAuditFeedback(present, missing, mismatch) {
  const blockers = [...(mismatch || []), ...(missing || [])].sort((a, b) => issuePriority(a) - issuePriority(b));
  const nextSteps = [];
  for (const issue of blockers) {
    if (issue?.hint && !nextSteps.includes(issue.hint)) {
      nextSteps.push(issue.hint);
    }
  }
  const topBlockers = blockers.slice(0, 6).map((item) => ({
    label: item.label || item.field,
    group: item.group,
    reason: item.reason || "valore_diverso",
    expected: item.expected_preview || previewValue(item.expected),
    found: item.found_preview || previewValue(item.found),
    hint: item.hint || null,
  }));
  const summary = blockers.length
    ? `Priorita': ${topBlockers.slice(0, 3).map((item) => item.label).join(" • ")}`
    : "Nessun blocco rilevato.";
  return {
    summary,
    totalBlockers: blockers.length,
    topBlockers,
    nextSteps: nextSteps.slice(0, 6),
    byGroup: buildGroupStats(present, missing, mismatch),
  };
}

function classifyAudit(fields, found) {
  const present = [];
  const missing = [];
  const mismatch = [];

  for (const field of fields) {
    const actual = sanitizeFoundValue(field, resolveFoundValue(field, found));
    if (valueMatches(field.expected, actual, field.kind)) {
      present.push({ ...field, found: actual });
      continue;
    }
    const reason = buildMismatchReason(field, field.expected, actual);
    const hint = buildAuditHint(field);
    if (actual) {
      mismatch.push({
        ...field,
        found: actual,
        found_preview: previewValue(actual),
        expected_preview: previewValue(field.expected),
        reason,
        hint,
      });
    } else {
      missing.push({
        ...field,
        found: actual || null,
        expected_preview: previewValue(field.expected),
        reason,
        hint,
      });
    }
  }

  const agendaFields = fields.filter((field) => field.group === "agenda");
  const agendaPresent = agendaFields.every((field) => present.some((item) => item.field === field.field));
  let status = "sync_failed";
  let message = "Appuntamento YAP non verificato.";
  let statusReason = "appointment_not_verified";

  if (agendaPresent && !missing.length && !mismatch.length) {
    status = "complete_synced";
    message = "YAP completo: agenda, note, ODL, materiali e ricambi verificati.";
    statusReason = "strict_match_complete";
  } else if (agendaPresent) {
    status = "partial_synced";
    message = "Agenda presente, ma verifica incompleta su note/ODL/materiali/ricambi/smaltimento.";
    statusReason = `strict_mismatch_missing_${missing.length}_mismatch_${mismatch.length}`;
  }

  const feedback = buildAuditFeedback(present, missing, mismatch);
  return { status, statusReason, message, present, missing, mismatch, feedback };
}

async function runAudit(mapping, args) {
  const username = ensureEnv("YAP_USERNAME");
  const password = ensureEnv("YAP_PASSWORD");
  const { plan, fields } = buildExpected(mapping);
  const plate = String(mapping.anagrafica?.targa || "").trim().toUpperCase();
  const searchTerms = [plate, plan.agenda.cosa, mapping.anagrafica?.cliente_nome].filter(Boolean);

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

  const browser = await launchChromiumWithFallback(
    chromium,
    {
      headless: !args.headed,
      args: launchArgs,
    },
    { resolveModule: requireFromYap.resolve.bind(requireFromYap), cwd: ROOT_DIR },
  );
  const context = await browser.newContext(await yapContextOptions({ freshLogin: args.freshLogin }));
  const page = await context.newPage();

  let screenshot = null;
  try {
    await loginYap(page, username, password);
    await openAgendaInApp(page);
    await gotoAgendaDate(page, mapping.agenda.data);

    const click = await clickAgendaEventRobust(page, searchTerms, plan.agenda.dalle, mapping.agenda.data);
    const events = click.events?.length ? click.events : await scanAgendaEvents(page);
    await page.waitForTimeout(1800);
    const popup = await extractPopup(page);
    const toolbar = await extractAgendaToolbar(page);
    let practice = { openedPractice: false, openedOdl: false, text: "", clickLabels: [] };
    if (popup.found && !args.quick) {
      practice = await tryOpenPracticeAndOdl(page);
    }

    if (args.debug) {
      screenshot = path.join(args.artifactDir, `audit-${plate || "practice"}-${Date.now()}.png`);
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    }

    const rankedEvents = rankAgendaEvents(events, searchTerms, plan.agenda.dalle)
      .map((item) => ({ ev: item.event, score: item.score }));
    const event = enrichAgendaEvent(rankedEvents[0]?.ev || null, plan, mapping.agenda.data);
    const clickEvent = click.success
      ? enrichAgendaEvent({ title: click.text, time: click.time || "" }, plan, mapping.agenda.data)
      : null;
    const found = { event: event || clickEvent, popup, toolbar, practice };
    const outcome = classifyAudit(fields, found);

    return {
      ok: outcome.status !== "sync_failed",
      checkedAt: new Date().toISOString(),
      mode: "readonly_yap_audit",
      quick: Boolean(args.quick),
      status: outcome.status,
      status_reason: outcome.statusReason,
      message: outcome.message,
      expected: {
        agenda: plan.agenda,
        fieldCount: fields.length,
        fields,
      },
      lookup: {
        searchTerms,
        expectedTime: plan.agenda.dalle,
        click,
        popupFound: Boolean(popup.found),
        openedPractice: Boolean(practice.openedPractice),
        bestEventScore: rankedEvents[0]?.score || 0,
        bestEvent: event ? [event.time, event.title].filter(Boolean).join(" ") : null,
        eventCount: events.length,
        eventTitles: events.map((ev) => [ev.time, ev.title].filter(Boolean).join(" ")).slice(0, 20),
      },
      found,
      present: outcome.present,
      missing: outcome.missing,
      mismatch: outcome.mismatch,
      feedback: outcome.feedback,
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
