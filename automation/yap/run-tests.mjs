#!/usr/bin/env node
/**
 * Runner YAP production-gate.
 * 
 * Uso:
 *   node run-tests.mjs
 *   node run-tests.mjs --cleanup-only
 */

import { runProductionGate } from './production-gate-runner.mjs';

console.log('╔════════════════════════════════════╗');
console.log('║     YAP PRODUCTION GATE          ║');
console.log('╚════════════════════════════════════╝');
console.log('');
console.log('⚠️  RUN_YAP_REAL=1 richiesto');
console.log('⚠️  YAP_REAL_COMMIT=1 richiesto per commit/delete reali');
console.log('📅 Date consentite: 2026-11-01 o successive');
console.log('🚗 Targhe consentite: TEST*/E2E*');
console.log('');

async function main() {
  const args = process.argv.slice(2);
  const startTime = Date.now();

  try {
    const result = await runProductionGate(args);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n╔════════════════════════════════════╗');
    console.log('║         REPORT FINALE              ║');
    console.log('╚════════════════════════════════════╝');
    console.log(`⏱️  Durata: ${duration}s`);
    console.log(`📄 Report: ${result.reportFile}`);
    console.log('🎉 YAP production gate completato');
    process.exit(0);
  } catch (e) {
    console.error(`\n💥 ERRORE YAP PRODUCTION GATE: ${e.message}`);
    process.exit(1);
  }
}

main();
