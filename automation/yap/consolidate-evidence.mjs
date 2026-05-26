#!/usr/bin/env node
/**
 * Consolida tutte le evidenze read-only in un dataset unico.
 * Output: analysis/yap-evidence-dataset.json
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ANALYSIS = path.join(path.dirname(fileURLToPath(import.meta.url)), "analysis");

async function readJson(name) {
  try {
    return JSON.parse(await fs.readFile(path.join(ANALYSIS, name), "utf8"));
  } catch {
    return null;
  }
}

async function readGlobScans() {
  const files = await fs.readdir(ANALYSIS);
  const scans = [];
  for (const f of files.filter((x) => x.startsWith("readonly-scan-") && x.endsWith(".json"))) {
    const data = JSON.parse(await fs.readFile(path.join(ANALYSIS, f), "utf8"));
    scans.push({ file: f, ...data });
  }
  return scans;
}

function evidenceRecord(partial) {
  return {
    id: partial.id,
    giorgioExampleId: partial.giorgioExampleId ?? null,
    giorgioContext: partial.giorgioContext ?? null,
    date: partial.date,
    source: partial.source,
    uiStatus: partial.uiStatus,
    agendaBar: {
      time: partial.agendaBar?.time ?? "",
      title: partial.agendaBar?.title ?? "",
      repartoClass: partial.agendaBar?.repartoClass ?? "",
    },
    popup: {
      cosa: partial.popup?.cosa ?? null,
      quando: partial.popup?.quando ?? null,
      dalle: partial.popup?.dalle ?? null,
      alle: partial.popup?.alle ?? null,
      tagChips: partial.popup?.tagChips ?? [],
      note1: partial.popup?.note1 ?? null,
      note2: partial.popup?.note2 ?? null,
    },
    apiMatch: partial.apiMatch ?? null,
    notes: partial.notes ?? [],
  };
}

function fromDeepDeepResults(deep) {
  const out = [];
  if (!deep?.results) return out;
  for (const r of deep.results) {
    if (r.type !== "appointment" || !r.found) continue;
    const t = r.target || {};
    out.push(
      evidenceRecord({
        id: `deep-${t.id}-${t.date}`,
        giorgioExampleId: t.id,
        giorgioContext: t.context,
        date: t.date,
        source: "deep-inspection-results.json",
        uiStatus: "popup_extracted",
        agendaBar: {
          time: "",
          title: r.clickedEvent?.text || "",
          repartoClass: r.clickedEvent?.repartoClass || "",
        },
        popup: {
          tagChips: r.popup?.tagChips || [],
          cosa: r.popup?.inputs?.find((i) => !i.hidden && i.value && !/^\d{2}\//.test(i.value) && !/^\d{1,2}\./.test(i.value))?.value,
        },
        notes: [],
      }),
    );
  }
  return out;
}

function fromPrecise(precise) {
  const out = [];
  if (!precise?.results) return out;
  for (const r of precise.results) {
    const t = r.target || {};
    if (!r.found) {
      out.push(
        evidenceRecord({
          id: `precise-${t.id}-${t.date}-missing`,
          giorgioExampleId: t.id,
          giorgioContext: t.context,
          date: t.date,
          source: "precise-inspection-results.json",
          uiStatus: "not_found",
          agendaBar: { time: "", title: "", repartoClass: "" },
          popup: { tagChips: [] },
          notes: ["not found in precise inspector"],
        }),
      );
      continue;
    }
    const inputs = r.popup?.inputs || [];
    const cosa = inputs[0]?.value;
    const quando = inputs.find((i) => /^\d{2}\/\d{2}\/\d{4}$/.test(i.value || ""))?.value;
    const times = inputs.filter((i) => /^\d{1,2}\.\d{2}$/.test(i.value || ""));
    out.push(
      evidenceRecord({
        id: `precise-${t.id}-${t.date}`,
        giorgioExampleId: t.id,
        giorgioContext: t.context,
        date: t.date,
        source: "precise-inspection-results.json",
        uiStatus: "popup_extracted",
        agendaBar: { time: "", title: r.text || "", repartoClass: "" },
        popup: {
          cosa,
          quando,
          dalle: times[0]?.value,
          alle: times[1]?.value,
          tagChips: extractTagsFromRaw(r.popup?.rawText),
        },
      }),
    );
  }
  return out;
}

function extractTagsFromRaw(rawText) {
  if (!Array.isArray(rawText)) return [];
  const known = ["pneumatici", "revisione", "comunicato", "preventivo", "tagliando", "meccanica"];
  const blob = rawText.join(" ").toLowerCase();
  return known.filter((t) => blob.includes(t));
}

function fromScans(scans) {
  const out = [];
  for (const scan of scans) {
    for (const ev of scan.events || []) {
      if (!ev.title || ev.title === "GIO NON CE") continue;
      const matchKit = /kit frizione|dp126gz|pikhlyk/i.test(ev.title);
      const matchCofano = /cofano|revisione|328562|belotti|freccia/i.test(ev.title);
      out.push(
        evidenceRecord({
          id: `scan-${scan.date}-${ev.time}-${ev.title.slice(0, 20)}`,
          giorgioExampleId: matchKit ? 2 : matchCofano ? 9 : null,
          giorgioContext: matchKit ? "officina" : matchCofano ? "revisione" : null,
          date: scan.date,
          source: scan.file,
          uiStatus: "agenda_bar_only",
          agendaBar: {
            time: ev.time,
            title: ev.title,
            repartoClass: ev.repartoClass || "",
          },
          popup: { tagChips: [] },
        }),
      );
    }
  }
  return out;
}

function mergeByKey(records) {
  const map = new Map();
  const priority = { popup_extracted: 3, agenda_bar_only: 2, not_found: 1 };
  for (const r of records) {
    const key = `${r.giorgioExampleId || "na"}-${r.date}`;
    const existing = map.get(key);
    if (!existing || (priority[r.uiStatus] || 0) > (priority[existing.uiStatus] || 0)) {
      map.set(key, r);
    } else if (existing && r.uiStatus === existing.uiStatus) {
      if ((r.popup?.tagChips?.length || 0) > (existing.popup?.tagChips?.length || 0)) {
        map.set(key, { ...existing, ...r, popup: { ...existing.popup, ...r.popup } });
      }
    }
  }
  return [...map.values()];
}

async function main() {
  const [precise, deep, scans, live2026] = await Promise.all([
    readJson("precise-inspection-results.json"),
    readJson("deep-inspection-results.json"),
    readGlobScans(),
    readJson("agenda-message-matches-live-2026.json"),
  ]);

  const officinaInferred = await readJson("officina-kit-frizione-inferred.json");
  const supplemental = [];
  if (officinaInferred) {
    supplemental.push(
      evidenceRecord({
        id: "inferred-officina-2025-04-04",
        giorgioExampleId: officinaInferred.giorgioExampleId,
        giorgioContext: officinaInferred.giorgioContext,
        date: officinaInferred.yapHistoricalDate,
        source: "officina-kit-frizione-inferred.json",
        uiStatus: "api_inferred",
        agendaBar: officinaInferred.agendaBar,
        popup: {
          cosa: officinaInferred.popupInferred?.cosa,
          quando: officinaInferred.popupInferred?.quando,
          dalle: officinaInferred.popupInferred?.dalle,
          alle: officinaInferred.popupInferred?.alle,
          tagChips: officinaInferred.popupInferred?.tagChips || [],
        },
        notes: [officinaInferred.popupInferred?.tagRationale || ""],
      }),
    );
  }

  const records = [
    ...fromPrecise(precise),
    ...fromDeepDeepResults(deep),
    ...fromScans(scans),
    ...supplemental,
  ];

  const merged = mergeByKey(records);

  const apiIndex = {};
  const apiExamples = live2026?.results || live2026?.examples || [];
  for (const ex of apiExamples) {
    apiIndex[ex.id] = {
      title: ex.title,
      context: ex.context,
      bestScore: ex.bestScore,
      bestDate: ex.bestDate,
      matchCount: ex.matches?.length || 0,
    };
  }

  const dataset = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    evidenceSchema: {
      required: ["date", "source", "uiStatus"],
      uiStatusValues: ["popup_extracted", "agenda_bar_only", "not_found", "api_only", "api_inferred"],
    },
    recordCount: merged.length,
    records: merged.sort((a, b) => String(a.date).localeCompare(String(b.date))),
    apiIndex,
    scansSummary: scans.map((s) => ({ date: s.date, eventCount: s.eventCount, file: s.file })),
  };

  const outPath = path.join(ANALYSIS, "yap-evidence-dataset.json");
  await fs.writeFile(outPath, JSON.stringify(dataset, null, 2), "utf8");
  console.log(`✅ ${merged.length} evidenze → ${outPath}`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
