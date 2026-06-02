#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import {
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  clickAgendaEvent,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

function parseArgs(argv) {
  const out = { headed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i];
    else if (a === "--search") out.search = argv[++i];
    else if (a === "--headed") out.headed = true;
  }
  if (!out.date || !out.search) throw new Error("Uso: node inspect-practice-tabs.mjs --date YYYY-MM-DD --search TERM");
  return out;
}

async function clickByText(page, regex) {
  return page.evaluate((source) => {
    const re = new RegExp(source, "i");
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
    };
    const nodes = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")]
      .filter(isVisible)
      .filter((el) => re.test((el.textContent || "").replace(/\s+/g, " ").trim()));
    const el = nodes[0];
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return true;
  }, regex.source).catch(() => false);
}

async function snapshot(page, label) {
  return page.evaluate((stepLabel) => {
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 3 && rect.height > 3 && style.display !== "none" && style.visibility !== "hidden";
    };
    const clean = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const tabs = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")]
      .filter(isVisible)
      .map((el) => clean(el.textContent || ""))
      .filter((t) => t && t.length <= 60)
      .filter((t) => /note interne|materiali di consumo|smaltimento rifiuti|ordini di lavoro|ricambi|magazzino|descrizione danni|totali/i.test(t));
    const inputs = [...document.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox']")]
      .filter(isVisible)
      .map((el) => ({
        tag: el.tagName,
        type: el.getAttribute("type") || null,
        value: clean(el.value || el.textContent || ""),
        placeholder: el.getAttribute("placeholder") || null,
        aria: el.getAttribute("aria-label") || null,
        name: el.getAttribute("name") || null,
        id: el.getAttribute("id") || null,
      }));
    const text = [...document.querySelectorAll("td, th, div, span, label")]
      .filter(isVisible)
      .map((el) => clean(el.textContent || ""))
      .filter((t) => t && t.length <= 120)
      .filter((t) => /materiali|ricambi|smaltimento|note|man|mac|imponibile|iva|totale|articolo|descrizione/i.test(t))
      .slice(0, 120);
    return { label: stepLabel, tabs, inputs, text };
  }, label);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = process.env.YAP_USERNAME;
  const password = process.env.YAP_PASSWORD;
  if (!username || !password) throw new Error("Servono YAP_USERNAME e YAP_PASSWORD");

  const browser = await chromium.launch({ headless: !args.headed });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const outDir = path.join(process.cwd(), "automation", "artifacts", "yap-inspect");
  await fs.mkdir(outDir, { recursive: true });

  try {
    await loginYap(page, username, password);
    try {
      await openAgendaInApp(page);
    } catch (error) {
      if (!/agenda_redirected_to_login/i.test(String(error?.message || ""))) throw error;
      await loginYap(page, username, password);
      await openAgendaInApp(page);
    }
    await gotoAgendaDate(page, args.date);
    const click = await clickAgendaEvent(page, [args.search]);
    if (!click?.success) throw new Error("Evento non trovato");
    await page.waitForTimeout(1200);
    await clickByText(page, /gestione pratica|apri pratica|\bpratica\b/);
    await page.waitForTimeout(1500);

    const results = [];
    results.push(await snapshot(page, "after_practice_open"));

    for (const item of [
      { label: "note_interne", re: /note interne/i },
      { label: "materiali_di_consumo", re: /materiali di consumo/i },
      { label: "smaltimento_rifiuti", re: /smaltimento rifiuti/i },
      { label: "ordini_di_lavoro", re: /ordini di lavoro/i },
    ]) {
      await clickByText(page, item.re);
      await page.waitForTimeout(700);
      results.push(await snapshot(page, item.label));
      await page.screenshot({ path: path.join(outDir, `${item.label}.png`), fullPage: true }).catch(() => {});
    }

    const outPath = path.join(outDir, `inspect-${args.date}-${args.search}.json`);
    await fs.writeFile(outPath, JSON.stringify(results, null, 2), "utf8");
    console.log(outPath);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
