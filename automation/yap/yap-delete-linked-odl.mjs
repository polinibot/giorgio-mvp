#!/usr/bin/env node
/**
 * Cancella l'ordine di lavoro collegato a un appuntamento YAP.
 * Uso:
 *   node automation/yap/yap-delete-linked-odl.mjs --date 2026-11-12 --search FK079BX
 *
 * Serve quando yap-delete-appointment.mjs risponde blocked_by_odl.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  buildYapTelemetry,
  createYapRuntime,
  loginYap,
  openAgendaWithRecovery,
  ROOT_DIR,
  scanVisibleAgendaEventTargets,
  waitForAgendaEventPopulation,
  YAP_ODL_DELETE_CONFIRM,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const DELETE_ACTION_ENDPOINTS = [
  "/yap/action/DocumentoDeleteAction",
  "/yap/action/OdlDeleteAction",
];

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
    else if (arg === "--time") args.time = next();
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

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isVisibleRect(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
}

async function clickAppointmentPopupPractice(page) {
  return page.evaluate(() => {
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
        (t.includes("gestione pratica") ||
          t.includes("apri pratica") ||
          (t.includes("pratica") && !t.includes("prenotazione"))) &&
        t.length < 60
      );
    });
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, label: (el.textContent || "").trim().slice(0, 80) };
    }
    return { clicked: false };
  });
}

async function clickOdlSection(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
    };
    const candidates = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")].filter((el) => {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return (
        (t.includes("ordini di lavoro") || t === "odl" || t.startsWith("ordini di lavoro")) &&
        t.length < 40
      );
    });
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) };
    }
    return { clicked: false };
  });
}

async function findAppointmentEvent(page, searchTerm, expectedTime = "") {
  const needle = normalize(searchTerm);
  const expectedNeedle = normalize(expectedTime).replace(":", ".");
  await waitForAgendaEventPopulation(page);
  const events = await scanVisibleAgendaEventTargets(page);
  return events.find((ev) =>
    normalize(ev.title).includes(needle)
    && (!expectedNeedle || normalize(ev.time || "").replace(":", ".").includes(expectedNeedle))
  ) || events.find((ev) => normalize(ev.title).includes(needle)) || null;
}

async function visibleYapMessage(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel")]
      .filter(isVisible)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" | ");
  }).catch(() => "");
}

async function clickOdlDeleteButton(page) {
  const target = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button, .gwt-Button, a.gwt-Anchor, [role='button']")];
    const match = buttons.find((el) => {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return text === "Elimina" && rect.width > 10 && rect.height > 10 && rect.y < 180 && style.display !== "none" && style.visibility !== "hidden";
    });
    if (!match) return null;
    const rect = match.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      text: (match.textContent || "").replace(/\s+/g, " ").trim(),
    };
  }).catch(() => null);

  if (target) {
    await page.mouse.click(target.x, target.y);
    return target;
  }

  const locator = page.locator("button, .gwt-Button, a.gwt-Anchor, [role='button']").filter({ hasText: /^Elimina$/i }).first();
  if (await locator.count().catch(() => 0)) {
    await locator.click({ force: true });
    return { text: "Elimina" };
  }

  return null;
}

async function clickConfirmIfPresent(page) {
  const dialogLocator = page.locator(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel");
  const count = await dialogLocator.count().catch(() => 0);
  if (!count) return false;

  const dialog = dialogLocator.last();
  const buttons = dialog.locator("button, .gwt-Button, a.gwt-Anchor, [role='button']");
  const patterns = [/^ok$/i, /^s[ìi]$/i, /^conferma$/i, /^elimina$/i, /^yes$/i];
  for (const pattern of patterns) {
    const candidate = buttons.filter({ hasText: pattern }).first();
    if (await candidate.count().catch(() => 0)) {
      await candidate.click({ force: true }).catch(() => {});
      return true;
    }
  }

  const any = buttons.first();
  if (await any.count().catch(() => 0)) {
    await any.click({ force: true }).catch(() => {});
    return true;
  }

  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log("Uso: node automation/yap/yap-delete-linked-odl.mjs --date YYYY-MM-DD --search TESTO [--time HH:MM] [--headed] [--dry-run] [--debug] [--fresh-login]");
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

  const startedAtMs = Date.now();
  const runtime = await createYapRuntime(chromium, {
    headed: args.headed,
    freshLogin: args.freshLogin,
    preferPersistentProfile: false,
    resolveModule: requireFromYap.resolve.bind(requireFromYap),
  });
  const { page } = runtime;
  const deleteRequests = [];
  const deleteResponses = [];
  const dialogMessages = [];

  page.on("request", (req) => {
    if (DELETE_ACTION_ENDPOINTS.some((endpoint) => req.url().includes(endpoint))) {
      deleteRequests.push({
        method: req.method(),
        url: req.url(),
        payload: req.postData() || "",
      });
    }
  });

  page.on("response", async (res) => {
    if (!DELETE_ACTION_ENDPOINTS.some((endpoint) => res.url().includes(endpoint))) return;
    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "";
    }
    deleteResponses.push({
      status: res.status(),
      url: res.url(),
      body: body.slice(0, 500),
    });
  });

  page.on("dialog", async (dialog) => {
    dialogMessages.push(dialog.message());
    if (dialog.message() === YAP_ODL_DELETE_CONFIRM) {
      await dialog.accept();
      return;
    }
    await dialog.dismiss().catch(() => {});
  });

  try {
    await loginYap(page, user, pass);
    await openAgendaWithRecovery(page, {
      dateIso: args.date,
      username: user,
      password: pass,
    });

    const event = await findAppointmentEvent(page, args.search, args.time);
    if (!event) {
      console.log(JSON.stringify({
        ok: true,
        found: false,
        searched: args.search,
        date: args.date,
        events: [],
        telemetry: buildYapTelemetry({
          runtime,
          viewport: { centerDateLabel: args.date },
          eventCount: 0,
          startedAtMs,
          extra: { action: "delete_linked_odl", expected_time: args.time || null },
        }),
      }, null, 2));
      return;
    }

    if (args.dryRun) {
      console.log(JSON.stringify({
        ok: true,
        found: true,
        dryRun: true,
        date: args.date,
        search: args.search,
        event,
        telemetry: buildYapTelemetry({
          runtime,
          viewport: { centerDateLabel: args.date },
          eventCount: 1,
          startedAtMs,
          extra: { action: "delete_linked_odl", expected_time: args.time || null },
        }),
      }, null, 2));
      return;
    }

    await page.mouse.click(event.x, event.y);
    await page.getByText("Dettagli appuntamento").first().waitFor({ state: "visible", timeout: 15000 });
    await page.waitForTimeout(300);

    const practiceLink = await clickAppointmentPopupPractice(page);
    if (!practiceLink?.clicked) {
      throw new Error("Link Gestione pratica non trovato nel popup appuntamento");
    }

    await page.waitForTimeout(3000);
    const odlTab = await clickOdlSection(page);
    if (!odlTab?.clicked) {
      throw new Error("Sezione Ordini di lavoro non trovata nella pratica");
    }

    await page.waitForTimeout(2500);
    const deleteButton = await clickOdlDeleteButton(page);
    if (!deleteButton) {
      throw new Error("Pulsante Elimina non trovato nella toolbar ODL");
    }

    for (let i = 0; i < 8; i += 1) {
      await page.waitForTimeout(500);
      const dialogText = await visibleYapMessage(page);
      if (dialogText) {
        await clickConfirmIfPresent(page);
      }
      if (deleteRequests.length) break;
    }

    await page.waitForTimeout(2000);

    const deleted = deleteRequests.length > 0;
    const screenshotPath = args.debug || !deleted
      ? path.join(ROOT_DIR, "automation", "artifacts", "yap", `delete-odl-${args.date}-${Date.now()}.png`)
      : null;

    if (screenshotPath) {
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    console.log(JSON.stringify({
      ok: true,
      date: args.date,
      search: args.search,
      found: true,
      deleted,
      status: deleted ? "deleted" : "not_deleted",
      screenshot: screenshotPath,
      deleteAction: {
        detected: deleted,
        requestMethod: deleteRequests[0]?.method,
        responseStatus: deleteResponses[0]?.status || null,
      },
      telemetry: buildYapTelemetry({
        runtime,
        viewport: { centerDateLabel: args.date },
        eventCount: 1,
        startedAtMs,
        extra: { action: "delete_linked_odl", expected_time: args.time || null },
      }),
      dialogMessages,
      nextStep: deleted
        ? "Rerun yap-delete-appointment.mjs on the same date/search."
        : "If this stays not_deleted, inspect the toolbar and confirm dialog text.",
    }, null, 2));
  } catch (error) {
    const errorSuffix = `${args.search}-${Date.now()}`;
    const errorScreenshotPath = path.join(ROOT_DIR, "automation", "artifacts", "yap", `error-delete-odl-${errorSuffix}.png`);
    try {
      await fs.mkdir(path.dirname(errorScreenshotPath), { recursive: true });
      await page.screenshot({ path: errorScreenshotPath, fullPage: true });
      error.screenshotPath = errorScreenshotPath;
      console.warn(`Screenshot dell'errore salvato in: ${errorScreenshotPath}`);
    } catch (screenshotError) {
      console.warn(`Fallito screenshot dell'errore: ${screenshotError.message}`);
    }
    console.log(JSON.stringify({
      ok: false,
      error: error.message,
      stack: error.stack,
      screenshot: error.screenshotPath || null,
      date: args.date,
      search: args.search,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err.message,
    stack: err.stack,
  }, null, 2));
  process.exit(1);
});
