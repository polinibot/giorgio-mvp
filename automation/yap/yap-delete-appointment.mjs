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
  waitForYapAction,
  yapContextOptions,
  launchChromiumWithFallback,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const DELETE_ACTION_ENDPOINT = "/yap/action/PrenotazioneDelAction";

function createDeleteTrace(context = {}) {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const timeline = [];

  const mark = (event, details = {}) => {
    const entry = {
      at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAtMs,
      event,
      ...details,
    };
    timeline.push(entry);
    console.warn(`[delete-trace] ${JSON.stringify(entry)}`);
    return entry;
  };

  const fail = (event, error, details = {}) => mark(event, {
    ...details,
    error: error instanceof Error ? error.message : String(error || ""),
  });

  const snapshot = (extra = {}) => ({
    ...context,
    started_at: startedAtIso,
    finished_at: new Date().toISOString(),
    total_elapsed_ms: Date.now() - startedAtMs,
    steps: [...timeline],
    ...extra,
  });

  return { mark, fail, snapshot };
}

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
    else if (arg.startsWith("--date=")) args.date = arg.slice("--date=".length);
    else if (arg === "--search") args.search = next();
    else if (arg.startsWith("--search=")) args.search = arg.slice("--search=".length);
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

async function listVisibleAgendaEvents(page) {
  return page.evaluate(() => {
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
}

async function findAndDeleteAppointment(page, searchTerm, dryRun, dateIso, debug = false, trace = null) {
  const normalizeText = (t) =>
    String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const needle = normalizeText(searchTerm);

  trace?.mark("agenda_scan_started", { search: searchTerm, date: dateIso });
  const events = await listVisibleAgendaEvents(page);
  trace?.mark("agenda_scan_completed", { event_count: events.length });

  const match = events.find((ev) => normalizeText(ev.title).includes(needle));
  if (!match) {
    trace?.mark("appointment_not_found_in_visible_events", { visible_titles: events.map((event) => event.title).slice(0, 12) });
    return { found: false, searched: searchTerm, events: events.map((e) => e.title) };
  }
  trace?.mark("appointment_match_found", {
    matched_title: match.title,
    matched_time: match.time || null,
  });

  if (dryRun) {
    trace?.mark("dry_run_completed", { matched_title: match.title });
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
  await page.waitForTimeout(150);
  // Click su area neutra (intestazione ore, lontana da eventi e sidebar)
  await page.mouse.click(300, 128);
  await page.waitForTimeout(150);

  trace?.mark("opening_appointment_details", { x: Math.round(match.x), y: Math.round(match.y) });
  await page.mouse.click(match.x, match.y);
  await page.getByText("Dettagli appuntamento").first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(150);
  trace?.mark("appointment_details_opened");

  // Usa page.locator per cliccare su "Elimina appuntamento" — GWT richiede click reale Playwright
  const elimLocator = page.locator(".gwt-DecoratedPopupPanel a.gwt-Anchor").filter({ hasText: /Elimina/i });
  const elimCount = await elimLocator.count();
  if (elimCount === 0) {
    page.off("request", onRequest);
    page.off("response", onResponse);
    const screenshotPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `delete-popup-${Date.now()}.png`);
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    trace?.mark("delete_anchor_missing", { screenshot: screenshotPath });
    throw new Error(`Anchor Elimina non trovato nel popup. Screenshot: ${screenshotPath}`);
  }
  let dialogMessages = [];
  trace?.mark("delete_action_click_started");
  const rpcSeen = waitForYapAction(
    page,
    "PrenotazioneDelAction",
    async () => {
      dialogMessages = await clickDeleteAndAcceptNativeDialog(page, elimLocator.first());
    },
    4500,
  ).then(() => true).catch(() => false);

  if (debug) {
    await page.waitForTimeout(350);
    const midPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `after-elimina-${Date.now()}.png`);
    await fs.mkdir(path.dirname(midPath), { recursive: true });
    await page.screenshot({ path: midPath, fullPage: false });
    console.warn(`[debug] dopo click elimina: ${midPath}`);
    trace?.mark("debug_screenshot_after_delete_click", { screenshot: midPath });
  }

  let visibleMessage = "";
  let confirmLoopIterations = 0;

  for (let i = 0; i < 8; i += 1) {
    confirmLoopIterations = i + 1;
    await page.waitForTimeout(180);
    if (deleteRpcRequest) break;
    visibleMessage = await visibleYapMessage(page);
    if (classifyDeleteFailure(visibleMessage)) break;
    const confirmed = await clickDeleteConfirmIfPresent(page);
    if (confirmed) {
      await page.waitForTimeout(180);
      break;
    }
  }

  if (!deleteRpcRequest) {
    trace?.mark("waiting_for_delete_rpc_after_confirm_loop", { iterations: confirmLoopIterations });
    await Promise.race([rpcSeen, page.waitForTimeout(2200)]);
  }

  await page.waitForTimeout(deleteRpcRequest ? 220 : 420);
  visibleMessage = visibleMessage || await visibleYapMessage(page);
  trace?.mark("delete_action_wait_completed", {
    rpc_detected: !!deleteRpcRequest,
    confirm_iterations: confirmLoopIterations,
    visible_message: visibleMessage || null,
    dialog_count: dialogMessages.length,
  });
  page.off("request", onRequest);
  page.off("response", onResponse);

  let afterEvents = await listVisibleAgendaEvents(page).catch(() => []);
  let stillPresent = afterEvents.some((event) => event.title.toLowerCase().includes(searchTerm.toLowerCase()));
  if (stillPresent || !page.url().includes("#!agenda")) {
    trace?.mark("reopening_agenda_for_verification", {
      still_present_before_reopen: stillPresent,
      current_url: page.url(),
    });
    await openAgendaInApp(page);
    await gotoAgendaDate(page, dateIso);
    await page.waitForTimeout(250);
    afterEvents = await listVisibleAgendaEvents(page).catch(() => []);
    stillPresent = afterEvents.some((event) => event.title.toLowerCase().includes(searchTerm.toLowerCase()));
  }
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

  trace?.mark("delete_verification_completed", {
    still_present: stillPresent,
    failure_status: failureStatus,
    response_status: deleteRpcResponse?.status ?? null,
    verified_event_count: afterEvents.length,
  });

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
    telemetry: {
      dialogMessages,
      rpcDetected: !!deleteRpcRequest,
      trace: trace?.snapshot({
        rpc_request_detected: !!deleteRpcRequest,
        rpc_response_status: deleteRpcResponse?.status ?? null,
        final_status: stillPresent ? (failureStatus || "not_deleted") : "deleted",
      }),
    },
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
    { resolveModule: requireFromYap.resolve.bind(requireFromYap), cwd: ROOT_DIR },
  );
  const context = await browser.newContext(await yapContextOptions({ freshLogin: args.freshLogin }));
  const page = await context.newPage();
  const trace = createDeleteTrace({
    worker: "yap-delete-appointment.mjs",
    search: args.search,
    date: args.date,
    debug: !!args.debug,
    fresh_login: !!args.freshLogin,
    dry_run: !!args.dryRun,
  });

  try {
    trace.mark("browser_ready", { headed: !!args.headed, fresh_login: !!args.freshLogin });
    if (hasCredentials) {
      trace.mark("login_started", { mode: "credentials" });
      await loginYap(page, user, pass);
      trace.mark("login_completed");
    } else {
      // Prova sessione esistente senza forzare login.
      trace.mark("login_skipped_using_existing_session");
      await openAgendaInApp(page);
    }
    trace.mark("agenda_open_requested");
    await openAgendaInApp(page);
    trace.mark("agenda_open_completed");
    trace.mark("agenda_date_navigation_started", { date: args.date });
    await gotoAgendaDate(page, args.date);
    trace.mark("agenda_date_navigation_completed", { date: args.date });

    const result = await findAndDeleteAppointment(page, args.search, args.dryRun, args.date, args.debug, trace);
    trace.mark("delete_flow_completed", { final_status: result.status || (result.deleted ? "deleted" : "unknown") });

    let screenshotPath = null;
    if (args.debug || result.status === "unknown_yap_error") {
      screenshotPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `after-delete-${args.date}-${Date.now()}.png`);
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      trace.mark("final_screenshot_saved", { screenshot: screenshotPath });
    }

    console.log(JSON.stringify({
      ok: true,
      date: args.date,
      search: args.search,
      screenshot: screenshotPath,
      ...result,
      telemetry: {
        ...(result.telemetry || {}),
        trace: trace.snapshot({
          outcome: result.status || (result.deleted ? "deleted" : "unknown"),
          screenshot: screenshotPath,
        }),
      },
    }, null, 2));
  } catch (error) {
    trace.fail("delete_flow_failed", error);
    const errorSuffix = `${args.search}-${Date.now()}`;
    const errorScreenshotPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `error-delete-${errorSuffix}.png`);
    try {
      await page.screenshot({ path: errorScreenshotPath, fullPage: true });
      error.screenshotPath = errorScreenshotPath;
      console.warn(`Screenshot dell'errore salvato in: ${errorScreenshotPath}`);
      trace.mark("error_screenshot_saved", { screenshot: errorScreenshotPath });
    } catch (screenshotError) {
      console.warn(`Fallito screenshot dell'errore: ${screenshotError.message}`);
      trace.fail("error_screenshot_failed", screenshotError);
    }
    error.deleteTrace = trace.snapshot({ screenshot: error.screenshotPath || null });
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
    telemetry: err.deleteTrace ? { trace: err.deleteTrace } : undefined,
  }, null, 2));
  process.exit(1);
});
