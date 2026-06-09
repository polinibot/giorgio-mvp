import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFieldWriteReport,
  buildOdlNeedles,
  extractTrailingJsonBlock,
  formatMacNeedle,
  formatManNeedle,
  hasVerifiedOdlWorkspace,
  parsePraticaHashPayload,
  shouldBlockAppointmentSaveForVehicle,
  shouldBlockPracticeWriteForVehicle,
} from "./yap-worker.mjs";
import {
  buildManagementPlan,
  buildYapPreview,
  hasWorkContexts,
  isRevisionePura,
} from "./lib/yap-mapping.mjs";

test("formatters use canonical MAN/MAC syntax", () => {
  assert.equal(formatManNeedle(1), "MAN: 1");
  assert.equal(formatMacNeedle("0.5"), "MAC: 0.5");
});

test("buildOdlNeedles includes canonical MAN/MAC needles", () => {
  const needles = buildOdlNeedles({
    internalNotes: "nota test",
    sections: [{
      reparto: "officina",
      descrizioni: ["tagliando completo"],
      ore_man: 1,
      ore_mac: 0.5,
      materiali_euro: 12.5,
      smaltimento_applica: true,
      smaltimento_percentuale: 2,
      ricambi: [{ name: "Filtro olio", quantity: 1 }],
    }],
  });

  assert.ok(needles.includes("officina"));
  assert.ok(needles.includes("tagliando completo"));
  assert.ok(needles.includes("MAN: 1"));
  assert.ok(needles.includes("MAC: 0.5"));
});

test("buildFieldWriteReport uses canonical field expectations", () => {
  const fields = buildFieldWriteReport({
    internalNotes: "NOTE TEST",
    sections: [{
      reparto: "officina",
      descrizioni: ["Lavoro test"],
      ore_man: 1,
      ore_mac: 0.5,
      materiali_euro: 12.5,
      smaltimento_applica: true,
      smaltimento_percentuale: 2,
      ricambi: [{ name: "Filtro olio", quantity: 1 }],
    }],
  }, {
    notes: { success: true },
    odl: { sections: [{ reparto: "officina", written: true }] },
    hours: { man: { success: true }, mac: { success: true } },
    materials: { success: true },
    waste: { success: true },
    parts: { success: true },
  });

  assert.ok(fields.some((field) => field.field_id === "odl.officina.man" && field.expected === "MAN: 1"));
  assert.ok(fields.some((field) => field.field_id === "odl.officina.mac" && field.expected === "MAC: 0.5"));
  assert.ok(fields.some((field) => field.field_id === "odl.officina.ricambio.Filtro olio" && field.expected === "Filtro olio x 1"));
});

test("revisione pura skips work planning", () => {
  const mapping = {
    contexts: ["revisione"],
    anagrafica: { targa: "TEST123" },
    agenda: { data: "2026-11-24", ora: "10:20", durata_minuti: 20, tipo_pratica: "preventivo" },
    lavorazioni: [{ reparto: "revisione", descrizioni: ["Controllo revisione"] }],
    note_interne: "Nota revisione",
  };

  assert.equal(isRevisionePura(mapping), true);
  assert.equal(hasWorkContexts(mapping), false);

  const plan = buildManagementPlan({ mapping });
  const preview = buildYapPreview(mapping);

  assert.equal(plan.odl, null);
  assert.deepEqual(plan.agenda.delegatedToYap, ["pratica"]);
  assert.equal(preview.proposedYap.odl, null);
  assert.deepEqual(preview.proposedYap.delegatedToYap, ["pratica"]);
});

test("preventivo work contexts use preventivi page", () => {
  const mapping = {
    contexts: ["carrozzeria"],
    anagrafica: { targa: "GA019BC" },
    agenda: { data: "2026-11-24", ora: "10:20", durata_minuti: 20, tipo_pratica: "preventivo" },
    lavorazioni: [{ reparto: "carrozzeria", descrizioni: ["Verniciatura cerchi"] }],
  };

  const plan = buildManagementPlan({ mapping });

  assert.equal(plan.odl.page, "preventivi");
  assert.equal(plan.odl.pageLabel, "Preventivi");
  assert.equal(plan.odl.yapMenu[0], "Preventivi");
  assert.deepEqual(plan.agenda.delegatedToYap, ["pratica", "odl_base"]);
});

test("parsePraticaHashPayload handles encoded pratica hashes", () => {
  const parsed = parsePraticaHashPayload("https://yap.mmbsoftware.it/#!pratica%7C%7B%22IdCompanyFolder%22:12684370315,%20%22Page%22:%22VEICOLO%22,%20%22ShowOdlMarcatempo%22:false%7D");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.idCompanyFolder, 12684370315);
  assert.equal(parsed.pageEnum, "VEICOLO");
});

test("verified ODL workspace accepts effective ODL states even when openedOdl is not explicit", () => {
  assert.equal(hasVerifiedOdlWorkspace({
    openedOdl: false,
    workspaceState: "odl_full",
  }), true);

  assert.equal(hasVerifiedOdlWorkspace({
    openedOdl: false,
    debug: { odl: { workspaceStateAfterFullReload: "odl_full" } },
  }), true);

  assert.equal(hasVerifiedOdlWorkspace({
    openedOdl: false,
    workspaceState: "loading_shell",
    debug: { odl: {} },
  }), false);
});

test("vehicle gate blocks practice write unless the vehicle is linked", () => {
  const job = { customer: { plate: "CN401MV" } };

  assert.equal(shouldBlockPracticeWriteForVehicle(job, { vehicleState: "linked" }), false);
  assert.equal(shouldBlockPracticeWriteForVehicle(job, { vehicleState: "failed" }), true);
  assert.equal(shouldBlockPracticeWriteForVehicle(job, { vehicleState: "not_found" }), true);
  assert.equal(shouldBlockPracticeWriteForVehicle(job, null), true);
  assert.equal(shouldBlockPracticeWriteForVehicle({ customer: {} }, { vehicleState: "failed" }), false);
});

test("vehicle gate blocks appointment save unless the vehicle is linked", () => {
  const job = { customer: { plate: "CN401MV" } };

  assert.equal(shouldBlockAppointmentSaveForVehicle(job, { vehicleState: "linked" }), false);
  assert.equal(shouldBlockAppointmentSaveForVehicle(job, { vehicleState: "failed" }), true);
  assert.equal(shouldBlockAppointmentSaveForVehicle(job, { vehicleState: "not_found" }), true);
  assert.equal(shouldBlockAppointmentSaveForVehicle(job, null), true);
  assert.equal(shouldBlockAppointmentSaveForVehicle({ customer: {} }, { vehicleState: "failed" }), false);
});

test("extractTrailingJsonBlock finds the final JSON object in mixed output", () => {
  const raw = [
    '{"event":"yap:phase","phase":"save"}',
    '{',
    '  "ok": true,',
    '  "result": {',
    '    "saved": true',
    '  }',
    '}',
  ].join("\n");

  const extracted = extractTrailingJsonBlock(raw);
  assert.ok(extracted);
  assert.deepEqual(JSON.parse(extracted), { ok: true, result: { saved: true } });
});
