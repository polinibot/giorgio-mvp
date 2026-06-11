/**
 * Idempotenza / dedup per sync YAP.
 * Chiave: targa + data + ora (normalizzata).
 */

export function buildDedupKey({ plate, date, time }) {
  const p = String(plate || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  const d = String(date || "").slice(0, 10);
  const t = String(time || "")
    .trim()
    .replace(".", ":")
    .slice(0, 5);
  if (!p || !d || !t) return null;
  return `${p}|${d}|${t}`;
}

export function parseDedupKey(key) {
  const [plate, date, time] = String(key || "").split("|");
  if (!plate || !date || !time) return null;
  return { plate, date, time };
}

/** Cerca match su eventi agenda già presenti (DOM scan o RPC decode). */
export function findExistingAppointment(events, { plate, date, time, toleranceMinutes = 0 }) {
  const key = buildDedupKey({ plate, date, time });
  if (!key) return { hit: false, reason: "missing_fields" };

  const targetPlate = plate.toUpperCase();
  const [targetH, targetM] = time.replace(".", ":").split(":").map(Number);

  // Pass 1: matching preciso targa+ora (titolo contiene la targa).
  for (const ev of events || []) {
    const title = String(ev.title || "");
    if (!title.toUpperCase().includes(targetPlate)) continue;

    const timeStr = String(ev.time || "");
    const startMatch = timeStr.match(/(\d{1,2})[.:](\d{2})/);
    if (!startMatch) {
      return { hit: true, reason: "plate_match_no_time_parse", event: ev, key };
    }
    const evH = Number(startMatch[1]);
    const evM = Number(startMatch[2]);
    const diff = Math.abs(evH * 60 + evM - (targetH * 60 + targetM));
    if (diff <= toleranceMinutes) {
      return { hit: true, reason: "plate_time_match", event: ev, key, diffMinutes: diff };
    }
  }

  // Pass 2 (fallback): YAP mostra icone al posto del testo nel .fc-title (titolo tronco/icona).
  // Se c'è un evento esattamente alla stessa ora, consideralo un potenziale duplicato.
  // Il worker aprirà il popup per verificare i dettagli.
  for (const ev of events || []) {
    const timeStr = String(ev.time || "");
    const startMatch = timeStr.match(/(\d{1,2})[.:](\d{2})/);
    if (!startMatch) continue;
    const evH = Number(startMatch[1]);
    const evM = Number(startMatch[2]);
    const diff = Math.abs(evH * 60 + evM - (targetH * 60 + targetM));
    if (diff <= toleranceMinutes) {
      return { hit: true, reason: "time_match_no_plate_in_title", event: ev, key, diffMinutes: diff };
    }
  }

  return { hit: false, reason: "not_found", key };
}

/** Stato sync consigliato dopo tentativo. */
export function resolveSyncStatus({ dedupHit, yapExternalId, error }) {
  if (error) return { status: "sync_failed", externalId: yapExternalId || null, error };
  if (dedupHit?.hit) {
    return {
      status: "synced",
      externalId: yapExternalId || dedupHit.event?.id || null,
      deduplicated: true,
      note: dedupHit.reason,
    };
  }
  if (yapExternalId) return { status: "synced", externalId: yapExternalId, deduplicated: false };
  return { status: "pending", externalId: null };
}

/** Log strutturato per dry-run e live. */
export function buildSyncLogEntry(job, result) {
  return {
    ts: new Date().toISOString(),
    practiceId: job.meta?.practice_id || job.practiceId || null,
    dedupKey: buildDedupKey({
      plate: job.customer?.plate || job.plate,
      date: job.appointment?.date || job.date,
      time: job.appointment?.time || job.time,
    }),
    dryRun: Boolean(result.dryRun),
    action: result.action || "create_appointment",
    syncStatus: result.syncStatus,
    yapPreview: result.yapPreview || null,
    dedup: result.dedup || null,
    error: result.error || null,
  };
}
