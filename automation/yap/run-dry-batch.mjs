#!/usr/bin/env node
/**
 * Esegue dry-run YAP su tutti i sample payload in sequenza (una sessione alla volta).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS = path.join(DIR, "analysis");

const SAMPLES = [
  "sample-payload.json",
  "sample-payload-revisione-pura.json",
  "sample-payload-carrozzeria-revisione.json",
  "sample-payload-fd897lp-revisione.json",
];

function runDryOnce(payloadFile) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(DIR, "yap-worker.mjs"), "--dry-run", "--payload-file", path.join(DIR, payloadFile)],
      { cwd: path.resolve(DIR, "..", ".."), env: process.env, shell: false },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => {
      try {
        const json = JSON.parse(out.trim());
        resolve({ payloadFile, code, json });
      } catch {
        resolve({ payloadFile, code, raw: out.slice(-800) });
      }
    });
  });
}

async function runDry(payloadFile, { retries = 2 } = {}) {
  let last = await runDryOnce(payloadFile);
  if (last.json?.ok || retries < 1) return last;
  console.log(`   ↻ retry ${payloadFile}…`);
  await new Promise((r) => setTimeout(r, 3000));
  last = await runDryOnce(payloadFile);
  last.retried = true;
  return last;
}

async function main() {
  const results = [];
  for (const f of SAMPLES) {
    console.log(`\n▶ Dry-run ${f}…`);
    results.push(await runDry(f));
    await new Promise((r) => setTimeout(r, 5000));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "dry_run_batch",
    allOk: results.every((r) => r.json?.ok),
    results: results.map((r) => ({
      file: r.payloadFile,
      ok: r.json?.ok ?? false,
      planned: r.json?.result?.planned,
      dedup: r.json?.result?.dedup,
      error: r.json?.error || r.raw || null,
    })),
  };

  const outPath = path.join(ANALYSIS, "dry-run-batch-report.json");
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("\n=== Dry-run batch ===");
  for (const r of report.results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.file}${r.planned ? ` → cosa=${r.planned.cosa} tags=${r.planned.tags?.join(",")}` : ""}`);
  }
  console.log(`\n📄 ${outPath}`);
  if (!report.allOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
