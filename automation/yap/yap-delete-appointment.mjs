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
  buildYapTelemetry,
  createYapRuntime,
  loginYap,
  openAgendaWithRecovery,
  waitForAgendaReady,
  ROOT_DIR,
  scanVisibleAgendaEventTargets,
  waitForAgendaEventPopulation,
  waitForYapAction,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const DELETE_ACTION_ENDPOINT = "/yap/action/PrenotazioneDelAction";
// RPC che YAP invia quando un DOCUMENTO (preventivo/ODL) viene davvero eliminato.
// Usate per confermare la delete del documento bloccante (non basta cliccare).
const DOC_DELETE_ENDPOINTS = [
  "/yap/action/DocumentoDeleteAction",
  "/yap/action/OdlDeleteAction",
  "/yap/action/PreventivoDelAction",
  "/yap/action/PreventivoDeleteAction",
];

function createDeleteTrace(context = {}) {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const timeline = [];

  const mark = (event, details = {}) => {
    const ts = new Date().toISOString();
    const elapsed_ms = Date.now() - startedAtMs;
    const entry = { at: ts, elapsed_ms, event, ...details };
    timeline.push(entry);
    console.warn(`[delete-trace] ${JSON.stringify(entry)}`);
    // CRITICO: emette ANCHE un evento yap:phase, l'unico formato che il backend estrae
    // in worker_phases. Senza questo il log della delete era SEMPRE vuoto nel banner
    // (il worker di sync lo ha perche' usa logPhase=yap:phase; la delete no).
    try {
      process.stderr.write(JSON.stringify({
        event: "yap:phase",
        phase: "delete",
        status: event,
        elapsed_ms,
        ts,
        ...details,
      }) + "\n");
    } catch (_) { /* best-effort */ }
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
  const args = { headed: false, dryRun: false, debug: false, freshLogin: false, time: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (!argv[i]) throw new Error(`Valore mancante per ${arg}`);
      return argv[i];
    };
    if (arg === "--date") args.date = next();
    else if (arg.startsWith("--date=")) args.date = arg.slice("--date=".length);
    else if (arg === "--time") args.time = next();
    else if (arg.startsWith("--time=")) args.time = arg.slice("--time=".length);
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
  if (/preventivo/.test(normalized)) return "blocked_by_preventivo";
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

// Apre la pratica dal popup appuntamento cliccando "Gestione pratica" (DOM-dispatch,
// come lo standalone yap-delete-linked-odl.mjs che funziona).
async function clickPracticeLinkInPopup(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 3 && r.height > 3 && s.display !== "none" && s.visibility !== "hidden";
    };
    const popup = document.querySelector(".gwt-DecoratedPopupPanel");
    const root = popup || document.body;
    const cand = [...root.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div")].filter((el) => {
      const t = (el.textContent || "").toLowerCase();
      return (t.includes("gestione pratica") || t.includes("apri pratica")
        || (t.includes("pratica") && !t.includes("prenotazione"))) && t.length < 60;
    });
    for (const el of cand) {
      if (!isVisible(el)) continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, label: (el.textContent || "").trim().slice(0, 80) };
    }
    return { clicked: false };
  }).catch(() => ({ clicked: false }));
}

// Clicca la sezione documento nella pratica (Preventivi / Ordini di lavoro).
async function clickDocSectionTab(page, tabReSource) {
  return page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 3 && r.height > 3 && s.display !== "none" && s.visibility !== "hidden";
    };
    const cand = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")].filter((el) => {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      return re.test(t) && t.length < 40;
    });
    for (const el of cand) {
      if (!isVisible(el)) continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) };
    }
    return { clicked: false };
  }, tabReSource).catch(() => ({ clicked: false }));
}

// Clicca il bottone "Elimina" della TOOLBAR documento (testo esatto "Elimina", in alto
// y<180). Evita di prendere l'Elimina dell'appuntamento o un delete di riga.
async function clickToolbarEliminaDoc(page) {
  const target = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, .gwt-Button, a.gwt-Anchor, [role='button']")];
    const m = btns.find((el) => {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return text === "Elimina" && r.width > 10 && r.height > 10 && r.y < 180
        && s.display !== "none" && s.visibility !== "hidden";
    });
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }).catch(() => null);
  if (target) {
    await page.mouse.click(target.x, target.y);
    return target;
  }
  const loc = page.locator("button, .gwt-Button, a.gwt-Anchor, [role='button']").filter({ hasText: /^Elimina$/i }).first();
  if (await loc.count().catch(() => 0)) {
    await loc.click({ force: true }).catch(() => {});
    return { text: "Elimina" };
  }
  return null;
}

/**
 * Gestisce documento bloccante (ODL o preventivo): apre la pratica, naviga alla sezione
 * del documento, clicca Elimina nella toolbar, conferma, e CONFERMA via RPC che il
 * documento sia stato eliminato; poi torna ad agenda e riprova la delete appuntamento.
 * Mirroring della logica provata in yap-delete-linked-odl.mjs.
 */
async function handleBlockingDocAndRetry(page, event, dateIso, searchTerm, trace, kind = "odl", expectedTime = "") {
  const doc = kind === "preventivo"
    ? { tabRe: /^Preventivi$|Preventivi/i }
    : { tabRe: /Ordini di lavoro|^ODL$/i };

  // Rileva la delete REALE del documento via RPC (non basta cliccare Elimina).
  const docRpc = [];
  const onDocReq = (req) => {
    if (DOC_DELETE_ENDPOINTS.some((e) => req.url().includes(e))) {
      docRpc.push({ method: req.method(), url: req.url() });
    }
  };
  page.on("request", onDocReq);
  // I dialog di conferma eliminazione documento (nativi e GWT) vanno accettati.
  const onDialog = (dialog) => {
    const m = dialog.message();
    if (/elimin|conferm|sicur|rimuov|vuoi|s[ìi]\b/i.test(m)) dialog.accept().catch(() => {});
    else dialog.dismiss().catch(() => {});
  };
  page.on("dialog", onDialog);
  try {
    trace?.mark(`${kind}_fix_open_popup`, { event: event.title });
    await page.mouse.click(event.x, event.y);
    await page.waitForTimeout(900);

    const practiceLink = await clickPracticeLinkInPopup(page);
    trace?.mark(`${kind}_fix_practice_link`, practiceLink);
    if (!practiceLink?.clicked) {
      await page.mouse.dblclick(event.x, event.y).catch(() => {});
    }
    await page.waitForTimeout(3000);

    const section = await clickDocSectionTab(page, doc.tabRe.source);
    trace?.mark(`${kind}_fix_section_click`, section);
    await page.waitForTimeout(2500);

    const del = await clickToolbarEliminaDoc(page);
    trace?.mark(`${kind}_fix_toolbar_elimina`, { found: Boolean(del) });

    // Loop conferma + attesa RPC delete documento.
    for (let i = 0; i < 12 && !docRpc.length; i += 1) {
      await page.waitForTimeout(400);
      await clickDeleteConfirmIfPresent(page).catch(() => {});
    }
    await page.waitForTimeout(1500);
    const docDeleted = docRpc.length > 0;
    trace?.mark(`${kind}_fix_doc_delete_rpc`, { detected: docDeleted, rpc_count: docRpc.length });

    // Torna all'agenda e riprova la delete appuntamento (auto-fix DISABILITATO per
    // evitare ricorsione infinita se il documento non si è eliminato).
    await openAgendaWithRecovery(page, { dateIso, username: process.env.YAP_USERNAME, password: process.env.YAP_PASSWORD });
    await page.waitForTimeout(1500);
    trace?.mark(`${kind}_fix_back_to_agenda`);

    const retryResult = await findAndDeleteAppointment(page, searchTerm, false, dateIso, false, trace, expectedTime, false);
    trace?.mark(`${kind}_fix_retry_completed`, { deleted: retryResult.deleted, status: retryResult.status });
    return retryResult.deleted;
  } catch (err) {
    trace?.mark(`${kind}_fix_error`, { error: err.message });
    return false;
  } finally {
    page.off("request", onDocReq);
    page.off("dialog", onDialog);
  }
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


async function listVisibleAgendaEvents(page) {
  await waitForAgendaEventPopulation(page);
  return scanVisibleAgendaEventTargets(page);
}

async function findAndDeleteAppointment(page, searchTerm, dryRun, dateIso, debug = false, trace = null, expectedTime = "", allowAutoFix = true) {
  const normalizeText = (t) =>
    String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const needle = normalizeText(searchTerm);
  const normalizedExpectedTime = normalizeText(expectedTime).replace(":", ".");
  const matchesNeedle = (event) => {
    if (!normalizeText(event.title).includes(needle)) return false;
    if (!normalizedExpectedTime) return true;
    return normalizeText(event.time || "").replace(":", ".").includes(normalizedExpectedTime);
  };

  trace?.mark("agenda_scan_started", { search: searchTerm, date: dateIso });
  const events = await listVisibleAgendaEvents(page);
  trace?.mark("agenda_scan_completed", { event_count: events.length });

  let matchingEvents = events.filter(matchesNeedle);
  let timeOnlyFallback = false;
  // Fallback: YAP mostra icone (titolo "V") al posto del testo nel .fc-title.
  // Se non c'è match per targa+ora, usa solo l'orario quando expectedTime è presente.
  if (matchingEvents.length === 0 && normalizedExpectedTime) {
    const toMin = (s) => { const [h, m] = String(s || "").replace(".", ":").split(":").map(Number); return isNaN(h) ? null : h * 60 + (m || 0); };
    const expMin = toMin(normalizedExpectedTime);
    if (expMin !== null) {
      matchingEvents = events.filter((ev) => {
        const evTime = normalizeText(ev.time || "").replace(".", ":");
        const startM = evTime.match(/(\d{1,2}):(\d{2})/);
        if (!startM) return false;
        return Math.abs(Number(startM[1]) * 60 + Number(startM[2]) - expMin) === 0;
      });
      if (matchingEvents.length) timeOnlyFallback = true;
    }
  }
  const match = matchingEvents[0];
  if (!match) {
    trace?.mark("appointment_not_found_in_visible_events", { visible_titles: events.map((event) => event.title).slice(0, 12) });
    return { found: false, searched: searchTerm, events: events.map((e) => e.title) };
  }
  if (timeOnlyFallback) {
    trace?.mark("time_only_fallback_used", { matched_title: match.title, matched_time: match.time });
  }
  const initialMatchCount = matchingEvents.length;
  trace?.mark("appointment_match_found", {
    matched_title: match.title,
    matched_time: match.time || null,
    initial_match_count: initialMatchCount,
    expected_time: expectedTime || null,
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

  const titleNeedle = String(match.title || "").trim();
  const timeNeedle = String(match.time || "").trim();
  const eventLocator = page.locator(".fc-time-grid-event, .fc-event")
    .filter({ hasText: titleNeedle });
  const exactLocator = timeNeedle
    ? eventLocator.filter({ hasText: timeNeedle }).first()
    : eventLocator.first();

  trace?.mark("opening_appointment_details", {
    x: Math.round(match.x),
    y: Math.round(match.y),
    locator_target: titleNeedle,
  });
  let clickedViaLocator = false;
  try {
    await exactLocator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await exactLocator.click({ timeout: 8000 });
    clickedViaLocator = true;
  } catch {
    await page.mouse.click(match.x, match.y);
  }
  await page.getByText("Dettagli appuntamento").first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(150);
  trace?.mark("appointment_details_opened", { via_locator: clickedViaLocator });

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
  // Handler dialog PERSISTENTE: attaccato prima del click e rimosso solo dopo
  // la verifica finale. Cattura sia i dialog sincroni (conferma) sia quelli
  // asincroni post-RPC (errore "non è possibile eliminare perché preventivo/odl"),
  // che YAP mostra come alert() dopo la risposta del server.
  const dialogMessages = [];
  const onDialog = async (dialog) => {
    const message = dialog.message();
    dialogMessages.push(message);
    if (/confermi l'eliminazione dell'appuntamento\?/i.test(message)) {
      await dialog.accept();
    } else {
      await dialog.dismiss().catch(() => {});
    }
  };
  page.on("dialog", onDialog);

  trace?.mark("delete_action_click_started");
  const rpcSeen = waitForYapAction(
    page,
    "PrenotazioneDelAction",
    () => elimLocator.first().click(),
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
    // controlla anche i dialog nativi già catturati dall'handler persistente
    const dialogBlock = classifyDeleteFailure(dialogMessages.join(" | "));
    if (dialogBlock) break;
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

  // Attesa extra per dialog asincroni post-RPC (es. errore "preventivo" che YAP
  // mostra come alert() dopo la risposta del server, fuori dal confirm loop).
  await page.waitForTimeout(deleteRpcRequest ? 220 : 600);
  visibleMessage = visibleMessage || await visibleYapMessage(page);
  const nativeDialogText = dialogMessages.join(" | ");
  if (!visibleMessage && nativeDialogText) visibleMessage = nativeDialogText;
  trace?.mark("delete_action_wait_completed", {
    rpc_detected: !!deleteRpcRequest,
    confirm_iterations: confirmLoopIterations,
    visible_message: visibleMessage || null,
    native_dialog_text: nativeDialogText || null,
    dialog_count: dialogMessages.length,
  });
  page.off("request", onRequest);
  page.off("response", onResponse);
  page.off("dialog", onDialog);

  let afterEvents = await listVisibleAgendaEvents(page).catch(() => []);
  let remainingMatches = afterEvents.filter(matchesNeedle).length;
  let deletedCount = Math.max(0, initialMatchCount - remainingMatches);
  let targetDeleted = deletedCount >= 1;
  if (!targetDeleted) {
    trace?.mark("reopening_agenda_for_verification", {
      remaining_matches_before_reopen: remainingMatches,
      deleted_count_before_reopen: deletedCount,
      current_url: page.url(),
    });
    await openAgendaWithRecovery(page, { dateIso, username: process.env.YAP_USERNAME, password: process.env.YAP_PASSWORD });
    await page.waitForTimeout(250);
    afterEvents = await listVisibleAgendaEvents(page).catch(() => []);
    remainingMatches = afterEvents.filter(matchesNeedle).length;
    deletedCount = Math.max(0, initialMatchCount - remainingMatches);
    targetDeleted = deletedCount >= 1;
  }
  let failureStatus = !targetDeleted
    ? classifyDeleteFailure(deleteRpcResponse?.body || visibleMessage)
    : null;
  // Gestione automatica documento bloccante (ODL o preventivo): apri pratica,
  // elimina il documento, riprova la delete dell'appuntamento.
  let odlAutoFixed = false;
  if ((failureStatus === "blocked_by_odl" || failureStatus === "blocked_by_preventivo") && !dryRun && allowAutoFix) {
    const blockKind = failureStatus === "blocked_by_preventivo" ? "preventivo" : "odl";
    trace?.mark("blocking_doc_auto_fix_started", { kind: blockKind });
    try {
      odlAutoFixed = await handleBlockingDocAndRetry(page, match, dateIso, searchTerm, trace, blockKind, expectedTime);
      if (odlAutoFixed) {
        trace?.mark("blocking_doc_auto_fix_success", { kind: blockKind });
        // Riverifica eliminazione
        await openAgendaWithRecovery(page, { dateIso, username: process.env.YAP_USERNAME, password: process.env.YAP_PASSWORD });
        await page.waitForTimeout(400);
        const finalEvents = await listVisibleAgendaEvents(page).catch(() => []);
        remainingMatches = finalEvents.filter(matchesNeedle).length;
        deletedCount = Math.max(0, initialMatchCount - remainingMatches);
        targetDeleted = deletedCount >= 1;
        if (targetDeleted) {
          failureStatus = null;
        }
        afterEvents = finalEvents;
      }
    } catch (odlErr) {
      trace?.mark("odl_auto_fix_failed", { error: odlErr.message });
    }
  }

  const repairHint = (failureStatus === "blocked_by_odl" && !odlAutoFixed)
    ? {
      script: `node automation/yap/yap-delete-linked-odl.mjs --date ${dateIso} --search ${searchTerm}${expectedTime ? ` --time ${expectedTime}` : ""}`,
      reason: "L'appuntamento e' collegato a un ordine di lavoro. La rimozione automatica dell'ODL non e' riuscita: elimina l'ODL su YAP, poi riprova.",
    }
    : (failureStatus === "blocked_by_preventivo" && !odlAutoFixed)
      ? {
        reason: "L'appuntamento e' collegato a un preventivo. La rimozione automatica del preventivo non e' riuscita: apri la pratica su YAP, elimina il preventivo, poi riprova.",
      }
      : null;

  trace?.mark("delete_verification_completed", {
    initial_match_count: initialMatchCount,
    remaining_match_count: remainingMatches,
    deleted_count: deletedCount,
    target_deleted: targetDeleted,
    failure_status: failureStatus,
    response_status: deleteRpcResponse?.status ?? null,
    verified_event_count: afterEvents.length,
  });

  return {
    found: true,
    deleted: targetDeleted,
    status: targetDeleted ? "deleted" : (failureStatus || "not_deleted"),
    confirmed: !!deleteRpcRequest,
    deleteAction: {
      detected: !!deleteRpcRequest,
      requestMethod: deleteRpcRequest?.method,
      responseStatus: deleteRpcResponse?.status,
      failureStatus,
    },
    deletedCount,
    remainingMatches,
    event: match,
    expectedTime: expectedTime || undefined,
    yapMessage: visibleMessage || undefined,
    note: targetDeleted
      ? remainingMatches > 0
        ? `Richiesta delete confermata: eliminata ${deletedCount} occorrenza, ${remainingMatches} slot omonimi ancora presenti in agenda.`
        : undefined
      : failureStatus === "blocked_by_odl"
        ? "YAP blocca la cancellazione perche l'appuntamento e' associato a un ordine di lavoro."
        : failureStatus === "blocked_by_preventivo"
          ? "YAP blocca la cancellazione perche l'appuntamento e' associato a un preventivo."
          : "Richiesta delete inviata ma evento ancora visibile in agenda."
      ,
    repairHint,
    telemetry: {
      dialogMessages,
      rpcDetected: !!deleteRpcRequest,
      trace: trace?.snapshot({
        rpc_request_detected: !!deleteRpcRequest,
        rpc_response_status: deleteRpcResponse?.status ?? null,
        final_status: targetDeleted ? "deleted" : (failureStatus || "not_deleted"),
      }),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log("Uso: node yap-delete-appointment.mjs --date YYYY-MM-DD --search TESTO [--time HH:MM] [--headed] [--dry-run] [--debug] [--fresh-login]");
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
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ];
  if (safeMode) {
    launchArgs.push(
      "--no-zygote",
      "--disable-features=site-per-process",
    );
  }

  const startedAtMs = Date.now();
  const runtime = await createYapRuntime(chromium, {
    headed: args.headed,
    freshLogin: args.freshLogin,
    launchArgs,
    viewport: { width: 1280, height: 820 },
    // Riusa profilo + sessione persistente (come il sync worker): se elimini subito
    // dopo un'altra operazione la sessione e' ancora viva e si SALTANO i ~22s di login.
    // Disattivabile con YAP_DELETE_PERSISTENT_PROFILE=0 (fallback al contesto pulito).
    preferPersistentProfile: String(process.env.YAP_DELETE_PERSISTENT_PROFILE || "1").trim() !== "0",
    resolveModule: requireFromYap.resolve.bind(requireFromYap),
  });
  const { page } = runtime;
  const trace = createDeleteTrace({
    worker: "yap-delete-appointment.mjs",
    search: args.search,
    expected_time: args.time || null,
    date: args.date,
    debug: !!args.debug,
    fresh_login: !!args.freshLogin,
    dry_run: !!args.dryRun,
  });
  page.on("crash", () => {
    trace.mark("page_crashed");
  });
  page.on("pageerror", (pageError) => {
    trace.fail("page_error", pageError);
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
    }
    const agendaReady = await waitForAgendaReady(page, 2500).then(() => true).catch(() => false);
    trace.mark("agenda_ready_check_completed", { ready: agendaReady });
    if (!agendaReady) {
      trace.mark("agenda_open_requested");
      await openAgendaWithRecovery(page, {
        dateIso: args.date,
        username: user,
        password: pass,
        onRetry: ({ attempt, error, reason }) => {
          trace.mark("agenda_recovery_retry", { attempt, error: error.slice(0, 180), reason });
        },
      });
      trace.mark("agenda_open_completed");
    }
    trace.mark("agenda_date_navigation_completed", { date: args.date });

    const result = await findAndDeleteAppointment(page, args.search, args.dryRun, args.date, args.debug, trace, args.time);
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
        ...buildYapTelemetry({
          runtime,
          viewport: { centerDateLabel: args.date, agendaSettle: { emptyConfirmed: false, unstable: false, polls: null } },
          eventCount: result.remainingMatches,
          startedAtMs,
          extra: { action: "delete_appointment", date: args.date, expected_time: args.time || null },
        }),
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
    await runtime.close();
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
