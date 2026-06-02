import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFieldWriteReport,
  buildOdlNeedles,
  extractTrailingJsonBlock,
  formatMacNeedle,
  formatManNeedle,
  parsePraticaHashPayload,
} from "./yap-worker.mjs";

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

  assert.ok(needles.includes("nota test"));
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

test("parsePraticaHashPayload handles encoded pratica hashes", () => {
  const parsed = parsePraticaHashPayload("https://yap.mmbsoftware.it/#!pratica%7C%7B%22IdCompanyFolder%22:12684370315,%20%22Page%22:%22VEICOLO%22,%20%22ShowOdlMarcatempo%22:false%7D");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.idCompanyFolder, 12684370315);
  assert.equal(parsed.pageEnum, "VEICOLO");
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
