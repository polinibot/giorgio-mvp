#!/usr/bin/env node
/**
 * Giorgio Production E2E Runner
 *
 * Esegue test realistici su produzione: Telegram, Mini App/backend, YAP.
 * Gate di sicurezza obbligatori prima di qualsiasi scrittura.
 *
 * Uso rapido:
 *   $env:RUN_PRODUCTION_E2E="1"; $env:ALLOW_PRODUCTION_WRITES="1"; $env:RUN_YAP_REAL="1"; node run-production-e2e.mjs
 *   # Aggiungere YAP_REAL_COMMIT=1 per commit YAP reali
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveEnv, assertGates, validateCasePayload, ARTIFACT_DIR } from "./lib/e2e-gates.mjs";
import { ApiClient, assertApiOk } from "./lib/e2e-api-client.mjs";
import { TEST_CASES, buildCreatePayload, buildUpdatePayload } from "./lib/e2e-cases.mjs";
import { CleanupManager } from "./lib/e2e-cleanup.mjs";
import {
  makeReport, addCaseResult, addCleanupResult, addError,
  finalize, writeReport, printSummary,
} from "./lib/e2e-report.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(ARTIFACT_DIR, "production-e2e-report.json");

function parseArgs(argv) {
  const args = { cleanupOnly: false, yapDryRun: false, help: false, cases: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cleanup-only") args.cleanupOnly = true;
    else if (a === "--yap-dry-run") args.yapDryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--cases") { i++; args.cases = (argv[i] || "").split(",").map(s => s.trim()).filter(Boolean); }
  }
  return args;
}

function printHelp() {
  console.log(`
Giorgio Production E2E

Uso:
  node run-production-e2e.mjs [opzioni]

Opzioni:
  --cleanup-only        Solo cleanup dei dati test precedenti
  --yap-dry-run         YAP in dry-run (non crea appuntamenti reali)
  --cases A,B,D         Esegui solo i casi specificati (default: tutti)
  --help                Questo messaggio

Variabili obbligatorie:
  RUN_PRODUCTION_E2E=1
  ALLOW_PRODUCTION_WRITES=1
  PRODUCTION_API_BASE_URL o API_BASE_URL
  GIORGIO_TELEGRAM_USER_ID
  TELEGRAM_BOT_TOKEN
  YAP_USERNAME
  YAP_PASSWORD

Variabili per YAP reale:
  RUN_YAP_REAL=1
  YAP_REAL_COMMIT=1

Variabili opzionali:
  YAP_DEBUG=1
  YAP_FRESH_LOGIN=1
`);
}

const log = (msg) => console.log(msg);
const logStep = (ok, name, detail = "") => {
  const icon = ok ? "  ✓" : "  ✗";
  console.log(`${icon} ${name}${detail ? `: ${detail}` : ""}`);
};

async function checkTelegram(env, report) {
  const checks = { botTokenValid: false, errorChannelConfigured: false };
  try {
    const botRes = await new ApiClient(env.apiBaseUrl, env.telegramUserId)
      .getTelegramBotInfo(env.telegramBotToken);
    checks.botTokenValid = botRes.status === 200 && botRes.json?.ok === true;
    logStep(checks.botTokenValid, "Telegram bot token", checks.botTokenValid ? botRes.json?.result?.username : `HTTP ${botRes.status}`);
  } catch (err) {
    logStep(false, "Telegram bot token", err.message);
  }

  try {
    const api = new ApiClient(env.apiBaseUrl, env.telegramUserId);
    const chanRes = await api.getErrorChannelStatus();
    checks.errorChannelConfigured = chanRes.json?.data?.configured === true;
    logStep(checks.errorChannelConfigured, "Error channel configurato", checks.errorChannelConfigured ? "ok" : "non configurato");
  } catch (err) {
    logStep(false, "Error channel status", err.message);
  }

  report.telegramChecks = checks;
  return checks;
}

async function runCase(testCase, env, api, cleanup, args) {
  const steps = [];
  const addStep = (name, ok, detail = "") => {
    steps.push({ name, ok, detail });
    logStep(ok, name, detail);
    return ok;
  };

  const yapEnabled = env.runYapReal && testCase.yapReal;
  const yapCommit = yapEnabled && env.yapRealCommit && !args.yapDryRun;

  log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log(`📋 Caso ${testCase.id}: ${testCase.label}`);
  log(`   Targa: ${testCase.plate} | Data: ${testCase.appointmentDate?.slice(0, 10)}`);
  log(`   Contesti: ${testCase.contexts.join(", ")} | YAP reale: ${yapCommit ? "sì" : "no (dry-run)"}`);
  log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const issues = validateCasePayload(testCase);
  if (issues.length) {
    return { skipped: true, error: `Payload non sicuro: ${issues.join("; ")}`, steps };
  }

  let practiceId = null;
  let yapCreated = false;

  try {
    // 1. Crea pratica
    const createPayload = buildCreatePayload(testCase);
    const createRes = await api.createFull(createPayload);
    assertApiOk(createRes, "createFull");
    practiceId = createRes.json?.data?.id;
    if (!practiceId) throw new Error("practice_id non ricevuto");
    addStep("Crea pratica", true, `id=${practiceId}`);
    cleanup.register({
      practiceId, plate: testCase.plate,
      appointmentDate: testCase.appointmentDate,
      yapCreated: false, caseId: testCase.id,
    });

    // 2. Lista pratiche + cerca targa
    const listRes = await api.listPractices();
    assertApiOk(listRes, "listPractices");
    const list = listRes.json?.data || listRes.json || [];
    const found = (Array.isArray(list) ? list : []).some(
      (p) => String(p.id) === String(practiceId) || p.plate_confirmed === testCase.plate
    );
    addStep("Targa in lista", found, found ? testCase.plate : "non trovata");

    // 3. Stats
    const statsRes = await api.getStats();
    assertApiOk(statsRes, "getStats");
    const stats = statsRes.json?.data || {};
    addStep("Stats ok", typeof stats.total === "number", `total=${stats.total}`);

    // 4. Detail
    const detailRes = await api.getPractice(practiceId);
    assertApiOk(detailRes, "getPractice");
    const practice = detailRes.json?.data?.practice || detailRes.json?.data || {};
    addStep("Detail ok", practice.plate_confirmed === testCase.plate, `plate=${practice.plate_confirmed}`);

    // 5. Mini App data
    const miniRes = await api.getMiniAppData(practiceId);
    assertApiOk(miniRes, "getMiniAppData");
    const miniPractice = miniRes.json?.data?.practice;
    addStep("Mini App data", !!miniPractice, miniPractice ? `id=${miniPractice.id}` : "practice mancante");

    // 6. YAP mapping preview
    const previewRes = await api.getYapMappingPreview(practiceId);
    const previewOk = previewRes.status >= 200 && previewRes.status < 300;
    addStep("YAP mapping preview", previewOk, previewOk ? "ok" : `HTTP ${previewRes.status}`);

    // 7. Update pratica
    const updatePayload = buildUpdatePayload(testCase);
    const updateRes = await api.updateFull(practiceId, updatePayload);
    assertApiOk(updateRes, "updateFull");
    addStep("Update pratica", true, `id=${practiceId}`);

    // 8. Detail dopo update
    const detail2Res = await api.getPractice(practiceId);
    assertApiOk(detail2Res, "getPractice post-update");
    const p2 = detail2Res.json?.data?.practice || detail2Res.json?.data || {};
    const updatedNotes = p2.internal_notes?.includes("UPDATED");
    addStep("Detail post-update", !!updatedNotes, updatedNotes ? "note aggiornate" : `note=${p2.internal_notes}`);

    // 9. YAP: sync dry-run
    if (yapEnabled) {
      const yapDryRes = await api.syncToYap(practiceId, {
        dry_run: true, debug: env.yapDebug, fresh_login: env.yapFreshLogin,
      });
      const dryData = yapDryRes.json?.data || {};
      const dryOk = yapDryRes.status < 300 && (dryData.status === "dry_run_or_duplicate" || dryData.status === "synced" || dryData.status === "not_ready");
      addStep("YAP dry-run", dryOk, dryData.status || `HTTP ${yapDryRes.status}`);
    }

    // 10. YAP: commit reale
    if (yapCommit) {
      const yapSyncRes = await api.syncToYap(practiceId, {
        dry_run: false, debug: env.yapDebug, fresh_login: env.yapFreshLogin,
      });
      const syncData = yapSyncRes.json?.data || {};
      const syncOk = yapSyncRes.status < 300 && (syncData.status === "synced" || syncData.status === "dry_run_or_duplicate");
      yapCreated = syncOk && syncData.status === "synced";
      if (yapCreated) cleanup.markYapCreated(practiceId);
      addStep("YAP sync commit", syncOk, syncData.status || `HTTP ${yapSyncRes.status}`);

      // 10b. Detail verifica synced
      const detail3Res = await api.getPractice(practiceId);
      const p3 = detail3Res.json?.data?.practice || detail3Res.json?.data || {};
      addStep("synced=true post-commit", p3.synced === true, `synced=${p3.synced}`);

      // 10c. Dedup check (dry-run dopo commit)
      if (yapCreated) {
        const dedupRes = await api.syncToYap(practiceId, {
          dry_run: true, debug: env.yapDebug, fresh_login: env.yapFreshLogin,
        });
        const dedupData = dedupRes.json?.data || {};
        const dedupOk = dedupData.status === "dry_run_or_duplicate";
        addStep("YAP dedup check", dedupOk, dedupData.status || `HTTP ${dedupRes.status}`);
      }

      // 10d. YAP delete
      if (yapCreated) {
        const yapDelRes = await api.deleteYapAppointment(practiceId, {
          date: testCase.appointmentDate.slice(0, 10),
          search: testCase.plate,
          dry_run: false,
          debug: env.yapDebug,
          fresh_login: env.yapFreshLogin,
        });
        const delData = yapDelRes.json?.data || {};
        const delOk = delData.status === "deleted";
        if (delOk) cleanup.markYapCreated(practiceId); // già marked, forza yapClean via cleanup
        addStep("YAP delete appointment", delOk, delData.status || `HTTP ${yapDelRes.status}`);

        // 10e. Detail verifica synced=false
        const detail4Res = await api.getPractice(practiceId);
        const p4 = detail4Res.json?.data?.practice || detail4Res.json?.data || {};
        addStep("synced=false post-delete", p4.synced === false, `synced=${p4.synced}`);
      }
    }

    // 11. Soft-delete backend
    const deleteRes = await api.deletePractice(practiceId);
    const deleteOk = deleteRes.status >= 200 && deleteRes.status < 300;
    addStep("Delete backend", deleteOk, deleteOk ? "ok" : `HTTP ${deleteRes.status}`);

    // 12. Verifica status=deleted
    const detail5Res = await api.getPractice(practiceId);
    const p5 = detail5Res.json?.data?.practice || detail5Res.json?.data || {};
    addStep("status=deleted", p5.status === "deleted", `status=${p5.status}`);

    const allPassed = steps.every((s) => s.ok);
    return { passed: !steps.some((s) => !s.ok), steps, practiceId, yapCreated };

  } catch (err) {
    log(`  💥 Errore: ${err.message}`);
    return { failed: true, error: err.message, steps, practiceId, yapCreated };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  console.log("╔══════════════════════════════════════════╗");
  console.log("║    GIORGIO PRODUCTION E2E RUNNER        ║");
  console.log("╚══════════════════════════════════════════╝");

  if (args.help) { printHelp(); return; }

  const env = resolveEnv();
  assertGates(env, { requireYapCommit: false });

  const api = new ApiClient(env.apiBaseUrl, env.telegramUserId);
  const cleanup = new CleanupManager();
  const report = makeReport(env, { yapDryRun: args.yapDryRun, cleanupOnly: args.cleanupOnly });
  report.reportFile = REPORT_PATH;
  const startTime = Date.now();

  console.log(`\n🔗 Backend: ${env.apiBaseUrl}`);
  console.log(`👤 User ID: ${env.telegramUserId}`);
  console.log(`📅 Min date: 2026-11-01`);
  console.log(`🚦 YAP real: ${env.runYapReal ? "sì" : "no"} | Commit: ${env.yapRealCommit && !args.yapDryRun ? "sì" : "no (dry-run)"}`);
  console.log("");

  let globalFailure = null;

  try {
    // === Telegram checks ===
    log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("🔔 Telegram checks");
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    await checkTelegram(env, report);

    if (args.cleanupOnly) {
      log("\n🧹 Modalità cleanup-only: nessuna pratica viene creata.");
      log("   Per cleanup specifico usare i practiceId nel report precedente.");
      return;
    }

    // === Filtra casi ===
    const activeCases = args.cases.length
      ? TEST_CASES.filter((c) => args.cases.includes(c.id))
      : TEST_CASES;

    if (!activeCases.length) throw new Error("Nessun caso da eseguire");

    log(`\n📦 Casi da eseguire: ${activeCases.map((c) => c.id).join(", ")}`);

    // === Esegui matrice ===
    for (const testCase of activeCases) {
      const result = await runCase(testCase, env, api, cleanup, args);
      addCaseResult(report, testCase.id, testCase.label, result);
    }

  } catch (err) {
    globalFailure = err;
    addError(report, "runner", err);
    log(`\n💥 Errore globale: ${err.message}`);
  } finally {
    // === Cleanup garantito ===
    log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("🧹 Cleanup dati test");
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    const resources = await cleanup.cleanupAll({ apiClient: api, env, onLog: log });
    addCleanupResult(report, resources);
    cleanup.printManualSteps();

    finalize(report, startTime);
    await writeReport(REPORT_PATH, report);
    printSummary(report);

    const hasFailures = report.summary.failed > 0 || !report.cleanup.allClean || globalFailure;
    process.exit(hasFailures ? 1 : 0);
  }
}

main();
