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
  return page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };

    const dialogs = [...document.querySelectorAll(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel")]
      .filter(isVisible)
      .filter((el) => {
        const text = (el.textContent || "").toLowerCase();
        return (
          text.includes("conferm") ||
          text.includes("sicuro") ||
          text.includes("elimin") ||
          text.includes("cancell")
        );
      });

    if (!dialogs.length) return false;
    const dialog = dialogs[dialogs.length - 1];
    const buttons = [...dialog.querySelectorAll("button, .gwt-Button, a.gwt-Anchor, [role='button']")]
      .filter(isVisible);
    if (!buttons.length) return false;

    const ok = buttons.find((el) => {
      const text = (el.textContent || "").toLowerCase();
      return /ok|s[ìi]|confer|elimin|cancell|yes/.test(text);
    }) || buttons[0];

    ok.click();
    return true;
  });
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

  await page.mouse.click(match.x, match.y);
  await page.getByText("Dettagli appuntamento").first().waitFor({ state: "visible", timeout: 15000 });

  const clicked = await page.evaluate(() => {
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")]
      .find((el) => (el.textContent || "").includes("Dettagli appuntamento"));
    if (!popup) return false;

    const anchors = [...popup.querySelectorAll("a.gwt-Anchor")]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);

    const elim = anchors.find((a) => (a.textContent || "").includes("Elimina")) || anchors[1];
    if (!elim) return false;
    elim.click();
    return true;
  });

  if (!clicked) {
    page.off("request", onRequest);
    page.off("response", onResponse);
    const screenshotPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `delete-popup-${Date.now()}.png`);
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    throw new Error(`Anchor Elimina non trovato nel popup. Screenshot: ${screenshotPath}`);
  }

  let visibleMessage = "";
  for (let i = 0; i < 4 && !deleteRpcRequest; i += 1) {
    await page.waitForTimeout(650);
    visibleMessage = await visibleYapMessage(page);
    if (classifyDeleteFailure(visibleMessage)) break;
    if (deleteRpcRequest) break;
    const confirmed = await clickDeleteConfirmIfPresent(page);
    if (!confirmed && i === 0) {
      await page.evaluate(() => {
        const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")]
          .find((el) => (el.textContent || "").includes("Dettagli appuntamento"));
        if (!popup) return;
        const anchors = [...popup.querySelectorAll("a.gwt-Anchor")]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x);
        const elim = anchors.find((a) => (a.textContent || "").includes("Elimina")) || anchors[1];
        if (elim) elim.click();
      });
    }
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
        ? "YAP blocca la cancellazione perché l'appuntamento è associato a un ordine di lavoro."
        : "Richiesta delete inviata ma evento ancora visibile in agenda."
      : undefined,
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

  const user = process.env.YAP_USERNAME;
  const pass = process.env.YAP_PASSWORD;
  if (!user || !pass) {
    console.error("Servono YAP_USERNAME e YAP_PASSWORD");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext(await yapContextOptions({ freshLogin: args.freshLogin }));
  const page = await context.newPage();

  try {
    await loginYap(page, user, pass);
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
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
