#!/usr/bin/env node
// Keep-alive sessione YAP.
//
// PERCHÉ: il worker (yap-worker.mjs) viene lanciato per-job come subprocess e non
// tiene un browser sempre aperto. La sessione YAP vive solo nel bundle persistito
// (cookie + sessionStorage + profilo Chrome). Se nessun job gira per un po', la
// sessione lato server scade e il job successivo paga ~30-45s di re-login.
//
// COSA FA: apre la sessione persistita, tocca l'agenda (così il server rinfresca il
// token), ri-persiste il bundle e chiude. Eseguito su schedule (intervallo < TTL
// sessione YAP) mantiene la sessione "sempre viva". Niente credenziali in chiaro:
// usa YAP_USERNAME / YAP_PASSWORD dall'ambiente come il worker.
//
// USO:
//   node yap-keepalive.mjs            # un ciclo di refresh, stampa JSON di stato, exit 0/1
//   node yap-keepalive.mjs --headed   # debug visivo
//
// Output: una riga JSON finale su stdout: { ok, refreshed, reloggato, elapsed_ms, ... }

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createYapRuntime,
  loginYap,
  openAgendaInApp,
  waitForAgendaReady,
  persistYapSession,
} from "./lib/yap-shared.mjs";

const requireFromYap = createRequire(new URL("./package.json", import.meta.url));
const { chromium } = requireFromYap("playwright");
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function ensureEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Variabile ambiente obbligatoria mancante: ${name}`);
  }
  return value.trim();
}

const _kaStart = Date.now();
let _kaLast = _kaStart;
function log(status, extra = {}) {
  const now = Date.now();
  process.stderr.write(JSON.stringify({
    event: "yap:keepalive",
    status,
    elapsed_ms: now - _kaStart,
    delta_ms: now - _kaLast,
    ts: new Date(now).toISOString(),
    ...extra,
  }) + "\n");
  _kaLast = now;
}

async function keepAliveOnce({ headed = false } = {}) {
  const started = Date.now();
  const username = ensureEnv("YAP_USERNAME");
  const password = ensureEnv("YAP_PASSWORD");

  const launchArgs = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--no-zygote", "--no-first-run", "--mute-audio", "--disable-background-networking",
    "--password-store=basic",
  ];

  log("starting");
  const runtime = await createYapRuntime(chromium, {
    headed,
    freshLogin: false,
    launchArgs,
    preferPersistentProfile: true,
    resolveModule: requireFromYap.resolve.bind(requireFromYap),
    cwd: ROOT_DIR,
  });

  const { context, page } = runtime;
  let reloggato = false;
  try {
    // loginYap rileva da solo se la sessione è già valida: in tal caso non rifà il
    // login completo, apre solo l'agenda. Marchiamo "reloggato" se vede il form login.
    const loginListener = (msg) => {
      try {
        const data = JSON.parse(msg.text?.() ?? "");
        if (data?.phase === "loginYap" && data?.status === "submitting_credentials") reloggato = true;
      } catch (_) {}
    };
    page.on?.("console", loginListener);

    await loginYap(page, username, password);
    // Tocca l'agenda per forzare il refresh del token lato server.
    await openAgendaInApp(page).catch(() => {});
    const agendaReady = await waitForAgendaReady(page, 8000).then(() => true).catch(() => false);
    await persistYapSession(context).catch(() => {});

    const elapsed = Date.now() - started;
    log("done", { agendaReady, reloggato, elapsed_ms: elapsed });
    return { ok: true, refreshed: true, agendaReady, reloggato, elapsed_ms: elapsed };
  } finally {
    await runtime.close().catch(() => {});
  }
}

async function main() {
  const headed = process.argv.includes("--headed");
  try {
    const result = await keepAliveOnce({ headed });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  } catch (error) {
    const payload = { ok: false, error: String(error?.message || error) };
    log("error", payload);
    process.stdout.write(JSON.stringify(payload) + "\n");
    process.exit(1);
  }
}

main();
