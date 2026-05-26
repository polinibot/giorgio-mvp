import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const YAP_DIR = path.join(ROOT_DIR, "automation", "yap");
export const ARTIFACT_DIR = path.join(ROOT_DIR, "automation", "artifacts", "yap");
export const PRODUCTION_GATE_PAYLOAD = path.join(YAP_DIR, "sample-payload-production-gate.json");
export const MIN_TEST_DATE = "2026-11-01";

export function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function resolveGateFlags(env = process.env) {
  return {
    runYapReal: isTruthyEnv(env.RUN_YAP_REAL),
    yapRealCommit: isTruthyEnv(env.YAP_REAL_COMMIT),
    freshLogin: isTruthyEnv(env.YAP_FRESH_LOGIN),
    debug: isTruthyEnv(env.YAP_DEBUG),
  };
}

export async function ensureArtifactDir() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  return ARTIFACT_DIR;
}

export function loadJsonFileSync(filePath) {
  const raw = fsSync.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

export function toIsoDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString().slice(0, 10);
}

export function isSafeProductionDate(isoDate) {
  const normalized = toIsoDate(isoDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  return normalized >= MIN_TEST_DATE;
}

export function normalizeTestPayload(raw) {
  const mapping = raw?.mapping || raw;
  const anagrafica = mapping?.anagrafica || {};
  const agenda = mapping?.agenda || {};
  const contexts = Array.isArray(mapping?.contexts)
    ? mapping.contexts
    : String(mapping?.contexts || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  return {
    mapping,
    plate: String(anagrafica.targa || "").trim(),
    customerName: String(anagrafica.cliente_nome || "").trim(),
    customerPhone: String(anagrafica.cliente_telefono || "").trim(),
    date: toIsoDate(agenda.data),
    time: String(agenda.ora || "").trim(),
    duration: Number(agenda.durata_minuti || 0),
    contexts,
    notes: String(mapping?.note_interne || "").trim(),
    practiceId: mapping?.meta?.practice_id ?? null,
  };
}

export function validateProductionGatePayload(payload) {
  const normalized = normalizeTestPayload(payload);
  const issues = [];

  if (!normalized.plate) issues.push("targa mancante");
  if (!/^(TEST|E2E)[A-Z0-9]+$/i.test(normalized.plate)) issues.push(`targa non consentita: ${normalized.plate}`);
  if (!normalized.customerName) issues.push("cliente mancante");
  if (!/^Test Automation/i.test(normalized.customerName) && !/TEST AUTOMATION/i.test(normalized.customerName)) {
    issues.push(`cliente non consentito: ${normalized.customerName}`);
  }
  if (!isSafeProductionDate(normalized.date)) issues.push(`data non sicura: ${normalized.date}`);
  if (!/^\d{2}:\d{2}$/.test(normalized.time)) issues.push(`ora non valida: ${normalized.time}`);
  if (!normalized.contexts.length) issues.push("contesti mancanti");
  if (normalized.duration <= 0) issues.push(`durata non valida: ${normalized.duration}`);

  return { ok: issues.length === 0, issues, normalized };
}

export function assertProductionGate({ flags, payload, allowDryRun = true }) {
  if (!flags.runYapReal) {
    throw new Error("RUN_YAP_REAL=1 richiesto per eseguire la suite YAP reale");
  }

  const validated = validateProductionGatePayload(payload);
  if (!validated.ok) {
    throw new Error(`Payload YAP non sicuro: ${validated.issues.join("; ")}`);
  }

  if (!allowDryRun && !flags.yapRealCommit) {
    throw new Error("YAP_REAL_COMMIT=1 richiesto per commit/delete reali");
  }

  return validated.normalized;
}

export async function writeJsonReport(reportPath, report) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
}

export function extractTrailingJsonBlock(stdout) {
  const text = String(stdout || "").trim();
  const start = text.lastIndexOf("\n{");
  if (start >= 0) {
    return text.slice(start + 1);
  }
  if (text.startsWith("{")) {
    return text;
  }
  return null;
}

export function parseTrailingJson(stdout) {
  const block = extractTrailingJsonBlock(stdout);
  if (!block) return null;
  try {
    return JSON.parse(block);
  } catch {
    return null;
  }
}

export function runNodeScript(scriptPath, args = [], env = process.env, cwd = YAP_DIR) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr, json: parseTrailingJson(stdout) });
    });
  });
}

export function buildGateReportBase(flags, normalizedPayload) {
  return {
    generatedAt: new Date().toISOString(),
    mode: {
      runYapReal: flags.runYapReal,
      yapRealCommit: flags.yapRealCommit,
      freshLogin: flags.freshLogin,
      debug: flags.debug,
    },
    payload: {
      practiceId: normalizedPayload.practiceId,
      plate: normalizedPayload.plate,
      customerName: normalizedPayload.customerName,
      date: normalizedPayload.date,
      time: normalizedPayload.time,
      duration: normalizedPayload.duration,
      contexts: normalizedPayload.contexts,
    },
    steps: [],
    cleanup: {
      attempted: false,
      deleted: false,
      status: "not_run",
    },
  };
}

export function appendStep(report, name, result) {
  report.steps.push({
    name,
    ...result,
  });
  return report;
}
