#!/usr/bin/env node
/**
 * Analizza un rpc-trace-*.json prodotto da yap-rpc-interceptor.mjs.
 * Estrae:
 *  - elenco PrenotazioneTableAction con stringTable e indice della targa cercata
 *  - PropertyGetAction (catalogo chip tag)
 *  - finestra di contesto attorno al match
 */

import fs from "node:fs/promises";
import path from "node:path";

function parseGwt(text) {
  if (!text || typeof text !== "string") return null;
  if (!text.startsWith("//OK") && !text.startsWith("//EX")) return null;
  const status = text.startsWith("//OK") ? "ok" : "exception";
  const body = text.slice(4);
  try {
    const arr = JSON.parse(body);
    return { status, arr };
  } catch {
    return { status, raw: text };
  }
}

function flatStrings(arr) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "string") out.push(v);
  };
  walk(arr);
  return out;
}

async function main() {
  const target = process.argv[2];
  const search = (process.argv[3] || "DP126GZ").toUpperCase();
  if (!target) {
    console.error("Uso: analyze-rpc-trace.mjs <trace.json> [SEARCH]");
    process.exit(2);
  }
  const trace = JSON.parse(await fs.readFile(target, "utf8"));
  const action = (url) => url.split("/").pop();

  const responses = trace.traces.filter((t) => t.direction === "response" && t.decoded?.raw);
  const summary = [];
  for (const r of responses) {
    const parsed = parseGwt(r.decoded.raw);
    if (!parsed?.arr) continue;
    const strings = flatStrings(parsed.arr);
    const haystack = strings.join("\u0001");
    const hit = haystack.toUpperCase().includes(search);
    if (!hit) continue;
    summary.push({
      action: action(r.url),
      stage: r.stage,
      length: r.length,
      stringCount: strings.length,
      stringsWithSearch: strings.filter((s) => s.toUpperCase().includes(search)).slice(0, 6),
      sampleStrings: strings.slice(0, 30),
    });
  }
  console.log(JSON.stringify({ search, hitCount: summary.length, hits: summary }, null, 2));

  const big = responses.find((r) => r.length > 10000 && action(r.url) === "PrenotazioneTableAction");
  if (big) {
    const parsed = parseGwt(big.decoded.raw);
    const strings = flatStrings(parsed.arr);
    const idx = strings.findIndex((s) => s.toUpperCase().includes(search));
    if (idx >= 0) {
      console.log("\n--- Stringhe attorno al match (PrenotazioneTableAction) ---");
      const start = Math.max(0, idx - 30);
      const end = Math.min(strings.length, idx + 60);
      for (let i = start; i < end; i += 1) {
        console.log(String(i).padStart(4), JSON.stringify(strings[i]).slice(0, 220));
      }
    }
  }

  const propAction = responses.find((r) => action(r.url) === "PropertyGetAction" && r.length > 10000);
  if (propAction) {
    const parsed = parseGwt(propAction.decoded.raw);
    const strings = flatStrings(parsed.arr);
    const tagLikely = strings.filter(
      (s) => /^[a-z][a-z\s\-]{2,30}$/i.test(s) &&
        !/[\\/.@]/.test(s) &&
        s.split(" ").length <= 3,
    );
    console.log("\n--- Chip tag candidati da PropertyGetAction ---");
    const sample = [...new Set(tagLikely.map((t) => t.toLowerCase().trim()))]
      .filter((t) => /^(meccanica|tagliando|revisione|pneumatici|preventivo|comunicato|carrozzeria|officina|elettrauto|gomme|olio|freni|cambio|frizione)/.test(t))
      .slice(0, 50);
    console.log(sample);
    const allUnique = [...new Set(strings.map((t) => String(t).trim()))].filter(
      (s) =>
        /^[a-zàèéìòù][\w\sàèéìòùÀÈÉÌÒÙ\-/]{1,40}$/i.test(s) &&
        !/[\\:.@?]/.test(s) &&
        !/^(true|false|null|java|com|it|gwt)/i.test(s),
    );
    console.log("\n--- Stringhe testuali rilevanti (lessico) ---");
    console.log(allUnique.slice(0, 200));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
