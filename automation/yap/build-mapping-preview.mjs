#!/usr/bin/env node
/**
 * Anteprima mapping Giorgio → YAP (solo lettura, nessun browser).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeMappingInput,
  pickCosa,
  pickYapTags,
  buildNotesForPopup,
} from "./lib/yap-mapping.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_V1 = path.join(__dirname, "analysis", "yap-giorgio-bridge-mapping-v1.json");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--payload-file") args.payloadFile = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Uso: node build-mapping-preview.mjs --payload-file automation/yap/sample-payload.json");
      process.exit(0);
    }
  }
  if (!args.payloadFile) {
    console.error("Serve --payload-file");
    process.exit(1);
  }
  return args;
}

function toItalianDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function toYapTime(time) {
  return String(time || "").trim().replace(":", ".");
}

function addMinutes(time, minutes) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(Date.UTC(2000, 0, 1, h, m + minutes, 0));
  return `${String(d.getUTCHours()).padStart(2, "0")}.${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let bridge = {};
  try {
    bridge = JSON.parse(await fs.readFile(BRIDGE_V1, "utf8"));
  } catch {}

  const raw = JSON.parse(await fs.readFile(path.resolve(args.payloadFile), "utf8"));
  const mapping = normalizeMappingInput(raw);

  const cosa = pickCosa(mapping);
  const ora = mapping.agenda.ora;
  const durata = Number(mapping.agenda.durata_minuti || 20);
  const tags = pickYapTags(mapping);
  const notes = buildNotesForPopup(mapping);

  const preview = {
    generatedAt: new Date().toISOString(),
    mode: "preview_only_no_yap_write",
    source: args.payloadFile,
    giorgioSummary: {
      cliente: mapping.anagrafica.cliente_nome,
      telefono: mapping.anagrafica.cliente_telefono,
      targa: mapping.anagrafica.targa,
      data: mapping.agenda.data,
      ora,
      durata_minuti: durata,
      contesti: mapping.contexts,
      tipo_pratica: mapping.agenda.tipo_pratica,
      lavorazioniCount: mapping.lavorazioni.length,
    },
    proposedYap: {
      popup: {
        cosa,
        quando: toItalianDate(mapping.agenda.data),
        dalle: toYapTime(ora),
        alle: addMinutes(ora, durata),
        tag: tags,
        note1_proposed: notes || null,
        note2_proposed: null,
      },
      agendaBar_expectedPattern: "YAP compone automaticamente: ora - targa - modello - cliente - telefono - suffisso",
    },
    confidence: {
      cosa: mapping.contexts?.length === 1 && mapping.contexts[0] === "revisione" ? "high" : "indicative",
      cosaNote:
        mapping.contexts?.length === 1 && mapping.contexts[0] === "revisione"
          ? null
          : "YAP compone titolo/barra agenda; Cosa popup è best-effort da mini-app",
      quando: "high",
      dalle_alle: "high",
      tag: tags.length ? "high" : "low",
      note1_note2: "blocked",
    },
    openQuestions: bridge.openItems || [],
    mappingVersion: bridge.schemaVersion || "1.0-frozen",
  };

  const outPath = path.join(__dirname, "analysis", `mapping-preview-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(preview, null, 2), "utf8");

  console.log(JSON.stringify(preview, null, 2));
  console.error(`\nSalvato: ${outPath}`);
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
