#!/usr/bin/env node
import path from "node:path";
import {
  PRODUCTION_GATE_PAYLOAD,
  YAP_DIR,
  ARTIFACT_DIR,
  ensureArtifactDir,
  loadJsonFileSync,
  resolveGateFlags,
  assertProductionGate,
  runNodeScript,
  buildGateReportBase,
  appendStep,
  writeJsonReport,
} from "./lib/yap-gate.mjs";

const WORKER_SCRIPT = path.join(YAP_DIR, "yap-worker.mjs");
const DELETE_SCRIPT = path.join(YAP_DIR, "yap-delete-appointment.mjs");
const REPORT_PATH = path.join(ARTIFACT_DIR, "production-gate-report.json");

function parseArgs(argv) {
  const args = { cleanupOnly: false, payloadFile: PRODUCTION_GATE_PAYLOAD, reportFile: REPORT_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (!argv[i]) throw new Error(`Valore mancante per ${arg}`);
      return argv[i];
    };
    if (arg === "--cleanup-only") args.cleanupOnly = true;
    else if (arg === "--payload-file") args.payloadFile = next();
    else if (arg === "--report-file") args.reportFile = next();
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Argomento non riconosciuto: ${arg}`);
  }
  return args;
}

function compactRun(run) {
  return {
    ok: run.code === 0 && run.json?.ok === true,
    exitCode: run.code,
    json: run.json,
    stdoutTail: String(run.stdout || "").slice(-2500),
    stderrTail: String(run.stderr || "").slice(-2500),
  };
}

function resolveDeleteStatus(deleteJson) {
  const status = deleteJson?.status || deleteJson?.result?.status || null;
  const deleted = deleteJson?.deleted ?? deleteJson?.result?.deleted ?? false;
  const found = deleteJson?.found ?? deleteJson?.result?.found ?? false;
  return { status, deleted: Boolean(deleted), found: Boolean(found) };
}

async function attemptCleanup({ flags, report, required = true }) {
  const normalized = report.payload;
  const deleteArgs = ["--date", normalized.date, "--search", normalized.plate];
  if (flags.debug) deleteArgs.push("--debug");
  if (flags.freshLogin) deleteArgs.push("--fresh-login");

  const cleanup = await runNodeScript(DELETE_SCRIPT, deleteArgs, {
    RUN_YAP_REAL: "1",
    YAP_REAL_COMMIT: "1",
    YAP_DEBUG: flags.debug ? "1" : "0",
  });
  const cleanupCompact = compactRun(cleanup);
  cleanupCompact.resolved = resolveDeleteStatus(cleanup.json);
  appendStep(report, "cleanup_delete", cleanupCompact);

  report.cleanup = {
    attempted: true,
    deleted: cleanupCompact.resolved.deleted,
    status: cleanupCompact.resolved.deleted ? "ok" : (cleanupCompact.resolved.status || "failed"),
    deleteStatus: cleanupCompact.resolved.status,
    search: normalized.plate,
    date: normalized.date,
  };

  if (required && !cleanupCompact.resolved.deleted) {
    throw new Error(`Cleanup YAP fallito: ${cleanupCompact.resolved.status || "unknown"}`);
  }

  return cleanup;
}

async function runWorkerPhase({ flags, payloadFile, report }) {
  const dryArgs = ["--payload-file", payloadFile, "--dry-run"];
  if (flags.debug) dryArgs.push("--debug");
  if (flags.freshLogin) dryArgs.push("--fresh-login");

  const dryRun = await runNodeScript(WORKER_SCRIPT, dryArgs, {
    RUN_YAP_REAL: "1",
    YAP_REAL_COMMIT: "0",
    YAP_DEBUG: flags.debug ? "1" : "0",
  });
  appendStep(report, "dry_run", compactRun(dryRun));
  if (dryRun.code !== 0 || !dryRun.json?.ok) {
    throw new Error("Dry-run YAP fallito");
  }

  if (!flags.yapRealCommit) {
    return { dryRun, commit: null, dedup: null, cleanup: null };
  }

  let commitAttempted = false;
  let committed = false;
  let cleanupRan = false;
  let cleanup = null;
  let commit = null;
  let dedup = null;

  const commitArgs = ["--payload-file", payloadFile, "--commit"];
  if (flags.debug) commitArgs.push("--debug");
  if (flags.freshLogin) commitArgs.push("--fresh-login");

  try {
    commitAttempted = true;
    commit = await runNodeScript(WORKER_SCRIPT, commitArgs, {
      RUN_YAP_REAL: "1",
      YAP_REAL_COMMIT: "1",
      YAP_DEBUG: flags.debug ? "1" : "0",
    });
    appendStep(report, "commit", compactRun(commit));
    if (commit.code !== 0 || !commit.json?.ok) {
      throw new Error("Commit YAP fallito");
    }
    committed = true;

    dedup = await runNodeScript(WORKER_SCRIPT, dryArgs, {
      RUN_YAP_REAL: "1",
      YAP_REAL_COMMIT: "0",
      YAP_DEBUG: flags.debug ? "1" : "0",
    });
    appendStep(report, "dedup_check", compactRun(dedup));
    const dedupHit = dedup.json?.result?.dedup?.hit === true;
    if (!dedupHit) {
      throw new Error("Verifica dedup fallita dopo il commit");
    }

    cleanup = await attemptCleanup({ flags, report, required: true });
    cleanupRan = true;
    return { dryRun, commit, dedup, cleanup };
  } finally {
    if (commitAttempted && !cleanupRan) {
      try {
        cleanup = await attemptCleanup({ flags, report, required: committed });
      } catch (cleanupError) {
        report.cleanup = {
          attempted: true,
          deleted: false,
          status: "failed",
          error: cleanupError.message,
          search: report.payload.plate,
          date: report.payload.date,
        };
        if (!report.error) {
          report.error = cleanupError.message;
        } else {
          report.cleanup.secondaryError = cleanupError.message;
        }
        if (committed) {
          throw cleanupError;
        }
      }
    }
  }
}

async function runCleanupOnly({ flags, payloadFile, report }) {
  const dryArgs = ["--date", report.payload.date, "--search", report.payload.plate, "--dry-run"];
  if (flags.debug) dryArgs.push("--debug");
  if (flags.freshLogin) dryArgs.push("--fresh-login");

  const dryRun = await runNodeScript(DELETE_SCRIPT, dryArgs, {
    RUN_YAP_REAL: "1",
    YAP_REAL_COMMIT: "0",
    YAP_DEBUG: flags.debug ? "1" : "0",
  });
  appendStep(report, "cleanup_dry_run", compactRun(dryRun));

  if (!flags.yapRealCommit) {
    report.cleanup = {
      attempted: true,
      deleted: false,
      status: "dry_run_only",
      search: report.payload.plate,
      date: report.payload.date,
    };
    return { dryRun, deleteRun: null };
  }

  const deleteArgs = ["--date", report.payload.date, "--search", report.payload.plate];
  if (flags.debug) deleteArgs.push("--debug");
  if (flags.freshLogin) deleteArgs.push("--fresh-login");

  const deleteRun = await runNodeScript(DELETE_SCRIPT, deleteArgs, {
    RUN_YAP_REAL: "1",
    YAP_REAL_COMMIT: "1",
    YAP_DEBUG: flags.debug ? "1" : "0",
  });
  const deleteCompact = compactRun(deleteRun);
  deleteCompact.resolved = resolveDeleteStatus(deleteRun.json);
  appendStep(report, "cleanup_delete", deleteCompact);

  report.cleanup = {
    attempted: true,
    deleted: deleteCompact.resolved.deleted,
    status: deleteCompact.resolved.deleted ? "ok" : (deleteCompact.resolved.status || "failed"),
    deleteStatus: deleteCompact.resolved.status,
    search: report.payload.plate,
    date: report.payload.date,
  };

  if (!deleteCompact.resolved.deleted) {
    throw new Error(`Cleanup YAP fallito: ${deleteCompact.resolved.status || "unknown"}`);
  }

  return { dryRun, deleteRun };
}

export async function runProductionGate(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs);
  if (args.help) {
    console.log(`
YAP production gate

Uso:
  node automation/yap/run-tests.mjs
  node automation/yap/run-tests.mjs --cleanup-only

Variabili richieste:
  RUN_YAP_REAL=1

Variabili opzionali:
  YAP_REAL_COMMIT=1   abilita commit/delete reali
  YAP_DEBUG=1         screenshot e log extra
  YAP_FRESH_LOGIN=1   forza login pulito
`);
    return { ok: true, reportFile: args.reportFile };
  }

  await ensureArtifactDir();
  const flags = resolveGateFlags();
  const payload = loadJsonFileSync(args.payloadFile);
  const normalized = assertProductionGate({ flags, payload, allowDryRun: true });
  const report = buildGateReportBase(flags, normalized);
  report.payloadFile = args.payloadFile;
  report.reportFile = args.reportFile;

  let failure = null;
  try {
    if (args.cleanupOnly) {
      await runCleanupOnly({ flags, payloadFile: args.payloadFile, report });
    } else {
      await runWorkerPhase({ flags, payloadFile: args.payloadFile, report });
    }
  } catch (error) {
    failure = error;
    report.error = error.message;
  } finally {
    await writeJsonReport(args.reportFile, report);
  }

  if (failure) {
    throw failure;
  }

  return { ok: true, reportFile: args.reportFile, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProductionGate().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message, stack: error.stack }, null, 2));
    process.exit(1);
  });
}
