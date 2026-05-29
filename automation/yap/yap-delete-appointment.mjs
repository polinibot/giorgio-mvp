#!/usr/bin/env node
/**
 * Cancella un appuntamento dall'agenda YAP.
 * Uso: node yap-delete-appointment.mjs --date 2026-11-12 --search TEST99ZZ
 * Opzioni:
 *   --date YYYY-MM-DD   giorno dell'appuntamento
 *   --search TESTO      testo da cercare nel titolo (targa, cliente, ecc.)
 *   --headed            apre il browser visibile (debug)
 *   --dry-run           mostra cosa cancella senza farlo davvero
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  ROOT_DIR,
  yapContextOptions,
  launchChromiumWithFallback,
} from "./lib/yap-shared.mjs";

const requireFromMiniApp = createRequire(new URL("../../mini-app/package.json", import.meta.url));
const { chromium } = requireFromMiniApp("playwright");

const DELETE_ACTION_ENDPOINT = "/yap/action/PrenotazioneDelAction";

function parseArgs(argv) {
  const args = { headed: false, dryRun: false, debug: false, freshLogin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (!argv[i]) throw new Error(`Valore mancante per ${arg}`);
      return argv[i];
    };
    if (arg === "--date") args.date = next();
    else if (arg === "--search") args.search = next();
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--debug") args.debug = true;
    else if (arg === "--fresh-login") args.freshLogin = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Argomento non riconosciuto: ${arg}`);
  }
  return args;
}

function classifyDeleteFailure(text) {
  const normalized = String(text || "").toLowerCase();
  if (/ordine di lavoro|odl|associat[oa].*lavoro|work order/.test(normalized)) return "blocked_by_odl";
  if (/non trov|not found/.test(normalized)) return "not_found";
  if (/permess|autorizz|permission|unauthorized|forbidden/.test(normalized)) return "permission_denied";
  if (normalized.trim()) return "unknown_yap_error";
  return null;
}

async function visibleYapMessage(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel, .toast, .notification, .materialert")]
      .filter(isVisible)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" | ");
  }).catch(() => "");
}

async function clickDeleteConfirmIfPresent(page) {
  // Cerca un dialog di conferma visibile con testo conferma/elimina/sì
  const confirmLocator = page.locator(
    ".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel"
  ).filter({ hasText: /conferm|sicuro|vuoi eliminare|eliminazione dell'appuntamento/i });

  const count = await confirmLocator.count();
  if (!count) return false;

  // Cerca bottone OK/Sì/Conferma nel dialog
  const okBtn = confirmLocator.last().locator(
    "button, .gwt-Button, a.gwt-Anchor, [role='button']"
  ).filter({ hasText: /ok|s[ìi]|confer|elimin|cancell|yes/i });

  const okCount = await okBtn.count();
  if (!okCount) {
    // Prova primo button disponibile
    const anyBtn = confirmLocator.last().locator("button, .gwt-Button, a.gwt-Anchor").first();
    if (await anyBtn.count()) { await anyBtn.click(); return true; }
    return false;
  }

  await okBtn.first().click();
  return true;
}

async function clickDeleteAndAcceptNativeDialog(page, locator) {
  const dialogMessages = [];
  const onDialog = async (dialog) => {
    const message = dialog.message();
    dialogMessages.push(message);
    if (/confermi l'eliminazione dell'appuntamento\?/i.test(message)) {
      await dialog.accept();
      return;
    }
    await dialog.dismiss().catch(() => {});
  };

  page.on("dialog", onDialog);
  try {
    await locator.click();
    return dialogMessages;
  } finally {
    page.off("dialog", onDialog);
  }
}

async function findAndDeleteAppointment(page, searchTerm, dryRun, dateIso) {
  const normalizeText = (t) =>
    String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const needle = normalizeText(searchTerm);

  const events = await page.evaluate(() => {
    return [...document.querySelectorAll(".fc-time-grid-event, .fc-event")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      })
      .map((el) => {
        const titleEl = el.querySelector(".fc-title") || el;
        const timeEl = el.querySelector(".fc-time");
        const rect = el.getBoundingClientRect();
        return {
          title: (titleEl.textContent || "").replace(/\s+/g, " ").trim(),
          time: (timeEl?.textContent || "").trim(),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
        };
      })
      .filter((ev) => ev.title);
  });

  const match = events.find((ev) => normalizeText(ev.title).includes(needle));
  if (!match) {
    return { found: false, searched: searchTerm, events: events.map((e) => e.title) };
  }

  if (dryRun) {
    return { found: true, dryRun: true, event: match, deleted: false };
  }

  let deleteRpcRequest = null;
  let deleteRpcResponse = null;
  const onRequest = (req) => {
    if (req.url().includes(DELETE_ACTION_ENDPOINT)) {
      deleteRpcRequest = {
        method: req.method(),
        url: req.url(),
        payload: req.postData() || "",
      };
    }
  };
  const onResponse = async (res) => {
    if (res.url().includes(DELETE_ACTION_ENDPOINT)) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        body = "";
      }
      deleteRpcResponse = {
        status: res.status(),
        body,
      };
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);

  // Chiudi eventuali tooltip/popup esistenti prima di cliccare sull'evento
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // Click su area neutra (intestazione ore, lontana da eventi e sidebar)
  await page.mouse.click(300, 128);
  await page.waitForTimeout(400);

  await page.mouse.click(match.x, match.y);
  await page.getByText("Dettagli appuntamento").first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(300);

  // Usa page.locator per cliccare su "Elimina appuntamento" — GWT richiede click reale Playwright
  const elimLocator = page.locator(".gwt-DecoratedPopupPanel a.gwt-Anchor").filter({ hasText: /Elimina/i });
  const elimCount = await elimLocator.count();
  if (elimCount === 0) {
    page.off("request", onRequest);
    page.off("response", onResponse);
    const screenshotPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `delete-popup-${Date.now()}.png`);
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    throw new Error(`Anchor Elimina non trovato nel popup. Screenshot: ${screenshotPath}`);
  }
  const dialogMessages = await clickDeleteAndAcceptNativeDialog(page, elimLocator.first());

  // Screenshot a 300ms, 1000ms, 2000ms dopo click Elimina per catturare dialog conferma
  for (const delay of [300, 700, 1000]) {
    await page.waitForTimeout(delay);
    const midPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `after-elimina-${delay}ms-${Date.now()}.png`);
    await fs.mkdir(path.dirname(midPath), { recursive: true });
    await page.screenshot({ path: midPath, fullPage: false });
    console.warn(`[debug] t+${delay}ms: ${midPath}`);
    // Se appare un popup intanto, esci dal loop
    const msg = await visibleYapMessage(page);
    if (msg) { console.warn(`[debug] t+${delay}ms popup: ${msg.slice(0, 120)}`); break; }
  }

  let visibleMessage = "";

  // Aspetta la RPC delete tramite waitForRequest (event-driven, non polling)
  // oppure un dialog di conferma che va cliccato prima
  const waitForRpc = page.waitForRequest(
    (req) => req.url().includes(DELETE_ACTION_ENDPOINT),
    { timeout: 10000 }
  ).then(() => "rpc").catch(() => "rpc_timeout");

  // Controlla anche se arriva prima un dialog di conferma
  let raceResult = "timeout";
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(600);
    if (deleteRpcRequest) { raceResult = "rpc"; break; }
    visibleMessage = await visibleYapMessage(page);
    if (classifyDeleteFailure(visibleMessage)) { raceResult = "error"; break; }
    const confirmed = await clickDeleteConfirmIfPresent(page);
    if (confirmed) { raceResult = "confirmed"; break; }
  }

  // Se c'era un dialog di conferma, aspetta ora la RPC
  if (raceResult === "confirmed" || raceResult === "timeout") {
    await Promise.race([waitForRpc, page.waitForTimeout(8000)]);
  }

  await page.waitForTimeout(500);
  visibleMessage = visibleMessage || await visibleYapMessage(page);
  page.off("request", onRequest);
  page.off("response", onResponse);

  if (!page.url().includes("#!agenda")) {
    await openAgendaInApp(page);
  }
  await gotoAgendaDate(page, dateIso);
  await page.waitForTimeout(600);

  const afterEvents = await page.evaluate(() =>
    [...document.querySelectorAll(".fc-time-grid-event, .fc-event")]
      .filter((el) => el.getBoundingClientRect().width > 2)
      .map((el) => (el.querySelector(".fc-title") || el).textContent.trim())
  );
  const stillPresent = afterEvents.some((t) => t.toLowerCase().includes(searchTerm.toLowerCase()));
  const failureStatus = stillPresent
    ? classifyDeleteFailure(deleteRpcResponse?.body || visibleMessage)
    : null;
  // Quando YAP blocca l'appuntamento per ODL, la correzione e' a due passi:
  // cancellare prima l'ordine di lavoro e poi rilanciare questo script.
  const repairHint = failureStatus === "blocked_by_odl"
    ? {
      script: `node automation/yap/yap-delete-linked-odl.mjs --date ${dateIso} --search ${searchTerm}`,
      reason: "L'appuntamento e' collegato a un ordine di lavoro. Prima elimina l'ODL, poi rilancia questo script.",
    }
    : null;

  return {
    found: true,
    deleted: !stillPresent,
    status: stillPresent ? (failureStatus || "not_deleted") : "deleted",
    confirmed: !!deleteRpcRequest,
    deleteAction: {
      detected: !!deleteRpcRequest,
      requestMethod: deleteRpcRequest?.method,
      responseStatus: deleteRpcResponse?.status,
      failureStatus,
    },
    event: match,
    yapMessage: visibleMessage || undefined,
    note: stillPresent
      ? failureStatus === "blocked_by_odl"
        ? "YAP blocca la cancellazione perche l'appuntamento e' associato a un ordine di lavoro."
        : "Richiesta delete inviata ma evento ancora visibile in agenda."
      : undefined,
    repairHint,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log("Uso: node yap-delete-appointment.mjs --date YYYY-MM-DD --search TESTO [--headed] [--dry-run] [--debug] [--fresh-login]");
    return;
  }
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error("Obbligatorio: --date YYYY-MM-DD");
    process.exit(1);
  }
  if (!args.search) {
    console.error("Obbligatorio: --search TESTO");
    process.exit(1);
  }

  const user = process.env.YAP_USERNAME || "";
  const pass = process.env.YAP_PASSWORD || "";
  const hasCredentials = Boolean(user && pass);
  if (!hasCredentials && args.freshLogin) {
    console.error("Con --fresh-login servono YAP_USERNAME e YAP_PASSWORD");
    process.exit(1);
  }

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
    if (hasCredentials) {
      await loginYap(page, user, pass);
    } else {
      // Prova sessione esistente senza forzare login.
      await openAgendaInApp(page);
    }
    await openAgendaInApp(page);
    await gotoAgendaDate(page, args.date);

    const result = await findAndDeleteAppointment(page, args.search, args.dryRun, args.date);

    let screenshotPath = null;
    if (args.debug || result.status === "unknown_yap_error") {
      screenshotPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `after-delete-${args.date}-${Date.now()}.png`);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    console.log(JSON.stringify({ ok: true, date: args.date, search: args.search, screenshot: screenshotPath, ...result }, null, 2));
  } catch (error) {
    const errorSuffix = `${args.search}-${Date.now()}`;
    const errorScreenshotPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `error-delete-${errorSuffix}.png`);
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

async function notifyError(error, args) {
  const apiBaseUrl = process.env.API_BASE_URL;
  if (!apiBaseUrl) return;

  const payload = {
    error_message: error.message,
    stack_trace: error.stack,
    screenshot_path: error.screenshotPath || null,
    practice_id: null,
    customer: args?.search ? { name: args.search, plate: args.search } : null,
    appointment: args?.date ? { date: args.date, time: null } : null,
    worker: "yap-delete-appointment.mjs",
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

main().catch(async (err) => {
  // Prova a notificare l'errore al backend
  try {
    const args = parseArgs(process.argv.slice(2));
    await notifyError(err, args);
  } catch {
    // Ignora errori nella notifica
  }

  console.error(JSON.stringify({
    ok: false,
    error: err.message,
    stack: err.stack,
    screenshot: err.screenshotPath || null,
  }, null, 2));
  process.exit(1);
});
