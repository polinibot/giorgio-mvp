#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  toItalianDate,
  toYapTime,
  addMinutes,
  normalizeAppointmentTime,
  getYapSlotMinutes,
  yapContextOptions,
  waitForAgendaReady,
  waitForYapAction,
} from "./lib/yap-shared.mjs";
import {
  pickCosaFromJob,
  pickYapTagsFromJob,
  buildNotesForPopup,
  jobToMapping,
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

async function openAgenda(page, isoDate) {
  await openAgendaInApp(page);
  if (isoDate) {
    await gotoAgendaDate(page, isoDate);
  }
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
  const [hours, minutes] = String(time || "").replace(".", ":").split(":").map(Number);
  return hours * 60 + minutes;
}

async function clickApproximateSlot(page, targetTime) {
  const normalizedTarget = normalizeAppointmentTime(targetTime);
  await waitForAgendaReady(page, 12000).catch(() => {});
  const candidate = await page.evaluate((requestedTime) => {
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
    }, null, { timeout: 10000 }).catch(() => {});

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

  await page.waitForTimeout(120);
  const clickX = (slot.text || slot.time)
    ? slot.x + slot.width + 260
    : slot.x + Math.min(220, slot.width / 2);
  const clickY = slot.y + Math.max(8, slot.height / 2);
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

async function addYapTagChips(page, tags) {
  if (!tags.length) return;

  await page.evaluate((desiredTags) => {
    const popups = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")];
    const popup = popups.find((p) => (p.textContent || "").includes("Dettagli"));
    if (!popup) return;

    const existing = (popup.textContent || "").toLowerCase();
    for (const tag of desiredTags) {
      if (existing.includes(tag.toLowerCase())) continue;

      const clickable = [...popup.querySelectorAll("div, span, button, a")].find((el) => {
        const text = (el.textContent || "").trim().toLowerCase();
        return text === tag.toLowerCase() && el.getBoundingClientRect().width > 0;
      });
      if (clickable) {
        clickable.click();
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
  }, tags);
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
  return page.evaluate(() => {
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

async function runYapAutomation(job, args) {
  const username = ensureEnv("YAP_USERNAME");
  const password = ensureEnv("YAP_PASSWORD");
  await fs.mkdir(args.artifactDir, { recursive: true });

  const browser = await chromium.launch({
    headless: !args.headed,
    executablePath: process.env.YAP_CHROMIUM_EXECUTABLE || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
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
      return {
        saved: false,
        mode: "commit-blocked-duplicate",
        dedup,
        message: "Commit bloccato: appuntamento duplicato rilevato in agenda.",
      };
    }

    await clickApproximateSlot(page, job.appointment.time);
    await fillAppointmentPopup(page, job);

    const suffix = `${job.practiceId || "payload"}-${Date.now()}`;
    let beforeSavePath = null;
    if (args.debug) {
      beforeSavePath = path.join(args.artifactDir, `before-save-${suffix}.png`);
      await page.screenshot({ path: beforeSavePath, fullPage: true });
    }

    let putResponse = null;
    let saveAttemptsUsed = 0;
    let lastSaveError = null;
    const maxSaveAttempts = 3;
    for (let attempt = 1; attempt <= maxSaveAttempts; attempt += 1) {
      saveAttemptsUsed = attempt;
      try {
        putResponse = await waitForYapAction(page, "PrenotazionePutAction", async () => {
          const saved = await page.evaluate(() => {
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
        }, 12000 + (attempt - 1) * 4000);
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
    await page.waitForTimeout(600);
    let afterSavePath = null;
    if (args.debug) {
      afterSavePath = path.join(args.artifactDir, `after-save-${suffix}.png`);
      await page.screenshot({ path: afterSavePath, fullPage: true });
    }
    await updatePracticeSynced(args, job).catch(() => {});

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
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/yap/notify-error`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
