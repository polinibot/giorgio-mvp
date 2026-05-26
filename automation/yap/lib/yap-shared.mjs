import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const YAP_BASE_URL = process.env.YAP_BASE_URL || "https://yap.mmbsoftware.it";
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const YAP_SESSION_STATE = process.env.YAP_SESSION_STATE || path.join(ROOT_DIR, "automation", "artifacts", "yap", "session-state.json");
export const YAP_APPOINTMENT_DELETE_CONFIRM = "Confermi l'eliminazione dell'appuntamento?";
export const YAP_ODL_DELETE_CONFIRM = "Confermi di voler eliminare l'ordine di lavoro?";

export function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toItalianDate(isoDate) {
  const [year, month, day] = String(isoDate).slice(0, 10).split("-");
  if (!year || !month || !day) {
    throw new Error(`Data non valida per YAP: ${isoDate}`);
  }
  return `${day}/${month}/${year}`;
}

export function toYapTime(time) {
  const raw = String(time || "").trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) {
    throw new Error(`Ora non valida: ${raw}. Atteso formato HH:MM`);
  }
  return raw.replace(":", ".");
}

export function addMinutes(time, minutes) {
  const [hours, mins] = time.split(":").map(Number);
  const date = new Date(Date.UTC(2000, 0, 1, hours, mins + minutes, 0));
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function yapContextOptions({ viewport = { width: 1440, height: 950 }, locale = "it-IT", freshLogin = false } = {}) {
  const options = { viewport };
  if (locale) options.locale = locale;
  if (!freshLogin && await exists(YAP_SESSION_STATE)) {
    options.storageState = YAP_SESSION_STATE;
  }
  return options;
}

export async function persistYapSession(context) {
  await fs.mkdir(path.dirname(YAP_SESSION_STATE), { recursive: true });
  await context.storageState({ path: YAP_SESSION_STATE });
}

export async function waitForAgendaReady(page, timeout = 20000) {
  await page.locator(".fc-time-grid, .fc-view-container, .view-switch, .fc-agenda-view").first().waitFor({
    state: "visible",
    timeout,
  });
}

async function dismissUnsupportedBrowserWarning(page) {
  const warningVisible = await page
    .getByText(/ATTENZIONE! La versione del browser in uso non è più supportata!/i)
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (!warningVisible) return false;

  const dialog = page.locator(".gwt-DialogBox, .gwt-PopupPanel, .gwt-DecoratedPopupPanel");
  const ok = dialog.locator("button, .gwt-Button, [role='button']").filter({ hasText: /^OK$/i }).first();

  if (await ok.isVisible({ timeout: 1500 }).catch(() => false)) {
    await ok.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    return true;
  }

  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, .gwt-Button, [role=\"button\"]")];
    const okBtn = btns.find((b) => (b.textContent || "").trim().toUpperCase() === "OK");
    if (okBtn) okBtn.click();
  }).catch(() => {});
  await page.waitForTimeout(300);
  return true;
}

export async function waitForYapAction(page, actionName, trigger, timeout = 15000) {
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/yap/action/${actionName}`),
  { timeout }).catch(() => null);
  await trigger();
  return responsePromise;
}

export async function gotoAgendaDate(page, isoDate) {
  const months = {
    gennaio: 0,
    febbraio: 1,
    marzo: 2,
    aprile: 3,
    maggio: 4,
    giugno: 5,
    luglio: 6,
    agosto: 7,
    settembre: 8,
    ottobre: 9,
    novembre: 10,
    dicembre: 11,
  };
  const target = new Date(`${isoDate}T12:00:00`);
  const targetIndex = target.getFullYear() * 12 + target.getMonth();
  const currentMonthIndex = async () => {
    const text = normalize(await page.locator(".view-switch").first().innerText({ timeout: 5000 }));
    const [monthName, yearText] = text.split(/\s+/);
    if (!(monthName in months) || !yearText) return null;
    return Number(yearText) * 12 + months[monthName];
  };

  for (let guard = 0; guard < 36; guard += 1) {
    const currentIndex = await currentMonthIndex();
    if (currentIndex == null || currentIndex === targetIndex) break;
    await page.locator(currentIndex > targetIndex ? ".prev-button" : ".next-button").first().click();
    await page.waitForTimeout(120);
  }

  const moved = await page.evaluate((targetDate) => {
    const target = new Date(`${targetDate}T12:00:00`);
    const titleButton = document.querySelector(".view-switch");
    if (!titleButton) return false;
    const day = String(target.getDate());
    const switchRoot = titleButton.parentElement?.parentElement?.parentElement || document.body;
    const candidates = [...switchRoot.querySelectorAll("button, div, span, td, a")]
      .filter((node) => (node.textContent || "").trim() === day)
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const classes = String(node.className || "").toLowerCase();
        return rect.width > 0 && rect.height > 0 && !classes.includes("disabled") && !classes.includes("other");
      });
    const candidate = candidates[0];
    if (!candidate) return false;
    candidate.click();
    return true;
  }, isoDate).catch(() => false);

  if (!moved) await page.keyboard.press("Home").catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await waitForAgendaReady(page, 10000).catch(() => {});
  await page.waitForTimeout(700);
}

export async function loginYap(page, username, password) {
  await page.goto(YAP_BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await dismissUnsupportedBrowserWarning(page);

  const loginInputVisible = await page.locator('input[name="u"]').first().isVisible({ timeout: 2500 }).catch(() => false);
  if (!loginInputVisible) {
    const alreadyIn = await page.getByText("Agenda", { exact: true }).first().isVisible({ timeout: 3000 }).catch(() => false);
    if (alreadyIn) {
      await persistYapSession(page.context()).catch(() => {});
      return;
    }
    await page.goto(`${YAP_BASE_URL}/#!agenda`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await dismissUnsupportedBrowserWarning(page);
    const agendaReady = await waitForAgendaReady(page, 5000).then(() => true).catch(() => false);
    if (agendaReady) {
      await persistYapSession(page.context()).catch(() => {});
      return;
    }
  }

  const okBtn = page.getByRole("button", { name: /^OK$/i }).or(page.getByText("OK", { exact: true }));
  try {
    await okBtn.first().waitFor({ state: "visible", timeout: 5000 });
    await okBtn.first().click({ force: true });
  } catch {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll("button, .gwt-Button, [role=\"button\"]")];
      const ok = btns.find((b) => b.textContent.trim().toUpperCase() === "OK");
      if (ok) ok.click();
    });
  }

  await page.waitForTimeout(300);
  await dismissUnsupportedBrowserWarning(page);
  await page.locator('input[name="u"]').waitFor({ state: "attached", timeout: 12000 });
  const filled = await page.evaluate(({ u, p }) => {
    const userEl = document.querySelector('input[name="u"]');
    const passEl = document.querySelector('input[name="pw"]');
    if (!userEl || !passEl) return false;
    userEl.focus();
    userEl.value = u;
    userEl.dispatchEvent(new Event("input", { bubbles: true }));
    userEl.dispatchEvent(new Event("change", { bubbles: true }));
    passEl.focus();
    passEl.value = p;
    passEl.dispatchEvent(new Event("input", { bubbles: true }));
    passEl.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, { u: username, p: password });
  if (!filled) {
    await page.locator('input[name="u"]').click({ force: true, timeout: 10000 });
    await page.locator('input[name="u"]').pressSequentially(username, { delay: 40 });
    await page.locator('input[name="pw"]').click({ force: true });
    await page.locator('input[name="pw"]').pressSequentially(password, { delay: 40 });
  }
  const loginBtn = page
    .getByTestId("loginSubmitButton")
    .or(page.getByRole("button", { name: /acc[ée]di/i }))
    .first();
  try {
    await loginBtn.click({ force: true, timeout: 10000 });
  } catch {
    await page.evaluate(() => {
      const btn =
        document.querySelector('[data-testid="loginSubmitButton"]') ||
        [...document.querySelectorAll("button, .gwt-Button")].find((b) =>
          /acc[eé]di/i.test(b.textContent || ""),
        );
      if (btn) btn.click();
    });
  }
  await page.waitForTimeout(1200);
  await dismissUnsupportedBrowserWarning(page);
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.getByText("Agenda", { exact: true }).first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  await persistYapSession(page.context()).catch(() => {});
}

export async function openAgendaInApp(page) {
  await page.goto(`${YAP_BASE_URL}/#!agenda`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  await dismissUnsupportedBrowserWarning(page);

  const selectors = [".fc-time-grid", ".fc-view-container", ".view-switch", ".fc-agenda-view"];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const sel of selectors) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) return;
    }
    const agendaLink = page.getByText("Agenda", { exact: true }).first();
    if (await agendaLink.isVisible().catch(() => false)) {
      await agendaLink.click().catch(() => {});
    }
    await page.waitForTimeout(800);
    await page.goto(`${YAP_BASE_URL}/#!agenda`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await dismissUnsupportedBrowserWarning(page);
    await waitForAgendaReady(page, 8000).catch(() => {});
  }

  await waitForAgendaReady(page, 20000);
}

export function matchEventText(text, terms) {
  const haystack = normalize(text);
  return terms.some((term) => haystack.includes(normalize(term)));
}

export async function clickAgendaEvent(page, terms) {
  return page.evaluate((searchTerms) => {
    const normalizedTerms = searchTerms.map((t) =>
      String(t || "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
    );
    const plateRe = /^[A-Z]{2}\d{3}[A-Z]{2}$/i;
    const events = [...document.querySelectorAll(".fc-time-grid-event, .fc-event")].filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    });

    let best = null;
    let bestScore = -1;

    for (const el of events) {
      const titleEl = el.querySelector(".fc-title") || el;
      const text = (titleEl.textContent || "").replace(/\s+/g, " ").trim();
      const hay = text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();

      for (const term of normalizedTerms) {
        if (!term || !hay.includes(term)) continue;
        let score = term.length;
        if (plateRe.test(term) && hay.includes(term)) score += 100;
        if (hay.startsWith(term)) score += 20;
        if (score > bestScore) {
          bestScore = score;
          best = { el, text };
        }
      }
    }

    if (!best) return { success: false };
    const { el, text } = best;
    const rect = el.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    for (const type of ["click", "dblclick"]) {
      el.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: center.x,
          clientY: center.y,
        }),
      );
    }
    const classes = String(el.className || "").split(/\s+/);
    const repartoClass = classes.find((c) => /^LCWVQRD-b-[a-z]$/.test(c)) || "";
    return { success: true, text: text.trim(), repartoClass };
  }, terms);
}
