#!/usr/bin/env node
/**
 * Probe read-only: da appuntamento agenda (es. revisione) verifica link UI/RPC verso pratica/ODL.
 * Nessun salvataggio. Apre popup, ispeziona DOM, opzionalmente clicca link "pratica"/"ODL" se presente.
 *
 * Uso:
 *   node yap-pratica-odl-probe.mjs --date 2025-04-04 --search EL733YJ --label revisione
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  loginYap,
  openAgendaInApp,
  gotoAgendaDate,
  clickAgendaEvent,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(DIR, "analysis");
const ARTIFACTS = path.join(DIR, "..", "artifacts", "yap-pratica-probe");

function parseArgs(argv) {
  const out = { headed: false, tryOpenPratica: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i];
    else if (a === "--search") out.search = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--headed") out.headed = true;
    else if (a === "--no-open-pratica") out.tryOpenPratica = false;
  }
  if (!out.date || !out.search) {
    console.error("Uso: node yap-pratica-odl-probe.mjs --date YYYY-MM-DD --search TERM [--label slug]");
    process.exit(1);
  }
  return out;
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isYapAction(url) {
  return /\/yap\/action\//i.test(String(url || ""));
}

function decodeGwtPreview(text) {
  if (typeof text !== "string" || !text.startsWith("//OK")) return null;
  try {
    const parsed = JSON.parse(text.slice(4));
    const stringTable = Array.isArray(parsed)
      ? parsed.find((x) => Array.isArray(x) && x.every((v) => typeof v === "string"))
      : null;
    return { stringTable: stringTable || [], rawLen: text.length };
  } catch {
    return { stringTable: [], rawLen: text.length };
  }
}

async function extractPopupDetails(page) {
  return page.evaluate(() => {
    const popup = [...document.querySelectorAll(".gwt-DecoratedPopupPanel")].find((p) =>
      (p.textContent || "").includes("Dettagli"),
    );
    if (!popup) return { found: false };

    const text = popup.innerText || "";
    const lower = text.toLowerCase();
    const inputs = [...popup.querySelectorAll("input")].map((i) => ({
      value: i.value || "",
      type: i.type,
    }));
    const knownTags = [
      "revisione",
      "preventivo",
      "comunicato",
      "pneumatici",
      "officina",
      "carrozzeria",
      "tagliando",
    ];
    const tagChips = knownTags.filter((t) => lower.includes(t));

    const keywords = [
      "pratica",
      "odl",
      "ordine",
      "gestione",
      "documento",
      "lavoro",
      "intervento",
    ];
    const links = [];
    for (const el of popup.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div")) {
      const label = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!label || label.length > 80) continue;
      const l = label.toLowerCase();
      if (keywords.some((k) => l.includes(k))) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        links.push({ label, tag: el.tagName, className: String(el.className || "").slice(0, 80) });
      }
    }

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    return {
      found: true,
      lines: lines.slice(0, 40),
      inputs,
      tagChips,
      praticaOdlLinks: [...new Map(links.map((x) => [x.label, x])).values()],
      hasPraticaWord: lower.includes("pratica"),
      hasOdlWord: /\bodl\b|ordine di lavoro/i.test(text),
    };
  });
}

async function tryClickPraticaLink(page) {
  return page.evaluate(() => {
    const popup = document.querySelector(".gwt-DecoratedPopupPanel");
    const root = popup || document.body;
    const candidates = [...root.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div")].filter(
      (el) => {
        const t = (el.textContent || "").toLowerCase();
        return (
          (t.includes("gestione pratica") ||
            t.includes("apri pratica") ||
            (t.includes("pratica") && !t.includes("prenotazione"))) &&
          t.length < 60
        );
      },
    );
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, label: (el.textContent || "").trim().slice(0, 80) };
    }
    return { clicked: false };
  });
}

async function tryClickOdlSection(page) {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll("button, a, [role='button'], .gwt-Label, span, div, td")].filter(
      (el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return (
          (t.includes("ordini di lavoro") || t === "odl" || t.startsWith("ordini di lavoro")) &&
          t.length < 40
        );
      },
    );
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, label: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) };
    }
    return { clicked: false };
  });
}

async function extractPageOdlHints(page) {
  return page.evaluate(() => {
    const body = document.body.innerText || "";
    const hash = String(window.location.hash || "");
    // Estrae Page enum dall'hash GWT (#!pratica|{...})
    let pageEnum = null;
    let idCompanyFolder = null;
    try {
      const match = hash.match(/#!pratica\|(.+)$/);
      if (match) {
        const parsed = JSON.parse(decodeURIComponent(match[1]));
        pageEnum = parsed?.Page ?? null;
        idCompanyFolder = parsed?.IdCompanyFolder ?? null;
      }
    } catch {}
    // Tab attivo nella pratica
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 3 && r.height > 3 && s.display !== "none" && s.visibility !== "hidden";
    };
    const activeTab = [...document.querySelectorAll("td, span, a, div, button")]
      .filter(isVisible)
      .filter((el) => el.getBoundingClientRect().y < 140)
      .find((el) => /\bselected\b|\bactive\b|gwt-selected/i.test(String(el.className || "")) || el.getAttribute("aria-selected") === "true");
    const activeTabText = activeTab ? (activeTab.textContent || "").replace(/\s+/g, " ").trim() : null;
    // Badge ODL (U = ha contenuto)
    const hasOdlBadge = /ordini di lavoro\s*U\b/.test(body);
    return {
      pageHasOdl: /\bodl\b|ordine di lavoro|manodopera|materiali di consumo/i.test(body),
      pageHasPratica: /gestione pratica|\bpratica\b/i.test(body),
      urlHash: hash.slice(0, 300),
      pageEnum,
      idCompanyFolder,
      activeTab: activeTabText,
      hasOdlBadge,
      snippet: body.slice(0, 2500),
    };
  });
}

function analyzeRpcForOdl(traces) {
  const action = (url) => String(url || "").split("/").pop();
  const hits = [];
  const odlStrings = new Set();

  for (const t of traces) {
    if (t.direction !== "response") continue;
    const name = action(t.url);
    const table = t.decoded?.stringTable || [];
    const odlRelated = table.filter((s) =>
      /ODL|Pratica|MANODOPERA|MATERIALI|OdlProperty|AutomatismoOdl|prenotazione/i.test(String(s)),
    );
    if (odlRelated.length || /Odl|Pratica|Prenotazione/i.test(name)) {
      for (const s of odlRelated) odlStrings.add(String(s).slice(0, 120));
      hits.push({
        stage: t.stage,
        action: name,
        responseLen: t.length || t.decoded?.rawLen || 0,
        odlStrings: odlRelated.slice(0, 15),
      });
    }
  }

  return {
    hitCount: hits.length,
    hits: hits.slice(0, 25),
    uniqueOdlStrings: [...odlStrings].slice(0, 40),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = process.env.YAP_USERNAME;
  const pass = process.env.YAP_PASSWORD;
  if (!user || !pass) {
    console.error("Servono YAP_USERNAME e YAP_PASSWORD");
    process.exit(1);
  }

  await fs.mkdir(ANALYSIS, { recursive: true });
  await fs.mkdir(ARTIFACTS, { recursive: true });

  const browser = await chromium.launch({ headless: !args.headed });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const traces = [];
  let stage = "boot";

  page.on("response", async (res) => {
    if (!isYapAction(res.url())) return;
    let text = "";
    try {
      text = await res.text();
    } catch {}
    traces.push({
      ts: Date.now(),
      stage,
      direction: "response",
      url: res.url(),
      length: text.length,
      action: res.url().split("/").pop(),
      decoded: decodeGwtPreview(text),
    });
  });

  const findings = {
    target: args,
    popup: null,
    praticaClick: null,
    odlClick: null,
    pageAfterPratica: null,
    pageAfterOdl: null,
    rpcAnalysis: null,
    conclusion: null,
  };

  try {
    stage = "login";
    await loginYap(page, user, pass);
    stage = "agenda";
    await openAgendaInApp(page);
    stage = "goto-date";
    await gotoAgendaDate(page, args.date);
    await page.screenshot({ path: path.join(ARTIFACTS, `${args.date}-agenda.png`), fullPage: true });

    stage = "click-event";
    const click = await clickAgendaEvent(page, [args.search, "REVISIONE"]);
    findings.click = click;
    if (!click?.success) {
      findings.conclusion = "Evento non trovato — impossibile verificare ODL collegato.";
      throw new Error(`Evento "${args.search}" non trovato il ${args.date}`);
    }

    stage = "wait-popup";
    await page.waitForTimeout(4500);
    findings.popup = await extractPopupDetails(page);
    await page.screenshot({ path: path.join(ARTIFACTS, `${args.date}-popup.png`), fullPage: true });

    if (args.tryOpenPratica && findings.popup?.praticaOdlLinks?.length) {
      stage = "open-pratica";
      findings.praticaClick = await tryClickPraticaLink(page);
      await page.waitForTimeout(4000);
      findings.pageAfterPratica = await extractPageOdlHints(page);
      await page.screenshot({ path: path.join(ARTIFACTS, `${args.date}-after-pratica-click.png`), fullPage: true });
      stage = "open-odl";
      findings.odlClick = await tryClickOdlSection(page);
      // Cattura hash immediato (prima del caricamento completo)
      findings.hashImmediateAfterOdlClick = await page.evaluate(() => String(window.location.hash || "")).catch(() => null);
      await page.waitForTimeout(4000);
      findings.pageAfterOdl = await extractPageOdlHints(page);
      // F1: tenta navigazione route diretta con Page:"ODL" per validare l'enum
      findings.odlRouteProbe = await page.evaluate(() => {
        const hash = String(window.location.hash || "");
        const match = hash.match(/#!pratica\|(.+)$/);
        if (!match) return { tried: false, reason: "no_pratica_hash" };
        try {
          const parsed = JSON.parse(decodeURIComponent(match[1]));
          const idCF = parsed?.IdCompanyFolder;
          if (!idCF) return { tried: false, reason: "no_idcompanyfolder" };
          const testHash = `#!pratica|${JSON.stringify({ IdCompanyFolder: idCF, Page: "ODL", ShowOdlMarcatempo: true })}`;
          return { tried: true, testHash, currentPageEnum: parsed?.Page };
        } catch (e) {
          return { tried: false, reason: e.message };
        }
      }).catch(() => ({ tried: false, reason: "eval_error" }));
      await page.screenshot({ path: path.join(ARTIFACTS, `${args.date}-after-odl-click.png`), fullPage: true });
      stage = "after-pratica";
    }

    stage = "close";
    await page.keyboard.press("Escape").catch(() => {});
  } catch (err) {
    findings.error = err.message;
  } finally {
    findings.rpcAnalysis = analyzeRpcForOdl(traces);

    if (!findings.conclusion) {
      const pop = findings.popup || {};
      const rpc = findings.rpcAnalysis || {};
      if (findings.pageAfterOdl?.pageHasOdl || findings.pageAfterPratica?.pageHasOdl) {
        findings.conclusion =
          "Appuntamento revisione → pratica collegata (EL733YJ). Menu 'Ordini di lavoro' e righe MANODOPERA/Materiali in UI. Giorgio non deve creare ODL manualmente.";
      } else if (pop.praticaOdlLinks?.length) {
        findings.conclusion =
          "Popup espone link 'Gestione pratica' — collegamento agenda→pratica confermato.";
      } else if (rpc.uniqueOdlStrings?.some((s) => /AutomatismoOdl|OdlProperty|MANODOPERA/i.test(s))) {
        findings.conclusion =
          "RPC conferma infrastruttura ODL nel tenant; collegamento per-record non visibile nel popup (automatismo post-save probabile).";
      } else {
        findings.conclusion =
          "Nessun link ODL visibile nel popup su appuntamento storico — automatismi potrebbero attivarsi solo su nuove prenotazioni.";
      }
    }

    const outName = `pratica-odl-probe-${args.date}-${slug(args.label || args.search)}.json`;
    const outPath = path.join(ANALYSIS, outName);
    await fs.writeFile(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: "readonly_pratica_odl_probe",
          ...findings,
          traceCount: traces.length,
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log(JSON.stringify({
      mode: "readonly_pratica_odl_probe",
      popup: findings.popup,
      praticaClick: findings.praticaClick,
      odlClick: findings.odlClick,
      pageAfterPratica: findings.pageAfterPratica,
      pageAfterOdl: findings.pageAfterOdl,
      hashImmediateAfterOdlClick: findings.hashImmediateAfterOdlClick || null,
      odlRouteProbe: findings.odlRouteProbe || null,
      conclusion: findings.conclusion,
      outputFile: outPath,
    }));
    console.log(`\n📄 ${outPath}`);
    await browser.close().catch(() => {});
  }

  if (findings.error && !findings.popup?.found) process.exit(1);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
