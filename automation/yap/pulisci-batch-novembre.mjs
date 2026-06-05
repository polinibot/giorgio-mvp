#!/usr/bin/env node
/**
 * Wrapper batch: delega alla pulizia inventario-driven.
 * Uso: node pulisci-batch-novembre.mjs [--dry-run] [--confirm]
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const targetScript = path.join(__dirname, "cleanup-yap-novembre.mjs");
const args = process.argv.slice(2);

const child = spawn(process.execPath, [targetScript, ...args], {
  cwd: __dirname,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error("Errore fatale:", err.message);
  process.exit(1);
});
