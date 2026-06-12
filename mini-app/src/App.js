import React, { useState, useEffect, useCallback, useRef, startTransition } from 'react';
import { flushSync } from 'react-dom';
import { useForm, Controller } from 'react-hook-form';
import axios from 'axios';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import './App.css';

// Configurazione axios
const API_BASE_URL = process.env.REACT_APP_API_URL
  || (process.env.NODE_ENV === 'development'
    ? 'http://127.0.0.1:8000'
    : 'https://giorgio-mvp-production.up.railway.app');
const DEV_TELEGRAM_USER_ID = process.env.REACT_APP_DEV_TELEGRAM_USER_ID || '761118078';

const DRAFT_STORAGE_KEY = 'giorgio_draft';
const DRAFT_STORAGE_TTL_MS = 24 * 60 * 60 * 1000;
const CLIENT_CACHE_TTL_MS = 30 * 1000;

const getDraftStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    window.localStorage?.removeItem(DRAFT_STORAGE_KEY);
  } catch (_) {
    // Legacy localStorage cleanup is best-effort only.
  }
  try {
    return window.sessionStorage || null;
  } catch (_) {
    return null;
  }
};

// --- Helpers ---

/** Retry with exponential backoff */
async function fetchWithRetry(fn, { maxRetries = 2, baseDelay = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function waitForNextPaint() {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return;
  }
  await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function probeApiConnection() {
  try {
    const res = await axios.get(`${API_BASE_URL}/test-connection`, { timeout: 5000 });
    return {
      ok: Boolean(res?.data?.status === 'ok'),
      status: res?.status || null,
      data: res?.data || null,
    };
  } catch (err) {
    return {
      ok: false,
      status: err?.response?.status || null,
      error: err?.message || null,
    };
  }
}

/** Classify error for user-friendly messages */
function extractErrorDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => extractErrorDetail(item)).filter(Boolean).join(' | ');
  }
  if (typeof detail === 'object') {
    if (detail.message || detail.error || detail.detail) {
      return detail.message || detail.error || detail.detail;
    }
    const parts = [
      detail.stderr,
      detail.stdout,
      detail.reason,
    ].filter(Boolean);
    return (
      parts.join(' | ')
      || JSON.stringify(detail)
    );
  }
  return String(detail);
}

function classifyError(err) {
  const url = String(err?.config?.url || '').toLowerCase();
  const isYapSync = url.includes('/yap/sync');
  const isYapAudit = url.includes('/yap/audit');
  const isYapDelete = url.includes('/yap/appointment');
  if (!err.response) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      if (isYapSync) {
        return 'La richiesta di sync YAP si è interrotta prima della risposta. La pratica potrebbe essere stata scritta comunque: premi Verifica YAP per controllare lo stato salvato.';
      }
      if (isYapAudit) {
        return 'La verifica YAP si è interrotta prima della risposta. Riprova Verifica YAP tra qualche minuto.';
      }
      if (isYapDelete) {
        return 'La richiesta di eliminazione YAP si è interrotta prima della risposta. Verifica se l\'appuntamento è ancora presente prima di riprovare.';
      }
      return 'Verifica YAP in corso da troppo tempo. Il portale potrebbe essere lento: riprova tra qualche minuto.';
    }
    if (isYapSync) {
      return 'La richiesta di sync YAP non ha restituito una risposta. Prima di riprovare, apri Verifica YAP per controllare se qualcosa è già stato scritto.';
    }
    if (isYapAudit) {
      return 'La verifica YAP non ha restituito una risposta. Riprova Verifica YAP tra qualche minuto.';
    }
    if (isYapDelete) {
      return 'La richiesta di eliminazione YAP non ha restituito una risposta. Controlla lo stato su YAP prima di riprovare.';
    }
    return 'Errore di rete. Controlla la connessione internet e riprova.';
  }
  const status = err.response.status;
  const detail = extractErrorDetail(err.response.data?.detail || err.response.data?.message || err.response.data?.error);
  if (status === 429) return detail || 'Operazione YAP già in corso. Attendi il completamento e riprova.';
  if (status === 504) return detail || 'Verifica YAP scaduta. Il portale YAP era irraggiungibile: riprova tra qualche minuto.';
  if (status === 422 || status === 400) return detail || 'Dati non validi. Controlla i campi e riprova.';
  if (status === 403) return detail || 'Utente non autorizzato. Contatta l\'amministratore.';
  if (status === 401) {
    if (detail === 'Invalid Telegram initData') {
      return 'Sessione Telegram non valida. Chiudi e riapri la Mini App dal bot.';
    }
    if (detail === 'Authentication required') {
      return 'Sessione Telegram mancante. Riapri la Mini App dal pulsante del bot.';
    }
    return 'Sessione scaduta. Chiudi e riapri la Mini App.';
  }
  if (status === 404) return detail || 'Risorsa non trovata.';
  if (status >= 500) return detail || 'Errore del server. Riprova tra qualche istante.';
  return detail || 'Errore sconosciuto. Riprova.';
}

function buildYapErrorResult(err, fallbackStatus = 'sync_failed') {
  const detail = err?.response?.data?.detail || err?.response?.data || {};
  const safeDetail = detail && typeof detail === 'object' ? detail : {};
  const url = String(err?.config?.url || '').toLowerCase();
  const inferredActionTarget = safeDetail.action_target
    || (url.includes('/yap/audit') ? 'audit' : (url.includes('/yap/appointment') ? 'delete' : (url.includes('/yap/sync') ? 'audit' : '')));
  const inferredNextAction = safeDetail.next_action
    || (inferredActionTarget === 'audit' ? 'Verifica YAP' : (inferredActionTarget === 'delete' ? 'Elimina YAP' : ''));
  const inferredErrorCode = safeDetail.error_code
    || (!err?.response && url.includes('/yap/sync') ? 'YAP_RESPONSE_LOST' : null);
  const inferredStatusReason = safeDetail.status_reason
    || safeDetail.reason
    || (!err?.response && url.includes('/yap/sync') ? 'response_interrupted_after_sync_request' : null);
  const message = safeDetail.message || safeDetail.error || classifyError(err);
  return normalizeYapResult({
    status: fallbackStatus,
    message,
    status_reason: inferredStatusReason,
    error_code: inferredErrorCode,
    next_action: inferredNextAction,
    action_target: inferredActionTarget,
    retryable: typeof safeDetail.retryable === 'boolean' ? safeDetail.retryable : true,
    worker_phases: safeDetail.worker_phases || [],
    runner: safeDetail.runner || null,
    stderr_tail: safeDetail.stderr_tail || '',
    stdout_tail: safeDetail.stdout_tail || '',
    telemetry: safeDetail.telemetry || null,
    audit: safeDetail.audit || null,
    practice: safeDetail.practice || null,
    error: safeDetail,
  });
}

function actionLabelFromTarget(actionTarget) {
  if (actionTarget === 'sync') return 'Riprova sync';
  if (actionTarget === 'audit') return 'Verifica YAP';
  if (actionTarget === 'delete') return 'Elimina YAP';
  if (actionTarget === 'open_odl') return 'Apri pratica-ODL';
  return '';
}

/** Italian phone validation */
function isValidItalianPhone(val) {
  const cleaned = val.replace(/[\s.()-]/g, '');
  return /^(\+39)?3\d{8,9}$/.test(cleaned) || /^0\d{5,10}$/.test(cleaned);
}

/** Italian license plate */
function isValidItalianPlate(val) {
  const cleaned = val.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{5,10}$/.test(cleaned);
}

function isLocalDevHost() {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

function extractYapTelemetry(result) {
  const candidates = [
    result?.telemetry,
    result?.audit?.telemetry,
    result?.yap?.telemetry,
    result?.yap?.result?.telemetry,
  ];
  return candidates.find((candidate) => candidate && typeof candidate === 'object') || null;
}

function normalizeYapResult(rawResult, { dryRun = false } = {}) {
  const result = rawResult || {};
  const rawStatus = String(result.status || result.mode || '').trim();
  const isDuplicate = rawStatus === 'dry_run_or_duplicate' && result.yap?.result?.mode === 'commit-blocked-duplicate';
  const isDryRun = rawStatus === 'dry_run_or_duplicate' && !isDuplicate;
  let status = isDuplicate ? 'duplicate' : (isDryRun || dryRun ? 'dry_run' : (rawStatus || 'unknown'));
  const message = result.message
    || result.yap?.result?.message
    || result.yap?.message
    || result.error?.message
    || '';

  if (status === 'unknown') {
    const inferred = String(result.practice?.management_sync_status || result.yap?.status || '').trim();
    const normalizedMessage = String(message || '').toLowerCase();
    if (inferred) status = inferred;
    else if (result.yap?.result?.saved || result.yap?.result?.mode === 'commit') status = (result.audit && typeof result.audit === 'object' && Object.keys(result.audit).length > 0) ? 'partial_synced' : 'agenda_synced';
    else if (normalizedMessage.includes('agenda sincronizzata')) status = 'partial_synced';
    else if (normalizedMessage.includes('appuntamento eliminato')) status = 'deleted';
    else if (normalizedMessage.includes('non trovato') || normalizedMessage.includes('not found')) status = 'not_found';
    else if (normalizedMessage.includes('fallita') || normalizedMessage.includes('errore')) status = 'sync_failed';
  }

  const nestedError = result?.yap?.error || result?.error || {};
  const errorCode = result.error_code || nestedError.error_code || null;
  const statusReason = result.status_reason || nestedError.reason || null;
  const nextAction = result.next_action || nestedError.next_action || '';
  const actionTarget = result.action_target || nestedError.action_target || '';
  const retryable = typeof result.retryable === 'boolean'
    ? result.retryable
    : (status === 'sync_failed' || status === 'not_ready');
  const telemetry = extractYapTelemetry(result);

  return {
    ...result,
    status,
    message,
    telemetry,
    retryable,
    status_reason: statusReason,
    error_code: errorCode,
    next_action: nextAction,
    action_target: actionTarget,
    action_label: actionLabelFromTarget(actionTarget),
    duplicate: isDuplicate || result.duplicate || false,
    dryRun: dryRun || result.dryRun || false,
  };
}

const YAP_PHASE_LABELS = {
  browser: 'avvio browser',
  login: 'accesso YAP',
  agenda: 'navigazione agenda',
  dedup: 'controllo duplicati',
  popup: 'popup appuntamento',
  save: 'salvataggio',
  odl: 'scrittura pratica/ODL',
  odl_route: 'apertura ODL',
  odl_tab: 'tab ODL',
  notes_fallback: 'scrittura note',
  event_click: 'ricerca evento',
  practice_odl: 'apertura pratica e ODL',
};

function summarizePhaseTimeline(phaseTimeline, fallback = '') {
  const phases = Array.isArray(phaseTimeline) ? phaseTimeline : [];
  if (!phases.length) return fallback;
  const done = phases.filter((phase) => phase?.status === 'completed').length;
  const totalMs = phases.reduce((sum, phase) => sum + (Number(phase?.duration_ms) || 0), 0);
  const failed = phases.find((phase) => phase?.status === 'failed');
  if (failed) {
    const label = YAP_PHASE_LABELS[failed.name] || failed.name || 'fase';
    return `YAP: ${label} fallita (${Math.round(totalMs / 1000)}s)`;
  }
  // Se nessuna fase è completed (es. tutte skipped), non mostrare "0/N fasi" che è rumore.
  if (!done) return fallback;
  return `${done}/${phases.length} fasi completate (${Math.round(totalMs / 1000)}s)`;
}

function workerPhasesToLabel(workerPhases, options = {}) {
  if (!Array.isArray(workerPhases) || !workerPhases.length) return null;
  const softenFailure = options.softenFailure === true;
  const meaningful = [...workerPhases].reverse().find((phase) => (
    phase
    && phase.phase !== 'inline_audit'
    && ['failed', 'ineffective'].includes(String(phase.status || '').toLowerCase())
  ));
  const last = meaningful || workerPhases[workerPhases.length - 1];
  if (!last) return null;
  const phaseLabel = YAP_PHASE_LABELS[last.phase] || last.phase;
  const elapsedS = Math.round((last.elapsed_ms || 0) / 1000);
  const statusMap = { starting: 'avvio', done: 'completato', ready: 'pronto', failed: 'fallito', ineffective: 'da ricontrollare', scanning: 'scansione', opening: 'apertura', filled: 'compilato', found: 'trovato', not_found: 'non trovato', partial: 'parziale' };
  const rawStatus = String(last.status || '').toLowerCase();
  const statusLabel = softenFailure && rawStatus === 'failed'
    ? 'da ricontrollare'
    : (statusMap[last.status] || last.status);
  return `YAP: ${phaseLabel} ${statusLabel} (${elapsedS}s)`;
}

function formatYapElapsedMs(totalElapsedMs) {
  const totalSeconds = Math.max(0, Math.round((Number(totalElapsedMs) || 0) / 1000));
  if (!totalSeconds) return '';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${totalSeconds}s`;
}

function formatYapSessionLabel(telemetry, status) {
  if (!telemetry || typeof telemetry !== 'object') return '';
  if (telemetry.used_persistent_profile || telemetry.session_mode === 'persistent_profile') {
    return 'Sessione riusata';
  }
  if (telemetry.session_mode === 'browser_context' && status !== 'complete_synced' && status !== 'duplicate') {
    return 'Sessione isolata';
  }
  return '';
}

function formatYapProfileLockLabel(profileLock) {
  if (!profileLock || typeof profileLock !== 'object') return '';
  if (profileLock.acquired === false) return 'Profilo occupato, fallback sessione isolata';
  if (Number(profileLock.wait_ms) > 0) {
    const elapsed = formatYapElapsedMs(profileLock.wait_ms);
    return elapsed ? `Lock profilo ${elapsed}` : 'Lock profilo';
  }
  return '';
}

function buildYapTelemetryDetails(telemetry, status) {
  if (!telemetry || typeof telemetry !== 'object') return [];
  const details = [];
  if (telemetry.agenda_unstable) details.push('Agenda instabile rilevata');
  else if (telemetry.empty_confirmed) details.push('Agenda vuota confermata');
  if (telemetry.session_mode === 'browser_context' && telemetry.profile_lock?.acquired === false) {
    details.push('Profilo occupato al momento del lock');
  }
  const profileLockLabel = formatYapProfileLockLabel(telemetry.profile_lock);
  if (profileLockLabel) details.push(profileLockLabel);
  return details;
}

function extractYapTechnicalDiagnostics(result) {
  const candidates = [
    result,
    result?.error,
    result?.yap?.error,
    result?.yap?.result,
  ].filter(Boolean);
  const pick = (key) => candidates.find((candidate) => candidate && candidate[key] != null)?.[key];
  const workerPhases = pick('worker_phases');
  const runner = pick('runner');
  const failedPhase = pick('failed_phase');
  const stderrTail = pick('stderr_tail');
  const stdoutTail = pick('stdout_tail');
  if (!failedPhase && !runner && !stderrTail && !stdoutTail && !Array.isArray(workerPhases)) return null;
  return {
    failedPhase: failedPhase || null,
    runner: runner && typeof runner === 'object' ? runner : null,
    workerPhases: Array.isArray(workerPhases) ? workerPhases : [],
    stderrTail: stderrTail ? String(stderrTail) : '',
    stdoutTail: stdoutTail ? String(stdoutTail) : '',
  };
}

function summarizeWorkerPhases(workerPhases) {
  const phases = Array.isArray(workerPhases) ? workerPhases : [];
  if (!phases.length) return '';
  return phases
    .map((phase) => `${phase?.phase || '?'}:${phase?.status || '?'}`)
    .join(' -> ');
}

function formatProgressElapsed(startedAt) {
  const elapsedMs = Date.now() - (Number(startedAt) || Date.now());
  return Math.max(0, Math.round(elapsedMs / 1000));
}

function getYapProgressPercent(action, startedAt) {
  // Il backend non trasmette fasi live durante il POST lungo. Qualsiasi percentuale
  // intermedia basata sul tempo sarebbe inventata: 0 = nessun completamento ancora
  // confermato, 100 viene impostato esclusivamente alla risposta terminale.
  return 0;
}

function getYapProgressLabel(action, startedAt, fallback = '') {
  const elapsed = formatProgressElapsed(startedAt);
  const actionLabel = {
    sync: 'Sincronizzazione YAP',
    audit: 'Verifica YAP',
    delete: 'Eliminazione YAP',
  }[action] || 'Operazione YAP';
  return `${actionLabel} in esecuzione sul server. Fase live non disponibile (${elapsed}s trascorsi).`;
}

function getYapSyncScope(result) {
  return result?.syncScope || result?.practice?.management_sync_scope || null;
}

function getYapAuditResult(resultOrPractice) {
  return resultOrPractice?.audit || resultOrPractice?.management_audit_result || resultOrPractice?.practice?.management_audit_result || null;
}

function normalizeYapAuditSnapshot(audit) {
  if (!audit) return null;
  let snapshot = audit;
  if (typeof snapshot === 'string') {
    try {
      snapshot = JSON.parse(snapshot);
    } catch (_) {
      return null;
    }
  }
  return snapshot && typeof snapshot === 'object' ? snapshot : null;
}

function mergeYapResultWithPersistedAudit(result, practice) {
  if (!result) return result;
  // Per gli esiti di ELIMINAZIONE NON mescolare worker log / audit dell'ultimo SYNC
  // salvato sulla pratica: mostrerebbe il log sbagliato (un sync) al posto della delete.
  const deleteStatuses = ['deleted', 'not_found', 'not_needed', 'delete_failed', 'blocked_by_odl', 'blocked_by_preventivo'];
  if (deleteStatuses.includes(String(result.status || '')) || result.action_target === 'delete') {
    return result;
  }
  const persistedAudit = normalizeYapAuditSnapshot(practice?.management_audit_result);
  if (!persistedAudit) return result;

  const merged = { ...result };
  const mergedError = merged.error && typeof merged.error === 'object' ? { ...merged.error } : null;

  if (!merged.audit) merged.audit = persistedAudit;
  if (!merged.management_audit_result) merged.management_audit_result = persistedAudit;
  if (merged.practice && !merged.practice.management_audit_result) {
    merged.practice = { ...merged.practice, management_audit_result: persistedAudit };
  }

  const fallbackKeys = ['worker_phases', 'phase_timeline', 'runner', 'failed_phase', 'stderr_tail', 'stdout_tail'];
  fallbackKeys.forEach((key) => {
    const currentValue = merged[key];
    const currentMissing = Array.isArray(currentValue) ? currentValue.length === 0 : currentValue == null || currentValue === '';
    if (currentMissing && persistedAudit[key] != null) {
      merged[key] = persistedAudit[key];
    }
    if (mergedError) {
      const errorValue = mergedError[key];
      const errorMissing = Array.isArray(errorValue) ? errorValue.length === 0 : errorValue == null || errorValue === '';
      if (errorMissing && persistedAudit[key] != null) {
        mergedError[key] = persistedAudit[key];
      }
    }
  });

  if (mergedError) merged.error = mergedError;
  return merged;
}

function flattenYapAuditItems(audit) {
  return {
    present: Array.isArray(audit?.present) ? audit.present : [],
    missing: Array.isArray(audit?.missing) ? audit.missing : [],
    mismatch: Array.isArray(audit?.mismatch) ? audit.mismatch : [],
  };
}

function matchYapAuditItem(item, matchers = []) {
  const haystack = [
    item?.field,
    item?.label,
    item?.expected,
    item?.found,
    item?.found_preview,
    item?.reason,
    item?.hint,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  // I matcher regex con ancore (^campo$) vanno testati ANCHE contro il solo `field`:
  // l'haystack unito (field + expected + ...) faceva fallire ^preventivo\.manodopera$
  // -> la checklist mostrava "n.d." anche quando il campo era presente nell'audit.
  const field = String(item?.field || '').toLowerCase();
  return matchers.some((matcher) => (
    matcher instanceof RegExp
      ? (matcher.test(haystack) || (field && matcher.test(field)))
      : haystack.includes(String(matcher || '').toLowerCase())
  ));
}

function getYapAuditChecklistState(audit, matchers = []) {
  const groups = flattenYapAuditItems(audit);
  const hasFailure = groups.missing.some((item) => matchYapAuditItem(item, matchers))
    || groups.mismatch.some((item) => matchYapAuditItem(item, matchers));
  const hasSuccess = groups.present.some((item) => matchYapAuditItem(item, matchers));
  return {
    seen: hasFailure || hasSuccess,
    value: hasFailure ? false : (hasSuccess ? true : null),
  };
}

function formatYapChecklistValue(value) {
  if (value === true) return 'si';
  if (value === false) return 'no';
  return 'n.d.';
}

function practiceNeedsYapDelete(practice) {
  const status = String(practice?.management_sync_status || '').trim().toLowerCase();
  return Boolean(
    practice?.management_external_id
    || practice?.synced
    || practice?.management_last_sync_at
    || ['synced', 'duplicate', 'agenda_synced', 'partial_synced', 'complete_synced', 'sync_failed', 'audit_failed', 'deleted', 'not_found', 'unknown'].includes(status)
  );
}

function buildYapChecklist({ audit, result, practiceType }) {
  const normalizedPracticeType = String(practiceType || result?.practice?.practice_type || '').trim().toLowerCase();
  const agendaState = getYapAuditChecklistState(audit, [/^agenda$/i, 'appuntamento salvato in agenda']);
  const vehicleState = getYapAuditChecklistState(audit, [/^veicolo$/i, 'veicolo agganciato']);
  const tagState = getYapAuditChecklistState(audit, [/^tag$/i, 'tag: ']);
  // NB: niente matcher-stringa 'documento salvato' qui: e' condiviso con odl.salvataggio
  // e faceva vincere il ramo Preventivo anche sulle pratiche ODL. Solo il campo esatto.
  const preventivoSaveState = getYapAuditChecklistState(audit, [/^preventivo\.salvataggio$/i]);
  const preventivoManState = getYapAuditChecklistState(audit, [/^preventivo\.manodopera$/i, 'riga manodopera']);
  const preventivoDescriptionState = getYapAuditChecklistState(audit, [/^preventivo\.descrizione$/i]);
  const preventivoPartsState = getYapAuditChecklistState(audit, [/^preventivo\.ricambio$/i, /^preventivo\.ricambi$/i]);
  const odlState = getYapAuditChecklistState(audit, [/^odl$/i, 'scrittura odl']);
  const odlSaveState = getYapAuditChecklistState(audit, [/^odl\.salvataggio$/i]);
  const odlManState = getYapAuditChecklistState(audit, [/^odl\.manodopera$/i]);
  const odlDescriptionState = getYapAuditChecklistState(audit, [/^odl\.descrizione$/i]);
  const odlPartsState = getYapAuditChecklistState(audit, [/^odl\.ricambio$/i, /^odl\.ricambi$/i]);
  const status = String(result?.status || result?.practice?.management_sync_status || audit?.status || '').trim().toLowerCase();

  const agendaValue = agendaState.value != null
    ? agendaState.value
    : ['agenda_synced', 'partial_synced', 'complete_synced', 'duplicate'].includes(status);

  const checklist = [
    { key: 'agenda', label: 'Agenda salvata', value: agendaValue },
    { key: 'veicolo', label: 'Veicolo agganciato', value: vehicleState.value },
    { key: 'tag', label: 'Tag inserito', value: tagState.value },
  ];

  if (normalizedPracticeType === 'preventivo' || preventivoSaveState.seen || preventivoManState.seen || preventivoDescriptionState.seen || preventivoPartsState.seen) {
    checklist.push(
      { key: 'preventivo-salvato', label: 'Preventivo salvato', value: preventivoSaveState.value },
      { key: 'preventivo-man', label: 'Preventivo manodopera', value: preventivoManState.value },
      { key: 'preventivo-descrizioni', label: 'Preventivo descrizioni', value: preventivoDescriptionState.value },
      { key: 'preventivo-ricambi', label: 'Preventivo ricambi', value: preventivoPartsState.value },
    );
  } else if (normalizedPracticeType === 'ordine_di_lavoro' || odlSaveState.seen || odlManState.seen || odlDescriptionState.seen || odlPartsState.seen || odlState.seen) {
    checklist.push(
      { key: 'odl-salvato', label: 'ODL salvato', value: odlSaveState.seen ? odlSaveState.value : odlState.value },
      { key: 'odl-man', label: 'ODL manodopera', value: odlManState.value },
      { key: 'odl-descrizioni', label: 'ODL descrizioni', value: odlDescriptionState.value },
      { key: 'odl-ricambi', label: 'ODL ricambi', value: odlPartsState.value },
    );
  }

  return checklist;
}

function buildYapDiagnosticSnapshot({
  audit,
  result,
  practice,
  checklist,
  technicalDiagnostics,
  writeReport,
}) {
  const groups = flattenYapAuditItems(audit);
  const practiceInfo = practice || result?.practice || {};
  return sanitizeDiagnosticValue({
    createdAt: new Date().toISOString(),
    practice: {
      id: practiceInfo?.id || null,
      plate: practiceInfo?.plate_confirmed || practiceInfo?.plate || '',
      customer: practiceInfo?.customer_name || '',
      phone: practiceInfo?.phone || '',
      practiceType: practiceInfo?.practice_type || '',
      appointmentDate: practiceInfo?.appointment_date || '',
      appointmentTime: practiceInfo?.appointment_time || '',
      contexts: practiceInfo?.contexts || [],
    },
    outcome: {
      status: result?.status || audit?.status || practiceInfo?.management_sync_status || '',
      message: result?.message || audit?.message || '',
      errorCode: result?.error_code || audit?.error_code || '',
      statusReason: result?.status_reason || audit?.status_reason || '',
      nextAction: result?.next_action || audit?.next_action || '',
      actionTarget: result?.action_target || audit?.action_target || '',
    },
    checklist: checklist.map((item) => ({
      key: item.key,
      label: item.label,
      value: formatYapChecklistValue(item.value),
    })),
    audit: {
      presentCount: groups.present.length,
      missingCount: groups.missing.length,
      mismatchCount: groups.mismatch.length,
      present: groups.present,
      missing: groups.missing,
      mismatch: groups.mismatch,
      feedback: audit?.feedback || null,
      lookup: audit?.lookup || null,
    },
    writeReport: writeReport || null,
    technicalDiagnostics: technicalDiagnostics || null,
    rawResult: result || null,
  });
}

function buildYapDiagnosticClipboardText(snapshot) {
  const practice = snapshot?.practice || {};
  const outcome = snapshot?.outcome || {};
  const audit = snapshot?.audit || {};
  const technical = snapshot?.technicalDiagnostics || {};
  const lines = [
    'Diagnostica YAP',
    `Pratica: ${practice.id || '-'} | targa: ${practice.plate || '-'} | tipo: ${practice.practiceType || '-'}`,
    `Cliente: ${practice.customer || '-'} | telefono: ${practice.phone || '-'}`,
    `Appuntamento: ${practice.appointmentDate || '-'} ${practice.appointmentTime || ''}`.trim(),
    `Stato: ${outcome.status || '-'} | codice: ${outcome.errorCode || '-'} | causa: ${outcome.statusReason || '-'}`,
    `Messaggio: ${outcome.message || '-'}`,
    `Azione consigliata: ${outcome.nextAction || '-'}`,
    '',
    'Checklist',
    ...(Array.isArray(snapshot?.checklist) ? snapshot.checklist.map((item) => `- ${item.label}: ${item.value}`) : []),
    '',
    `Audit: presenti ${audit.presentCount || 0}, mancanti ${audit.missingCount || 0}, diversi ${audit.mismatchCount || 0}`,
  ];

  if (technical?.runner?.finished_at || technical?.failedPhase || technical?.workerPhases?.length) {
    lines.push(
      `Crash log: ts ${technical?.runner?.finished_at || '-'} | last_phase ${technical?.workerPhases?.length ? `${technical.workerPhases[technical.workerPhases.length - 1]?.phase || '?'}:${technical.workerPhases[technical.workerPhases.length - 1]?.status || '?'}` : (technical?.failedPhase || '-')}`,
    );
  }

  if (technical?.stdoutTail) {
    lines.push('', 'stdout tail', technical.stdoutTail);
  }
  if (technical?.stderrTail) {
    lines.push('', 'stderr tail', technical.stderrTail);
  }

  lines.push('', 'JSON', JSON.stringify(snapshot, null, 2));
  return lines.join('\n');
}

function buildWorkerLogLines(workerPhases) {
  const workerLog = Array.isArray(workerPhases) ? workerPhases : [];
  if (!workerLog.length) return '';
  const hidden = ['phase', 'status', 'elapsed_ms', 'delta_ms', 'ts', 'seq', 'run', 'event'];
  return workerLog.map((phase) => {
    const elapsed = typeof phase.elapsed_ms === 'number' ? `${(phase.elapsed_ms / 1000).toFixed(1)}s` : '';
    const delta = typeof phase.delta_ms === 'number' ? `+${phase.delta_ms}ms` : '';
    const extra = Object.entries(phase)
      .filter(([key, value]) => !hidden.includes(key) && value != null && value !== '')
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join(' ');
    return `${elapsed.padStart(6)} ${delta.padStart(8)}  ${phase.phase || '?'}:${phase.status || '?'}${extra ? `  ${extra}` : ''}`;
  }).join('\n');
}

function buildYapLogClipboardText({ technicalDiagnostics, workerPhases }) {
  const lines = ['Crash log YAP + Log worker'];
  if (technicalDiagnostics?.runner?.finished_at) {
    lines.push(`ts: ${technicalDiagnostics.runner.finished_at}`);
  }
  if (technicalDiagnostics?.runner?.script || technicalDiagnostics?.runner?.timeout_seconds) {
    lines.push(`script: ${technicalDiagnostics?.runner?.script || 'yap-worker.mjs'}${technicalDiagnostics?.runner?.timeout_seconds ? ` timeout: ${technicalDiagnostics.runner.timeout_seconds}s` : ''}`);
  }
  if (technicalDiagnostics?.workerPhases?.length) {
    const last = technicalDiagnostics.workerPhases[technicalDiagnostics.workerPhases.length - 1];
    lines.push(`last_phase: ${last?.phase || '?'}:${last?.status || '?'}`);
    lines.push(`phases: ${summarizeWorkerPhases(technicalDiagnostics.workerPhases)}`);
  } else if (technicalDiagnostics?.failedPhase) {
    lines.push(`last_phase: ${technicalDiagnostics.failedPhase}`);
  }
  const workerLogText = buildWorkerLogLines(workerPhases || technicalDiagnostics?.workerPhases || []);
  if (workerLogText) {
    lines.push('', 'worker log', workerLogText);
  }
  if (technicalDiagnostics?.stdoutTail) {
    lines.push('', 'stdout tail', technicalDiagnostics.stdoutTail);
  }
  if (technicalDiagnostics?.stderrTail) {
    lines.push('', 'stderr tail', technicalDiagnostics.stderrTail);
  }
  return lines.join('\n');
}

function formatYapStatusReason(reason) {
  const normalized = String(reason || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'audit_deferred') return 'verifica automatica non conclusa';
  if (normalized === 'appointment_not_verified') return 'appuntamento non verificato';
  if (normalized === 'audit_not_completed') return 'audit non completato';
  if (normalized === 'post_write_review_needed') return 'alcuni campi post-scrittura sono da ricontrollare';
  if (normalized.startsWith('strict_mismatch_missing_')) return 'alcuni campi non coincidono con l’atteso';
  if (normalized === 'strict_match_complete') return 'verifica completa riuscita';
  return normalized.replaceAll('_', ' ');
}

function formatYapWriteReportIssue(fieldLabel, errorCode) {
  const field = String(fieldLabel || '').trim().toLowerCase();
  const error = String(errorCode || '').trim().toLowerCase();
  if (!field && !error) return '';
  if (error === 'notes_field_not_found') return 'note da ricontrollare';
  if (error === 'odl_tab_not_found') return 'ODL da ricontrollare';
  if (error === 'odl_route_ineffective') return 'ODL da ricontrollare';
  if (error === 'odl_unavailable_no_vehicle') return 'ODL non disponibile';
  if (error === 'materials_field_not_found') return 'materiali da ricontrollare';
  if (error === 'parts_field_not_found') return 'ricambi da ricontrollare';
  if (error === 'waste_field_not_found') return 'smaltimento da ricontrollare';
  if (error === 'man_field_not_found') return 'MAN da ricontrollare';
  if (error === 'mac_field_not_found') return 'MAC da ricontrollare';
  if (error.endsWith('_field_not_found')) return `${field || 'campo'} da ricontrollare`;
  return field || error;
}

function isAgendaOnlyYapSync(result) {
  const scope = getYapSyncScope(result);
  if (!scope) return false;
  return scope.mode === 'agenda_only' || scope.complete === false || scope.partial === true || scope.full === false;
}

function formatYapPracticeStatus(practice) {
  const status = String(practice?.management_sync_status || '').trim();
  if (status === 'complete_synced') return 'Completa';
  if (status === 'partial_synced') return 'Parziale';
  if (status === 'agenda_synced') return 'Agenda scritta (verifica incompleta)';
  if (status === 'sync_failed') return 'Sync YAP fallita';
  if (status === 'deleted') return 'Appuntamento eliminato da YAP';
  if (status === 'blocked_by_odl') return 'Eliminazione bloccata da ODL';
  if (status === 'blocked_by_preventivo') return 'Eliminazione bloccata da preventivo';
  if (status === 'duplicate') return 'Agenda già presente in YAP';
  if (status === 'not_ready') return 'Pratica non pronta per YAP';
  if (status === 'not_found') return 'Appuntamento già assente su YAP';
  if (status) return status;
  return practice?.synced ? 'Sincronizzata' : 'Non sincronizzata';
}

function getYapSyncUiTone(practice) {
  const status = String(practice?.management_sync_status || '').trim();
  if (status === 'sync_failed') return 'error';
  if (status === 'complete_synced') return 'success';
  if (status === 'partial_synced' || status === 'agenda_synced' || status === 'duplicate' || status === 'not_ready') {
    return 'warning';
  }
  if (status === 'deleted' || status === 'not_found') return 'success';
  return practice?.synced ? 'success' : 'error';
}

function getYapSyncDotClass(practice) {
  const tone = getYapSyncUiTone(practice);
  if (tone === 'success') return 'sync-dot-green';
  if (tone === 'warning') return 'sync-dot-warning';
  return 'sync-dot-red';
}

function getYapSyncPillClass(practice) {
  const tone = getYapSyncUiTone(practice);
  if (tone === 'success') return 'sync-pill-green';
  if (tone === 'warning') return 'sync-pill-warning';
  return 'sync-pill-red';
}

function getYapDetailToggleClass(practice) {
  const tone = getYapSyncUiTone(practice);
  if (tone === 'warning') return 'partial-synced';
  return tone === 'error' ? 'not-synced' : 'synced';
}

function getYapOverviewSyncButtonLabel(practice, isLoading) {
  if (isLoading) return 'Sync in corso...';
  const status = String(practice?.management_sync_status || '').trim();
  if (status === 'sync_failed') return 'Riprova sync YAP';
  if (['partial_synced', 'agenda_synced', 'complete_synced', 'duplicate'].includes(status)) return 'Risincronizza YAP';
  return practice?.synced ? 'Risincronizza YAP' : 'Sincronizza con YAP';
}

/** Format date to DD/MM/YYYY */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateForBackend(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const YAP_APPOINTMENT_MIN_TIME = '08:00';
const YAP_APPOINTMENT_MAX_TIME = '18:00';
const MINI_APP_TIME_STEP_MINUTES = 20;

function timeToMinutes(time) {
  const match = String(time || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinutesAsTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function clampAppointmentTimeToYapRange(time, fallback = YAP_APPOINTMENT_MIN_TIME) {
  const minMinutes = timeToMinutes(YAP_APPOINTMENT_MIN_TIME);
  const maxMinutes = timeToMinutes(YAP_APPOINTMENT_MAX_TIME);
  const rawMinutes = timeToMinutes(time);
  if (rawMinutes == null || minMinutes == null || maxMinutes == null) return fallback;
  const roundedMinutes = Math.round(rawMinutes / MINI_APP_TIME_STEP_MINUTES) * MINI_APP_TIME_STEP_MINUTES;
  const clampedMinutes = Math.min(Math.max(roundedMinutes, minMinutes), maxMinutes);
  return formatMinutesAsTime(clampedMinutes);
}

/** Opzioni orario nella fascia YAP, ogni 20 min. */
function buildAppointmentTimeOptions() {
  const options = [];
  const startMinutes = timeToMinutes(YAP_APPOINTMENT_MIN_TIME);
  const endMinutes = timeToMinutes(YAP_APPOINTMENT_MAX_TIME);
  for (let minutes = startMinutes; minutes <= endMinutes; minutes += MINI_APP_TIME_STEP_MINUTES) {
    options.push(formatMinutesAsTime(minutes));
  }
  return options;
}

const APPOINTMENT_TIME_OPTIONS = buildAppointmentTimeOptions();

/** Ora attuale arrotondata allo step mini-app e bloccata nella fascia YAP. */
function nowRoundedToSlot() {
  const d = new Date();
  const m = Math.floor(d.getMinutes() / MINI_APP_TIME_STEP_MINUTES) * MINI_APP_TIME_STEP_MINUTES;
  return clampAppointmentTimeToYapRange(`${String(d.getHours()).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
}

function addMinutesToTime(time, minutes) {
  const [h, m] = String(time || '00:00').split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const RANDOM_CONTEXTS = ['officina', 'carrozzeria', 'revisione'];
const RANDOM_FIRST_NAMES = ['Andrea', 'Luca', 'Marco', 'Giulia', 'Sara', 'Elena', 'Paolo', 'Marta', 'Davide', 'Francesca'];
const RANDOM_LAST_NAMES = ['Rossi', 'Bianchi', 'Ferrari', 'Esposito', 'Romano', 'Gallo', 'Bruno', 'Marino', 'Greco', 'Conti'];
const RANDOM_COMPANIES = ['Autofficina Delta Srl', 'Car Service Nova', 'Futura Garage', 'Nord Pneumatici', 'Linea Motori Srl'];
const RANDOM_INTERNAL_NOTES = [
  'Test casuale completo',
  'Pratica generata per stress test',
  'Controllare coerenza dati',
  'Scenario random multi-flusso',
  'Bozza generata automaticamente',
];
const RANDOM_OFFICINA_ROWS = [
  'Tagliando completo',
  'Cambio filtri',
  'Controllo freni',
  'Diagnosi elettronica',
  'Verifica fluidi',
  'Sostituzione batteria',
];
const RANDOM_CARROZZERIA_ROWS = [
  'Ripristino paraurti',
  'Lucidatura zona riparata',
  'Verniciatura parziale',
  'Rimozione graffi',
  'Allineamento pannello',
  'Controllo finitura',
];
const RANDOM_OFFICINA_PARTS = [
  'Filtro olio',
  'Olio motore 5W30',
  'Pastiglie freno',
  'Filtro aria',
  'Candela accensione',
  'Batteria 60Ah',
];
const RANDOM_CARROZZERIA_PARTS = [
  'Primer',
  'Stucco',
  'Vernice base',
  'Trasparente',
  'Nastro mascheratura',
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(items) {
  return items[randomInt(0, items.length - 1)];
}

function randomSubset(items, minCount = 1, maxCount = items.length) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const target = randomInt(minCount, Math.min(maxCount, pool.length));
  return pool.slice(0, target);
}

function isEmptyFormValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Date) return Number.isNaN(value.getTime());
  return false;
}

function randomPlate() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const pick = (source, count) => Array.from({ length: count }, () => source[randomInt(0, source.length - 1)]).join('');
  return `${pick(letters, 2)}${pick(digits, 3)}${pick(letters, 2)}`;
}

function randomPhone() {
  return `+39${randomInt(320, 399)}${randomInt(1000000, 9999999)}`;
}

function randomDateInNovember2026() {
  const day = randomInt(1, 28);
  return new Date(2026, 10, day, 12, 0, 0);
}

function randomPartQuantity() {
  return `${randomInt(1, 4)} ${randomChoice(['pz', 'set', 'cf', 'L'])}`;
}

function randomSectionPayload(context) {
  const contextConfig = {
    officina: {
      rows: RANDOM_OFFICINA_ROWS,
      manHours: [0.5, 6],
      macHours: null,
      materialsMin: 20,
      materialsMax: 320,
      wasteApply: false,
      parts: RANDOM_OFFICINA_PARTS,
    },
    carrozzeria: {
      rows: RANDOM_CARROZZERIA_ROWS,
      manHours: [0.5, 4],
      macHours: [0.5, 5],
      materialsMin: 40,
      materialsMax: 450,
      wasteApply: true,
      parts: RANDOM_CARROZZERIA_PARTS,
    },
    revisione: {
      // La revisione NON ha righe nel preventivo (solo il tag): niente righe/ore/ricambi.
      rows: [],
      manHours: null,
      macHours: null,
      materialsMin: null,
      materialsMax: null,
      wasteApply: false,
      parts: [],
    },
  }[context];

  const descriptionRows = contextConfig.rows.length
    ? randomSubset(contextConfig.rows, 1, Math.min(3, contextConfig.rows.length))
    : [];
  const manHours = contextConfig.manHours ? Number((Math.random() * (contextConfig.manHours[1] - contextConfig.manHours[0]) + contextConfig.manHours[0]).toFixed(1)) : null;
  const macHours = contextConfig.macHours
    ? Number((Math.random() * (contextConfig.macHours[1] - contextConfig.macHours[0]) + contextConfig.macHours[0]).toFixed(1))
    : null;
  const materialsAmount = contextConfig.materialsMin === null
    ? null
    : Number((Math.random() * (contextConfig.materialsMax - contextConfig.materialsMin) + contextConfig.materialsMin).toFixed(2));
  const wasteApply = context === 'carrozzeria' ? Math.random() < 0.7 : false;
  const wastePercentage = wasteApply ? Number((Math.random() * 8 + 2).toFixed(1)) : null;

  return {
    section: {
      context,
      description_rows: descriptionRows,
      man_hours: context === 'carrozzeria' ? null : manHours,
      mac_hours: macHours,
      materials_amount: materialsAmount,
      waste_apply: wasteApply,
      waste_percentage: wastePercentage,
      notes: `Scenario ${context} casuale`,
    },
    parts: contextConfig.parts.length
      ? randomSubset(contextConfig.parts, 1, Math.min(3, contextConfig.parts.length)).map((name) => ({
        context,
        name,
        quantity: randomPartQuantity(),
      }))
      : [],
  };
}

function buildRandomPracticeDraft() {
  const selectedContexts = randomSubset(RANDOM_CONTEXTS, 1, RANDOM_CONTEXTS.length);
  const customerType = Math.random() < 0.55 ? 'privato' : 'azienda';
  const billingToComplete = customerType === 'azienda' ? Math.random() < 0.5 : false;
  const isCompany = customerType === 'azienda';
  const customerName = isCompany
    ? randomChoice(RANDOM_COMPANIES)
    : `${randomChoice(RANDOM_FIRST_NAMES)} ${randomChoice(RANDOM_LAST_NAMES)}`;
  const appointmentDate = randomDateInNovember2026();
  const appointmentTime = randomChoice(APPOINTMENT_TIME_OPTIONS);
  const practiceType = Math.random() < 0.5 ? 'preventivo' : 'ordine_di_lavoro';
  const plateConfirmed = randomPlate();
  const phone = randomPhone();
  const internalNotes = `${randomChoice(RANDOM_INTERNAL_NOTES)} - ${selectedContexts.join(' + ')}`;

  const sectionEntries = selectedContexts.map((context) => randomSectionPayload(context));
  const sections = {};
  const parts = {};
  sectionEntries.forEach(({ section, parts: sectionParts }) => {
    sections[section.context] = section;
    if (sectionParts.length) parts[section.context] = sectionParts;
  });

  return {
    formData: {
      plate_confirmed: plateConfirmed,
      phone,
      customer_name: customerName,
      customer_type: customerType,
      billing_to_complete: billingToComplete,
      company_name: billingToComplete ? customerName : '',
      vat_number: billingToComplete ? `IT${randomInt(10000000000, 99999999999)}` : '',
      fiscal_code: billingToComplete ? `${randomChoice(RANDOM_LAST_NAMES).slice(0, 3).toUpperCase()}${randomChoice(RANDOM_FIRST_NAMES).slice(0, 3).toUpperCase()}80A01H501U` : '',
      billing_address: billingToComplete ? `Via ${randomChoice(['Roma', 'Milano', 'Torino', 'Napoli'])} ${randomInt(1, 99)}` : '',
      billing_city: billingToComplete ? randomChoice(['Milano', 'Roma', 'Torino', 'Bologna']) : '',
      billing_zip: billingToComplete ? String(randomInt(10000, 99999)) : '',
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
      practice_type: practiceType,
      internal_notes: internalNotes,
    },
    selectedContexts,
    sections,
    parts,
  };
}

// --- Sub-components ---

/** Toast notification */
function Toast({ toasts, removeToast }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.type} ${t.exiting ? 'toast-exit' : ''}`}
          onClick={() => removeToast(t.id)}
        >
          {t.type === 'success' ? '✅' : t.type === 'error' ? '❌' : '⚠️'} {t.message}
        </div>
      ))}
    </div>
  );
}

/** Custom confirmation modal */
function ConfirmModal({ title, message, onConfirm, onCancel }) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-content">
        <h3 id="modal-title">{title}</h3>
        <p>{message}</p>
        <div className="modal-actions">
          <button className="modal-cancel" onClick={onCancel} type="button">Annulla</button>
          <button className="modal-confirm" onClick={onConfirm} type="button">Conferma</button>
        </div>
      </div>
    </div>
  );
}

/** Lightbox for full-size photo */
function Lightbox({ src, onClose }) {
  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-content" onClick={e => e.stopPropagation()}>
        <button className="lightbox-close" onClick={onClose} type="button" aria-label="Chiudi foto">✕</button>
        <img src={src} alt="Foto pratica" className="lightbox-img" />
      </div>
    </div>
  );
}

/** Skeleton loading placeholder */
function SkeletonLoader() {
  return (
    <div className="container">
      <div className="skeleton skeleton-line" style={{ width: '50%', margin: '0 auto 20px' }} />
      {[1, 2, 3].map((i) => (
        <div key={i} className="skeleton-section">
          <div className="skeleton skeleton-line short" />
          <div className="skeleton skeleton-input" />
          <div className="skeleton skeleton-input" />
        </div>
      ))}
    </div>
  );
}

/** Dashboard skeleton */
function DashboardSkeleton() {
  return (
    <div className="container">
      <div className="stats-row">
        {[1, 2, 3].map(i => (
          <div key={i} className="stat-card skeleton-stat">
            <div className="skeleton skeleton-line" style={{ width: '40%', height: '24px' }} />
            <div className="skeleton skeleton-line" style={{ width: '70%', height: '12px', marginTop: '8px' }} />
          </div>
        ))}
      </div>
      <div className="skeleton skeleton-input" style={{ marginBottom: '12px' }} />
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="skeleton-section" style={{ marginBottom: '12px' }}>
          <div className="skeleton skeleton-line" style={{ width: '45%' }} />
          <div className="skeleton skeleton-line" style={{ width: '65%', marginTop: '8px' }} />
          <div className="skeleton skeleton-line short" style={{ marginTop: '8px' }} />
        </div>
      ))}
    </div>
  );
}

// Context badge colors
const CONTEXT_COLORS = {
  officina: { bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: 'rgba(59, 130, 246, 0.3)' },
  carrozzeria: { bg: 'rgba(251, 146, 60, 0.15)', color: '#fb923c', border: 'rgba(251, 146, 60, 0.3)' },
  revisione: { bg: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: 'rgba(74, 222, 128, 0.3)' },
};

// File upload constants
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Form fields that are actually sent to the backend
const FORM_FIELDS = [
  'plate_confirmed', 'phone', 'customer_name', 'customer_type', 'billing_to_complete',
  'company_name', 'vat_number', 'fiscal_code', 'billing_address', 'billing_city', 'billing_zip',
  'appointment_date', 'appointment_time', 'practice_type', 'internal_notes',
];

// Precompiled demo data used for fast QA testing in browser/Telegram preview
const DEMO_DRAFT = {
  plate_confirmed: 'AB123CD',
  phone: '3331234567',
  customer_name: 'Mario Rossi',
  customer_type: 'azienda',
  billing_to_complete: true,
  appointment_date: '2026-11-20',
  appointment_time: '09:20',
  practice_type: 'preventivo',
  internal_notes: 'Demo QA precompilata',
  company_name: 'Rossi SRL',
  vat_number: 'IT12345678901',
  fiscal_code: 'RSSMRA80A01H501U',
  billing_address: 'Via Roma 1',
  billing_city: 'Milano',
  billing_zip: '20100',
};

const DEMO_CONTEXTS = ['officina', 'carrozzeria', 'revisione'];

const DEMO_SECTIONS = {
  officina: {
    description_rows: ['Tagliando completo', 'Controllo freni'],
    man_hours: 2.5,
    mac_hours: '',
    materials_amount: '',
    waste_apply: false,
    waste_percentage: 2,
    notes: 'Demo officina',
  },
  carrozzeria: {
    description_rows: ['Ripristino paraurti', 'Lucidatura finale'],
    man_hours: '',
    mac_hours: 1.5,
    materials_amount: 120,
    waste_apply: true,
    waste_percentage: 7.5,
    notes: 'Demo carrozzeria',
  },
  revisione: {
    description_rows: ['Controllo pre-revisione'],
    man_hours: '',
    mac_hours: '',
    materials_amount: '',
    waste_apply: false,
    waste_percentage: 2,
    notes: 'Demo revisione',
  },
};

const DEMO_PARTS = {
  officina: [
    { name: 'Filtro olio', quantity: '1 pz' },
    { name: 'Pastiglie freno', quantity: '1 set' },
  ],
  carrozzeria: [
    { name: 'Stucco', quantity: '1 confezione' },
  ],
};

const DASHBOARD_DEMO_PRACTICES = [
  {
    practice: {
      plate_confirmed: 'GF456LM',
      phone: '3391122334',
      customer_name: 'Luca Bianchi',
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-23T09:00:00',
      appointment_time: '09:00',
      practice_type: 'preventivo',
      contexts: ['officina', 'revisione'],
      internal_notes: 'Pratica demo completa #1',
    },
    sections: [
      {
        context: 'officina',
        description_rows: ['Cambio olio e filtro', 'Controllo impianto frenante'],
        man_hours: 2,
        mac_hours: null,
        materials_amount: 85,
        waste_apply: true,
        waste_percentage: 4,
        notes: 'Cliente in attesa in sede',
      },
      {
        context: 'revisione',
        description_rows: ['Pre-check revisione ministeriale'],
        man_hours: 0.5,
        mac_hours: null,
        materials_amount: null,
        waste_apply: false,
        waste_percentage: 2,
        notes: 'Scadenza revisione tra 10 giorni',
      },
    ],
    parts: [
      { context: 'officina', name: 'Olio 5W30', quantity: '4 L' },
      { context: 'officina', name: 'Filtro olio', quantity: '1 pz' },
    ],
  },
  {
    practice: {
      plate_confirmed: 'ZT890PR',
      phone: '3479988776',
      customer_name: 'Autonoleggio Nord Srl',
      customer_type: 'azienda',
      billing_to_complete: false,
      appointment_date: '2026-11-25T14:30:00',
      appointment_time: '14:30',
      practice_type: 'ordine_di_lavoro',
      contexts: ['carrozzeria'],
      internal_notes: 'Pratica demo completa #2',
    },
    sections: [
      {
        context: 'carrozzeria',
        description_rows: ['Ripristino fiancata dx', 'Verniciatura parafango posteriore'],
        man_hours: 4,
        mac_hours: 1,
        materials_amount: 260,
        waste_apply: true,
        waste_percentage: 7.5,
        notes: 'Consegna prevista entro 48h',
      },
    ],
    parts: [
      { context: 'carrozzeria', name: 'Primer', quantity: '1 barattolo' },
      { context: 'carrozzeria', name: 'Trasparente', quantity: '1 kit' },
    ],
  },
  {
    practice: {
      plate_confirmed: 'ER321TY',
      phone: '3336655441',
      customer_name: 'Giulia Ferri',
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-26T11:00:00',
      appointment_time: '11:00',
      practice_type: 'preventivo',
      contexts: ['officina'],
      internal_notes: 'Pratica demo completa #3',
    },
    sections: [
      {
        context: 'officina',
        description_rows: ['Diagnosi rumore avantreno', 'Sostituzione testina sterzo'],
        man_hours: 2.5,
        mac_hours: null,
        materials_amount: 95,
        waste_apply: false,
        waste_percentage: 2,
        notes: 'Provare il veicolo prima della consegna',
      },
    ],
    parts: [
      { context: 'officina', name: 'Testina sterzo dx', quantity: '1 pz' },
    ],
  },
  {
    practice: {
      plate_confirmed: 'NM654KL',
      phone: '3494433221',
      customer_name: 'Studio Tecnico Verdi',
      customer_type: 'azienda',
      billing_to_complete: false,
      appointment_date: '2026-11-27T08:30:00',
      appointment_time: '08:30',
      practice_type: 'ordine_di_lavoro',
      contexts: ['revisione', 'officina'],
      internal_notes: 'Pratica demo completa #4',
    },
    sections: [
      {
        context: 'revisione',
        description_rows: ['Verifica impianto luci', 'Controllo emissioni preliminare'],
        man_hours: 1,
        mac_hours: null,
        materials_amount: null,
        waste_apply: false,
        waste_percentage: 2,
        notes: 'Documenti veicolo già verificati',
      },
      {
        context: 'officina',
        description_rows: ['Sostituzione lampada anabbagliante sx'],
        man_hours: 0.5,
        mac_hours: null,
        materials_amount: 18,
        waste_apply: false,
        waste_percentage: 2,
        notes: 'Ricambio disponibile in magazzino',
      },
    ],
    parts: [
      { context: 'officina', name: 'Lampada H7', quantity: '1 pz' },
    ],
  },
  {
    practice: {
      plate_confirmed: 'BC741QS',
      phone: '3357788991',
      customer_name: 'Elena Riva',
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-27T16:00:00',
      appointment_time: '16:00',
      practice_type: 'preventivo',
      contexts: ['carrozzeria'],
      internal_notes: 'Pratica demo completa #5',
    },
    sections: [
      {
        context: 'carrozzeria',
        description_rows: ['Rimozione graffi portiera posteriore sx', 'Lucidatura zona ripristinata'],
        man_hours: 1.5,
        mac_hours: 0.5,
        materials_amount: 75,
        waste_apply: true,
        waste_percentage: 5,
        notes: 'Cliente richiede finitura lucida',
      },
    ],
    parts: [],
  },
];

const YAP_TEST_BATCH_PRACTICES = [
  {
    practice: {
      plate_confirmed: 'CN401MV',
      phone: '3899885954',
      customer_name: 'Singh Gurwinder',
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-24T08:00:00',
      appointment_time: '08:00',
      practice_type: 'preventivo',
      contexts: ['officina'],
      internal_notes: 'TEST YAP BATCH 01 - officina preventivo',
    },
    sections: [
      {
        context: 'officina',
        description_rows: ['Tagliando completo', 'Verifica fluidi'],
        man_hours: 5.7,
        mac_hours: null,
        materials_amount: null,
        waste_apply: false,
        waste_percentage: 2,
        notes: 'Caso test officina preventivo',
      },
    ],
    parts: [
      { context: 'officina', name: 'Filtro olio', quantity: '1 cf' },
    ],
  },
  {
    practice: {
      plate_confirmed: 'CN401MV',
      phone: '3899885954',
      customer_name: 'Singh Gurwinder',
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-24T08:20:00',
      appointment_time: '08:20',
      practice_type: 'ordine_di_lavoro',
      contexts: ['officina'],
      internal_notes: 'TEST YAP BATCH 02 - officina odl',
    },
    sections: [
      {
        context: 'officina',
        description_rows: ['Diagnosi avantreno', 'Sostituzione testina sterzo'],
        man_hours: 2.5,
        mac_hours: null,
        materials_amount: null,
        waste_apply: false,
        waste_percentage: 2,
        notes: 'Caso test officina ODL',
      },
    ],
    parts: [
      { context: 'officina', name: 'Testina sterzo dx', quantity: '1 pz' },
    ],
  },
  {
    practice: {
      plate_confirmed: 'CN401MV',
      phone: '3899885954',
      customer_name: 'Singh Gurwinder',
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-24T08:40:00',
      appointment_time: '08:40',
      practice_type: 'preventivo',
      contexts: ['carrozzeria'],
      internal_notes: 'TEST YAP BATCH 03 - carrozzeria preventivo',
    },
    sections: [
      {
        context: 'carrozzeria',
        description_rows: ['Descr', 'Preparazione pannello'],
        man_hours: null,
        mac_hours: 0.8,
        materials_amount: 333.7,
        waste_apply: true,
        waste_percentage: 2,
        notes: 'Caso test carrozzeria preventivo con smaltimento',
      },
    ],
    parts: [
      { context: 'carrozzeria', name: 'Trasparente', quantity: '4 L' },
      { context: 'carrozzeria', name: 'Nastro mascheratura', quantity: '2 cf' },
    ],
  },
  {
    practice: {
      plate_confirmed: 'CN401MV',
      phone: '3899885954',
      customer_name: 'Singh Gurwinder',
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-24T09:00:00',
      appointment_time: '09:00',
      practice_type: 'ordine_di_lavoro',
      contexts: ['carrozzeria'],
      internal_notes: 'TEST YAP BATCH 04 - carrozzeria odl',
    },
    sections: [
      {
        context: 'carrozzeria',
        description_rows: ['Ripristino paraurti', 'Lucidatura finale'],
        man_hours: null,
        mac_hours: 1.2,
        materials_amount: 120,
        waste_apply: true,
        waste_percentage: 7.5,
        notes: 'Caso test carrozzeria ODL con smaltimento',
      },
    ],
    parts: [
      { context: 'carrozzeria', name: 'Stucco', quantity: '1 cf' },
      { context: 'carrozzeria', name: 'Primer', quantity: '1 cf' },
    ],
  },
  {
    practice: {
      plate_confirmed: 'CN401MV',
      phone: '3899885954',
      customer_name: 'Singh Gurwinder',
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-24T09:20:00',
      appointment_time: '09:20',
      practice_type: 'preventivo',
      contexts: ['officina', 'carrozzeria'],
      internal_notes: 'TEST YAP BATCH 05 - mix preventivo',
    },
    sections: [
      {
        context: 'officina',
        description_rows: ['Controllo freni'],
        man_hours: 1.5,
        mac_hours: null,
        materials_amount: null,
        waste_apply: false,
        waste_percentage: 2,
        notes: 'Mix preventivo - officina',
      },
      {
        context: 'carrozzeria',
        description_rows: ['Lucidatura zona riparata'],
        man_hours: null,
        mac_hours: 0.5,
        materials_amount: 80,
        waste_apply: true,
        waste_percentage: 5,
        notes: 'Mix preventivo - carrozzeria',
      },
    ],
    parts: [
      { context: 'officina', name: 'Pastiglie freno', quantity: '1 set' },
      { context: 'carrozzeria', name: 'Trasparente', quantity: '1 L' },
    ],
  },
  {
    practice: {
      plate_confirmed: 'CN401MV',
      phone: '3899885954',
      customer_name: 'Singh Gurwinder',
      customer_type: 'privato',
      billing_to_complete: false,
      appointment_date: '2026-11-24T09:40:00',
      appointment_time: '09:40',
      practice_type: 'ordine_di_lavoro',
      contexts: ['officina', 'carrozzeria'],
      internal_notes: 'TEST YAP BATCH 06 - mix odl',
    },
    sections: [
      {
        context: 'officina',
        description_rows: ['Diagnosi elettronica'],
        man_hours: 1,
        mac_hours: null,
        materials_amount: null,
        waste_apply: false,
        waste_percentage: 2,
        notes: 'Mix ODL - officina',
      },
      {
        context: 'carrozzeria',
        description_rows: ['Allineamento pannello'],
        man_hours: null,
        mac_hours: 0.7,
        materials_amount: 60,
        waste_apply: true,
        waste_percentage: 4,
        notes: 'Mix ODL - carrozzeria',
      },
    ],
    parts: [
      { context: 'officina', name: 'Batteria 60Ah', quantity: '1 pz' },
      { context: 'carrozzeria', name: 'Nastro mascheratura', quantity: '1 cf' },
    ],
  },
];

/** Normalize sections data: ensure description_rows is always an array */
const normalizeSections = (rawSections) => {
  if (!rawSections || !Array.isArray(rawSections)) return {};
  const result = {};
  rawSections.forEach(s => {
    result[s.context] = {
      ...s,
      description_rows: Array.isArray(s.description_rows)
        ? (s.description_rows.length > 0 ? s.description_rows : [''])
        : typeof s.description_rows === 'string'
          ? (s.description_rows.trim() ? s.description_rows.split('\n') : [''])
          : [''],
      man_hours: s.man_hours || '',
      mac_hours: s.mac_hours || '',
      materials_amount: s.materials_amount || '',
      waste_apply: s.waste_apply || false,
      waste_percentage: s.waste_percentage || 2,
      notes: s.notes || '',
    };
  });
  return result;
};

const normalizeContexts = (contexts) => {
  if (Array.isArray(contexts)) return contexts;
  if (typeof contexts === 'string') return contexts.split(',').map(c => c.trim()).filter(Boolean);
  return [];
};

const BROWSER_PREVIEW_PRACTICES = DASHBOARD_DEMO_PRACTICES.map((item, index) => {
  const id = `preview-${index + 1}`;
  return {
    id,
    ...item.practice,
    plate: item.practice.plate_confirmed,
    synced: false,
    status: 'preview',
    created_at: item.practice.appointment_date,
    sections: item.sections,
    parts: item.parts,
    photos: [],
    _preview: true,
  };
});

const buildPreviewPracticeItems = (items, prefix = 'preview-seed') => (
  (items || []).map((item, index) => ({
    id: `${prefix}-${index + 1}`,
    ...item.practice,
    plate: item.practice.plate_confirmed,
    synced: false,
    status: 'preview',
    created_at: item.practice.appointment_date,
    sections: item.sections,
    parts: item.parts,
    photos: [],
    _preview: true,
  }))
);

const buildPreviewStats = (items) => ({
  total: items.length,
  this_month: items.length,
  pending_sync: items.filter(p => !p.synced).length,
});

const buildPreviewPreSyncMap = (items) => {
  const map = {};
  items.forEach((p) => {
    const missing = [
      ['plate', p.plate_confirmed || p.plate],
      ['phone', p.phone],
      ['customer_name', p.customer_name],
      ['appointment_date', p.appointment_date],
      ['appointment_time', p.appointment_time],
      ['contexts', normalizeContexts(p.contexts).length],
    ].filter(([, value]) => !value);
    map[p.id] = {
      ready: missing.length === 0,
      score: Math.max(0, 100 - (missing.length * 18)),
      errors: missing.map(([field]) => ({ field, priority: 1, message: `${field} mancante` })),
    };
  });
  return map;
};

const filterPreviewPractices = (items, search = '', filters = {}) => {
  const query = (search || '').trim().toLowerCase();
  const contextFilters = Object.entries(filters)
    .filter(([k, v]) => v === true && k !== 'synced')
    .map(([k]) => k);

  return items.filter((p) => {
    if (filters.synced === true && !p.synced) return false;
    if (filters.synced === false && p.synced) return false;

    const contexts = normalizeContexts(p.contexts);
    if (contextFilters.length && !contextFilters.some(ctx => contexts.includes(ctx))) return false;

    if (!query) return true;
    const haystack = [
      p.plate,
      p.plate_confirmed,
      p.customer_name,
      p.phone,
      p.practice_type,
      p.internal_notes,
      ...contexts,
      ...(p.sections || []).flatMap(s => [s.context, s.notes, ...(s.description_rows || [])]),
      ...(p.parts || []).flatMap(part => [part.name, part.quantity]),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  });
};

const getDashboardDraftCard = (search = '', filters = {}) => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = getDraftStorage()?.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (!draft || typeof draft !== 'object') return null;

    const timestamp = Number(draft.timestamp || 0);
    if (!timestamp || Date.now() - timestamp > DRAFT_STORAGE_TTL_MS) {
      getDraftStorage()?.removeItem(DRAFT_STORAGE_KEY);
      return null;
    }

    const formData = draft.formData || {};
    const contexts = normalizeContexts(draft.selectedContexts || formData.contexts);
    const sections = draft.sections || {};
    const parts = draft.parts || {};

    const hasFormValue = Object.values(formData).some((value) => !isEmptyFormValue(value));
    const hasSectionValue = Object.values(sections).some((section) => {
      if (!section) return false;
      return [
        section.description_rows,
        section.man_hours,
        section.mac_hours,
        section.materials_amount,
        section.waste_apply,
        section.waste_percentage,
        section.notes,
      ].some((value) => !isEmptyFormValue(value));
    });
    const hasPartValue = Object.values(parts).some((items) =>
      Array.isArray(items) && items.some((item) => !isEmptyFormValue(item?.name) || !isEmptyFormValue(item?.quantity))
    );

    if (!hasFormValue && contexts.length === 0 && !hasSectionValue && !hasPartValue) return null;

    const draftCard = {
      id: 'local-draft',
      _localDraft: true,
      synced: false,
      status: 'local_draft',
      plate: formData.plate_confirmed || '',
      plate_confirmed: formData.plate_confirmed || '',
      customer_name: formData.customer_name || '',
      phone: formData.phone || '',
      practice_type: formData.practice_type || '',
      internal_notes: formData.internal_notes || '',
      appointment_date: formData.appointment_date || null,
      appointment_time: formData.appointment_time ? clampAppointmentTimeToYapRange(formData.appointment_time) : '',
      contexts,
      created_at: new Date(timestamp).toISOString(),
      _sectionsForSearch: Object.values(sections || {}),
      _partsForSearch: Object.values(parts || {}).flatMap((items) => (Array.isArray(items) ? items : [])),
    };

    if (filters.synced === true) return null;
    if (filters.synced === false && draftCard.synced) return null;

    const contextFilters = Object.entries(filters)
      .filter(([k, v]) => v === true && k !== 'synced')
      .map(([k]) => k);
    if (contextFilters.length && !contextFilters.some((ctx) => draftCard.contexts.includes(ctx))) return null;

    const query = (search || '').trim().toLowerCase();
    if (!query) return draftCard;

    const haystack = [
      draftCard.plate,
      draftCard.plate_confirmed,
      draftCard.customer_name,
      draftCard.phone,
      draftCard.practice_type,
      draftCard.internal_notes,
      ...draftCard.contexts,
      ...draftCard._sectionsForSearch.flatMap((s) => [s?.context, s?.notes, ...(s?.description_rows || [])]),
      ...draftCard._partsForSearch.flatMap((part) => [part?.name, part?.quantity]),
    ].filter(Boolean).join(' ').toLowerCase();

    return haystack.includes(query) ? draftCard : null;
  } catch (_) {
    return null;
  }
};

const normalizeCompareText = (value) => String(value || '').trim().toLowerCase();
const normalizeComparePlate = (value) => String(value || '').replace(/[\s-]/g, '').toUpperCase();

function isDraftDuplicatedByPractice(draftCard, practice) {
  if (!draftCard || !practice) return false;
  const draftPlate = normalizeComparePlate(draftCard.plate_confirmed || draftCard.plate);
  const practicePlate = normalizeComparePlate(practice.plate_confirmed || practice.plate);
  if (draftPlate && practicePlate && draftPlate === practicePlate) return true;

  const draftCustomer = normalizeCompareText(draftCard.customer_name);
  const practiceCustomer = normalizeCompareText(practice.customer_name);
  const draftPhone = normalizeCompareText(draftCard.phone);
  const practicePhone = normalizeCompareText(practice.phone);

  if (!draftCustomer || !practiceCustomer || draftCustomer !== practiceCustomer) return false;
  if (draftPhone && practicePhone && draftPhone === practicePhone) return true;

  const draftContexts = normalizeContexts(draftCard.contexts);
  const practiceContexts = normalizeContexts(practice.contexts);
  return draftContexts.some((ctx) => practiceContexts.includes(ctx));
}

const buildPreviewDetail = (p) => {
  const { sections = [], parts = [], photos = [], ...practice } = p;
  return { practice, sections, parts, photos };
};

const extractTelegramInitDataFromLocation = () => {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const fromSearch = searchParams.get('tgWebAppData');
    if (fromSearch) return fromSearch;

    const hashRaw = window.location.hash?.startsWith('#') ? window.location.hash.slice(1) : (window.location.hash || '');
    const hashParams = new URLSearchParams(hashRaw);
    const fromHash = hashParams.get('tgWebAppData');
    if (fromHash) return fromHash;
  } catch (_) {
    // no-op
  }
  return '';
};

const extractTelegramUserIdFromLocation = () => {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const fromSearch = searchParams.get('user_id');
    if (fromSearch) return fromSearch;

    const hashRaw = window.location.hash?.startsWith('#') ? window.location.hash.slice(1) : (window.location.hash || '');
    const hashParams = new URLSearchParams(hashRaw);
    const fromHash = hashParams.get('user_id');
    if (fromHash) return fromHash;
  } catch (_) {
    // no-op
  }
  return '';
};

const extractTelegramUserIdFromRuntime = () => {
  try {
    const runtimeId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    if (runtimeId !== undefined && runtimeId !== null && String(runtimeId).trim()) {
      return String(runtimeId).trim();
    }
  } catch (_) {
    // no-op
  }
  return '';
};

const extractPracticeAccessTokenFromLocation = () => {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const fromSearch = searchParams.get('access_token');
    if (fromSearch) return fromSearch;

    const hashRaw = window.location.hash?.startsWith('#') ? window.location.hash.slice(1) : (window.location.hash || '');
    const hashParams = new URLSearchParams(hashRaw);
    const fromHash = hashParams.get('access_token');
    if (fromHash) return fromHash;
  } catch (_) {
    // no-op
  }
  return '';
};

const stripSensitiveAuthParamsFromUrl = () => {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    let changed = false;
    ['access_token', 'tgWebAppData'].forEach((key) => {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    });

    const hashRaw = url.hash?.startsWith('#') ? url.hash.slice(1) : (url.hash || '');
    if (hashRaw) {
      const hashParams = new URLSearchParams(hashRaw);
      ['access_token', 'tgWebAppData'].forEach((key) => {
        if (hashParams.has(key)) {
          hashParams.delete(key);
          changed = true;
        }
      });
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : '';
    }

    if (changed) {
      window.history.replaceState(null, document.title, `${url.pathname}${url.search}${url.hash}`);
    }
  } catch (_) {
    // no-op
  }
};

const isDebugUiEnabled = () => (
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug_ui') === '1'
);

const SENSITIVE_DIAGNOSTIC_KEYS = ['authorization', 'cookie', 'initdata', 'password', 'secret', 'tgwebappdata', 'token'];

function isSafeDiagnosticMetadataKey(normalizedKey) {
  const isAuthMetadata = normalizedKey.includes('initdata') || normalizedKey.includes('token');
  return isAuthMetadata
    && (
      normalizedKey.endsWith('present')
      || normalizedKey.endsWith('length')
      || normalizedKey.endsWith('hash')
    );
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/(access_token|authorization|hash|initData|secret|tgWebAppData|token)=([^&#\s]+)/gi, '$1=[redacted]')
    .slice(0, 2000);
}

function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 25).map((item) => sanitizeDiagnosticValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, item]) => {
      const normalizedKey = String(key).toLowerCase().replace(/[_-]/g, '');
      acc[key] = !isSafeDiagnosticMetadataKey(normalizedKey)
        && SENSITIVE_DIAGNOSTIC_KEYS.some((marker) => normalizedKey.includes(marker))
        ? '[redacted]'
        : sanitizeDiagnosticValue(item, depth + 1);
      return acc;
    }, {});
  }
  if (typeof value === 'string') return redactSensitiveText(value);
  return value;
}

function buildClientDebugSnapshot({
  authMode,
  browserPreviewMode,
  errorMessage,
  initData,
  telegramUserId,
  practiceAccessToken,
  lastApiDebug,
}) {
  const location = typeof window !== 'undefined' ? window.location : {};
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const webApp = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;

  return sanitizeDiagnosticValue({
    createdAt: new Date().toISOString(),
    apiBaseUrl: API_BASE_URL,
    authMode,
    browserPreviewMode,
    errorMessage: errorMessage || '',
    initDataPresent: Boolean(initData),
    initDataLength: initData?.length || 0,
    initDataHasHash: Boolean(initData?.includes('hash=')),
    telegramUserId: telegramUserId || '',
    practiceAccessTokenPresent: Boolean(practiceAccessToken),
    practiceAccessTokenLength: practiceAccessToken?.length || 0,
    lastApiDebug,
    location: {
      href: location.href || '',
      search: location.search || '',
      hash: location.hash || '',
    },
    navigator: {
      onLine: nav.onLine,
      language: nav.language,
      userAgent: nav.userAgent,
    },
    telegram: {
      platform: webApp?.platform || '',
      version: webApp?.version || '',
      colorScheme: webApp?.colorScheme || '',
      viewportHeight: webApp?.viewportHeight || null,
      viewportStableHeight: webApp?.viewportStableHeight || null,
    },
    viewport: typeof window !== 'undefined' ? {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    } : {},
  });
}

function postClientDiagnostics(payload) {
  if (typeof window === 'undefined') return;
  try {
    const body = JSON.stringify(sanitizeDiagnosticValue(payload));
    fetch(`${API_BASE_URL}/client-diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: body.length < 60000,
    }).catch(() => {});
  } catch (_) {
    // Diagnostics must never break the user flow.
  }
}

function YapCrashLogButton({ initData, telegramUserId }) {
  const [loading, setLoading] = useState(false);
  const [crash, setCrash] = useState(null);
  const [err, setErr] = useState('');
  const load = async () => {
    setLoading(true); setErr(''); setCrash(null);
    try {
      const params = {};
      if (initData) params['init_data'] = initData;
      else if (telegramUserId) params['user_id'] = telegramUserId;
      const res = await fetch(`${API_BASE_URL}/yap/last-crash?${new URLSearchParams(params).toString()}`, {
        headers: initData ? { 'X-Telegram-Init-Data': initData } : {},
      });
      const json = await res.json();
      if (!json?.data?.found) { setErr('Nessun crash dump salvato.'); return; }
      setCrash(json.data);
    } catch (e) { setErr(String(e?.message || e)); }
    finally { setLoading(false); }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" className="debug-panel-action" onClick={load} disabled={loading}>
        {loading ? 'Caricamento...' : 'Crash log YAP'}
      </button>
      {err && <div className="debug-panel-line" style={{ color: '#f66' }}>{err}</div>}
      {crash && (
        <div style={{ marginTop: 6, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#111', color: '#eee', padding: 8, borderRadius: 4, maxHeight: 400, overflowY: 'auto' }}>
          <b>ts:</b> {crash.ts}{'\n'}
          <b>script:</b> {crash.script}  <b>timeout:</b> {crash.timeout_seconds}s{'\n'}
          <b>last_phase:</b> {crash.last_phase}{'\n'}
          <b>phases:</b> {crash.phase_summary}{'\n\n'}
          <b>stdout:</b>{'\n'}{crash.stdout || '(vuoto)'}{'\n\n'}
          <b>stderr:</b>{'\n'}{crash.stderr || '(vuoto)'}
        </div>
      )}
    </div>
  );
}

function DebugPanel({ authMode, browserPreviewMode, errorMessage, initData, telegramUserId, practiceAccessToken, lastApiDebug }) {
  const [copyStatus, setCopyStatus] = useState('');
  const payloadRef = useRef(null);
  const showDebugUi = isDebugUiEnabled() || Boolean(errorMessage) || lastApiDebug?.status === 'error';
  if (!showDebugUi) return null;

  const snapshot = buildClientDebugSnapshot({
    authMode,
    browserPreviewMode,
    errorMessage,
    initData,
    telegramUserId,
    practiceAccessToken,
    lastApiDebug,
  });
  const snapshotText = JSON.stringify(snapshot, null, 2);

  const copyDebug = async () => {
    try {
      await navigator.clipboard.writeText(snapshotText);
      setCopyStatus('copiato');
    } catch (_) {
      payloadRef.current?.focus();
      payloadRef.current?.select();
      setCopyStatus('testo selezionato: copia manualmente');
    }
  };

  return (
    <div className="debug-panel">
      <div className="debug-panel-title">Debug Sessione</div>
      {errorMessage && <div className="debug-panel-line">errore visibile: {errorMessage}</div>}
      <div className="debug-panel-line">apiBaseUrl: {API_BASE_URL}</div>
      <div className="debug-panel-line">authMode: {authMode}</div>
      <div className="debug-panel-line">initData presente: {initData ? 'si' : 'no'}</div>
      <div className="debug-panel-line">initData len: {initData?.length || 0}</div>
      <div className="debug-panel-line">initData hash=: {initData?.includes('hash=') ? 'si' : 'no'}</div>
      <div className="debug-panel-line">telegramUserId: {telegramUserId || '-'}</div>
      <div className="debug-panel-line">accessToken presente: {practiceAccessToken ? 'si' : 'no'}</div>
      <div className="debug-panel-line">accessToken len: {practiceAccessToken?.length || 0}</div>
      {lastApiDebug && (
        <>
          <div className="debug-panel-line">lastApi.label: {lastApiDebug.label || '-'}</div>
          <div className="debug-panel-line">lastApi.status: {lastApiDebug.status || '-'}</div>
          <div className="debug-panel-line">lastApi.method: {lastApiDebug.method || '-'}</div>
          <div className="debug-panel-line">lastApi.url: {lastApiDebug.url || '-'}</div>
          <div className="debug-panel-line">lastApi.params: {JSON.stringify(lastApiDebug.params || {})}</div>
          <div className="debug-panel-line">lastApi.headerKeys: {JSON.stringify(lastApiDebug.headerKeys || [])}</div>
          <div className="debug-panel-line">lastApi.error: {JSON.stringify(lastApiDebug.error || null)}</div>
          <div className="debug-panel-line">lastApi.timestamp: {lastApiDebug.timestamp || '-'}</div>
        </>
      )}
      <div className="debug-panel-actions">
        <button type="button" className="debug-panel-action" onClick={copyDebug}>Copia debug</button>
        {copyStatus && <span className="debug-panel-copy-status">{copyStatus}</span>}
      </div>
      <YapCrashLogButton initData={initData} telegramUserId={telegramUserId} />
      <textarea
        ref={payloadRef}
        className="debug-panel-payload"
        readOnly
        value={snapshotText}
        aria-label="Payload debug copiabile"
      />
    </div>
  );
}

// --- Main App ---

function App() {
  const standaloneBrowserMode = typeof window !== 'undefined' && !window.Telegram?.WebApp;
  const telegramRuntimeInitData = typeof window !== 'undefined' ? (window.Telegram?.WebApp?.initData || '') : '';
  const forcePreviewMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';
  const hasUrlAuth = Boolean(
    extractTelegramInitDataFromLocation()
    || extractTelegramUserIdFromLocation()
    || extractPracticeAccessTokenFromLocation()
  );
  const localDevRealApiMode = standaloneBrowserMode && isLocalDevHost() && !forcePreviewMode && Boolean(DEV_TELEGRAM_USER_ID);
  const browserPreviewMode = forcePreviewMode || (standaloneBrowserMode
    && !telegramRuntimeInitData
    && !hasUrlAuth
    && !localDevRealApiMode);

  // Navigation state
  const [currentView, setCurrentView] = useState('dashboard');
  const [selectedPracticeId, setSelectedPracticeId] = useState(null);
  const [editingPractice, setEditingPractice] = useState(null);
  const [navigationStack, setNavigationStack] = useState([]);

  // Shared state
  const [initData, setInitData] = useState('');
  const [telegramUserId, setTelegramUserId] = useState('');
  const [practiceAccessToken, setPracticeAccessToken] = useState('');
  const [lastApiDebug, setLastApiDebug] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [confirmModal, setConfirmModal] = useState(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  const [startedFromBot, setStartedFromBot] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Dashboard state
  const [practices, setPractices] = useState([]);
  const [stats, setStats] = useState({ total: 0, this_month: 0, pending_sync: 0 });
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardDraftCard, setDashboardDraftCard] = useState(null);
  const [preSyncByPractice, setPreSyncByPractice] = useState({});
  const [seedingDemoPractices, setSeedingDemoPractices] = useState(false);
  const [seedingYapTestPractices, setSeedingYapTestPractices] = useState(false);
  const [previewPractices, setPreviewPractices] = useState(BROWSER_PREVIEW_PRACTICES);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState({ officina: false, carrozzeria: false, revisione: false, synced: null });

  // Detail state
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState('overview');
  const [yapPreview, setYapPreview] = useState(null);
  const [yapPreviewLoading, setYapPreviewLoading] = useState(false);
  const [, setYapPreviewError] = useState('');
  const [yapLastPracticeId, setYapLastPracticeId] = useState(null);
  const [formYapPreview, setFormYapPreview] = useState(null);
  const [formYapPreviewLoading, setFormYapPreviewLoading] = useState(false);
  const formYapPreviewTimerRef = useRef(null);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);

  // Form state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [practice, setPractice] = useState(null);
  const [error, setError] = useState('');
  const [submitInProgress, setSubmitInProgress] = useState(false);
  const [saveProgress, setSaveProgress] = useState(null);

  const [showDraftBanner, setShowDraftBanner] = useState(false);
  const [slowRequest, setSlowRequest] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [selectedContexts, setSelectedContexts] = useState([]);
  // Toggle "imposta data/ora manualmente": se OFF (default) non chiediamo data/ora
  // e usiamo oggi + ora attuale (il worker fa comunque da rete di sicurezza).
  const [scheduleManually, setScheduleManually] = useState(false);
  const [sections, setSections] = useState({});
  const [parts, setParts] = useState({});
  const [formPhotos, setFormPhotos] = useState([]);
  const [formPhotoUploadProgress, setFormPhotoUploadProgress] = useState('');
  const [existingPhotos, setExistingPhotos] = useState([]);
  const formFileInputRef = useRef(null);

  const slowTimerRef = useRef(null);
  const saveProgressTimerRef = useRef(null);
  const saveProgressClearTimerRef = useRef(null);
  const yapActionProgressTimerRef = useRef(null);
  const yapActionProgressClearTimerRef = useRef(null);
  const yapAbortControllerRef = useRef(null);
  const yapSyncRequestRef = useRef({ practiceId: null, promise: null });
  const auditYapAppointmentRef = useRef(null);
  const toastIdRef = useRef(0);
  const formRef = useRef(null);
  const searchTimerRef = useRef(null);
  const previewSeqRef = useRef(BROWSER_PREVIEW_PRACTICES.length + 1);
  const preSyncCacheRef = useRef(new Map());
  const detailCacheRef = useRef(new Map());
  const yapPreviewCacheRef = useRef(new Map());

  const { register, control, handleSubmit, setValue, watch, getValues, formState: { errors } } = useForm();
  const authMode = browserPreviewMode ? 'preview browser' : (initData ? 'initData' : (telegramUserId ? 'fallback user_id' : 'non autenticato'));
  const diagnosticsStateRef = useRef({});
  const showDeveloperUi = isDebugUiEnabled();

  // --- Draft persistence ---
  const persistDraft = useCallback(() => {
    try {
      if (saving || submitInProgress) return false;
      const data = getValues();
      const draft = { formData: data, selectedContexts, sections, parts, timestamp: Date.now(), practiceId: practice?.id || null };
      getDraftStorage()?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      return true;
    } catch (_) {
      return false;
    }
  }, [getValues, selectedContexts, sections, parts, practice, saving, submitInProgress]);

  const hasMeaningfulDraft = useCallback(() => {
    if (saving || submitInProgress) return false;
    const data = getValues();
    const formHasValue = Object.values(data || {}).some((value) => !isEmptyFormValue(value));
    const contextsHasValue = (selectedContexts || []).length > 0;
    const sectionsHasValue = Object.values(sections || {}).some((section) => {
      if (!section) return false;
      return [
        section.description_rows,
        section.man_hours,
        section.mac_hours,
        section.materials_amount,
        section.waste_apply,
        section.waste_percentage,
        section.notes,
      ].some((value) => !isEmptyFormValue(value));
    });
    const partsHasValue = Object.values(parts || {}).some((items) => Array.isArray(items) && items.some((item) => {
      if (!item) return false;
      return !isEmptyFormValue(item.name) || !isEmptyFormValue(item.quantity);
    })); 
    return formHasValue || contextsHasValue || sectionsHasValue || partsHasValue;
  }, [getValues, selectedContexts, sections, parts, saving, submitInProgress]);

  const stopSaveProgressTimers = useCallback(() => {
    if (saveProgressTimerRef.current) {
      clearInterval(saveProgressTimerRef.current);
      saveProgressTimerRef.current = null;
    }
    if (saveProgressClearTimerRef.current) {
      clearTimeout(saveProgressClearTimerRef.current);
      saveProgressClearTimerRef.current = null;
    }
  }, []);

  const startSaveProgress = useCallback((label, stage = 'save') => {
    stopSaveProgressTimers();
    const now = Date.now();
    setSaveProgress({
      label,
      stage,
      status: 'running',
      percent: 8,
      startedAt: now,
      stageStartedAt: now,
    });
    saveProgressTimerRef.current = setInterval(() => {
      setSaveProgress((current) => {
        if (!current || current.status !== 'running') return current;
        const caps = {
          validate: 18,
          save: 45,
          photos: 72,
          sync: 58,
        };
        const cap = caps[current.stage] ?? 92;
        const increment = current.percent < 20 ? 3.5 : current.percent < 60 ? 1.6 : 0.6;
        const nextPercent = current.stage === 'sync'
          ? current.percent
          : Math.min(cap, Number((current.percent + increment).toFixed(1)));
        const nextLabel = current.stage === 'sync'
          ? getYapProgressLabel('sync', current.stageStartedAt || current.startedAt, current.label)
          : current.label;
        if (nextPercent === current.percent && nextLabel === current.label) return current;
        return { ...current, percent: nextPercent, label: nextLabel };
      });
    }, 340);
  }, [stopSaveProgressTimers]);

  const updateSaveProgress = useCallback((patch) => {
    setSaveProgress((current) => {
      if (!current) return current;
      const stageChanged = patch.stage && patch.stage !== current.stage;
      return {
        ...current,
        ...patch,
        stageStartedAt: stageChanged ? Date.now() : current.stageStartedAt,
      };
    });
  }, []);

  const finishSaveProgress = useCallback((label, status = 'success', clearDelay = 1400) => {
    stopSaveProgressTimers();
    setSaveProgress((current) => {
      if (!current) return current;
      return {
        ...current,
        label: label || current.label,
        status,
        percent: 100,
      };
    });
    if (clearDelay > 0) {
      saveProgressClearTimerRef.current = setTimeout(() => {
        setSaveProgress((current) => {
          if (!current || current.status !== status) return current;
          return null;
        });
      }, clearDelay);
    }
  }, [stopSaveProgressTimers]);

  const stopYapActionProgressTimers = useCallback(() => {
    if (yapActionProgressTimerRef.current) {
      clearInterval(yapActionProgressTimerRef.current);
      yapActionProgressTimerRef.current = null;
    }
    if (yapActionProgressClearTimerRef.current) {
      clearTimeout(yapActionProgressClearTimerRef.current);
      yapActionProgressClearTimerRef.current = null;
    }
  }, []);

  const startYapActionProgress = useCallback((action, practiceId, label) => {
    stopYapActionProgressTimers();
    const now = Date.now();
    setYapActionProgress({
      action,
      practiceId,
      label,
      status: 'running',
      percent: 0,
      startedAt: now,
    });
    yapActionProgressTimerRef.current = setInterval(() => {
      setYapActionProgress((current) => {
        if (!current || current.status !== 'running') return current;
        const nextPercent = getYapProgressPercent(current.action, current.startedAt);
        const nextLabel = getYapProgressLabel(current.action, current.startedAt, current.label);
        if (nextPercent === current.percent && nextLabel === current.label) return current;
        return { ...current, percent: nextPercent, label: nextLabel };
      });
    }, 800);
  }, [stopYapActionProgressTimers]);

  const finishYapActionProgress = useCallback((label, status = 'success', clearDelay = 1400) => {
    stopYapActionProgressTimers();
    setYapActionProgress((current) => {
      if (!current) return current;
      return {
        ...current,
        label: label || current.label,
        status,
        percent: 100,
      };
    });
    const delay = clearDelay <= 0 ? 3500 : clearDelay;
    yapActionProgressClearTimerRef.current = setTimeout(() => {
      setYapActionProgress((current) => {
        if (!current || current.status !== status) return current;
        return null;
      });
    }, delay);
  }, [stopYapActionProgressTimers]);

  const updateYapActionProgress = useCallback((patch) => {
    setYapActionProgress((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const cancelYapAction = useCallback(() => {
    if (yapAbortControllerRef.current) {
      yapAbortControllerRef.current.abort();
      yapAbortControllerRef.current = null;
    }
    finishYapActionProgress('Operazione annullata.', 'error', 2000);
  }, [finishYapActionProgress]);

  const normalizeYapOutcome = useCallback((rawResult, options = {}) => (
    normalizeYapResult(rawResult, options)
  ), []);

  const getCacheValue = useCallback((storeRef, key) => {
    const entry = storeRef.current.get(String(key));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      storeRef.current.delete(String(key));
      return null;
    }
    return entry.value;
  }, []);

  const setCacheValue = useCallback((storeRef, key, value, ttlMs = CLIENT_CACHE_TTL_MS) => {
    storeRef.current.set(String(key), {
      value,
      expiresAt: Date.now() + Math.max(1000, ttlMs),
    });
  }, []);

  const invalidatePracticeCaches = useCallback((practiceId) => {
    const id = String(practiceId || '');
    if (!id) return;
    preSyncCacheRef.current.delete(id);
    detailCacheRef.current.delete(id);
    yapPreviewCacheRef.current.delete(id);
  }, []);

  const watchedValues = watch();

  const clearDraft = useCallback(() => {
    try { getDraftStorage()?.removeItem(DRAFT_STORAGE_KEY); } catch (_) {}
    setDashboardDraftCard(null);
  }, []);

  const restoreDraft = useCallback((targetPracticeId = null) => {
    try {
      const raw = getDraftStorage()?.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      if (Date.now() - draft.timestamp > DRAFT_STORAGE_TTL_MS) {
        getDraftStorage()?.removeItem(DRAFT_STORAGE_KEY);
        return false;
      }
      if (draft.practiceId !== targetPracticeId) {
        return false;
      }
      if (draft.formData) {
        if (draft.formData.appointment_date) setScheduleManually(true);
        Object.keys(draft.formData).forEach(key => {
          if (key === 'appointment_date' && draft.formData[key]) {
            setValue(key, new Date(draft.formData[key]));
          } else if (key === 'appointment_time' && draft.formData[key]) {
            setValue(key, clampAppointmentTimeToYapRange(draft.formData[key]));
          } else {
            setValue(key, draft.formData[key]);
          }
        });
      }
      if (draft.selectedContexts) setSelectedContexts(draft.selectedContexts);
      if (draft.selectedContexts) setValue('contexts', draft.selectedContexts);
      if (draft.sections) {
        setSections(normalizeSections(
          Object.entries(draft.sections).map(([context, section]) => ({ context, ...section }))
        ));
      }
      if (draft.parts) setParts(draft.parts);
      return true;
    } catch (_) { return false; }
  }, [setValue]);

  // Event listener per persistere la bozza al cambio tab/chiusura pagina.
  // Separato dall'effect del debounce sotto per evitare di re-aggiungere/rimuovere
  // addEventListener ad ogni tasto premuto (watchedValues cambia ad ogni keystroke).
  useEffect(() => {
    if (currentView !== 'form' || loading || submitInProgress) return undefined;

    const persistDraftOnLeave = () => {
      if (hasMeaningfulDraft()) persistDraft();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && hasMeaningfulDraft()) persistDraft();
    };

    window.addEventListener('beforeunload', persistDraftOnLeave);
    window.addEventListener('pagehide', persistDraftOnLeave);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', persistDraftOnLeave);
      window.removeEventListener('pagehide', persistDraftOnLeave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentView, loading, submitInProgress, persistDraft, hasMeaningfulDraft]);

  // Debounce: persiste la bozza 250ms dopo ogni modifica al form.
  // watchedValues cambia ad ogni keystroke (react-hook-form), quindi questo effect
  // si triggera spesso — ma fa solo un setTimeout, niente DOM pesante.
  useEffect(() => {
    if (currentView !== 'form' || loading || submitInProgress) return undefined;
    const timer = setTimeout(() => {
      if (hasMeaningfulDraft()) persistDraft();
    }, 250);
    return () => clearTimeout(timer);
  }, [watchedValues, currentView, loading, submitInProgress, selectedContexts, sections, parts, persistDraft, hasMeaningfulDraft]);

  useEffect(() => () => {
    stopSaveProgressTimers();
    stopYapActionProgressTimers();
  }, [stopSaveProgressTimers, stopYapActionProgressTimers]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hiddenDebug = {
      authMode,
      browserPreviewMode,
      initDataPresent: Boolean(initData),
      initDataLength: initData?.length || 0,
      initDataHasHash: Boolean(initData?.includes('hash=')),
      telegramUserId: telegramUserId || '',
      practiceAccessTokenPresent: Boolean(practiceAccessToken),
      practiceAccessTokenLength: practiceAccessToken?.length || 0,
      search: window.location.search || '',
      hash: window.location.hash || '',
      lastApiDebug,
      updatedAt: new Date().toISOString(),
    };

    diagnosticsStateRef.current = {
      authMode,
      browserPreviewMode,
      initData,
      telegramUserId,
      practiceAccessToken,
      lastApiDebug,
      hiddenDebug,
    };
    window.__GIORGIO_DEBUG__ = hiddenDebug;
    try {
      sessionStorage.setItem('giorgio_hidden_debug', JSON.stringify(hiddenDebug));
    } catch (_) {
      // no-op
    }
  }, [authMode, browserPreviewMode, initData, telegramUserId, practiceAccessToken, lastApiDebug]);

  const rememberRequest = useCallback((label, { method = 'GET', url, params = {}, headers = {} } = {}) => {
    const previousApiDebug = diagnosticsStateRef.current?.lastApiDebug || null;
    const nextApiDebug = {
      ...(previousApiDebug || {}),
      timestamp: new Date().toISOString(),
      label,
      method,
      url,
      params,
      headerKeys: Object.keys(headers || {}),
      status: 'pending',
      error: null,
    };
    diagnosticsStateRef.current = { ...(diagnosticsStateRef.current || {}), lastApiDebug: nextApiDebug };
    setLastApiDebug(nextApiDebug);
  }, []);

  const rememberResponse = useCallback((label, extra = {}) => {
    const previousApiDebug = diagnosticsStateRef.current?.lastApiDebug || null;
    const nextApiDebug = {
      ...(previousApiDebug || {}),
      ...(previousApiDebug?.label === label ? {} : { label }),
      timestamp: new Date().toISOString(),
      status: 'ok',
      error: null,
      ...extra,
    };
    diagnosticsStateRef.current = { ...(diagnosticsStateRef.current || {}), lastApiDebug: nextApiDebug };
    setLastApiDebug(nextApiDebug);
  }, []);

  const rememberError = useCallback((label, err, extra = {}) => {
    const diagnosticState = diagnosticsStateRef.current || {};
    const previousApiDebug = diagnosticState.lastApiDebug?.label === label ? diagnosticState.lastApiDebug : {};
    const nextApiDebug = {
      ...(previousApiDebug || {}),
      ...(previousApiDebug?.label === label ? {} : { label }),
      timestamp: new Date().toISOString(),
      status: 'error',
      error: {
        message: err?.message || null,
        status: err?.response?.status || null,
        detail: err?.response?.data?.detail || null,
        code: err?.response?.data?.code || err?.code || null,
      },
      ...extra,
    };
    diagnosticsStateRef.current = { ...diagnosticState, lastApiDebug: nextApiDebug };
    setLastApiDebug(nextApiDebug);
    if (!diagnosticState.browserPreviewMode) {
      const message = classifyError(err);
      postClientDiagnostics({
        source: 'mini-app',
        severity: 'error',
        message,
        label,
        url: typeof window !== 'undefined' ? window.location.href : '',
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        telegram_user_id: diagnosticState.telegramUserId || '',
        api: nextApiDebug,
        context: {
          authMode: diagnosticState.authMode,
          online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        },
        snapshot: buildClientDebugSnapshot({
          authMode: diagnosticState.authMode,
          browserPreviewMode: diagnosticState.browserPreviewMode,
          errorMessage: message,
          initData: diagnosticState.initData,
          telegramUserId: diagnosticState.telegramUserId,
          practiceAccessToken: diagnosticState.practiceAccessToken,
          lastApiDebug: nextApiDebug,
        }),
      });
    }
  }, []);

  // --- Toast helpers ---
  const addToast = useCallback((message, type = 'success', duration = 4000) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type, exiting: false }]);
    setTimeout(() => {
      setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 350);
    }, type === 'error' ? 15000 : duration);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 350);
  }, []);

  // --- Navigation helpers ---
  const navigateTo = useCallback((view, opts = {}) => {
    setNavigationStack(prev => [...prev, currentView]);
    setCurrentView(view);
    if (opts.practiceId) setSelectedPracticeId(opts.practiceId);
    if (view === 'form') setLoading(false);
    if (opts.editingPractice) {
      setEditingPractice(opts.editingPractice);
      setPractice(opts.editingPractice);
    }
    if (opts.existingPhotos) setExistingPhotos(opts.existingPhotos);
  }, [currentView]);

  const navigateBack = useCallback(() => {
    if (currentView === 'form') {
      persistDraft();
    }
    const prev = navigationStack[navigationStack.length - 1] || 'dashboard';
    setNavigationStack(s => s.slice(0, -1));
    setCurrentView(prev);
    setSelectedPracticeId(null);
    setEditingPractice(null);
    // Reset form state when leaving form view
    setSelectedContexts([]);
    setSections({});
    setParts({});
    setFormPhotos([]);
    setExistingPhotos([]);
    setFormPhotoUploadProgress('');
    setPractice(null);
    setError('');
  }, [navigationStack, currentView, persistDraft]);

  const openDashboard = useCallback(() => {
    if (currentView === 'form' && !submitInProgress && hasMeaningfulDraft()) {
      persistDraft();
    }
    setCurrentView('dashboard');
    setNavigationStack([]);
    setSelectedPracticeId(null);
    setEditingPractice(null);
    setDetailData(null);
    setLoading(false);
  }, [persistDraft, currentView, submitInProgress, hasMeaningfulDraft]);

  // --- Telegram BackButton ---
  useEffect(() => {
    if (browserPreviewMode) return;
    if (!window.Telegram?.WebApp?.BackButton) return;
    const bb = window.Telegram.WebApp.BackButton;
    if (currentView === 'dashboard') {
      bb.hide();
    } else {
      bb.show();
      const handler = () => navigateBack();
      bb.onClick(handler);
      return () => bb.offClick(handler);
    }
  }, [browserPreviewMode, currentView, navigateBack]);

  // --- Telegram MainButton (fixed in-app CTA) ---
  useEffect(() => {
    if (browserPreviewMode) return;
    if (!window.Telegram?.WebApp?.MainButton) return;
    const mb = window.Telegram.WebApp.MainButton;
    const handler = () => openDashboard();

    mb.offClick(handler);
    if (currentView !== 'dashboard') {
      mb.setText('📋 Dashboard');
      mb.show();
      mb.onClick(handler);
    } else {
      mb.hide();
    }

    return () => mb.offClick(handler);
  }, [browserPreviewMode, currentView, openDashboard]);

  // --- Slow request indicator ---
  const startSlowTimer = useCallback(() => {
    slowTimerRef.current = setTimeout(() => setSlowRequest(true), 10000);
  }, []);
  const clearSlowTimer = useCallback(() => {
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    slowTimerRef.current = null;
    setSlowRequest(false);
  }, []);

  const applyDemoTemplate = useCallback(() => {
    setPractice(null);
    setEditingPractice(null);
    setStartedFromBot(false);
    setSubmitInProgress(false);
    setYapLastPracticeId(null);
    setYapLastResult(null);
    setError('');
    setShowDraftBanner(false);
    setFieldErrors({});
    setScheduleManually(true);
    setSelectedContexts([...DEMO_CONTEXTS]);
    setSections(normalizeSections(DEMO_CONTEXTS.map(context => ({ context, ...DEMO_SECTIONS[context] }))));
    setParts({
      officina: DEMO_PARTS.officina.map((part) => ({ ...part, _key: Date.now() + Math.random() })),
      carrozzeria: DEMO_PARTS.carrozzeria.map((part) => ({ ...part, _key: Date.now() + Math.random() })),
    });

    Object.entries(DEMO_DRAFT).forEach(([key, value]) => {
      if (key === 'appointment_date' && value) {
        setValue(key, new Date(`${value}T00:00:00`));
      } else {
        setValue(key, value);
      }
    });

    setLoading(false);
    setCurrentView('form');
  }, [setValue]);

  // --- API helpers ---
  const getHeaders = useCallback(() => {
    const headers = {};
    if (initData) headers['X-Telegram-Init-Data'] = initData;
    if (telegramUserId) headers['X-Telegram-User-Id'] = telegramUserId;
    return headers;
  }, [initData, telegramUserId]);

  const getAuthParams = useCallback(() => {
    const params = {};
    if (telegramUserId) params.user_id = telegramUserId;
    if (practiceAccessToken) params.access_token = practiceAccessToken;
    return params;
  }, [telegramUserId, practiceAccessToken]);

  const refreshDashboardDraftCard = useCallback((search = '', filters = {}, practiceItems = []) => {
    const draftCard = getDashboardDraftCard(search, filters);
    if (!draftCard) {
      setDashboardDraftCard(null);
      return;
    }
    const items = Array.isArray(practiceItems) ? practiceItems : [];
    const duplicated = items.some((practiceItem) => isDraftDuplicatedByPractice(draftCard, practiceItem));
    if (duplicated) {
      try { getDraftStorage()?.removeItem(DRAFT_STORAGE_KEY); } catch (_) {}
      setDashboardDraftCard(null);
      return;
    }
    setDashboardDraftCard(draftCard);
  }, []);

  const loadPreSyncChecks = useCallback(async (practiceItems) => {
    const list = Array.isArray(practiceItems) ? practiceItems : [];
    if (!list.length) {
      setPreSyncByPractice({});
      return;
    }
    const map = {};
    const missingIds = [];
    for (const item of list) {
      const cached = getCacheValue(preSyncCacheRef, item.id);
      if (cached) map[item.id] = cached;
      else missingIds.push(item.id);
    }

    if (missingIds.length) {
      try {
        const res = await axios.get(`${API_BASE_URL}/practices/pre-sync-check-batch`, {
          params: { ...getAuthParams(), ids: missingIds.join(',') },
          headers: getHeaders(),
          timeout: 12000,
        });
        const payload = res.data?.data || {};
        for (const [id, value] of Object.entries(payload)) {
          map[id] = value;
          setCacheValue(preSyncCacheRef, id, value);
        }
      } catch (_) {
        // keep partial cached map
      }
    }
    setPreSyncByPractice(map);
  }, [getAuthParams, getHeaders, getCacheValue, setCacheValue]);

  // --- Dashboard: Load practices ---
  const loadDashboard = useCallback(async (search = '', filters = {}) => {
    setDashboardLoading(true);
    if (browserPreviewMode) {
      const previewItems = filterPreviewPractices(previewPractices, search, filters);
      setPractices(previewItems);
      refreshDashboardDraftCard(search, filters, previewItems);
      setStats(buildPreviewStats(previewPractices));
      setPreSyncByPractice(buildPreviewPreSyncMap(previewItems));
      rememberResponse('dashboard.preview', {
        method: 'LOCAL',
        url: 'browser-preview',
        params: { search, filters },
      });
      setDashboardLoading(false);
      return;
    }

    try {
      const params = {};
      if (search) params.search = search;
      const contextFilters = Object.entries(filters).filter(([k, v]) => v === true && k !== 'synced').map(([k]) => k);
      if (contextFilters.length) params.context = contextFilters.join(',');
      if (filters.synced === true) params.synced = 'true';
      if (filters.synced === false) params.synced = 'false';
      params.sort = 'date_desc';
      Object.assign(params, getAuthParams());
      rememberRequest('dashboard.list', { method: 'GET', url: `${API_BASE_URL}/api/practices`, params, headers: getHeaders() });

      const [practicesRes, statsRes] = await Promise.all([
        fetchWithRetry(() => axios.get(`${API_BASE_URL}/api/practices`, { params, headers: getHeaders(), timeout: 15000 })),
        fetchWithRetry(() => axios.get(`${API_BASE_URL}/api/practices/stats`, { params: getAuthParams(), headers: getHeaders(), timeout: 15000 }))
      ]);

      const practiceItems = practicesRes.data?.data || practicesRes.data || [];
      setPractices(practiceItems);
      refreshDashboardDraftCard(search, filters, practiceItems);
      setStats(statsRes.data?.data || statsRes.data || { total: 0, this_month: 0, pending_sync: 0 });
      loadPreSyncChecks(practiceItems);
      rememberResponse('dashboard.list');
    } catch (err) {
      let diagnosticExtra = {};
      let errorMessage = classifyError(err);
      if (!err?.response) {
        const connectionProbe = await probeApiConnection();
        diagnosticExtra.connectionProbe = connectionProbe;
        if (connectionProbe.ok) {
          errorMessage = initData
            ? 'Backend raggiungibile, ma la richiesta della Mini App non e\' passata. Chiudi e riapri la Mini App dal bot.'
            : 'Backend raggiungibile, ma la richiesta del browser non e\' passata. Riprova o riapri la Mini App.';
        }
      }
      rememberError('dashboard.list', err, diagnosticExtra);
      addToast(errorMessage, 'error');
      refreshDashboardDraftCard(search, filters, []);
    } finally {
      setDashboardLoading(false);
    }
  }, [browserPreviewMode, previewPractices, getAuthParams, getHeaders, addToast, loadPreSyncChecks, refreshDashboardDraftCard, rememberRequest, rememberResponse, rememberError, initData]);

  const seedDemoPractices = useCallback(async () => {
    if (seedingDemoPractices) return;
    if (browserPreviewMode) {
      const resetItems = BROWSER_PREVIEW_PRACTICES;
      const visibleItems = filterPreviewPractices(resetItems, searchQuery, activeFilters);
      setPreviewPractices(resetItems);
      setPractices(visibleItems);
      setStats(buildPreviewStats(resetItems));
      setPreSyncByPractice(buildPreviewPreSyncMap(visibleItems));
      addToast('Preview ripristinata con pratiche demo locali', 'success');
      return;
    }

    setSeedingDemoPractices(true);
    try {
      await Promise.all(
        DASHBOARD_DEMO_PRACTICES.map((payload) =>
          fetchWithRetry(() =>
            axios.post(`${API_BASE_URL}/practices/full`, payload, {
              params: getAuthParams(),
              headers: getHeaders(),
              timeout: 30000,
            })
          )
        )
      );
      addToast(`Ho creato ${DASHBOARD_DEMO_PRACTICES.length} pratiche demo complete`, 'success');
      await loadDashboard(searchQuery, activeFilters);
    } catch (err) {
      addToast(classifyError(err), 'error');
    } finally {
      setSeedingDemoPractices(false);
    }
  }, [seedingDemoPractices, browserPreviewMode, getAuthParams, getHeaders, addToast, loadDashboard, searchQuery, activeFilters]);

  const seedYapTestPractices = useCallback(async () => {
    if (seedingYapTestPractices) return;
    if (browserPreviewMode) {
      const seededPreviewItems = buildPreviewPracticeItems(YAP_TEST_BATCH_PRACTICES, 'preview-yap-test');
      const visibleItems = filterPreviewPractices(seededPreviewItems, searchQuery, activeFilters);
      setPreviewPractices(seededPreviewItems);
      setPractices(visibleItems);
      setStats(buildPreviewStats(seededPreviewItems));
      setPreSyncByPractice(buildPreviewPreSyncMap(visibleItems));
      addToast(`Preview caricata con ${YAP_TEST_BATCH_PRACTICES.length} pratiche test YAP su CN401MV`, 'success');
      return;
    }

    setSeedingYapTestPractices(true);
    try {
      await Promise.all(
        YAP_TEST_BATCH_PRACTICES.map((payload) =>
          fetchWithRetry(() =>
            axios.post(`${API_BASE_URL}/practices/full`, payload, {
              params: getAuthParams(),
              headers: getHeaders(),
              timeout: 30000,
            })
          )
        )
      );
      addToast(`Ho creato ${YAP_TEST_BATCH_PRACTICES.length} pratiche test YAP per CN401MV`, 'success');
      await loadDashboard(searchQuery, activeFilters);
    } catch (err) {
      addToast(classifyError(err), 'error');
    } finally {
      setSeedingYapTestPractices(false);
    }
  }, [seedingYapTestPractices, browserPreviewMode, getAuthParams, getHeaders, addToast, loadDashboard, searchQuery, activeFilters]);

  // Load dashboard on view mount
  useEffect(() => {
    if (!bootstrapped) return;
    if (currentView === 'dashboard' && (initData || telegramUserId || standaloneBrowserMode || browserPreviewMode)) {
      loadDashboard(searchQuery, activeFilters);
    }
  }, [bootstrapped, currentView, initData, telegramUserId, standaloneBrowserMode, browserPreviewMode, loadDashboard, searchQuery, activeFilters]);

  // Debounced search
  useEffect(() => {
    if (!bootstrapped) return;
    if (currentView !== 'dashboard') return;
    if (!initData && !telegramUserId && !standaloneBrowserMode && !browserPreviewMode) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadDashboard(searchQuery, activeFilters);
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [bootstrapped, currentView, initData, telegramUserId, standaloneBrowserMode, browserPreviewMode, searchQuery, activeFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Detail: Load practice ---
  const loadDetail = useCallback(async (id) => {
    if (!id) return;
    const cachedDetail = getCacheValue(detailCacheRef, id);
    if (cachedDetail) {
      setDetailData(cachedDetail);
      setYapPreview(getCacheValue(yapPreviewCacheRef, id) || null);
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    setDetailData(null);
    setYapPreview(null);
    if (browserPreviewMode) {
      const previewPractice = previewPractices.find(p => String(p.id) === String(id));
      if (previewPractice) {
        setDetailData(buildPreviewDetail(previewPractice));
      } else {
        addToast('Pratica preview non trovata', 'error');
        navigateBack();
      }
      setDetailLoading(false);
      return;
    }

    try {
      rememberRequest('practice.detail', { method: 'GET', url: `${API_BASE_URL}/api/practices/${id}`, params: getAuthParams(), headers: getHeaders() });
      const res = await fetchWithRetry(() =>
        axios.get(`${API_BASE_URL}/api/practices/${id}`, { params: getAuthParams(), headers: getHeaders(), timeout: 15000 })
      );
      const detailPayload = res.data?.data || res.data;
      setDetailData(detailPayload);
      setCacheValue(detailCacheRef, id, detailPayload);
      rememberResponse('practice.detail');
    } catch (err) {
      rememberError('practice.detail', err);
      addToast(classifyError(err), 'error');
      navigateBack();
    } finally {
      setDetailLoading(false);
    }
  }, [browserPreviewMode, previewPractices, getAuthParams, getHeaders, addToast, navigateBack, getCacheValue, setCacheValue, rememberRequest, rememberResponse, rememberError]);

  const loadYapPreview = useCallback(async (id) => {
    if (!id || browserPreviewMode) return;
    const cachedPreview = getCacheValue(yapPreviewCacheRef, id);
    if (cachedPreview) {
      setYapPreview(cachedPreview);
      setYapPreviewError('');
      setYapPreviewLoading(false);
      return;
    }
    setYapPreviewError('');
    setYapPreviewLoading(true);
    try {
      rememberRequest('yap.preview', { method: 'GET', url: `${API_BASE_URL}/practices/${id}/yap-mapping-preview`, params: getAuthParams(), headers: getHeaders() });
      const yapRes = await fetchWithRetry(() =>
        axios.get(`${API_BASE_URL}/practices/${id}/yap-mapping-preview`, { params: getAuthParams(), headers: getHeaders(), timeout: 15000 })
      );
      const previewPayload = yapRes.data?.data || yapRes.data;
      setYapPreview(previewPayload);
      setYapPreviewError('');
      setCacheValue(yapPreviewCacheRef, id, previewPayload);
      rememberResponse('yap.preview');
    } catch (yapErr) {
      rememberError('yap.preview', yapErr);
      const previewErrorMessage = classifyError(yapErr) || 'Anteprima YAP non disponibile.';
      setYapPreview({ emptyMessage: previewErrorMessage });
      setYapPreviewError(previewErrorMessage);
    } finally {
      setYapPreviewLoading(false);
    }
  }, [browserPreviewMode, getAuthParams, getHeaders, getCacheValue, setCacheValue, rememberRequest, rememberResponse, rememberError]);

  useEffect(() => {
    if (currentView === 'detail' && selectedPracticeId) {
      const keepYapTab = detailTab === 'yap' && String(yapLastPracticeId || '') === String(selectedPracticeId);
      if (!keepYapTab) {
        setDetailTab('overview');
      }
      loadDetail(selectedPracticeId);
    }
  }, [currentView, selectedPracticeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (currentView === 'detail' && detailTab === 'yap' && selectedPracticeId) {
      loadYapPreview(selectedPracticeId);
    }
  }, [currentView, detailTab, selectedPracticeId, loadYapPreview]);

  // --- Form photo queue ---
  const addFormPhotos = useCallback((files) => {
    const validFiles = [];
    for (const file of files) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        addToast(`${file.name}: tipo non supportato.`, 'error');
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        addToast(`${file.name}: troppo grande (max 10MB).`, 'error');
        continue;
      }
      validFiles.push({ file, preview: URL.createObjectURL(file), id: Date.now() + Math.random() });
    }
    setFormPhotos(prev => [...prev, ...validFiles]);
  }, [addToast]);

  const removeFormPhoto = useCallback((id) => {
    setFormPhotos(prev => {
      const item = prev.find(p => p.id === id);
      if (item) URL.revokeObjectURL(item.preview);
      return prev.filter(p => p.id !== id);
    });
  }, []);

  const uploadQueuedPhotos = useCallback(async (practiceId, onProgress) => {
    if (formPhotos.length === 0) return;
    const currentTelegramUserId = telegramUserId;
    let successCount = 0;
    let failCount = 0;
    // Upload sequenziale intenzionale: permette il progress "foto N di M" preciso
    // e protegge da rate-limit lato server (Cloudinary). Non parallelizzare.
    for (let i = 0; i < formPhotos.length; i++) {
      setFormPhotoUploadProgress(`Caricamento foto ${i + 1}/${formPhotos.length}...`);
      if (onProgress) {
        const base = 30;
        const span = 28;
        const overall = base + (i / Math.max(1, formPhotos.length)) * span;
        onProgress({
          stage: 'photos',
          status: 'running',
          percent: Number(overall.toFixed(1)),
          label: `Caricamento foto ${i + 1}/${formPhotos.length}...`,
        });
      }
      try {
        const fd = new FormData();
        fd.append('file', formPhotos[i].file);
        const query = currentTelegramUserId ? `?user_id=${encodeURIComponent(currentTelegramUserId)}` : '';
        rememberRequest('photo.upload', {
          method: 'POST',
          url: `${API_BASE_URL}/api/practices/${practiceId}/photos`,
          params: currentTelegramUserId ? { user_id: currentTelegramUserId } : {},
          headers: {
            ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
            ...(currentTelegramUserId ? { 'X-Telegram-User-Id': currentTelegramUserId } : {}),
          }
        });
        const res = await fetch(`${API_BASE_URL}/api/practices/${practiceId}/photos${query}`, {
          method: 'POST',
          headers: {
            ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
            ...(currentTelegramUserId ? { 'X-Telegram-User-Id': currentTelegramUserId } : {}),
          },
          body: fd
        });
        if (res.ok) {
          successCount++;
          rememberResponse('photo.upload');
        } else {
          failCount++;
          rememberError('photo.upload', { message: `HTTP ${res.status}`, response: { status: res.status, data: { detail: `upload_failed_${res.status}` } } });
        }
        if (onProgress) {
          const progress = 30 + (((i + 1) / Math.max(1, formPhotos.length)) * 28);
          onProgress({
            stage: 'photos',
            status: 'running',
            percent: Number(progress.toFixed(1)),
            label: `Foto ${i + 1}/${formPhotos.length} inviata...`,
          });
        }
      } catch (err) {
        failCount++;
        rememberError('photo.upload', err);
        if (onProgress) {
          const progress = 30 + (((i + 1) / Math.max(1, formPhotos.length)) * 28);
          onProgress({
            stage: 'photos',
            status: 'running',
            percent: Number(progress.toFixed(1)),
            label: `Foto ${i + 1}/${formPhotos.length} processata...`,
          });
        }
      }
    }
    setFormPhotoUploadProgress('');
    if (onProgress) {
      onProgress({
        stage: 'photos',
        status: 'running',
        percent: 60,
        label: 'Caricamento foto completato',
      });
    }
    if (successCount > 0 && failCount > 0) {
      addToast(`${successCount} foto caricate, ${failCount} non caricate.`, 'warning');
    } else if (successCount > 0) {
      addToast(`${successCount} foto caricate con successo!`, 'success');
    } else if (failCount > 0) {
      addToast(`${failCount} foto non caricate.`, 'error');
    }
    // Cleanup previews
    formPhotos.forEach(p => URL.revokeObjectURL(p.preview));
    setFormPhotos([]);
  }, [formPhotos, initData, telegramUserId, addToast, rememberRequest, rememberResponse, rememberError]);

  // --- YAP Automation ---
  const [yapSyncLoading, setYapSyncLoading] = useState(false);
  const [yapDeleteLoading, setYapDeleteLoading] = useState(false);
  const [yapAuditLoading, setYapAuditLoading] = useState(false);
  const [yapLastResult, setYapLastResult] = useState(null);
  const [yapDiagnosticCopyStatus, setYapDiagnosticCopyStatus] = useState('');
  const [yapLogCopyStatus, setYapLogCopyStatus] = useState('');
  const [yapActionProgress, setYapActionProgress] = useState(null);

  // Recupero ONESTO dell'esito dopo una caduta di rete sul POST lungo di sync: il worker
  // gira ancora / ha finito e il backend ha gia' persistito l'esito (audit + worker log).
  // Pollo la pratica finche' compare un esito FRESCO (management_last_sync_at >= inizio
  // sync) e terminale, poi lo ricostruisco nel formato risultato (con log completo).
  const recoverPersistedSyncResult = useCallback(async (id, sinceMs) => {
    const deadline = Date.now() + 210000; // ~3.5 min (worker timeout ~230s)
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      let practice = null;
      try {
        const res = await axios.get(`${API_BASE_URL}/api/practices/${id}`, {
          params: getAuthParams(), headers: getHeaders(), timeout: 15000,
        });
        practice = res?.data?.data || res?.data || null;
      } catch (_) { continue; }
      if (!practice) continue;
      const lastSyncMs = practice.management_last_sync_at ? Date.parse(practice.management_last_sync_at) : 0;
      const status = String(practice.management_sync_status || '').toLowerCase();
      const terminal = ['complete_synced', 'partial_synced', 'agenda_synced', 'synced', 'duplicate', 'sync_failed'].includes(status);
      // -90s di tolleranza per skew di clock frontend/server.
      if (terminal && lastSyncMs && lastSyncMs >= sinceMs - 90000) {
        const base = normalizeYapResult({ status: practice.management_sync_status, practice }, {});
        return mergeYapResultWithPersistedAudit(base, practice);
      }
    }
    return null;
  }, [getAuthParams, getHeaders]);

  const syncToYap = useCallback(async (id, options = {}) => {
    const silent = options.silent || false;
    const apiOptions = { ...options };
    delete apiOptions.silent;
    const syncStartedAtMs = Date.now();
    const currentSync = yapSyncRequestRef.current;
    if (currentSync?.practiceId != null) {
      if (String(currentSync.practiceId || '') === String(id || '')) {
        if (!silent) addToast('Sync YAP gia in corso su questa pratica.', 'info');
        return { status: 'busy', message: 'Sync YAP gia in corso su questa pratica.' };
      }
      if (!silent) addToast('C e gia una sync YAP in corso. Attendi il completamento.', 'warning');
      return { status: 'busy', message: 'C e gia una sync YAP in corso. Attendi il completamento.' };
    }
    if (browserPreviewMode) {
      if (!silent) addToast('Anteprima: sync YAP simulato', 'success');
      setYapLastPracticeId(id);
      setYapLastResult({ status: 'synced', simulated: true, message: 'Sync simulata in anteprima browser.' });
      return { status: 'synced', simulated: true };
    }
    if (!silent) {
      startYapActionProgress('sync', id, 'Sincronizzazione YAP avviata. In attesa dell’esito reale dal server...');
    }
    yapSyncRequestRef.current = { practiceId: id, promise: true };
    setYapSyncLoading(true);
    setYapLastResult(null);
    setYapLastPracticeId(id);
    const abortController = new AbortController();
    yapAbortControllerRef.current = abortController;
    try {
      rememberRequest('yap.sync', { method: 'POST', url: `${API_BASE_URL}/practices/${id}/yap/sync`, params: getAuthParams(), headers: getHeaders() });
      // NON ritentare in automatico: la sync e' un POST non idempotente che apre il
      // browser e scrive su YAP. Il retry raddoppiava l'esecuzione ("appena finito, riparte").
      // 340s: worker sync (210s) + attesa lock YAP (fino a 100s). Con 240s la
      // richiesta abortiva durante la contesa del lock con un falso errore di rete.
      const res = await axios.post(`${API_BASE_URL}/practices/${id}/yap/sync`, apiOptions, { params: getAuthParams(), headers: getHeaders(), timeout: 340000, signal: abortController.signal });
      const data = normalizeYapOutcome(res.data?.data || {}, { dryRun: Boolean(apiOptions.dry_run) });
      setYapLastResult(data);
      rememberResponse('yap.sync');
      if (!silent) {
        const phaseLabel = workerPhasesToLabel(data.worker_phases)
          || summarizePhaseTimeline(data.phase_timeline, 'YAP: scrittura completata...');
        updateYapActionProgress({ percent: 100, label: phaseLabel });
      }
      if (['complete_synced', 'partial_synced', 'agenda_synced', 'synced', 'duplicate'].includes(data.status)) {
        invalidatePracticeCaches(id);
        if (!silent) {
          const tone = data.status === 'complete_synced'
            ? 'success'
            : (data.status === 'duplicate' ? 'info' : 'warning');
          addToast(data.status === 'duplicate'
            ? (data.message || 'Agenda già presente in YAP: nessuna modifica necessaria')
            : (data.message || 'Appuntamento salvato su YAP ✓ (verifica in corso...)'),
            tone);
        }
        loadDetail(id);
      } else if (data.status === 'dry_run') {
        if (!silent) addToast('Dry-run YAP completato: nessuna modifica eseguita', 'info');
      } else if (data.status === 'not_ready') {
        if (!silent) addToast('Pratica non pronta per sync YAP', 'warning');
      } else {
        if (!silent) addToast(data.message || `Sync YAP: ${data.status}`, 'info');
      }
      if (!silent) {
        const progressLabel = data.message || 'Sync YAP completata.';
        const progressStatus = data.status === 'sync_failed' ? 'error' : 'success';
        finishYapActionProgress(progressLabel, progressStatus, progressStatus === 'error' ? 0 : 1200);
      }
      return data;
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || err?.name === 'AbortError') {
        return { status: 'cancelled' };
      }
      rememberError('yap.sync', err);
      const detail = err?.response?.data?.detail || {};
      if (detail?.stderr_tail || detail?.worker_phases) {
        console.error('[YAP SYNC TIMEOUT DEBUG]',
          '\nphases:', JSON.stringify(detail.worker_phases || [], null, 2),
          '\nstderr_tail:\n', detail.stderr_tail || '');
      }
      // RETE CADUTA sul POST lungo: NON dichiarare un falso fallimento. Il worker quasi
      // sicuramente gira ancora / ha finito e il backend ha persistito l'esito completo
      // (audit + worker log). Lo recuperiamo in polling e mostriamo QUELLO.
      const isNetworkError = !err?.response
        && (err?.code === 'ERR_NETWORK' || err?.code === 'ECONNABORTED'
            || /network|timeout/i.test(String(err?.message || '')));
      if (isNetworkError) {
        if (!silent) updateYapActionProgress({ percent: 0, label: 'Risposta interrotta: operazione non conclusa lato app. Recupero dell’esito reale dal server...' });
        const recovered = await recoverPersistedSyncResult(id, syncStartedAtMs);
        if (recovered) {
          setYapLastResult(recovered);
          rememberResponse('yap.sync');
          invalidatePracticeCaches(id);
          loadDetail(id);
          const tone = recovered.status === 'complete_synced' ? 'success'
            : (recovered.status === 'sync_failed' ? 'error' : 'warning');
          if (!silent) addToast(recovered.message || 'Esito YAP recuperato dopo interruzione di rete.', tone);
          if (!silent) finishYapActionProgress(recovered.message || 'Esito YAP recuperato.', recovered.status === 'sync_failed' ? 'error' : 'success', 1200);
          return recovered;
        }
        // Non recuperato entro il timeout: messaggio onesto (niente "errore di rete" secco).
        const pending = buildYapErrorResult(err, 'sync_failed');
        pending.message = 'Rete interrotta durante il sync. Il worker potrebbe essere ancora in corso: attendi qualche secondo e premi "Verifica YAP".';
        setYapLastResult(pending);
        if (!silent) addToast(pending.message, 'warning');
        if (!silent) finishYapActionProgress(pending.message, 'error', 0);
        return pending;
      }

      const errorResult = buildYapErrorResult(err, 'sync_failed');
      setYapLastResult(errorResult);
      if (!silent) addToast(errorResult.message, 'error');
      if (!silent) finishYapActionProgress(errorResult.message || 'Sync YAP fallita', 'error', 0);
      return errorResult;
    } finally {
      yapAbortControllerRef.current = null;
      yapSyncRequestRef.current = { practiceId: null, promise: null };
      setYapSyncLoading(false);
    }
  }, [browserPreviewMode, getAuthParams, getHeaders, addToast, loadDetail, startYapActionProgress, finishYapActionProgress, updateYapActionProgress, normalizeYapOutcome, invalidatePracticeCaches, recoverPersistedSyncResult, rememberRequest, rememberResponse, rememberError]);

  const deleteYapAppointment = useCallback(async (id, options = {}) => {
    if (browserPreviewMode) {
      addToast('Anteprima: delete YAP simulato', 'success');
      setYapLastPracticeId(id);
      setYapLastResult({ status: 'deleted', simulated: true, message: 'Eliminazione simulata in anteprima browser.' });
      return { status: 'deleted', simulated: true };
    }
    flushSync(() => {
      startYapActionProgress('delete', id, 'Eliminazione YAP avviata. In attesa dell’esito reale dal server...');
      setYapDeleteLoading(true);
      setYapLastResult(null);
      setYapLastPracticeId(id);
    });
    updateYapActionProgress({ percent: 0, label: 'Eliminazione YAP in esecuzione sul server. Fase live non disponibile.' });
    await waitForNextPaint();
    try {
      const listPractice = Array.isArray(practices)
        ? practices.find((practiceItem) => String(practiceItem.id) === String(id))
        : null;
      const inferredTime = options.time
        || (String(selectedPracticeId || '') === String(id) ? detailData?.practice?.appointment_time : '')
        || listPractice?.appointment_time
        || '';
      const requestOptions = inferredTime ? { ...options, time: inferredTime } : { ...options };
      rememberRequest('yap.delete', { method: 'DELETE', url: `${API_BASE_URL}/practices/${id}/yap/appointment`, params: getAuthParams(), headers: getHeaders(), data: requestOptions });
      // NON ritentare in automatico: la delete e' non idempotente lato YAP.
      // 340s: attesa lock (100s) + worker con cascata preventivo/ODL (230s).
      const res = await axios.delete(`${API_BASE_URL}/practices/${id}/yap/appointment`, { data: requestOptions, params: getAuthParams(), headers: getHeaders(), timeout: 340000 });
      const data = normalizeYapOutcome(res.data?.data || {});
      setYapLastResult(data);
      rememberResponse('yap.delete');
      invalidatePracticeCaches(id);
      const phaseLabel = summarizePhaseTimeline(data.phase_timeline, data.message || 'Eliminazione YAP completata.');
      if (data.status === 'deleted' || data.status === 'not_found' || data.status === 'not_needed') {
        finishYapActionProgress(phaseLabel, 'success', 1200);
        addToast(data.status === 'not_found' ? 'Appuntamento già assente su YAP. Pratica rimossa.' : 'Appuntamento eliminato da YAP', 'success');
        setPractices((current) => current.filter((practiceItem) => String(practiceItem.id) !== String(id)));
        if (String(selectedPracticeId || '') === String(id)) {
          setCurrentView('dashboard');
          setNavigationStack([]);
          setSelectedPracticeId(null);
          setDetailData(null);
        }
        startTransition(() => {
          loadDashboard(searchQuery, activeFilters);
        });
      } else if (data.status === 'blocked_by_odl') {
        finishYapActionProgress(phaseLabel, 'error', 0);
        addToast('Impossibile eliminare: associato a ordine di lavoro', 'warning');
      } else if (data.status === 'blocked_by_preventivo') {
        finishYapActionProgress(phaseLabel, 'error', 0);
        addToast('Impossibile eliminare: presente un preventivo. Eliminalo prima su YAP, poi riprova.', 'warning');
      } else {
        finishYapActionProgress(phaseLabel, 'success', 1200);
        addToast(data.message || `Delete YAP: ${data.status}`, 'info');
      }
      return data;
    } catch (err) {
      rememberError('yap.delete', err);
      const errorResult = buildYapErrorResult(err, 'delete_failed');
      setYapLastResult(errorResult);
      addToast(errorResult.message, 'error');
      finishYapActionProgress(errorResult.message || 'Eliminazione YAP fallita', 'error', 0);
      return errorResult;
    } finally {
      setYapDeleteLoading(false);
    }
  }, [browserPreviewMode, getAuthParams, getHeaders, addToast, startYapActionProgress, finishYapActionProgress, updateYapActionProgress, normalizeYapOutcome, selectedPracticeId, detailData, practices, loadDashboard, searchQuery, activeFilters, invalidatePracticeCaches, rememberRequest, rememberResponse, rememberError]);

  const auditYapAppointment = useCallback(async (id, options = {}) => {
    const background = options.background || false;
    if (browserPreviewMode) {
      const simulated = {
        status: 'partial_synced',
        message: 'Anteprima: agenda verificata, ODL/materiali/ricambi non controllati.',
        audit: { present: [], missing: [], mismatch: [] },
      };
      addToast(simulated.message, 'warning');
      setYapLastPracticeId(id);
      setYapLastResult(simulated);
      return simulated;
    }
    if (!background) {
      startYapActionProgress('audit', id, 'YAP: avvio browser e ripristino sessione...');
      setYapAuditLoading(true);
      setYapLastResult(null);
    }
    setYapLastPracticeId(id);
    const auditAbortController = new AbortController();
    yapAbortControllerRef.current = auditAbortController;
    try {
      rememberRequest('yap.audit', { method: 'POST', url: `${API_BASE_URL}/practices/${id}/yap/audit`, params: getAuthParams(), headers: getHeaders() });
      // NON ritentare in automatico: l'audit apre il browser; un retry lanciava un secondo run.
      // 340s: worker audit (240s) + attesa lock YAP (fino a 100s).
      const res = await axios.post(`${API_BASE_URL}/practices/${id}/yap/audit`, options, { params: getAuthParams(), headers: getHeaders(), timeout: 340000, signal: auditAbortController.signal });
      const data = normalizeYapOutcome(res.data?.data || {});
      rememberResponse('yap.audit');
      invalidatePracticeCaches(id);
      if (background) {
        // Verifica in background: aggiorna lo stato SOLO per confermare (verde),
        // senza mai declassare un salvataggio gia' riuscito ne' mostrare spinner/toast.
        if (data.status === 'complete_synced') {
          setYapLastResult(data);
          addToast(data.message || 'Verifica YAP completata: tutto ok', 'success');
        }
        loadDetail(id);
        return data;
      }
      setYapLastResult(data);
      const tone = data.status === 'complete_synced' ? 'success' : (data.status === 'sync_failed' ? 'error' : 'warning');
      const auditLabel = data.message || 'Controllo YAP completato';
      finishYapActionProgress(auditLabel, tone === 'error' ? 'error' : 'success', tone === 'error' ? 0 : 1400);
      addToast(auditLabel, tone);
      loadDetail(id);
      return data;
    } catch (err) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || err?.name === 'AbortError') {
        return { status: 'cancelled' };
      }
      rememberError('yap.audit', err);
      const errorResult = buildYapErrorResult(err, 'audit_failed');
      if (background) {
        // Verifica in background fallita: NON tocchiamo il risultato della sync
        // (l'appuntamento e' stato comunque scritto). Niente toast/spinner di errore.
        return errorResult;
      }
      setYapLastResult(errorResult);
      finishYapActionProgress(errorResult.message || 'Verifica YAP fallita', 'error', 0);
      addToast(errorResult.message, 'error');
      return errorResult;
    } finally {
      yapAbortControllerRef.current = null;
      setYapAuditLoading(false);
    }
  }, [browserPreviewMode, getAuthParams, getHeaders, addToast, loadDetail, startYapActionProgress, finishYapActionProgress, normalizeYapOutcome, invalidatePracticeCaches, rememberRequest, rememberResponse, rememberError]);

  auditYapAppointmentRef.current = auditYapAppointment;

  const renderGlobalYapActionProgressBar = () => {
    if (!yapActionProgress) return null;
    return (
      <div className="yap-global-progress-shell">
        <div className={`yap-action-progress yap-global-progress ${yapActionProgress.status === 'error' ? 'save-progress-error' : yapActionProgress.status === 'success' ? 'save-progress-success' : 'save-progress-running'}`}>
          <div className="save-progress-header">
            {yapActionProgress.status === 'running' && <span className="loading-spinner sm"></span>}
            <span className="save-progress-label">{yapActionProgress.label}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
              <span className="save-progress-percent">
                {Math.round(yapActionProgress.percent)}% {yapActionProgress.status === 'running' ? 'confermato' : 'completato'}
              </span>
              {yapActionProgress.status === 'running' && (
                <button
                  type="button"
                  onClick={cancelYapAction}
                  style={{ background: 'none', border: '1px solid currentColor', borderRadius: '4px', color: 'inherit', cursor: 'pointer', fontSize: '11px', opacity: 0.75, padding: '1px 6px', lineHeight: '1.4' }}
                  title="Annulla operazione"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
          <div className="upload-progress-bar" aria-hidden="true">
            <div
              className="upload-progress-bar-fill"
              style={{ width: `${Math.max(0, Math.min(100, yapActionProgress.percent))}%` }}
            />
          </div>
        </div>
      </div>
    );
  };

  // Pannello "Log worker" riusabile: mostra la timeline dettagliata delle fasi del worker.
  const renderWorkerLogPanel = (phases) => {
    const workerLog = Array.isArray(phases) ? phases : [];
    if (!workerLog.length) return null;
    const lines = buildWorkerLogLines(workerLog);
    return (
      <details className="yap-result-tech" open>
        <summary>🪵 Log worker ({workerLog.length} azioni)</summary>
        <div className="yap-result-tech-body">
          <pre className="yap-worker-log">{lines}</pre>
        </div>
      </details>
    );
  };

  const renderYapResultBanner = (result, { practiceId = null, showRetry = false, showDelete = false } = {}) => {
    const resolvedPracticeId = practiceId || yapLastPracticeId;
    const showActionProgress = Boolean(
      yapActionProgress &&
      resolvedPracticeId &&
      String(yapActionProgress.practiceId) === String(resolvedPracticeId)
    );
    if (!result && !showActionProgress) return null;
    if (showActionProgress && yapActionProgress.status === 'running') return null;
    const safeResult = result || {};
    const statusCandidate = [
      safeResult.status,
      safeResult.practice?.management_sync_status,
      safeResult.yap?.status,
    ].find((value) => String(value || '').trim().length > 0);
    let status = String(statusCandidate || 'unknown').trim();
    if (!result && showActionProgress) status = 'running';
    const agendaOnly = isAgendaOnlyYapSync(safeResult);
    const audit = getYapAuditResult(safeResult);
    const titleMap = {
      complete_synced: 'YAP completo',
      partial_synced: 'YAP parziale',
      agenda_synced: 'YAP agenda scritta',
      synced: agendaOnly ? 'YAP parziale' : 'Sync YAP completata',
      duplicate: 'Duplicato rilevato',
      dry_run: 'Dry-run YAP completato',
      not_ready: 'Pratica non pronta',
      blocked_by_odl: 'Eliminazione bloccata da ODL',
      deleted: 'Appuntamento eliminato',
      not_found: 'Appuntamento già assente',
      sync_failed: 'Sync YAP fallita',
      audit_failed: 'Verifica YAP fallita',
      delete_failed: 'Eliminazione YAP fallita',
      running: 'Operazione YAP in corso',
      unknown: 'Stato YAP sconosciuto',
    };
    const message = safeResult.message
      || safeResult.yap?.result?.message
      || safeResult.yap?.message
      || ((status === 'deleted' || status === 'not_found') ? 'Appuntamento eliminato da YAP.' : '')
      || '';
    if (status === 'unknown') {
      const normalizedMessage = String(message || '').toLowerCase();
      if (normalizedMessage.includes('agenda sincronizzata')) status = 'agenda_synced';
      if (normalizedMessage.includes('appuntamento eliminato')) status = 'deleted';
      if (normalizedMessage.includes('non trovato') || normalizedMessage.includes('not found')) status = 'not_found';
      if (normalizedMessage.includes('fallita') || normalizedMessage.includes('errore')) status = 'sync_failed';
    }
    const isSuccess = status === 'complete_synced' || status === 'deleted' || status === 'not_found';
    const isWarning = ['partial_synced', 'agenda_synced', 'synced', 'not_ready', 'blocked_by_odl', 'dry_run'].includes(status);
    const toneClass = isSuccess ? 'yap-success' : (isWarning ? 'yap-warning' : 'yap-error');
    const telemetry = safeResult.telemetry || extractYapTelemetry(safeResult);
    const primaryMeta = [];
    const diagnosticItems = [];
    const statusReason = safeResult.status_reason || safeResult?.yap?.error?.reason || null;
    const actionTarget = safeResult.action_target || safeResult?.yap?.error?.action_target || '';
    const isPostWriteReview = status === 'partial_synced' && statusReason === 'post_write_review_needed';
    const persistedAuditSnapshot = normalizeYapAuditSnapshot(getYapAuditResult(safeResult));
    const effectiveWorkerPhases = (Array.isArray(safeResult.worker_phases) && safeResult.worker_phases.length)
      ? safeResult.worker_phases
      : (Array.isArray(persistedAuditSnapshot?.worker_phases) ? persistedAuditSnapshot.worker_phases : []);
    const effectivePhaseTimeline = (Array.isArray(safeResult.phase_timeline) && safeResult.phase_timeline.length)
      ? safeResult.phase_timeline
      : (Array.isArray(persistedAuditSnapshot?.phase_timeline) ? persistedAuditSnapshot.phase_timeline : []);
    const workerPhaseLabel = workerPhasesToLabel(effectiveWorkerPhases, { softenFailure: isPostWriteReview });
    if (Number.isFinite(safeResult.preSync?.score)) primaryMeta.push(`Pre-sync ${safeResult.preSync.score}/100`);
    const saveAttempts = Number(telemetry?.saveAttempts || safeResult.yap?.result?.telemetry?.saveAttempts || 0);
    if (saveAttempts > 0) primaryMeta.push(`${saveAttempts} ${saveAttempts === 1 ? 'tentativo' : 'tentativi'}`);
    const elapsedLabel = formatYapElapsedMs(telemetry?.total_elapsed_ms);
    if (elapsedLabel) primaryMeta.push(`Tempo ${elapsedLabel}`);
    const sessionLabel = formatYapSessionLabel(telemetry, status);
    if (sessionLabel) primaryMeta.push(sessionLabel);
    if (safeResult.screenshot) diagnosticItems.push('Screenshot salvato');
    if (safeResult.duplicate) diagnosticItems.push('Dedup attivo');
    if (audit) {
      const auditCount = (audit.present?.length || 0) + (audit.missing?.length || 0) + (audit.mismatch?.length || 0);
      const auditTechnicalFailure = audit.technical_failure === true || audit.status_reason === 'audit_not_completed';
      const auditNeedsReview = audit.status_reason === 'post_write_review_needed';
      if (auditTechnicalFailure && auditCount === 0) {
        diagnosticItems.push('Audit non completato');
      } else if (!(auditNeedsReview && auditCount === 0)) {
        diagnosticItems.push(`Audit: ${audit.present?.length || 0} presenti, ${audit.missing?.length || 0} mancanti, ${audit.mismatch?.length || 0} diversi`);
      }
    }
    const technicalDiagnostics = extractYapTechnicalDiagnostics(safeResult) || extractYapTechnicalDiagnostics(persistedAuditSnapshot);
    const workerLogPhases = effectiveWorkerPhases.length
      ? effectiveWorkerPhases
      : effectivePhaseTimeline;
    const canCopyYapLogs = Boolean((technicalDiagnostics && (
      technicalDiagnostics.runner?.finished_at
      || technicalDiagnostics.failedPhase
      || technicalDiagnostics.stdoutTail
      || technicalDiagnostics.stderrTail
      || technicalDiagnostics.workerPhases.length
    )) || workerLogPhases.length);
    const copyYapLogs = async () => {
      const payload = buildYapLogClipboardText({ technicalDiagnostics, workerPhases: workerLogPhases });
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(payload);
        } else {
          const helper = document.createElement('textarea');
          helper.value = payload;
          helper.setAttribute('readonly', 'readonly');
          helper.style.position = 'absolute';
          helper.style.left = '-9999px';
          document.body.appendChild(helper);
          helper.select();
          document.execCommand('copy');
          document.body.removeChild(helper);
        }
        setYapLogCopyStatus('log copiato');
      } catch (_) {
        setYapLogCopyStatus('copia log non riuscita');
      }
    };
    if (workerPhaseLabel) {
      diagnosticItems.push(workerPhaseLabel);
    } else {
      const phaseSummary = summarizePhaseTimeline(effectivePhaseTimeline);
      const hasFailedPhase = Array.isArray(effectivePhaseTimeline)
        && effectivePhaseTimeline.some((phase) => phase?.status === 'failed');
      if (phaseSummary && hasFailedPhase) diagnosticItems.push(phaseSummary);
    }
    const writeReport = safeResult.write_report || safeResult.yap?.result?.write_report || null;
    const writeReportDebug = writeReport?.debug || null;
    if (writeReport?.ok === false) {
      const issues = [
        writeReport.notes?.error ? formatYapWriteReportIssue('note', writeReport.notes.error) : null,
        writeReport.odl?.error ? formatYapWriteReportIssue('odl', writeReport.odl.error) : null,
        writeReport.materials?.error ? formatYapWriteReportIssue('materiali', writeReport.materials.error) : null,
        writeReport.parts?.error ? formatYapWriteReportIssue('ricambi', writeReport.parts.error) : null,
        writeReport.waste?.error ? formatYapWriteReportIssue('smaltimento', writeReport.waste.error) : null,
      ].filter(Boolean);
      if (issues.length) {
        diagnosticItems.push(`Post-scrittura: ${issues.slice(0, 2).join(', ')}`);
      }
    }
    const errorCode = safeResult.error_code || safeResult?.yap?.error?.error_code || null;
    diagnosticItems.push(...buildYapTelemetryDetails(telemetry, status).filter(Boolean));
    if (errorCode && errorCode !== 'YAP_TIMEOUT') diagnosticItems.push(`Codice ${errorCode}`);
    if (statusReason && !isPostWriteReview) {
      const reasonStr = String(statusReason).trim().toLowerCase();
      if (!reasonStr.startsWith('timeout')) {
        const formattedReason = formatYapStatusReason(statusReason);
        if (formattedReason) {
          const prefix = reasonStr === 'audit_deferred' ? 'Stato' : 'Causa';
          diagnosticItems.push(`${prefix} ${formattedReason}`);
        }
      }
    }
    const canRetry = showRetry && resolvedPracticeId && ['sync_failed', 'not_ready', 'dry_run', 'duplicate', 'partial_synced', 'agenda_synced'].includes(status) && !isPostWriteReview;
    const canAudit = showRetry && resolvedPracticeId && ['sync_failed', 'audit_failed', 'partial_synced', 'agenda_synced'].includes(status);
    const canDelete = showDelete && resolvedPracticeId && ['complete_synced', 'partial_synced', 'agenda_synced', 'synced', 'duplicate', 'dry_run', 'not_ready', 'sync_failed', 'audit_failed'].includes(status);
    const canActionHint = Boolean(
      resolvedPracticeId
      && ['sync', 'audit', 'delete'].includes(actionTarget)
      && ['sync_failed', 'audit_failed', 'partial_synced', 'blocked_by_odl', 'delete_failed', 'not_ready'].includes(status)
    );
    const showSyncHint = canActionHint && actionTarget === 'sync' && !canRetry;
    const showAuditHint = canActionHint && actionTarget === 'audit' && !canAudit;
    const showDeleteHint = canActionHint && actionTarget === 'delete' && !canDelete;
    const showTechnicalAuditState = audit?.technical_failure === true || audit?.status_reason === 'audit_not_completed';
    const technicalAuditOverridesTitle = showTechnicalAuditState && !['sync_failed', 'audit_failed', 'delete_failed'].includes(status);
    const statusTitle = technicalAuditOverridesTitle
      ? 'Verifica YAP incompleta'
      : (titleMap[status] || titleMap.unknown);

    return (
      <div className={`yap-result-banner ${toneClass}`}>
        <div className="yap-result-summary">
          <div>
            <div className="yap-result-status">{statusTitle}</div>
            {message && <div className="yap-result-message">{message}</div>}
            {primaryMeta.length > 0 && (
              <div className="yap-result-badges">
                {primaryMeta.map((item) => (
                  <span key={item} className="yap-result-badge">{item}</span>
                ))}
              </div>
            )}
            {diagnosticItems.length > 0 && (
              <div className="yap-result-details">
                {diagnosticItems.map((item) => (
                  <div key={item} className="yap-result-detail">{item}</div>
                ))}
              </div>
            )}
            {renderWorkerLogPanel(workerLogPhases)}
            {technicalDiagnostics && (status === 'sync_failed' || status === 'audit_failed' || status === 'delete_failed' || status === 'partial_synced' || status === 'agenda_synced' || showTechnicalAuditState) && (
              <details className="yap-result-tech" open={status === 'sync_failed' || status === 'audit_failed' || status === 'delete_failed' || status === 'partial_synced' || showTechnicalAuditState}>
                <summary>Crash log YAP</summary>
                <div className="yap-result-tech-body">
                  {(() => {
                    // Diagnostica ODL non aperto: mostra perche' l'ODL non si e' aperto
                    // (renderer crashato vs loading infinito vs tab assente). Popolata dal
                    // worker quando openedOdl=false. E' la chiave per capire i fallimenti su Railway.
                    const od = safeResult?.write_report?.odlDiagnostic || safeResult?.result?.write_report?.odlDiagnostic;
                    if (!od) return null;
                    return (
                      <div className="yap-result-tech-block" style={{ marginBottom: 8 }}>
                        <strong>ODL non aperto:</strong>
                        <div>errore: {od.odlError || '?'} | stato: {od.workspaceState || '?'}</div>
                        <div>pagina_responsiva: {String(od.pageResponsive)}{od.evalError ? ` (evalError: ${od.evalError})` : ''}</div>
                        <div>tab_ordini_lavoro: {String(od.hasOrdiniLavoroTab)} | sub_tab_odl: {String(od.hasOdlSubTabs)}</div>
                        <div>reload_pratica: {od.refreshAttempts != null ? od.refreshAttempts : '?'} | fallback_click: {String(od.odlFallbackClickUsed)}</div>
                        {Array.isArray(od.loadingTexts) && od.loadingTexts.length > 0 && (
                          <div>loading_visibili: {od.loadingTexts.join(' | ')}</div>
                        )}
                        {Array.isArray(od.dialogTexts) && od.dialogTexts.length > 0 && (
                          <div>modali_visibili: {od.dialogTexts.join(' | ')}</div>
                        )}
                        {Array.isArray(od.topTabs) && od.topTabs.length > 0 && (
                          <div>tab_presenti: {od.topTabs.join(', ')}</div>
                        )}
                        <div>pageEnum: {od.pageEnum || '?'}</div>
                        <div>RPC: {od.rpcResCount != null ? `${od.rpcResCount} risposte / ${od.rpcReqCount} richieste` : '?'}{od.rpcPendingCount != null ? ` | pendenti: ${od.rpcPendingCount}` : ''}{od.rpcFailCount ? ` | fail: ${od.rpcFailCount}` : ''}</div>
                        {Array.isArray(od.rpcSummary) && od.rpcSummary.length > 0 && (
                          <div style={{ opacity: 0.9, whiteSpace: 'pre-wrap', fontSize: '0.85em' }}>
                            azioni: {od.rpcSummary.map((row) => {
                              const bits = [`${row.action}: ${row.pending || 0} pendenti`, `${row.res || 0}/${row.req || 0} risposte`];
                              if (row.fail) bits.push(`${row.fail} fail`);
                              if (row.lastStatus) bits.push(`HTTP ${row.lastStatus}`);
                              if (row.lastError) bits.push(String(row.lastError).slice(0, 48));
                              return bits.join(', ');
                            }).join(' | ')}
                          </div>
                        )}
                        {Array.isArray(od.rpc) && od.rpc.length > 0 && (
                          <div style={{ opacity: 0.85, whiteSpace: 'pre-wrap', fontSize: '0.85em' }}>traffico: {od.rpc.join(' | ')}</div>
                        )}
                        {od.bodyExcerpt && (<div style={{ opacity: 0.8 }}>testo: {String(od.bodyExcerpt).slice(0, 200)}</div>)}
                      </div>
                    );
                  })()}
                  {technicalDiagnostics.runner?.finished_at && (
                    <div><strong>ts:</strong> {technicalDiagnostics.runner.finished_at}</div>
                  )}
                  {(technicalDiagnostics.runner?.script || technicalDiagnostics.runner?.timeout_seconds) && (
                    <div>
                      <strong>script:</strong> {technicalDiagnostics.runner?.script || 'yap-worker.mjs'}
                      {technicalDiagnostics.runner?.timeout_seconds ? `  timeout: ${technicalDiagnostics.runner.timeout_seconds}s` : ''}
                    </div>
                  )}
                  {(technicalDiagnostics.workerPhases.length > 0 || technicalDiagnostics.failedPhase) && (
                    <div>
                      <strong>last_phase:</strong> {technicalDiagnostics.workerPhases.length > 0
                        ? `${technicalDiagnostics.workerPhases[technicalDiagnostics.workerPhases.length - 1]?.phase || '?'}:${technicalDiagnostics.workerPhases[technicalDiagnostics.workerPhases.length - 1]?.status || '?'}`
                        : technicalDiagnostics.failedPhase}
                    </div>
                  )}
                  {technicalDiagnostics.workerPhases.length > 0 && (
                    <div>
                      <strong>phases:</strong> {summarizeWorkerPhases(technicalDiagnostics.workerPhases)}
                    </div>
                  )}
                  {technicalDiagnostics.stdoutTail && (
                    <div className="yap-result-tech-block">
                      <strong>stdout:</strong>
                      <pre>{technicalDiagnostics.stdoutTail}</pre>
                    </div>
                  )}
                  {technicalDiagnostics.stderrTail && (
                    <div className="yap-result-tech-block">
                      <strong>stderr:</strong>
                      <pre>{technicalDiagnostics.stderrTail}</pre>
                    </div>
                  )}
                </div>
              </details>
            )}
            {writeReportDebug && isDebugUiEnabled() && (
              <details className="yap-result-tech">
                <summary>Debug YAP</summary>
                <div className="yap-result-tech-body">
                  {writeReportDebug.notes?.editableCount != null && (
                    <div><strong>note editable:</strong> {writeReportDebug.notes.editableCount}</div>
                  )}
                  {writeReportDebug.notes?.primaryAttempt?.attempts?.length > 0 && (
                    <div>
                      <strong>note primary:</strong>{' '}
                      {writeReportDebug.notes.primaryAttempt.attempts
                        .map((attempt) => `${attempt.index}:${attempt.ok ? 'ok' : 'ko'}${attempt.debug?.selected?.tag ? `/${attempt.debug.selected.tag}` : ''}`)
                        .join(' | ')}
                    </div>
                  )}
                  {writeReportDebug.notes?.fallbackSuccess != null && (
                    <div><strong>note fallback:</strong> {writeReportDebug.notes.fallbackSuccess ? 'ok' : 'failed'}</div>
                  )}
                  {writeReportDebug.notes?.noteSummaryBlock?.selected && (
                    <div>
                      <strong>note summary:</strong> {[writeReportDebug.notes.noteSummaryBlock.selected.tag, writeReportDebug.notes.noteSummaryBlock.selected.role].filter(Boolean).join(' | ')}
                    </div>
                  )}
                  {writeReportDebug.notes?.fallbackDebug?.selected && (
                    <div>
                      <strong>note target:</strong> {[
                        writeReportDebug.notes.fallbackDebug.selected.tag,
                        writeReportDebug.notes.fallbackDebug.selected.role,
                        writeReportDebug.notes.fallbackDebug.selected.contenteditable,
                      ].filter(Boolean).join(' | ')}
                    </div>
                  )}
                  {writeReportDebug.odl?.routeReason && (
                    <div><strong>odl route reason:</strong> {writeReportDebug.odl.routeReason}</div>
                  )}
                  {typeof writeReportDebug.odl?.odlRpcReady === 'boolean' && (
                    <div><strong>odl rpc ready:</strong> {writeReportDebug.odl.odlRpcReady ? 'yes' : 'no'}</div>
                  )}
                  {Number.isFinite(writeReportDebug.odl?.odlWaitAttempts) && (
                    <div><strong>odl wait:</strong> {writeReportDebug.odl.odlWaitAttempts} checks</div>
                  )}
                  {Array.isArray(writeReportDebug.odl?.fallbackAttempts) && writeReportDebug.odl.fallbackAttempts.length > 0 && (
                    <div><strong>odl attempts:</strong> {writeReportDebug.odl.fallbackAttempts.join(' -> ')}</div>
                  )}
                  {writeReportDebug.odl?.routeResult && (
                    <div className="yap-result-tech-block">
                      <strong>odl route:</strong>
                      <pre>{JSON.stringify(writeReportDebug.odl.routeResult, null, 2)}</pre>
                    </div>
                  )}
                  {Array.isArray(writeReportDebug.odl?.topCandidatesBeforeRetry) && writeReportDebug.odl.topCandidatesBeforeRetry.length > 0 && (
                    <div>
                      <strong>odl top before retry:</strong> {writeReportDebug.odl.topCandidatesBeforeRetry.slice(0, 3).map((item) => item.text || '?').join(' | ')}
                    </div>
                  )}
                  {Array.isArray(writeReportDebug.odl?.topCandidates) && writeReportDebug.odl.topCandidates.length > 0 && (
                    <div>
                      <strong>odl top:</strong> {writeReportDebug.odl.topCandidates.slice(0, 3).map((item) => item.text || '?').join(' | ')}
                    </div>
                  )}
                  {writeReportDebug.odl?.workspaceStateBefore || writeReportDebug.odl?.workspaceStateAfter ? (
                    <div>
                      <strong>odl state:</strong> {writeReportDebug.odl.workspaceStateBefore || '-'} -> {writeReportDebug.odl.workspaceStateAfter || '-'}
                    </div>
                  ) : null}
                  {Array.isArray(writeReportDebug.sections) && writeReportDebug.sections.length > 0 && (
                    <div className="yap-result-tech-block">
                      <strong>sectioni:</strong>
                      <pre>{JSON.stringify(writeReportDebug.sections.map((section) => ({
                        reparto: section.reparto,
                        yapReparto: section.yapReparto,
                        written: section.written,
                        summaryLength: section.summaryLength,
                        fields: Object.fromEntries(Object.entries(section.fields || {}).map(([key, value]) => [key, Boolean(value)])),
                      })), null, 2)}</pre>
                    </div>
                  )}
                </div>
              </details>
            )}
            {(!technicalDiagnostics && (status === 'sync_failed' || status === 'audit_failed' || showTechnicalAuditState)) && (
              <YapCrashLogButton initData={initData} telegramUserId={telegramUserId} />
            )}
          </div>
        </div>
        {(canCopyYapLogs || canRetry || canAudit || canDelete || showSyncHint || showAuditHint || showDeleteHint) && (
          <div className="yap-result-actions">
            {canCopyYapLogs && (
              <button
                type="button"
                className="yap-result-action"
                onClick={copyYapLogs}
              >
                Copia crash + worker log
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                className="yap-result-action"
                onClick={() => syncToYap(resolvedPracticeId, { dry_run: false })}
                disabled={yapSyncLoading}
              >
                Riprova sync
              </button>
            )}
            {canAudit && (
              <button
                type="button"
                className="yap-result-action"
                onClick={() => auditYapAppointment(resolvedPracticeId, { debug: false })}
                disabled={yapAuditLoading}
              >
                {yapAuditLoading ? 'Verifica...' : 'Verifica YAP'}
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                className="yap-result-action yap-result-action-danger"
                onClick={() => deleteYapAppointment(resolvedPracticeId, { dry_run: false })}
                disabled={yapDeleteLoading}
              >
                Elimina YAP
              </button>
            )}
            {showSyncHint && (
              <button
                type="button"
                className="yap-result-action"
                onClick={() => syncToYap(resolvedPracticeId, { dry_run: false })}
                disabled={yapSyncLoading}
              >
                {safeResult.action_label || 'Riprova sync'}
              </button>
            )}
            {showAuditHint && (
              <button
                type="button"
                className="yap-result-action"
                onClick={() => auditYapAppointment(resolvedPracticeId, { debug: false })}
                disabled={yapAuditLoading}
              >
                {safeResult.action_label || 'Verifica YAP'}
              </button>
            )}
            {showDeleteHint && (
              <button
                type="button"
                className="yap-result-action yap-result-action-danger"
                onClick={() => deleteYapAppointment(resolvedPracticeId, { dry_run: false })}
                disabled={yapDeleteLoading}
              >
                {safeResult.action_label || 'Elimina YAP'}
              </button>
            )}
            {yapLogCopyStatus && (
              <span className="yap-audit-copy-status">{yapLogCopyStatus}</span>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderYapAuditReport = (audit, { result = null, practice: practiceInfo = null, source = 'live' } = {}) => {
    if (!audit) return null;
    const groups = [
      { key: 'present', title: 'Presenti', items: audit.present || [] },
      { key: 'missing', title: 'Mancanti', items: audit.missing || [] },
      { key: 'mismatch', title: 'Diversi', items: audit.mismatch || [] },
    ];
    const feedback = audit.feedback || {};
    const lookup = audit.lookup || {};
    const topBlockers = Array.isArray(feedback.topBlockers) ? feedback.topBlockers : [];
    const nextSteps = Array.isArray(feedback.nextSteps) ? feedback.nextSteps : [];
    const byGroup = feedback.byGroup || {};
    const totalItems = groups.reduce((sum, group) => sum + group.items.length, 0);
    const auditTechnicalFailure = audit.technical_failure === true || audit.status_reason === 'audit_not_completed';
    const auditNeedsReview = audit.status_reason === 'post_write_review_needed';
    const groupOrder = ['tags', 'agenda', 'odl', 'notes', 'materials', 'parts', 'waste'];
    const groupLabel = {
      tags: 'Tag',
      agenda: 'Agenda',
      odl: 'ODL',
      notes: 'Note',
      materials: 'Materiali',
      parts: 'Ricambi',
      waste: 'Smaltimento',
    };
    const technicalDiagnostics = result ? extractYapTechnicalDiagnostics(result) : null;
    const writeReport = result?.write_report || result?.yap?.result?.write_report || null;
    const checklist = buildYapChecklist({
      audit,
      result,
      practiceType: practiceInfo?.practice_type || result?.practice?.practice_type || '',
    });
    const diagnosticSnapshot = buildYapDiagnosticSnapshot({
      audit,
      result,
      practice: practiceInfo,
      checklist,
      technicalDiagnostics,
      writeReport,
    });
    const diagnosticText = buildYapDiagnosticClipboardText(diagnosticSnapshot);

    const copyYapDiagnostic = async () => {
      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(diagnosticText);
        } else {
          const helper = document.createElement('textarea');
          helper.value = diagnosticText;
          helper.setAttribute('readonly', 'readonly');
          helper.style.position = 'absolute';
          helper.style.left = '-9999px';
          document.body.appendChild(helper);
          helper.select();
          document.execCommand('copy');
          document.body.removeChild(helper);
        }
        setYapDiagnosticCopyStatus('diagnostica copiata');
      } catch (_) {
        setYapDiagnosticCopyStatus('copia non riuscita');
      }
    };

    return (
      <div className="section yap-audit-section">
        <div className="section-title-row yap-audit-header">
          <h2>Controllo YAP</h2>
          <div className="yap-audit-actions">
            <button
              type="button"
              className="yap-result-action"
              onClick={copyYapDiagnostic}
            >
              Copia diagnostica YAP
            </button>
            {yapDiagnosticCopyStatus && (
              <span className="yap-audit-copy-status">{yapDiagnosticCopyStatus}</span>
            )}
            <span className={`yap-audit-status yap-audit-status-${audit.status || 'unknown'}`}>
              {formatYapPracticeStatus({ management_sync_status: audit.status })}
            </span>
          </div>
        </div>
        {source === 'persisted' && (
          <div className="yap-audit-message">
            <strong>Nota:</strong> questo e' l'ultimo controllo YAP salvato per la pratica, non l'esito della sync che sta partendo adesso.
          </div>
        )}
        {audit.message && <div className="yap-audit-message">{audit.message}</div>}
        {checklist.length > 0 && (
          <div className="yap-audit-checklist">
            {checklist.map((item) => (
              <div
                key={item.key}
                className={`yap-audit-check-item yap-audit-check-${item.value === true ? 'yes' : item.value === false ? 'no' : 'na'}`}
              >
                <span>{item.label}</span>
                <strong>{formatYapChecklistValue(item.value)}</strong>
              </div>
            ))}
          </div>
        )}
        {auditTechnicalFailure && totalItems === 0 && (
          <div className="yap-audit-message">
            <strong>Audit non completato:</strong> la scrittura su YAP e' partita, ma la verifica automatica non ha prodotto campi affidabili.
            {audit.error_code ? ` Codice ${audit.error_code}.` : ''}
            {audit.next_action ? ` Azione: ${audit.next_action}.` : ''}
          </div>
        )}
        {auditNeedsReview && totalItems === 0 && (
          <div className="yap-audit-message">
            <strong>Verifica automatica parziale:</strong> la scrittura su YAP risulta avviata, ma alcuni campi post-scrittura sono da ricontrollare.
            {audit.next_action ? ` Azione: ${audit.next_action}.` : ''}
          </div>
        )}
        {lookup && (lookup.method || lookup.click?.method || Number.isFinite(lookup.eventCount)) && (
          <div className="yap-audit-message">
            <strong>Ricerca evento:</strong> metodo {lookup.click?.method || lookup.method || '-'}
            {Number.isFinite(lookup.eventCount) ? ` | eventi trovati ${lookup.eventCount}` : ''}
            {lookup.expectedTime ? ` | ora attesa ${lookup.expectedTime}` : ''}
            {lookup.bestEvent ? ` | match ${lookup.bestEvent}` : ''}
            {Number.isFinite(lookup.bestEventScore) && lookup.bestEventScore > 0 ? ` | score ${lookup.bestEventScore}` : ''}
            {typeof lookup.popupFound === 'boolean' ? ` | popup ${lookup.popupFound ? 'aperto' : 'non aperto'}` : ''}
            {typeof lookup.openedPractice === 'boolean' ? ` | pratica ${lookup.openedPractice ? 'aperta' : 'non aperta'}` : ''}
            {Array.isArray(lookup.searchTerms) && lookup.searchTerms.length ? ` | cerca ${lookup.searchTerms.join(', ')}` : ''}
            {Array.isArray(lookup.eventTitles) && lookup.eventTitles.length ? ` | primi eventi: ${lookup.eventTitles.slice(0, 3).join(' ; ')}` : ''}
          </div>
        )}
        {(feedback.summary || topBlockers.length || nextSteps.length) && (
          <div className="yap-audit-message">
            {feedback.summary && <div><strong>Priorita:</strong> {feedback.summary}</div>}
            {topBlockers.length > 0 && (
              <div>
                <strong>Blocchi principali:</strong> {topBlockers.slice(0, 3).map(item => item.label).join(' | ')}
              </div>
            )}
            {nextSteps.length > 0 && (
              <div>
                <strong>Prossimi passi:</strong> {nextSteps.slice(0, 3).join(' | ')}
              </div>
            )}
          </div>
        )}
        {Object.keys(byGroup).length > 0 && (
          <div className="yap-audit-message">
            {groupOrder
              .filter((key) => byGroup[key])
              .map((key) => {
                const stats = byGroup[key] || {};
                return `${groupLabel[key] || key}: ${stats.present || 0} ok, ${stats.missing || 0} mancanti, ${stats.mismatch || 0} diversi`;
              })
              .join(' | ')}
          </div>
        )}
        {!((auditTechnicalFailure || auditNeedsReview) && totalItems === 0) && (
          <div className="yap-audit-grid">
            {groups.map(group => (
              <div key={group.key} className={`yap-audit-card yap-audit-${group.key}`}>
                <div className="yap-audit-card-title">{group.title} ({group.items.length})</div>
                {group.items.length > 0 ? (
                  <ul className="yap-audit-list">
                    {group.items.slice(0, 8).map((item, index) => (
                      <li key={`${group.key}-${item.field || index}`}>
                        <span>{item.label || item.field}</span>
                        {item.expected != null && <small>atteso: {String(item.expected)}</small>}
                        {item.found && group.key === 'mismatch' && <small>trovato: {String(item.found_preview || item.found).slice(0, 160)}</small>}
                        {item.reason && <small>motivo: {String(item.reason)}</small>}
                        {item.hint && <small>azione: {String(item.hint)}</small>}
                      </li>
                    ))}
                    {group.items.length > 8 && (
                      <li className="yap-audit-more">
                        <details>
                          <summary>+{group.items.length - 8} altri campi</summary>
                          <ul className="yap-audit-list">
                            {group.items.slice(8).map((item, index) => (
                              <li key={`${group.key}-more-${item.field || index}`}>
                                <span>{item.label || item.field}</span>
                                {item.expected != null && <small>atteso: {String(item.expected)}</small>}
                                {item.found && group.key === 'mismatch' && <small>trovato: {String(item.found_preview || item.found).slice(0, 160)}</small>}
                                {item.reason && <small>motivo: {String(item.reason)}</small>}
                                {item.hint && <small>azione: {String(item.hint)}</small>}
                              </li>
                            ))}
                          </ul>
                        </details>
                      </li>
                    )}
                  </ul>
                ) : (
                  <div className="yap-audit-empty">Nessun campo</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // --- Form: Load practice for editing ---
  const loadPractice = useCallback(async (practiceId, currentInitData, plateFromUrl = '', currentTelegramUserId = '', currentPracticeAccessToken = '') => {
    startSlowTimer();
    try {
      rememberRequest('miniapp.load_practice', {
        method: 'GET',
        url: `${API_BASE_URL}/mini-app/data`,
        params: {
          practice_id: practiceId,
          ...(plateFromUrl ? { plate_confirmed: plateFromUrl } : {}),
          ...(currentTelegramUserId ? { user_id: currentTelegramUserId } : {}),
          ...(currentPracticeAccessToken ? { access_token: currentPracticeAccessToken } : {}),
        },
        headers: {
          ...(currentInitData ? { 'X-Telegram-Init-Data': currentInitData } : {}),
          ...(currentTelegramUserId ? { 'X-Telegram-User-Id': currentTelegramUserId } : {}),
        }
      });
      const response = await fetchWithRetry(() =>
        axios.get(`${API_BASE_URL}/mini-app/data`, {
          params: {
            practice_id: practiceId,
            ...(plateFromUrl ? { plate_confirmed: plateFromUrl } : {}),
            ...(currentTelegramUserId ? { user_id: currentTelegramUserId } : {}),
            ...(currentPracticeAccessToken ? { access_token: currentPracticeAccessToken } : {}),
          },
          headers: {
            ...(currentInitData ? { 'X-Telegram-Init-Data': currentInitData } : {}),
            ...(currentTelegramUserId ? { 'X-Telegram-User-Id': currentTelegramUserId } : {}),
          },
          timeout: 30000
        })
      );

      if (response.data.success) {
        rememberResponse('miniapp.load_practice');
        const practiceData = response.data.data.practice;
        setPractice(practiceData);
        const isDraft = practiceData.status === 'draft';

        if (isDraft) {
          setSelectedContexts([]);
          setValue('plate_confirmed', practiceData.plate_confirmed || plateFromUrl || '');
        } else {
          setSelectedContexts(normalizeContexts(practiceData.contexts));
          // Only set form-relevant fields, not internal DB fields
          FORM_FIELDS.forEach(key => {
            if (key === 'appointment_date' && practiceData[key]) {
              setValue(key, new Date(practiceData[key]));
            } else if (key !== 'appointment_date') {
              if (practiceData[key] !== undefined) setValue(key, practiceData[key]);
            }
          });
        }

        if (!isDraft && response.data.data.sections) {
          setSections(normalizeSections(response.data.data.sections));
        }

        if (!isDraft && response.data.data.parts) {
          const partsData = {};
          response.data.data.parts.forEach(p => {
            if (!partsData[p.context]) partsData[p.context] = [];
            partsData[p.context].push({ name: p.name || '', quantity: p.quantity || '', _key: Date.now() + Math.random() });
          });
          setParts(partsData);
        }

        // Load existing photos
        if (response.data.data.photos) {
          setExistingPhotos(response.data.data.photos);
        }
      }
    } catch (err) {
      rememberError('miniapp.load_practice', err);
      const status = err.response?.status;
      if (status === 404) {
        setPractice(null);
        setSelectedContexts([]);
        setError('');
        if (plateFromUrl) setValue('plate_confirmed', plateFromUrl);
      } else {
        setError(classifyError(err));
      }
    } finally {
      clearSlowTimer();
      setLoading(false);
    }
  }, [setValue, startSlowTimer, clearSlowTimer, rememberRequest, rememberResponse, rememberError]);

  // Pre-fill form when editing from detail
  useEffect(() => {
    if (currentView === 'form' && editingPractice) {
      setPractice(editingPractice);
      const p = editingPractice;
      const restored = restoreDraft(p.id);
      if (restored) {
        setShowDraftBanner(true);
      } else {
        setValue('plate_confirmed', p.plate_confirmed || p.plate || '');
        setValue('phone', p.phone || '');
        setValue('customer_name', p.customer_name || '');
        setValue('customer_type', p.customer_type || 'privato');
        setValue('appointment_time', p.appointment_time ? clampAppointmentTimeToYapRange(p.appointment_time) : '');
        setValue('practice_type', p.practice_type || 'preventivo');
        setValue('internal_notes', p.internal_notes || p.notes || '');
        setValue('billing_to_complete', p.billing_to_complete || false);
        setValue('company_name', p.company_name || '');
        setValue('vat_number', p.vat_number || '');
        setValue('fiscal_code', p.fiscal_code || '');
        setValue('billing_address', p.billing_address || '');
        setValue('billing_city', p.billing_city || '');
        setValue('billing_zip', p.billing_zip || '');
        if (p.appointment_date) {
          setValue('appointment_date', new Date(p.appointment_date));
          // Pratica esistente con data: mostra i campi manuali per non sovrascriverla con "oggi".
          setScheduleManually(true);
        }
        setSelectedContexts(normalizeContexts(p.contexts));
        if (p.sections) {
          setSections(normalizeSections(Array.isArray(p.sections) ? p.sections : []));
        }
        if (p.parts) {
          const pd = {};
          (Array.isArray(p.parts) ? p.parts : []).forEach(pt => {
            if (!pd[pt.context]) pd[pt.context] = [];
            pd[pt.context].push({ name: pt.name || '', quantity: pt.quantity || '', _key: Date.now() + Math.random() });
          });
          setParts(pd);
        }
      }
      setError('');
      setLoading(false);
    }
  }, [currentView, editingPractice, setValue, restoreDraft]);

  // Telegram WebApp init
  useEffect(() => {
    if (window.Telegram && window.Telegram.WebApp) {
      const webApp = window.Telegram.WebApp;
      webApp.ready();
      webApp.expand();
      webApp.setHeaderColor('#0f0f1a');
      webApp.setBackgroundColor('#0f0f1a');

      const currentInitData = webApp.initData || extractTelegramInitDataFromLocation();
      const currentTelegramUserId = extractTelegramUserIdFromLocation() || extractTelegramUserIdFromRuntime();
      const currentPracticeAccessToken = extractPracticeAccessTokenFromLocation();
      setInitData(currentInitData);
      setTelegramUserId(currentTelegramUserId);
      setPracticeAccessToken(currentPracticeAccessToken);
      stripSensitiveAuthParamsFromUrl();

      const urlParams = new URLSearchParams(window.location.search);
      const demoMode = urlParams.get('demo');
      const practiceId = urlParams.get('practice_id');
      const plate = urlParams.get('plate');

      if (demoMode === 'complete' || demoMode === 'full') {
        setBootstrapped(true);
        applyDemoTemplate();
        return;
      }

      if (practiceId || plate) {
        // Opened from bot with params -> show form
        setStartedFromBot(true);
        setCurrentView('form');
        if (practiceId) {
          if (!currentInitData && !currentTelegramUserId) {
            rememberError('miniapp.bootstrap', { response: { status: 401, data: { detail: 'bootstrap_missing_auth' } }, message: 'Bootstrap missing Telegram auth' }, {
              method: 'BOOT',
              url: window.location.href,
              params: { practice_id: practiceId, plate: plate || '' },
            });
            setError('Autenticazione Telegram assente. Riapri la Mini App dal pulsante del bot.');
            setLoading(false);
            setBootstrapped(true);
            return;
          }
          loadPractice(practiceId, currentInitData, plate || '', currentTelegramUserId, currentPracticeAccessToken);
        } else {
          if (plate) setValue('plate_confirmed', plate);
          const hadDraft = restoreDraft();
          if (hadDraft) setShowDraftBanner(true);
          setLoading(false);
        }
        setBootstrapped(true);
      } else {
        // Opened from menu -> show dashboard
        setCurrentView('dashboard');
        setLoading(false);
        setBootstrapped(true);
      }
    } else {
      // Standalone browser/dev mode: allow the real backend to load with an empty initData header.
      setInitData('');
      const currentTelegramUserId =
        extractTelegramUserIdFromLocation() || extractTelegramUserIdFromRuntime() || (localDevRealApiMode ? DEV_TELEGRAM_USER_ID : '');
      const currentPracticeAccessToken = extractPracticeAccessTokenFromLocation();
      setTelegramUserId(currentTelegramUserId);
      setPracticeAccessToken(currentPracticeAccessToken);
      stripSensitiveAuthParamsFromUrl();
      const urlParams = new URLSearchParams(window.location.search);
      const demoMode = urlParams.get('demo');
      const practiceId = urlParams.get('practice_id');
      const plate = urlParams.get('plate');

      if (demoMode === 'complete' || demoMode === 'full') {
        setBootstrapped(true);
        applyDemoTemplate();
        return;
      }

      if (practiceId || plate) {
        setStartedFromBot(true);
        setCurrentView('form');
        if (practiceId) {
          if (!currentTelegramUserId) {
            rememberError('miniapp.bootstrap', { response: { status: 401, data: { detail: 'standalone_missing_auth' } }, message: 'Standalone bootstrap missing Telegram auth' }, {
              method: 'BOOT',
              url: window.location.href,
              params: { practice_id: practiceId, plate: plate || '' },
            });
            setError('Autenticazione Telegram assente. Riapri la Mini App dal pulsante del bot.');
            setLoading(false);
            setBootstrapped(true);
            return;
          }
          loadPractice(practiceId, '', plate || '', currentTelegramUserId, currentPracticeAccessToken);
        } else {
          if (plate) setValue('plate_confirmed', plate);
          const hadDraft = restoreDraft();
          if (hadDraft) setShowDraftBanner(true);
          setLoading(false);
        }
        setBootstrapped(true);
      } else {
        setCurrentView('dashboard');
        setLoading(false);
        setBootstrapped(true);
      }
    }
  }, [loadPractice, setValue, restoreDraft, applyDemoTemplate]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Contexts ---
  const toggleContext = (context) => {
    const newContexts = selectedContexts.includes(context)
      ? selectedContexts.filter(c => c !== context)
      : [...selectedContexts, context];
    setSelectedContexts(newContexts);
    setValue('contexts', newContexts);
    if (!sections[context]) {
      setSections(prev => ({
        ...prev,
        [context]: { description_rows: [''], man_hours: '', mac_hours: '', materials_amount: '', waste_apply: false, waste_percentage: 2, notes: '' }
      }));
    }
  };

  const updateSection = (context, field, value) => {
    setSections(prev => {
      const current = prev[context] || {};
      return { ...prev, [context]: { ...current, [field]: value } };
    });
  };

  const addDescriptionRow = (context) => {
    setSections(prev => {
      const current = prev[context] || {};
      const rows = Array.isArray(current.description_rows) ? current.description_rows : [''];
      return { ...prev, [context]: { ...current, description_rows: [...rows, ''] } };
    });
  };

  const removeDescriptionRow = (context, index) => {
    setSections(prev => {
      const current = prev[context] || {};
      const rows = Array.isArray(current.description_rows) ? current.description_rows : [''];
      return { ...prev, [context]: { ...current, description_rows: rows.filter((_, i) => i !== index) } };
    });
  };

  const updateDescriptionRow = (context, index, value) => {
    setSections(prev => {
      const current = prev[context] || {};
      const rows = Array.isArray(current.description_rows) ? current.description_rows : [''];
      return { ...prev, [context]: { ...current, description_rows: rows.map((row, i) => i === index ? value : row) } };
    });
  };

  // --- Parts ---
  const getPartsForContext = (context) => parts[context] || [];

  const addPart = (context) => {
    setParts(prev => ({ ...prev, [context]: [...(prev[context] || []), { name: '', quantity: '', _key: Date.now() + Math.random() }] }));
  };

  const removePart = (context, index) => {
    setParts(prev => ({ ...prev, [context]: (prev[context] || []).filter((_, i) => i !== index) }));
  };

  const updatePart = (context, index, field, value) => {
    setParts(prev => ({ ...prev, [context]: (prev[context] || []).map((p, i) => i === index ? { ...p, [field]: value } : p) }));
  };

  const buildYapPreviewFormPayload = useCallback(() => {
    const data = getValues();
    const plate = (data.plate_confirmed || '').trim();
    const phone = (data.phone || '').trim();
    const name = (data.customer_name || '').trim();
    if (!plate || !phone || !name || selectedContexts.length === 0) {
      return null;
    }
    if (scheduleManually && (!data.appointment_date || !data.appointment_time)) {
      return null;
    }
    // La revisione non richiede righe descrittive.
    const hasRows = selectedContexts
      .filter((ctx) => ctx !== 'revisione')
      .every((ctx) => (sections[ctx]?.description_rows || []).some((row) => (row || '').trim()));
    if (!hasRows) return null;

    const sectionPayloads = selectedContexts.map((context) => {
      const section = sections[context] || {};
      return {
        context,
        description_rows: (section.description_rows || []).filter((row) => (row || '').trim()),
        man_hours: section.man_hours === '' ? null : section.man_hours,
        mac_hours: section.mac_hours === '' ? null : section.mac_hours,
        materials_amount: section.materials_amount === '' ? null : section.materials_amount,
        waste_apply: section.waste_apply || false,
        waste_percentage: section.waste_apply ? (section.waste_percentage || 2) : null,
        notes: section.notes || null,
      };
    });

    const partPayloads = [];
    for (const context of selectedContexts) {
      for (const p of (parts[context] || []).filter((item) => (item.name || '').trim())) {
        partPayloads.push({
          context,
          name: p.name.trim(),
          quantity: (p.quantity || '').trim() || null,
        });
      }
    }

    return {
      practice: {
        plate_confirmed: plate,
        phone,
        customer_name: name,
        customer_type: data.customer_type || 'privato',
        billing_to_complete: data.billing_to_complete || false,
        company_name: data.company_name?.trim() || null,
        vat_number: data.vat_number?.trim() || null,
        fiscal_code: data.fiscal_code?.trim() || null,
        billing_address: data.billing_address?.trim() || null,
        billing_city: data.billing_city?.trim() || null,
        billing_zip: data.billing_zip?.trim() || null,
        appointment_date: scheduleManually ? formatDateForBackend(data.appointment_date) : formatDateForBackend(new Date()),
        appointment_time: scheduleManually ? data.appointment_time : nowRoundedToSlot(),
        practice_type: data.practice_type || 'ordine_di_lavoro',
        contexts: selectedContexts,
        internal_notes: data.internal_notes || null,
      },
      sections: sectionPayloads,
      parts: partPayloads,
    };
  }, [getValues, selectedContexts, sections, parts, scheduleManually]);

  const renderFieldMappingTable = (rows, title) => {
    if (!rows?.length) return null;
    return (
      <div className="yap-field-map-group">
        <h4 className="yap-field-map-heading">{title}</h4>
        <table className="yap-field-map-table">
          <thead>
            <tr>
              <th>Giorgio</th>
              <th>Dove in YAP</th>
              <th>Valore</th>
              <th>Chi scrive</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.giorgio}-${i}`} className={`yap-fm-${r.writer || r.automation}`}>
                <td>{r.giorgio}</td>
                <td title={r.yap}>{r.yapPath || r.yap}</td>
                <td>{r.value != null && r.value !== '' ? String(r.value) : '—'}</td>
                <td><span className="yap-fm-badge">{r.writerLabel || r.automation}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderYapPreviewPanel = (preview, loading, { showOdl = true, title = '📅 Anteprima YAP (mapping completo)' } = {}) => {
    const fm = preview?.proposedYap?.fieldMapping;
    return (
    <div className="section yap-preview-section">
      <h2>{title}</h2>
      <p className="yap-preview-intro">
        Mappa completa: per ogni campo Giorgio indica <strong>dove</strong> va in YAP (agenda, pratica, ordini di lavoro).
        «Giorgio worker» = già automatizzato in agenda; «pianificato» = destinazione definita, prossimo step worker ODL.
      </p>
      {fm?.mappingNote && <p className="yap-preview-hint">{fm.mappingNote}</p>}
      {preview?.confidence?.cosaNote && (
        <p className="yap-preview-hint">{preview.confidence.cosaNote}</p>
      )}
      {loading && <div className="yap-preview-loading">Calcolo anteprima…</div>}
      {!loading && preview?.proposedYap?.popup && (
        <>
          <div className="yap-preview-grid">
            <div className="yap-preview-field">
              <span className="yap-preview-label">Cosa</span>
              <span className="yap-preview-value">{preview.proposedYap.popup.cosa || '—'}</span>
            </div>
            <div className="yap-preview-field">
              <span className="yap-preview-label">Quando</span>
              <span className="yap-preview-value">{preview.proposedYap.popup.quando || '—'}</span>
            </div>
            <div className="yap-preview-field">
              <span className="yap-preview-label">Dalle</span>
              <span className="yap-preview-value">{preview.proposedYap.popup.dalle || '—'}</span>
            </div>
            <div className="yap-preview-field">
              <span className="yap-preview-label">Alle</span>
              <span className="yap-preview-value">{preview.proposedYap.popup.alle || '—'}</span>
            </div>
          </div>
          {(preview.proposedYap.popup.tag || []).length > 0 && (
            <div className="yap-preview-tags">
              {(preview.proposedYap.popup.tag || []).map((tag) => (
                <span key={tag} className="yap-tag-chip">{tag}</span>
              ))}
            </div>
          )}
          {preview.giorgioSummary?.cosa_breve && (
            <div className="yap-preview-brief">
              Titolo breve lavoro: <strong>{preview.giorgioSummary.cosa_breve}</strong>
              <span className="yap-preview-brief-hint"> (priorità: officina → carrozzeria → revisione)</span>
            </div>
          )}
          {preview?.proposedYap?.popup?.alle && (
            <div className="yap-preview-slot-end">
              Fine slot YAP (20 min): <strong>{preview.proposedYap.popup.alle.replace('.', ':')}</strong>
            </div>
          )}
          {preview.giorgioSummary?.note_interne && (
            <div className="yap-preview-notes">
              <span className="yap-preview-label">Note interne</span>
              <pre className="yap-preview-notes-body">{preview.giorgioSummary.note_interne}</pre>
            </div>
          )}
          {preview.preSync && (
            <div className={`yap-preview-readiness ${preview.preSync.ready ? 'ready' : 'not-ready'}`}>
              {preview.preSync.ready
                ? `Pronta per sync • score ${preview.preSync.score}/100`
                : `Non ancora pronta • score ${preview.preSync.score}/100`}
            </div>
          )}
          {preview.preSync?.issues?.length > 0 && (
            <div className="yap-preview-issues">
              {preview.preSync.issues.map((issue, index) => {
                const level = issue.blocking
                  ? 'blocking'
                  : (issue.type === 'info' ? 'info' : 'warning');
                const levelLabel = level === 'blocking'
                  ? 'Bloccante'
                  : (level === 'info' ? 'Info' : 'Attenzione');
                return (
                  <div
                    key={`${issue.type}-${index}`}
                    className={`yap-preview-issue ${level}`}
                  >
                    <div className="yap-preview-issue-head">
                      <span>{levelLabel}</span>
                      <span>{issue.type}</span>
                    </div>
                    <div className="yap-preview-issue-body">{issue.message}</div>
                  </div>
                );
              })}
            </div>
          )}
          {showOdl && preview.proposedYap?.odl && (
            <div className="yap-odl-preview">
              <h3 className="yap-odl-title">Gestione pratica / ODL</h3>
              <p className="yap-odl-reason">{preview.proposedYap.odl.reason}</p>
              {preview.proposedYap.odl.pageLabel && (
                <p className="yap-odl-reason">Pagina scelta: {preview.proposedYap.odl.pageLabel}</p>
              )}
              {(preview.proposedYap.odl.lavorazioniGiorgio || []).map((lav, idx) => (
                <div key={`${lav.reparto}-${idx}`} className="yap-odl-reparto">
                  <span className="context-badge yap-odl-badge">{lav.reparto}</span>
                  <ul className="yap-odl-lines">
                    {(lav.descrizioni || []).map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                  {lav.noteReparto && (
                    <div className="yap-odl-note-reparto">Note: {lav.noteReparto}</div>
                  )}
                  {lav.ore_man != null && <div className="yap-odl-metric">MAN: {lav.ore_man} h</div>}
                  {lav.ore_mac != null && <div className="yap-odl-metric">MAC: {lav.ore_mac} h</div>}
                  {lav.materiali_euro != null && <div className="yap-odl-metric">Materiali: €{lav.materiali_euro}</div>}
                  {lav.smaltimento?.applica && (
                    <div className="yap-odl-metric">Smaltimento: {lav.smaltimento.percentuale ?? 2}%</div>
                  )}
                  {(lav.ricambi || []).length > 0 && (
                    <div className="yap-odl-ricambi">
                      Ricambi: {(lav.ricambi || []).map((r) => r.name).filter(Boolean).join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {fm && (
            <div className="yap-field-map-section">
              <h3 className="yap-odl-title">Mappa campi Giorgio → YAP</h3>
              {fm.summary && (
                <p className="yap-field-map-summary">
                  Agenda worker: { (fm.summary.agendaWorker || fm.summary.v1GiorgioWrites || []).join(', ') } ·
                  ODL pianificato: { (fm.summary.odlWorkerPlanned || fm.summary.v2GiorgioOptional || []).join(', ') }
                </p>
              )}
              {renderFieldMappingTable(fm.anagrafica, 'Anagrafica → pratica / barra agenda')}
              {renderFieldMappingTable(fm.agenda, 'Agenda — popup appuntamento')}
              {renderFieldMappingTable(fm.agendaBar, 'Agenda — barra evento')}
              {renderFieldMappingTable(fm.gestionePratica, 'Gestione pratica')}
              {(fm.ordiniDiLavoro || fm.lavorazioni || []).map((lav) =>
                renderFieldMappingTable(lav.fields, `Ordini di lavoro — ${lav.reparto}`)
              )}
              {renderFieldMappingTable(fm.altro, 'Altro')}
            </div>
          )}
        </>
      )}
      {!loading && !preview?.proposedYap?.popup && (
        <div className="yap-preview-empty">{preview?.emptyMessage || 'Completa targa, data, ora, contesti e almeno una riga descrittiva per vedere l&apos;anteprima.'}</div>
      )}
    </div>
    );
  };

  const watchedPlate = watch('plate_confirmed');
  const watchedPhone = watch('phone');
  const watchedCustomer = watch('customer_name');
  const watchedDate = watch('appointment_date');
  const watchedTime = watch('appointment_time');
  const watchedPracticeType = watch('practice_type');
  const watchedCustomerType = watch('customer_type');
  // Revisione "pura": unico contesto selezionato = revisione. In questo caso
  // niente righe descrittive, niente tipo pratica (non servono su YAP).
  const isRevisioneOnly = selectedContexts.length > 0 && selectedContexts.every((c) => c === 'revisione');

  useEffect(() => {
    if (browserPreviewMode || currentView !== 'form') return undefined;

    if (formYapPreviewTimerRef.current) clearTimeout(formYapPreviewTimerRef.current);
    formYapPreviewTimerRef.current = setTimeout(async () => {
      const body = buildYapPreviewFormPayload();
      if (!body) {
        setFormYapPreview(null);
        setFormYapPreviewLoading(false);
        return;
      }
      setFormYapPreviewLoading(true);
      try {
        const res = await axios.post(
          `${API_BASE_URL}/yap-mapping-preview/from-form`,
          body,
          { params: getAuthParams(), headers: getHeaders(), timeout: 15000 }
        );
        setFormYapPreview(res.data?.data || null);
      } catch {
        setFormYapPreview(null);
      } finally {
        setFormYapPreviewLoading(false);
      }
    }, 600);

    return () => {
      if (formYapPreviewTimerRef.current) clearTimeout(formYapPreviewTimerRef.current);
    };
  }, [
    browserPreviewMode,
    currentView,
    buildYapPreviewFormPayload,
    watchedPlate,
    watchedPhone,
    watchedCustomer,
    watchedDate,
    watchedTime,
    watchedPracticeType,
    watchedCustomerType,
    selectedContexts,
    sections,
    parts,
    getAuthParams,
    getHeaders,
  ]);

  // --- Delete practice ---
  const deletePractice = (practiceToDelete) => {
    const p = practiceToDelete || practice;
    if (!p || !p.id) return;
    setConfirmModal({
      title: '🗑 Cancellare pratica?',
      message: 'Questa operazione non è reversibile. Vuoi procedere?',
      onConfirm: async () => {
        setConfirmModal(null);
        if (browserPreviewMode) {
          invalidatePracticeCaches(p.id);
          const nextPreviewPractices = previewPractices.filter(pr => String(pr.id) !== String(p.id));
          const visibleItems = filterPreviewPractices(nextPreviewPractices, searchQuery, activeFilters);
          setPreviewPractices(nextPreviewPractices);
          setPractices(visibleItems);
          setStats(buildPreviewStats(nextPreviewPractices));
          setPreSyncByPractice(buildPreviewPreSyncMap(visibleItems));
          setCurrentView('dashboard');
          setNavigationStack([]);
          setSelectedPracticeId(null);
          setDetailData(null);
          addToast('Pratica rimossa', 'success');
          return;
        }

        setSaving(true);
        startYapActionProgress('delete', p.id, 'Eliminazione pratica in corso...');
        const reqStartMs = Date.now();
        try {
          // 400s: attesa lock YAP (fino a 100s) + worker delete con cascata
          // preventivo/ODL (fino a 230s, SENZA retry safe-mode lato server) + margine.
          // Con un timeout piu' corto del caso peggiore il client mollava mentre il
          // server lavorava ancora -> falso "Errore di rete" e log vuoto.
          const res = await axios.delete(`${API_BASE_URL}/practices/${p.id}`, { params: getAuthParams(), headers: getHeaders(), timeout: 400000 });
          // L'endpoint e' uno STREAM (heartbeat \n + JSON finale): axios a volte consegna
          // res.data come stringa. Normalizziamo a oggetto.
          let body = res?.data;
          if (typeof body === 'string') { try { body = JSON.parse(body.trim()); } catch { body = {}; } }
          // Risposta di FALLIMENTO YAP (blocco preventivo/ODL o crash): il backend risponde
          // 200 con success:false. Senza questo blocco veniva scambiata per successo e
          // l'utente non vedeva ne' errore ne' log. Mostriamo il banner col log e restiamo.
          if (body && body.success === false) {
            const errObj = (body.errors && typeof body.errors === 'object') ? body.errors : { detail: String(body.errors || '') };
            const errMsg = errObj.detail || errObj.message || 'Eliminazione YAP fallita.';
            setYapLastPracticeId(p.id);
            setYapLastResult(normalizeYapResult({
              status: errObj.failure_status || 'delete_failed',
              message: errMsg,
              worker_phases: errObj.worker_phases || [],
              stderr_tail: errObj.stderr_tail || '',
              stdout_tail: errObj.stdout_tail || '',
              runner: errObj.runner || null,
              error: errObj,
            }));
            finishYapActionProgress(errMsg, 'error', 0);
            addToast(errMsg, 'error');
            return; // resta sul dettaglio per leggere/copiare il log
          }
          // Il backend distingue "eliminata anche su YAP" da "eliminata SOLO localmente"
          // (appuntamento non trovato / dati mancanti): mostra il messaggio vero.
          const deleteMessage = body?.data?.message || 'Pratica cancellata con successo';
          const yapInfo = body?.data?.yap;
          const yapWarning = Boolean(yapInfo && (!yapInfo.attempted || !yapInfo.deleted));
          // Se YAP NON ha eliminato (ODL/preventivo bloccante, ecc.) mostra il banner con
          // il log worker copiabile prima di lasciare il dettaglio.
          if (yapWarning) {
            setYapLastPracticeId(p.id);
            setYapLastResult(normalizeYapOutcome(body?.data || {}));
          }
          finishYapActionProgress(yapWarning ? deleteMessage : 'Pratica eliminata', yapWarning ? 'error' : 'success', yapWarning ? 4000 : 800);
          invalidatePracticeCaches(p.id);
          clearDraft();
          addToast(deleteMessage, yapWarning ? 'error' : 'success');
          setPractices(prev => prev.filter(pr => pr.id !== p.id));
          setStats(prev => prev ? { ...prev, total: prev.total - 1, pending_sync: p.synced ? prev.pending_sync : prev.pending_sync - 1 } : prev);
          if (yapWarning) {
            // Resta sul dettaglio: l'utente deve poter leggere/copiare il log dell'errore YAP.
            return;
          }
          await new Promise(r => setTimeout(r, 900));
          setCurrentView('dashboard');
          setNavigationStack([]);
          setSelectedPracticeId(null);
          setDetailData(null);
        } catch (err) {
          // La richiesta HTTP puo' MORIRE per timeout proxy mentre lo script YAP gira
          // ancora (delete lente con cascata preventivo): in quel caso "err" non ha corpo
          // e il log resta vuoto. Il backend pero' persiste l'esito in last-delete.json
          // quando lo script finisce: lo recuperiamo in polling (cercando un dump piu'
          // recente dell'inizio richiesta) cosi' il log e' comunque visibile/copiabile.
          let recovered = null;
          const hadResponse = Boolean(err?.response);
          if (!hadResponse) {
            updateYapActionProgress({ percent: 95, label: 'Connessione interrotta: recupero l’esito dal server…' });
            // Il task server-side ora scrive SEMPRE last-delete.json anche a client
            // disconnesso: il dump arriva al massimo entro il timeout script (230s).
            // Poll fino a ~2 minuti per coprire la coda piu' lunga.
            for (let attempt = 0; attempt < 20 && !recovered; attempt += 1) {
              await new Promise(r => setTimeout(r, attempt === 0 ? 2000 : 6000));
              try {
                const dumpRes = await axios.get(`${API_BASE_URL}/yap/last-delete`, { params: getAuthParams(), headers: getHeaders(), timeout: 15000 });
                const dump = dumpRes?.data?.data;
                const dumpMs = dump?.ts ? Date.parse(dump.ts) : NaN;
                const fresh = Number.isFinite(dumpMs) && dumpMs >= (reqStartMs - 5000);
                if (dump?.found && String(dump.practice_id) === String(p.id) && fresh) {
                  recovered = normalizeYapResult({
                    status: dump.status || (dump.deleted ? 'deleted' : 'delete_failed'),
                    message: dump.deleted ? 'Appuntamento eliminato da YAP.' : (dump.error || 'Eliminazione YAP non confermata (connessione interrotta).'),
                    action_target: 'delete',
                    worker_phases: dump.worker_phases || [],
                    stderr_tail: dump.stderr_tail || '',
                    stdout_tail: dump.stdout_tail || '',
                    runner: dump.runner || null,
                    error: dump,
                  });
                }
              } catch (_) { /* riprova */ }
            }
          }
          const errorResult = recovered || buildYapErrorResult(err, 'delete_failed');
          // Mostra il banner col log copiabile, non solo il toast.
          setYapLastPracticeId(p.id);
          setYapLastResult(errorResult);
          if (recovered && (recovered.status === 'deleted' || recovered.status === 'not_found')) {
            // Lo script E' riuscito lato server nonostante la connessione caduta.
            invalidatePracticeCaches(p.id);
            setPractices(prev => prev.filter(pr => pr.id !== p.id));
            finishYapActionProgress('Appuntamento eliminato da YAP (recuperato dopo timeout)', 'success', 1500);
            addToast('Eliminazione confermata dal server (la connessione era caduta).', 'success');
          } else {
            const msg = errorResult.message || classifyError(err);
            finishYapActionProgress(msg, 'error', 0);
            addToast(msg, 'error');
          }
        } finally {
          setSaving(false);
        }
      },
      onCancel: () => setConfirmModal(null)
    });
  };

  // --- Client-side validation ---
  const validateFields = (data) => {
    const errs = {};
    const name = (data.customer_name || '').trim();
    if (!name) errs.customer_name = 'Nome obbligatorio';
    else if (name.length < 2) errs.customer_name = 'Nome troppo corto (min 2 caratteri)';
    else if (name.length > 100) errs.customer_name = 'Nome troppo lungo (max 100 caratteri)';

    const plate = (data.plate_confirmed || '').trim();
    if (!plate) errs.plate_confirmed = 'Targa obbligatoria';
    else if (!isValidItalianPlate(plate)) errs.plate_confirmed = 'Formato targa non valido (es. AB123CD)';

    const phone = (data.phone || '').trim();
    if (!phone) errs.phone = 'Telefono obbligatorio';
    else if (!isValidItalianPhone(phone)) errs.phone = 'Numero di telefono italiano non valido';

    // Data/ora obbligatorie solo se l'utente ha scelto di impostarle manualmente.
    if (scheduleManually) {
      if (!data.appointment_date) errs.appointment_date = 'Data obbligatoria';
      if (!data.appointment_time) errs.appointment_time = 'Ora obbligatoria';
      else if (!APPOINTMENT_TIME_OPTIONS.includes(data.appointment_time)) errs.appointment_time = `Ora fuori fascia YAP (${YAP_APPOINTMENT_MIN_TIME}-${YAP_APPOINTMENT_MAX_TIME})`;
    }
    if (selectedContexts.length === 0) errs.contexts = 'Seleziona almeno un contesto';
    selectedContexts.forEach(context => {
      // La revisione non ha righe descrittive (non vanno da nessuna parte su YAP).
      if (context === 'revisione') return;
      const rows = sections[context]?.description_rows || [];
      if (!rows.some(row => (row || '').trim())) {
        errs.contexts = `Inserisci almeno una riga descrittiva per ${context}`;
      }
      const waste = sections[context]?.waste_percentage;
      if (sections[context]?.waste_apply && (Number.isNaN(Number(waste)) || Number(waste) < 0 || Number(waste) > 100)) {
        errs.contexts = 'La percentuale smaltimento deve essere tra 0 e 100';
      }
    });

    return errs;
  };

  const scrollToFirstError = (errs) => {
    const firstKey = Object.keys(errs)[0];
    if (!firstKey) return;
    const el = document.querySelector(`[name="${firstKey}"], [data-field="${firstKey}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // --- Submit ---
  const onSubmit = async (data) => {
    const validationErrors = validateFields(data);
    if (Object.keys(validationErrors).length > 0) {
      setFieldErrors(validationErrors);
      scrollToFirstError(validationErrors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    setSubmitInProgress(true);
    setError('');
    startSlowTimer();
    startSaveProgress('Verifica dati e salvataggio in corso...', 'validate');
    const saveHintTimers = [];

    try {
      const practicePayload = {
        plate_confirmed: data.plate_confirmed,
        phone: data.phone,
        customer_name: data.customer_name,
        customer_type: data.customer_type,
        billing_to_complete: data.billing_to_complete || false,
        appointment_date: scheduleManually ? formatDateForBackend(data.appointment_date) : formatDateForBackend(new Date()),
        appointment_time: scheduleManually ? data.appointment_time : nowRoundedToSlot(),
        practice_type: data.practice_type,
        contexts: selectedContexts,
        internal_notes: data.internal_notes || null,
      };

      const sectionPayloads = selectedContexts.map(context => {
        const section = sections[context] || {};
        return {
          context,
          description_rows: (section.description_rows || []).filter(row => (row || '').trim()),
          man_hours: section.man_hours === '' ? null : section.man_hours,
          mac_hours: section.mac_hours === '' ? null : section.mac_hours,
          materials_amount: section.materials_amount === '' ? null : section.materials_amount,
          waste_apply: section.waste_apply || false,
          waste_percentage: section.waste_apply ? (section.waste_percentage || 2) : null,
          notes: section.notes || null,
        };
      });

      const partPayloads = [];
      for (const context of selectedContexts) {
        const list = (parts[context] || []).filter(p => (p.name || '').trim());
        for (const p of list) {
          partPayloads.push({ context, name: p.name.trim(), quantity: (p.quantity || '').trim() || null });
        }
      }

      const payload = { practice: practicePayload, sections: sectionPayloads, parts: partPayloads };

      if (browserPreviewMode) {
        const previewId = practice?.id || `preview-${previewSeqRef.current++}`;
        const previewPhotos = [
          ...existingPhotos,
          ...formPhotos.map((item, index) => ({
            id: `${previewId}-photo-${Date.now()}-${index}`,
            url: item.preview,
            thumbnail: item.preview,
          })),
        ];
        const previewItem = {
          id: previewId,
          ...practicePayload,
          plate: practicePayload.plate_confirmed,
          synced: practice?.synced || false,
          status: 'preview',
          created_at: practice?.created_at || new Date().toISOString(),
          sections: sectionPayloads,
          parts: partPayloads,
          photos: previewPhotos,
          _preview: true,
        };

        setPreviewPractices(prev => (
          practice
            ? prev.map(p => String(p.id) === String(practice.id) ? previewItem : p)
            : [previewItem, ...prev]
        ));
        clearDraft();
        addToast(practice ? 'Pratica aggiornata' : 'Pratica creata', 'success');

        setSelectedPracticeId(previewId);
        setYapLastPracticeId(previewId);
        setYapLastResult({ status: 'dry_run', simulated: true, message: 'Anteprima: nessuna scrittura reale su YAP.' });
        setDetailData(buildPreviewDetail(previewItem));
        setDetailTab('yap');
        setCurrentView('detail');
        setNavigationStack(['dashboard']);
        setEditingPractice(null);
        setPractice(null);
        setFormPhotos([]);
        setExistingPhotos(previewPhotos);
        finishSaveProgress(practice ? 'Pratica aggiornata in anteprima.' : 'Pratica creata in anteprima.', 'success', 800);
        return;
      }

      let response;
      if (practice) {
        rememberRequest('practice.update', { method: 'PUT', url: `${API_BASE_URL}/practices/${practice.id}/full`, params: getAuthParams(), headers: getHeaders() });
        response = await fetchWithRetry(() =>
            axios.put(`${API_BASE_URL}/practices/${practice.id}/full`, payload, { params: getAuthParams(), headers: getHeaders(), timeout: 30000 })
        );
      } else {
        rememberRequest('practice.create', { method: 'POST', url: `${API_BASE_URL}/practices/full`, params: getAuthParams(), headers: getHeaders() });
        response = await fetchWithRetry(() =>
            axios.post(`${API_BASE_URL}/practices/full`, payload, { params: getAuthParams(), headers: getHeaders(), timeout: 30000 })
        );
      }

      if (response.data.success) {
        rememberResponse(practice ? 'practice.update' : 'practice.create');
        const responseData = response.data.data || {};
        const practiceId = responseData.id || (practice && practice.id);
        if (practiceId) invalidatePracticeCaches(practiceId);

        // Evita la ricreazione automatica della bozza mentre la sync è ancora in corso.
        clearDraft();
        updateSaveProgress({
          label: formPhotos.length > 0 ? `Caricamento ${formPhotos.length} foto...` : 'Preparazione sincronizzazione YAP...',
          stage: formPhotos.length > 0 ? 'photos' : 'sync',
          percent: formPhotos.length > 0 ? 30 : 58,
          status: 'running',
        });

        // Upload queued photos after practice creation
        if (formPhotos.length > 0 && practiceId) {
          await uploadQueuedPhotos(practiceId, (patch) => updateSaveProgress(patch));
        }

        updateSaveProgress({
          label: 'Pratica salvata. Sincronizzazione YAP in esecuzione; percentuale live non disponibile.',
          stage: 'sync',
          percent: 58,
          status: 'running',
        });
        addToast('Salvataggio completato. Sync YAP avviata...', 'info');

        // Keep YAP aligned automatically after a successful save.
        if (practiceId) {
          const syncResult = await syncToYap(practiceId, { dry_run: false, silent: true });
          const actionLabel = practice ? 'aggiornata' : 'creata';
          const finalMessage = syncResult.status === 'complete_synced'
            ? `Pratica ${actionLabel}. YAP completo verificato.`
            : syncResult.status === 'busy'
              ? `Pratica ${actionLabel}. Sync YAP gia in corso.`
            : ['partial_synced', 'agenda_synced', 'synced', 'duplicate'].includes(syncResult.status)
              ? `Pratica ${actionLabel}. ${syncResult.message || 'YAP verificato parzialmente.'}`
            : syncResult.status === 'dry_run'
              ? `Pratica ${actionLabel}. Dry-run YAP completato.`
              : syncResult.status === 'not_ready'
                ? `Pratica ${actionLabel}, ma non pronta per YAP.`
                : `Pratica ${actionLabel}, ma sync YAP fallita: ${syncResult.message || 'errore sconosciuto'}`;
          const bannerSyncResult = ['complete_synced', 'partial_synced', 'agenda_synced', 'synced', 'duplicate', 'busy'].includes(syncResult.status)
            ? syncResult
            : { ...syncResult, message: finalMessage };
          const finalSyncResult = { ...bannerSyncResult };
          setYapLastResult(finalSyncResult);
          finishSaveProgress(finalMessage, syncResult.status === 'sync_failed' ? 'error' : 'success', syncResult.status === 'sync_failed' ? 0 : 1400);
          setSelectedPracticeId(practiceId);
          setDetailTab('yap');
          setCurrentView('detail');
          setNavigationStack(['dashboard']);
          const toastTone = syncResult.status === 'sync_failed'
            ? 'error'
            : (['partial_synced', 'agenda_synced', 'not_ready', 'dry_run', 'busy'].includes(syncResult.status) ? 'warning' : 'success');
          addToast(finalMessage, toastTone);
        } else {
          const missingIdMessage = 'Salvataggio completato, ma ID pratica non disponibile.';
          finishSaveProgress(missingIdMessage, 'error', 0);
          addToast(missingIdMessage, 'error');
        }

        setEditingPractice(null);
        setPractice(null);
      } else {
        const apiMessage = response.data?.message || 'Salvataggio non confermato dal server';
        finishSaveProgress(apiMessage, 'error', 0);
        setError(apiMessage);
        addToast(apiMessage, 'error');
      }
    } catch (err) {
      rememberError(practice ? 'practice.update' : 'practice.create', err);
      setError(classifyError(err));
      finishSaveProgress(classifyError(err), 'error', 0);
      addToast(classifyError(err), 'error');
    } finally {
      saveHintTimers.forEach((timerId) => clearTimeout(timerId));
      clearSlowTimer();
      setSaving(false);
      setSubmitInProgress(false);
    }
  };

  // --- Reset form for new practice ---
  const resetFormForNew = useCallback(() => {
    stopSaveProgressTimers();
    setSaveProgress(null);
    setPractice(null);
    setEditingPractice(null);
    setStartedFromBot(false);
    setShowDraftBanner(false);
    setYapLastPracticeId(null);
    setYapLastResult(null);
    setSelectedContexts([]);
    setSections({});
    setParts({});
    setError('');
    setFieldErrors({});
    setSubmitInProgress(false);
    setScheduleManually(false);
    setValue('contexts', []);
    setValue('plate_confirmed', '');
    setValue('phone', '');
    setValue('customer_name', '');
    setValue('customer_type', 'privato');
    setValue('appointment_date', null);
    setValue('appointment_time', '');
    setValue('practice_type', 'preventivo');
    setValue('internal_notes', '');
    setValue('billing_to_complete', false);
    setValue('company_name', '');
    setValue('vat_number', '');
    setValue('fiscal_code', '');
    setValue('billing_address', '');
    setValue('billing_city', '');
    setValue('billing_zip', '');
    setFormPhotos([]);
    setExistingPhotos([]);
    setFormPhotoUploadProgress('');
    setLoading(false);
  }, [setValue, stopSaveProgressTimers]);

  const discardDraft = useCallback(() => {
    clearDraft();
    setShowDraftBanner(false);
    if (practice) {
      const p = practice;
      setValue('plate_confirmed', p.plate_confirmed || p.plate || '');
      setValue('phone', p.phone || '');
      setValue('customer_name', p.customer_name || '');
      setValue('customer_type', p.customer_type || 'privato');
      setValue('appointment_time', p.appointment_time ? clampAppointmentTimeToYapRange(p.appointment_time) : '');
      setValue('practice_type', p.practice_type || 'preventivo');
      setValue('internal_notes', p.internal_notes || p.notes || '');
      setValue('billing_to_complete', p.billing_to_complete || false);
      setValue('company_name', p.company_name || '');
      setValue('vat_number', p.vat_number || '');
      setValue('fiscal_code', p.fiscal_code || '');
      setValue('billing_address', p.billing_address || '');
      setValue('billing_city', p.billing_city || '');
      setValue('billing_zip', p.billing_zip || '');
      if (p.appointment_date) setValue('appointment_date', new Date(p.appointment_date));
      setSelectedContexts(normalizeContexts(p.contexts));
      if (p.sections) {
        setSections(normalizeSections(Array.isArray(p.sections) ? p.sections : []));
      }
      if (p.parts) {
        const pd = {};
        (Array.isArray(p.parts) ? p.parts : []).forEach(pt => {
          if (!pd[pt.context]) pd[pt.context] = [];
          pd[pt.context].push({ name: pt.name || '', quantity: pt.quantity || '', _key: Date.now() + Math.random() });
        });
        setParts(pd);
      }
    } else {
      resetFormForNew();
    }
  }, [clearDraft, resetFormForNew, setValue, practice]);

  // --- Filter toggle ---
  const toggleFilter = (key) => {
    setActiveFilters(prev => {
      if (key === 'synced') {
        const next = prev.synced === null ? false : prev.synced === false ? true : null;
        return { ...prev, synced: next };
      }
      return { ...prev, [key]: !prev[key] };
    });
  };

  // Helper for field error display
  const renderFieldError = (name) => {
    const msg = fieldErrors[name] || errors[name]?.message;
    if (!msg) return null;
    return <div className="field-error">{msg}</div>;
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minAppointmentDate = practice ? null : today;

  // ==================== RENDER ====================

  const openNewPracticeForm = () => {
    resetFormForNew();
    const restored = restoreDraft();
    if (restored) {
      setShowDraftBanner(true);
    }
    setCurrentView('form');
    setNavigationStack(['dashboard']);
  };

  const applyRandomPracticeDraft = () => {
    const randomDraft = buildRandomPracticeDraft();

    const currentValues = getValues();
    const currentContexts = normalizeContexts(currentValues.contexts || selectedContexts);
    const nextContexts = currentContexts.length ? currentContexts : randomDraft.selectedContexts;
    const contextSeeds = nextContexts.length ? nextContexts : randomDraft.selectedContexts;

    if (!currentContexts.length && nextContexts.length) {
      setSelectedContexts(nextContexts);
      setValue('contexts', nextContexts);
    } else if (currentContexts.length) {
      setSelectedContexts(currentContexts);
      setValue('contexts', currentContexts);
    }

    const setIfEmpty = (field, value) => {
      if (isEmptyFormValue(currentValues[field])) {
        setValue(field, value);
      }
    };

    Object.entries(randomDraft.formData).forEach(([field, value]) => {
      setIfEmpty(field, value);
    });

    const nextSections = { ...sections };
    const nextParts = { ...parts };
    contextSeeds.forEach((context) => {
      const existingSection = nextSections[context] || {};
      const generatedSection = randomDraft.sections[context] || randomSectionPayload(context).section;
      const mergedSection = { ...existingSection };

      if (isEmptyFormValue(mergedSection.description_rows)) mergedSection.description_rows = generatedSection.description_rows;
      if (isEmptyFormValue(mergedSection.man_hours)) mergedSection.man_hours = generatedSection.man_hours;
      if (isEmptyFormValue(mergedSection.mac_hours)) mergedSection.mac_hours = generatedSection.mac_hours;
      if (isEmptyFormValue(mergedSection.materials_amount)) mergedSection.materials_amount = generatedSection.materials_amount;
      if (isEmptyFormValue(mergedSection.waste_apply)) mergedSection.waste_apply = generatedSection.waste_apply;
      if (isEmptyFormValue(mergedSection.waste_percentage)) mergedSection.waste_percentage = generatedSection.waste_percentage;
      if (isEmptyFormValue(mergedSection.notes)) mergedSection.notes = generatedSection.notes;

      if (!Array.isArray(mergedSection.description_rows) || mergedSection.description_rows.length === 0) {
        mergedSection.description_rows = generatedSection.description_rows;
      }

      nextSections[context] = mergedSection;

      const existingParts = nextParts[context];
      if (!Array.isArray(existingParts) || existingParts.length === 0) {
        const generatedParts = randomDraft.parts[context] || randomSectionPayload(context).parts;
        if (generatedParts.length) nextParts[context] = generatedParts;
      }
    });

    setSections(nextSections);
    setParts(nextParts);

    if (isEmptyFormValue(currentValues.appointment_date)) {
      setValue('appointment_date', randomDraft.formData.appointment_date);
    }
    if (isEmptyFormValue(currentValues.appointment_time)) {
      setValue('appointment_time', clampAppointmentTimeToYapRange(randomDraft.formData.appointment_time));
    }

    setCurrentView('form');
    setNavigationStack(['dashboard']);
  };

  const deleteMultiplePractices = () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const n = ids.length;
    setConfirmModal({
      title: `🗑 Eliminare ${n} pratica${n > 1 ? 'e' : ''}?`,
      message: `Le pratiche verranno rimosse sia su YAP che localmente. Se l'appuntamento YAP è protetto da ODL, l'eliminazione YAP fallirà ma la pratica locale verrà comunque rimossa. Operazione non reversibile.`,
      onConfirm: async () => {
        setConfirmModal(null);
        setSelectionMode(false);
        setSelectedIds(new Set());
        let deleted = 0;
        let failed = 0;
        startYapActionProgress('batch_delete', null, `Eliminazione in corso… 0/${n}`);
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          updateYapActionProgress({ percent: Math.round(((i) / n) * 100), label: `Eliminazione ${i + 1}/${n} su YAP e locale…` });
          try {
            if (browserPreviewMode) {
              setPractices(prev => prev.filter(pr => String(pr.id) !== String(id)));
            } else {
              // 1. Prima elimina appuntamento YAP (se esiste)
              try {
                const listPractice = Array.isArray(practices)
                  ? practices.find(practiceItem => String(practiceItem.id) === String(id))
                  : null;
                const inferredTime = listPractice?.appointment_time || '';
                if (practiceNeedsYapDelete(listPractice)) {
                  // 340s (NON 60s): un run di delete YAP dura 60-90s+ (login incluso)
                  // e con la cascata preventivo/ODL anche di piu'. Con 60s la richiesta
                  // andava in timeout mentre il worker girava ancora, la pratica veniva
                  // comunque eliminata in locale (skip_yap sotto) e l'appuntamento
                  // restava su YAP senza alcun errore visibile.
                  await axios.delete(`${API_BASE_URL}/practices/${id}/yap/appointment`, {
                    data: inferredTime ? { skip_audit: true, time: inferredTime } : { skip_audit: true },
                    params: getAuthParams(),
                    headers: getHeaders(),
                    timeout: 340000,
                  });
                }
              } catch (yapErr) {
                // detail puo' essere un oggetto (FastAPI): normalizza a stringa.
                const detailText = (() => {
                  const d = yapErr?.response?.data?.detail;
                  if (typeof d === 'string') return d;
                  try { return JSON.stringify(d || ''); } catch { return ''; }
                })();
                // 409 = appuntamento bloccato da preventivo/ODL: NON cancellare la
                // pratica locale, altrimenti resta un appuntamento orfano su YAP
                // senza piu' nessuna pratica da cui ritentare l'eliminazione.
                if (yapErr?.response?.status === 409) {
                  throw yapErr;
                }
                // Se non trovato su YAP, continua comunque
                if (!detailText.includes('not_found') && !detailText.includes('non trovato')) {
                  console.warn(`YAP delete warning for ${id}:`, detailText || yapErr.message);
                }
              }
              // 2. Poi elimina pratica locale
              await axios.delete(`${API_BASE_URL}/practices/${id}`, {
                params: { ...getAuthParams(), skip_yap: true },
                headers: getHeaders(),
                timeout: 15000,
              });
              setPractices(prev => prev.filter(pr => String(pr.id) !== String(id)));
              invalidatePracticeCaches(id);
            }
            deleted++;
          } catch (err) {
            console.error(`Delete failed for ${id}:`, err);
            failed++;
          }
        }
        if (failed > 0) {
          finishYapActionProgress(`${deleted} eliminat${deleted === 1 ? 'a' : 'e'}, ${failed} fallite`, 'error', 4000);
        } else {
          finishYapActionProgress(`${deleted} pratica${deleted > 1 ? 'e' : ''} eliminata${deleted > 1 ? '' : ''}`, 'success', 2500);
        }
        loadDashboard(searchQuery, activeFilters);
      },
      onCancel: () => setConfirmModal(null)
    });
  };

  // --- Dashboard View ---
  const renderDashboard = () => {
    const effectiveDraftCard = (
      dashboardDraftCard && !practices.some((practiceItem) => isDraftDuplicatedByPractice(dashboardDraftCard, practiceItem))
        ? dashboardDraftCard
        : null
    );
    const dashboardItems = effectiveDraftCard ? [effectiveDraftCard, ...practices] : practices;
    const toggleSelect = (id, e) => {
      e.stopPropagation();
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    };
    return (
    <div className="view-dashboard view-enter">
      <div className="container">
        <h1>🔧 Giorgio</h1>
        {showDeveloperUi && (
          <>
            <div className="field-hint" style={{ marginBottom: 12 }}>
              Auth: <strong>{authMode}</strong>
            </div>
            {browserPreviewMode && (
              <div className="preview-banner">
                Modalita anteprima browser: dati demo/locali, nessun salvataggio reale nel gestionale.
              </div>
            )}
          </>
        )}
        <DebugPanel
          authMode={authMode}
          browserPreviewMode={browserPreviewMode}
          errorMessage={error}
          initData={initData}
          telegramUserId={telegramUserId}
          practiceAccessToken={practiceAccessToken}
          lastApiDebug={lastApiDebug}
        />

        {/* Stats */}
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-number">{stats.total}</div>
            <div className="stat-label">Totale</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">{stats.this_month}</div>
            <div className="stat-label">Questo mese</div>
          </div>
          {showDeveloperUi && (
            <div className="stat-card">
              <div className="stat-number">{stats.pending_sync}</div>
              <div className="stat-label">Da sincr.</div>
            </div>
          )}
        </div>

        {/* Search */}
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input
            type="text"
            className="search-input"
            placeholder="Cerca targa, cliente..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="search-clear" onClick={() => setSearchQuery('')} type="button" aria-label="Cancella ricerca">✕</button>
          )}
        </div>

        {/* Filter chips */}
        <div className="filter-chips">
          {['officina', 'carrozzeria', 'revisione'].map(ctx => (
            <button
              key={ctx}
              type="button"
              className={`filter-chip ${activeFilters[ctx] ? 'filter-chip-active' : ''}`}
              style={activeFilters[ctx] ? { background: CONTEXT_COLORS[ctx].bg, borderColor: CONTEXT_COLORS[ctx].border, color: CONTEXT_COLORS[ctx].color } : {}}
              onClick={() => toggleFilter(ctx)}
            >
              {ctx.charAt(0).toUpperCase() + ctx.slice(1)}
            </button>
          ))}
          {showDeveloperUi && (
            <button
              type="button"
              className={`filter-chip ${activeFilters.synced !== null ? 'filter-chip-active' : ''}`}
              onClick={() => toggleFilter('synced')}
            >
              {activeFilters.synced === null ? 'Sincr.' : activeFilters.synced ? '🟢 Sincr.' : '🔴 Non sincr.'}
            </button>
          )}
        </div>

        {showDeveloperUi && (
          <div className="detail-actions" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={seedDemoPractices}
              disabled={seedingDemoPractices}
            >
              {browserPreviewMode
                ? 'Ricarica pratiche demo locali'
                : (seedingDemoPractices ? 'Creazione pratiche demo...' : `Crea ${DASHBOARD_DEMO_PRACTICES.length} pratiche esempio piene`)}
            </button>
          </div>
        )}

        <div className="detail-actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={seedYapTestPractices}
            disabled={seedingYapTestPractices}
          >
            {browserPreviewMode
              ? 'Carica pratiche test YAP locali'
              : (seedingYapTestPractices ? 'Creazione pratiche test YAP...' : `Crea ${YAP_TEST_BATCH_PRACTICES.length} pratiche test YAP (CN401MV)`)}
          </button>
        </div>

        {/* Practice list */}
        {dashboardLoading ? (
          <DashboardSkeleton />
        ) : dashboardItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <h3>Nessuna pratica trovata</h3>
            <p>Prova a modificare i filtri o crea una nuova pratica.</p>
          </div>
        ) : (
          <div className="practice-list">
            {dashboardItems.map(p => {
              const isLocalDraft = p._localDraft === true;
              const preSync = preSyncByPractice[p.id];
              const preSyncReady = preSync?.ready === true;
              const preSyncScore = Number.isFinite(preSync?.score) ? preSync.score : null;
              const isSelected = selectedIds.has(p.id);
              return (
              <div
                key={p.id}
                className={`practice-card ${isLocalDraft ? 'practice-card-draft' : ''} ${selectionMode && isSelected ? 'practice-card-selected' : ''} ${!isLocalDraft && p.management_sync_status ? `card-status-${p.management_sync_status.replace(/_/g, '-')}` : ''}`}
                onClick={() => {
                  if (selectionMode && !isLocalDraft) { toggleSelect(p.id, { stopPropagation: () => {} }); return; }
                  if (isLocalDraft) openNewPracticeForm(); else navigateTo('detail', { practiceId: p.id });
                }}
              >
                <div className="practice-card-header">
                  <span className="practice-plate">{p.plate || (isLocalDraft ? 'BOZZA' : '—')}</span>
                  <span className={`sync-pill ${isLocalDraft ? 'sync-pill-draft' : getYapSyncPillClass(p)}`}>
                    <span className={`sync-dot ${isLocalDraft ? 'sync-dot-draft' : getYapSyncDotClass(p)}`} />
                    {isLocalDraft ? 'Bozza locale' : (formatYapPracticeStatus(p) === 'Non sincronizzata' ? 'Da sincronizzare' : formatYapPracticeStatus(p))}
                  </span>
                </div>
                <div className="practice-card-customer-row">
                  <div className="practice-card-customer">{p.customer_name || (isLocalDraft ? 'Compilazione non completata' : '—')}</div>
                  {showDeveloperUi && <div className="practice-card-id">#{p.id}</div>}
                </div>
                {!isLocalDraft && p.phone && (
                  <div className="practice-card-phone">📞 {p.phone}</div>
                )}
                <div className="practice-card-badges">
                  {normalizeContexts(p.contexts).map(ctx => (
                    <span key={ctx} className="context-badge" style={{ background: CONTEXT_COLORS[ctx]?.bg, color: CONTEXT_COLORS[ctx]?.color, borderColor: CONTEXT_COLORS[ctx]?.border }}>
                      {ctx.charAt(0).toUpperCase() + ctx.slice(1)}
                    </span>
                  ))}
                  {preSync && preSyncScore !== null && (
                    <span className={`pre-sync-pill ${preSyncReady ? 'pre-sync-pill-ready' : 'pre-sync-pill-not-ready'}`}>
                      {preSyncScore}/100
                    </span>
                  )}
                </div>
                <div className="practice-card-footer">
                  <span className="practice-card-date">
                    📅 {formatDate(p.appointment_date || p.created_at)}
                    {!isLocalDraft && p.appointment_time && (
                      <span className="practice-card-time"> • {p.appointment_time}</span>
                    )}
                  </span>
                  {selectionMode && !isLocalDraft ? (
                    <span className={`card-select-indicator ${isSelected ? 'card-select-indicator-on' : ''}`}>
                      {isSelected ? '✓' : '○'}
                    </span>
                  ) : (
                    <span className="practice-card-open">{isLocalDraft ? 'Riprendi bozza →' : 'Apri dettagli →'}</span>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* FAB */}
      {!selectionMode && (
        <button
          className="fab"
          type="button"
          onClick={openNewPracticeForm}
          aria-label="Nuova pratica"
        >
          +
        </button>
      )}

      {/* Selection toolbar */}
      {selectionMode ? (
        <div className="selection-toolbar">
          <div className="selection-toolbar-left">
            <button
              type="button"
              className="selection-all-btn"
              onClick={() => {
                const selectablePractices = practices.filter(pr => !pr._localDraft);
                if (selectedIds.size === selectablePractices.length) {
                  setSelectedIds(new Set());
                } else {
                  setSelectedIds(new Set(selectablePractices.map(pr => pr.id)));
                }
              }}
            >
              {selectedIds.size === practices.filter(pr => !pr._localDraft).length ? 'Deseleziona tutte' : 'Seleziona tutte'}
            </button>
            <span className="selection-count">{selectedIds.size > 0 ? `${selectedIds.size} selezionate` : 'Nessuna selezionata'}</span>
          </div>
          <div className="selection-actions">
            <button
              type="button"
              className="selection-delete-btn"
              disabled={selectedIds.size === 0}
              onClick={deleteMultiplePractices}
            >
              Elimina{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
            </button>
            <button type="button" className="selection-cancel-btn" onClick={() => { setSelectionMode(false); setSelectedIds(new Set()); }}>
              Annulla
            </button>
          </div>
        </div>
      ) : (
        practices.length > 1 && (
          <button
            type="button"
            className="selection-enter-btn"
            onClick={() => { setSelectionMode(true); setSelectedIds(new Set()); }}
          >
            Seleziona
          </button>
        )
      )}
    </div>
  );
  };

  // --- Detail View ---
  const renderDetail = () => {
    if (detailLoading || !detailData) {
      return (
        <div className="view-detail view-enter">
          <div className="container">
            <button className="back-button" onClick={navigateBack} type="button">← Indietro</button>
            {showDeveloperUi && browserPreviewMode && (
              <div className="preview-banner">
                Anteprima locale: puoi provare la logica, ma le modifiche non salvano dati reali.
              </div>
            )}
            <SkeletonLoader />
          </div>
        </div>
      );
    }

    const d = detailData;
    const practice = d.practice || d;
    const photos = d.photos || [];
    const dSections = d.sections || [];
    const dParts = d.parts || [];
    const contexts = normalizeContexts(practice.contexts);
    const appointmentLabel = `${formatDate(practice.appointment_date || practice.created_at)}${practice.appointment_time ? ` • ${practice.appointment_time}` : ''}`;
    const partsByContext = dParts.reduce((acc, part) => {
      const ctx = part.context || 'generale';
      if (!acc[ctx]) acc[ctx] = [];
      acc[ctx].push(part);
      return acc;
    }, {});
    const yapBusy = yapSyncLoading || yapAuditLoading || yapDeleteLoading;
    const currentPracticeYapAction = Boolean(
      yapLastPracticeId === practice.id
      && (yapSyncLoading || yapAuditLoading || yapDeleteLoading || (yapActionProgress && yapActionProgress.status === 'running'))
    );
    const liveYapResult = yapLastPracticeId === practice.id
      ? mergeYapResultWithPersistedAudit(yapLastResult, practice)
      : null;
    const liveAudit = getYapAuditResult(liveYapResult);
    const auditSource = liveAudit ? 'live' : 'persisted';
    const persistedAudit = currentPracticeYapAction ? null : practice.management_audit_result;
    const auditToRender = liveAudit || persistedAudit;
    const openYapTab = () => setDetailTab('yap');
    const runOverviewSync = () => {
      setDetailTab('yap');
      syncToYap(practice.id, { dry_run: false });
    };
    const runOverviewAudit = () => {
      setDetailTab('yap');
      auditYapAppointment(practice.id, { debug: false });
    };

    return (
      <div className="view-detail view-enter">
        <div className="container">
          <button className="back-button" onClick={navigateBack} type="button">← Indietro</button>
          {showDeveloperUi && browserPreviewMode && (
            <div className="preview-banner">
              Anteprima locale: puoi provare la logica, ma le modifiche non salvano dati reali.
            </div>
          )}

          {/* Header info */}
          <div className="detail-header section">
            <div className="detail-plate">{practice.plate_confirmed || practice.plate || '—'}</div>
            <div className="detail-customer">{practice.customer_name || '—'}</div>
            {practice.phone && <div className="detail-phone">📞 {practice.phone}</div>}
            <div className="detail-date">📅 {appointmentLabel}</div>
            <div className="detail-meta-grid">
              <div className="detail-meta-item">
                <span className="detail-meta-label">Tipo pratica</span>
                <span className="detail-meta-value">{practice.practice_type ? practice.practice_type.replaceAll('_', ' ') : '—'}</span>
              </div>
              <div className="detail-meta-item">
                <span className="detail-meta-label">Tipo cliente</span>
                <span className="detail-meta-value">{practice.customer_type || '—'}</span>
              </div>
            {showDeveloperUi && (
              <div className="detail-meta-item">
                <span className="detail-meta-label">Stato pratica</span>
                <span className="detail-meta-value">{practice.status || '—'}</span>
              </div>
            )}
            <div className="detail-meta-item">
              <span className="detail-meta-label">Stato YAP</span>
              <span className="detail-meta-value">
                {formatYapPracticeStatus(practice)}
              </span>
            </div>
            {practice.management_last_sync_at && (
              <div className="detail-meta-item">
                <span className="detail-meta-label">Ultimo sync YAP</span>
                <span className="detail-meta-value">
                  {formatDateTime(practice.management_last_sync_at)}
                </span>
              </div>
            )}
            <div className="detail-meta-item">
              <span className="detail-meta-label">Contesti</span>
              <span className="detail-meta-value">{contexts.length ? contexts.join(', ') : '—'}</span>
            </div>
          </div>
        </div>

          <div className="detail-tabs section">
            {[
              { key: 'overview', label: 'Panoramica' },
              { key: 'works', label: 'Lavori' },
              { key: 'parts', label: 'Ricambi' },
              { key: 'photos', label: `Foto (${photos.length})` },
              { key: 'yap', label: 'YAP' },
            ].map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`detail-tab-button ${detailTab === tab.key ? 'active' : ''}`}
                onClick={() => setDetailTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {detailTab === 'yap' && (
            <>
          {yapLastPracticeId === practice.id && renderYapResultBanner(liveYapResult, { practiceId: practice.id, showRetry: true, showDelete: true })}

          {/* Log worker persistito: visibile anche dopo un reload / riapertura pratica. */}
          {yapLastPracticeId !== practice.id && (() => {
            let mar = practice.management_audit_result;
            if (typeof mar === 'string') {
              try { mar = JSON.parse(mar); } catch { mar = null; }
            }
            return renderWorkerLogPanel(mar?.worker_phases);
          })()}

          {currentPracticeYapAction && !liveAudit && (
            <div className="section yap-audit-section">
              <div className="yap-audit-message">
                <strong>Controllo YAP in aggiornamento:</strong> sto aspettando l'esito corrente della sincronizzazione prima di mostrarti il riepilogo.
              </div>
            </div>
          )}

          {renderYapAuditReport(
            auditToRender,
            {
              result: liveYapResult,
              practice,
              source: auditSource,
            },
          )}

          {!browserPreviewMode && renderYapPreviewPanel(yapPreview, yapPreviewLoading)}

          {/* YAP Automation Controls */}
          {!browserPreviewMode && (
            <div className="section">
              <h2>🔧 Automazione YAP</h2>
              <div className="detail-sync-actions">
                <button
                  type="button"
                  className="detail-sync-action detail-sync-action-primary"
                  onClick={() => syncToYap(practice.id, { dry_run: false })}
                  disabled={yapBusy}
                >
                  {yapSyncLoading ? 'Sincronizzazione...' : 'Sincronizza con YAP'}
                </button>
                {(['partial_synced', 'sync_failed', 'complete_synced', 'agenda_synced'].includes(practice.management_sync_status)) && (
                  <button
                    type="button"
                    className="detail-sync-action"
                    onClick={() => auditYapAppointment(practice.id, { debug: false })}
                    disabled={yapBusy}
                  >
                    {yapAuditLoading ? 'Verifica...' : 'Verifica YAP'}
                  </button>
                )}
                <button
                  type="button"
                  className="detail-sync-action detail-sync-action-danger"
                  onClick={() => deleteYapAppointment(practice.id, { dry_run: false })}
                  disabled={yapBusy}
                >
                  {yapDeleteLoading ? 'Eliminazione...' : 'Elimina da YAP'}
                </button>
              </div>
            </div>
          )}

          {/* Esito ultima azione YAP (sync/audit/delete) anche nel dettaglio: senza
              questo, un errore di "Elimina da YAP" mostrava solo un toast e NESSUN
              log copiabile (il banner esisteva solo nella lista dashboard). */}
          {!browserPreviewMode && yapLastPracticeId === practice.id && renderYapResultBanner(liveYapResult, { practiceId: practice.id, showRetry: true, showDelete: false })}
            </>
          )}

          {/* Sync status */}
          {detailTab === 'overview' && (
            <>
              <div className="section detail-sync-section">
                <div className="detail-sync-label">Stato sincronizzazione</div>
                <div className={`detail-sync-toggle ${getYapDetailToggleClass(practice)}`}>
                  <span className={`sync-dot ${getYapSyncDotClass(practice)}`} />
                  {formatYapPracticeStatus(practice)}
                </div>
                <div className="detail-sync-help">
                  Da qui puoi rilanciare subito la sync. La tab YAP resta il pannello completo con audit, errori e dettagli.
                </div>
                <div className="detail-sync-actions">
                  <button
                    type="button"
                    className="detail-sync-action detail-sync-action-primary"
                    onClick={runOverviewSync}
                    disabled={yapBusy}
                  >
                    {getYapOverviewSyncButtonLabel(practice, yapSyncLoading)}
                  </button>
                  {(['partial_synced', 'sync_failed', 'complete_synced', 'agenda_synced'].includes(practice.management_sync_status)) && (
                    <button
                      type="button"
                      className="detail-sync-action"
                      onClick={runOverviewAudit}
                      disabled={yapBusy}
                    >
                      {yapAuditLoading ? 'Verifica...' : 'Verifica YAP'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="detail-sync-action detail-sync-action-secondary"
                    onClick={openYapTab}
                  >
                    Dettagli YAP
                  </button>
                </div>
              </div>
              <div className="section detail-overview-section">
                {practice.internal_notes && (
                  <div className="detail-overview-block">
                    <div className="detail-overview-label">Note interne</div>
                    <div className="detail-overview-value">{practice.internal_notes}</div>
                  </div>
                )}
                {dSections.length > 0 && (
                  <div className="detail-overview-block">
                    <div className="detail-overview-label">Lavori principali</div>
                    <div className="detail-overview-list">
                      {dSections.slice(0, 3).map((sectionItem, idx) => {
                        const rows = Array.isArray(sectionItem.description_rows) ? sectionItem.description_rows.filter(Boolean) : [];
                        const firstRow = rows[0] || 'Descrizione non disponibile';
                        return (
                          <div key={`overview-work-${idx}`} className="detail-overview-item">
                            <span className="context-badge" style={{ background: CONTEXT_COLORS[sectionItem.context]?.bg || 'rgba(255,255,255,0.06)', color: CONTEXT_COLORS[sectionItem.context]?.color || '#cbd5e1', borderColor: CONTEXT_COLORS[sectionItem.context]?.border || 'rgba(255,255,255,0.15)' }}>
                              {sectionItem.context?.charAt(0).toUpperCase() + sectionItem.context?.slice(1)}
                            </span>
                            <span className="detail-overview-item-text">{firstRow}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {dParts.length > 0 && (
                  <div className="detail-overview-block">
                    <div className="detail-overview-label">Ricambi principali</div>
                    <div className="detail-overview-value">
                      {dParts.slice(0, 6).map((partItem) => [partItem.name, partItem.quantity].filter(Boolean).join(' ')).join(', ')}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Sections */}
          {detailTab === 'works' && dSections.length > 0 && (
            <div className="section">
              <h2>📋 Sezioni</h2>
              {dSections.map((s, i) => (
                <div key={i} className="detail-section-card">
                  <div className="detail-section-head">
                    <span className="context-badge" style={{ background: CONTEXT_COLORS[s.context]?.bg, color: CONTEXT_COLORS[s.context]?.color, borderColor: CONTEXT_COLORS[s.context]?.border }}>
                      {s.context?.charAt(0).toUpperCase() + s.context?.slice(1)}
                    </span>
                    <div className="detail-section-hours">
                      {s.man_hours ? `MAN ${s.man_hours}h` : ''}
                      {s.man_hours && s.mac_hours ? ' • ' : ''}
                      {s.mac_hours ? `MAC ${s.mac_hours}h` : ''}
                      {s.materials_amount ? ` • Materiali €${s.materials_amount}` : ''}
                      {s.waste_apply ? ` • Smalt. ${s.waste_percentage || 2}%` : ''}
                    </div>
                  </div>
                  {Array.isArray(s.description_rows) && s.description_rows.length > 0 && (
                    <ul className="detail-description-list">
                      {s.description_rows.filter(Boolean).map((row, idx) => (
                        <li key={idx}>{row}</li>
                      ))}
                    </ul>
                  )}
                  {s.notes && <div className="detail-section-notes">📝 {s.notes}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Parts */}
          {detailTab === 'parts' && dParts.length > 0 && (
            <div className="section">
              <h2>🔩 Ricambi</h2>
              {Object.entries(partsByContext).map(([context, items]) => (
                <div key={context} className="detail-parts-group">
                  <div className="detail-parts-group-head">
                    <span className="context-badge" style={{ background: CONTEXT_COLORS[context]?.bg || 'rgba(255,255,255,0.06)', color: CONTEXT_COLORS[context]?.color || '#cbd5e1', borderColor: CONTEXT_COLORS[context]?.border || 'rgba(255,255,255,0.15)' }}>
                      {context?.charAt(0).toUpperCase() + context?.slice(1)}
                    </span>
                    <span className="detail-parts-count">{items.length} pezzi</span>
                  </div>
                  {items.map((p, i) => (
                    <div key={`${context}-${i}`} className="detail-part-item">
                      <span>• {p.name}</span>
                      {p.quantity && <span className="detail-part-qty">× {p.quantity}</span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Photos */}
          {detailTab === 'photos' && (
          <div className="section">
            <h2>📷 Foto ({photos.length})</h2>
            {photos.length > 0 ? (
              <div className="photo-grid">
                {photos.map((photo, i) => (
                  <div key={photo.id || i} className="photo-thumb-wrapper">
                    <img
                      src={photo.thumbnail || photo.url}
                      alt={`Foto ${i + 1}`}
                      onClick={() => setLightboxPhoto(photo.url)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="photo-empty-state">Nessuna foto disponibile.</div>
            )}
            <div className="photo-view-note">In modalità visualizzazione non è possibile aggiungere o eliminare foto. Usa Modifica pratica.</div>
          </div>

          )}

          {/* Actions */}
          <div className="detail-actions">
            <button
              className="button-submit"
              type="button"
              onClick={() => {
                navigateTo('form', {
                  editingPractice: {
                    ...practice,
                    sections: dSections,
                    parts: dParts,
                  },
                  existingPhotos: photos,
                });
              }}
            >
              ✏️ Modifica
            </button>
            <button
              className="button-delete"
              type="button"
              onClick={() => deletePractice(practice)}
              disabled={saving}
            >
              🗑 Elimina
            </button>
          </div>
          {/* Esito/errore dell'eliminazione completa "🗑 Elimina": senza questo banner
              un fallimento mostrava solo un toast, senza log copiabile. */}
          {!browserPreviewMode && yapLastPracticeId === practice.id && renderYapResultBanner(liveYapResult, { practiceId: practice.id, showRetry: false, showDelete: false })}
        </div>

        {lightboxPhoto && <Lightbox src={lightboxPhoto} onClose={() => setLightboxPhoto(null)} />}
      </div>
    );
  };

  // --- Form View ---
  const renderForm = () => {
    return (
      <div className="view-form view-enter">
        <div className="container">
          {(currentView === 'form' && !startedFromBot) && (
            <button className="back-button" onClick={navigateBack} type="button">← Indietro</button>
          )}
          {(currentView === 'form' && startedFromBot) && (
            <button className="back-button" onClick={() => { openDashboard(); setStartedFromBot(false); }} type="button">← Dashboard</button>
          )}

          <div className="section-inline-actions" style={{ marginBottom: 12 }}>
            <h1>🔧 Dati Pratica</h1>
            <button type="button" className="btn-secondary" onClick={applyRandomPracticeDraft}>
              Casuale
            </button>
          </div>
          {false && showDeveloperUi && (
            <>
              <div className="field-hint" style={{ marginBottom: 12 }}>
                Auth: <strong>{authMode}</strong>
              </div>
              {browserPreviewMode && (
                <div className="preview-banner">
                  Anteprima locale: questo form simula il salvataggio senza inviare dati al backend.
                </div>
              )}
            </>
          )}
          <DebugPanel
            authMode={authMode}
            browserPreviewMode={browserPreviewMode}
            errorMessage={error}
            initData={initData}
            telegramUserId={telegramUserId}
            practiceAccessToken={practiceAccessToken}
            lastApiDebug={lastApiDebug}
          />

          {showDraftBanner && (
            <div className="draft-banner" role="status" aria-live="polite">
              <span>📝 Bozza ripristinata</span>
              <button type="button" onClick={discardDraft}>
                Scarta
              </button>
            </div>
          )}

          {error && <div className="error">{error}</div>}

          {slowRequest && (
            <div className="slow-request-warning">Richiesta lenta: se e' una sync YAP, guarda la barra progresso per la fase corrente.</div>
          )}

          <form ref={formRef} onSubmit={handleSubmit(onSubmit)} className="form" noValidate>
            {/* Foto */}
            <div className="section photo-upload-section">
              <h2>📷 Foto{existingPhotos.length > 0 ? ` (${existingPhotos.length} esistenti${formPhotos.length > 0 ? ` + ${formPhotos.length} nuove` : ''})` : ''}</h2>

              {/* Existing photos from server */}
              {existingPhotos.length > 0 && (
                <div className="photo-preview-grid" style={{ marginBottom: formPhotos.length > 0 ? 12 : 0 }}>
                  {existingPhotos.map((photo, i) => (
                    <div key={photo.id || `existing-${i}`} className="photo-preview-item">
                      <img src={photo.thumbnail || photo.url} alt={`Foto ${i + 1}`} />
                      <button
                        className="photo-remove-btn"
                        type="button"
                        onClick={() => {
                          setConfirmModal({
                            title: '🗑 Eliminare questa foto?',
                            message: 'La foto verrà rimossa definitivamente.',
                            onConfirm: () => {
                              setConfirmModal(null);
                              setExistingPhotos(prev => prev.filter(p => p.id !== photo.id));
                              if (practice?.id && photo.id) {
                                const query = telegramUserId ? `?user_id=${encodeURIComponent(telegramUserId)}` : '';
                                fetch(`${API_BASE_URL}/api/practices/${practice.id}/photos/${photo.id}${query}`, {
                                  method: 'DELETE',
                                  headers: {
                                    ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
                                    ...(telegramUserId ? { 'X-Telegram-User-Id': telegramUserId } : {}),
                                  }
                                }).catch(() => {});
                              }
                            },
                            onCancel: () => setConfirmModal(null)
                          });
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Newly added photos */}
              {formPhotos.length > 0 && (
                <div className="photo-preview-grid">
                  {formPhotos.map((item) => (
                    <div key={item.id} className="photo-preview-item">
                      <img src={item.preview} alt="Preview" />
                      <button
                        className="photo-remove-btn"
                        type="button"
                        onClick={() => removeFormPhoto(item.id)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {formPhotoUploadProgress && (
                <div className="upload-progress">
                  <span className="loading-spinner sm"></span>
                  {formPhotoUploadProgress}
                </div>
              )}
              <input
                type="file"
                ref={formFileInputRef}
                className="photo-file-input"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(e) => { if (e.target.files.length) addFormPhotos(Array.from(e.target.files)); e.target.value = ''; }}
              />
              <button
                className="photo-upload-btn"
                type="button"
                onClick={() => formFileInputRef.current?.click()}
              >
                📷 Aggiungi foto
              </button>
            </div>

            {/* Dati cliente */}
            <div className="section">
              <h2>👤 Dati Cliente</h2>
              <div className="form-group">
                <label htmlFor="plate_confirmed">Targa*</label>
                <input
                  id="plate_confirmed"
                  {...register('plate_confirmed', { required: 'Targa obbligatoria' })}
                  className={`input ${fieldErrors.plate_confirmed ? 'input-error' : ''}`}
                  placeholder="AB123CD"
                  aria-label="Targa del veicolo"
                  autoComplete="off"
                />
                {renderFieldError('plate_confirmed')}
              </div>

              <div className="form-group">
                <label htmlFor="phone">Telefono*</label>
                <input
                  id="phone"
                  {...register('phone', { required: 'Telefono obbligatorio' })}
                  className={`input ${fieldErrors.phone ? 'input-error' : ''}`}
                  placeholder="3351234567"
                  type="tel"
                  autoComplete="tel"
                />
                {renderFieldError('phone')}
              </div>

              <div className="form-group">
                <label htmlFor="customer_name">Cliente/Riferimento*</label>
                <input
                  id="customer_name"
                  {...register('customer_name', { required: 'Nome obbligatorio' })}
                  className={`input ${fieldErrors.customer_name ? 'input-error' : ''}`}
                  placeholder="Mario Rossi"
                  autoComplete="name"
                />
                {renderFieldError('customer_name')}
              </div>

              <div className="form-group">
                <label htmlFor="customer_type">Tipo Cliente*</label>
                <select id="customer_type" {...register('customer_type')} className="select">
                  <option value="privato">Privato</option>
                  <option value="azienda">Azienda</option>
                </select>
              </div>

              {watch('customer_type') === 'azienda' && (
                <label className="inline-checkbox">
                  <input type="checkbox" {...register('billing_to_complete')} />
                  Dati fatturazione da completare
                </label>
              )}

              {watch('billing_to_complete') && watch('customer_type') === 'azienda' && (
                <div className="revealed-fields">
                  <div className="form-group">
                    <label htmlFor="company_name">Ragione Sociale</label>
                    <input
                      id="company_name"
                      {...register('company_name')}
                      className="input"
                      placeholder="Ragione Sociale"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="vat_number">Partita IVA</label>
                    <input
                      id="vat_number"
                      {...register('vat_number')}
                      className="input"
                      placeholder="IT12345678901"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="fiscal_code">Codice Fiscale</label>
                    <input
                      id="fiscal_code"
                      {...register('fiscal_code')}
                      className="input"
                      placeholder="RSSMRA80A01H501U"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="billing_address">Indirizzo</label>
                    <input
                      id="billing_address"
                      {...register('billing_address')}
                      className="input"
                      placeholder="Via Roma 1"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="billing_city">Città</label>
                    <input
                      id="billing_city"
                      {...register('billing_city')}
                      className="input"
                      placeholder="Milano"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="billing_zip">CAP</label>
                    <input
                      id="billing_zip"
                      {...register('billing_zip')}
                      className="input"
                      placeholder="20100"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Contesti */}
            <div className="section" data-field="contexts">
              <h2>🔧 Contesti</h2>
              <div className="checkboxes">
                {['officina', 'carrozzeria', 'revisione'].map(context => (
                  <label key={context} className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selectedContexts.includes(context)}
                      onChange={() => toggleContext(context)}
                    />
                    {context.charAt(0).toUpperCase() + context.slice(1)}
                  </label>
                ))}
              </div>
              <div className="field-hint">Seleziona almeno un tipo di sezione</div>
              {fieldErrors.contexts && <div className="field-error">{fieldErrors.contexts}</div>}
            </div>

            {/* Data/ora: toggle compatto (no card ingombrante) */}
            <label className="schedule-toggle">
              <input
                type="checkbox"
                checked={scheduleManually}
                onChange={(e) => setScheduleManually(e.target.checked)}
              />
              <span>📅 Imposta data e ora manualmente</span>
              {!scheduleManually && <em>— altrimenti oggi all'ora attuale</em>}
            </label>

            {(scheduleManually || !isRevisioneOnly) && (
            <div className="section">
              {scheduleManually && (
              <div className="form-group">
                <label htmlFor="appointment_date">Data*</label>
                <Controller
                  control={control}
                  name="appointment_date"
                  render={({ field }) => (
                    <DatePicker
                      id="appointment_date"
                      selected={field.value}
                      onChange={field.onChange}
                      className={`input ${fieldErrors.appointment_date ? 'input-error' : ''}`}
                      dateFormat="dd/MM/yyyy"
                      placeholderText="GG/MM/AAAA"
                      minDate={minAppointmentDate}
                    />
                  )}
                />
                {renderFieldError('appointment_date')}
              </div>
              )}

              {scheduleManually && (
              <div className="form-group">
                <label htmlFor="appointment_time">Ora inizio appuntamento*</label>
                <select
                  id="appointment_time"
                  {...register('appointment_time')}
                  className={`select ${fieldErrors.appointment_time ? 'input-error' : ''}`}
                >
                  <option value="">-- Seleziona --</option>
                  {APPOINTMENT_TIME_OPTIONS.map((slot) => (
                    <option key={slot} value={slot}>{slot}</option>
                  ))}
                </select>
                {watchedTime && (
                  <div className="field-hint">
                    Durata slot YAP: 20 min → fine prevista {addMinutesToTime(watchedTime, 20)}
                  </div>
                )}
                {renderFieldError('appointment_time')}
              </div>
              )}

              {!isRevisioneOnly && (
              <div className="form-group">
                <label htmlFor="practice_type">Tipo Pratica*</label>
                <select id="practice_type" {...register('practice_type')} className="select">
                  <option value="preventivo">Preventivo</option>
                  <option value="ordine_di_lavoro">Ordine di Lavoro</option>
                </select>
              </div>
              )}

            </div>
            )}

            {/* Sezioni dinamiche (la revisione non ha card: niente righe/note) */}
            {selectedContexts.filter((context) => context !== 'revisione').map(context => (
              <div key={context} className="section">
                <h2>📋 {context.charAt(0).toUpperCase() + context.slice(1)}</h2>

                <div className="form-group">
                  <div className="section-inline-actions">
                    <label>Righe Descrittive*</label>
                    <button type="button" onClick={() => addDescriptionRow(context)} className="button-add" aria-label={`Aggiungi riga descrittiva a ${context}`}>+ Aggiungi riga</button>
                  </div>
                  {sections[context]?.description_rows?.map((row, index) => (
                    <div key={`${context}-row-${index}-${sections[context].description_rows.length}`} className="description-row">
                      <input
                        type="text"
                        value={row}
                        onChange={(e) => updateDescriptionRow(context, index, e.target.value)}
                        className="input"
                        placeholder="Descrizione lavoro..."
                      />
                      {sections[context].description_rows.length > 1 && (
                        <button type="button" onClick={() => removeDescriptionRow(context, index)} className="button-remove" aria-label={`Rimuovi riga ${index + 1} da ${context}`}>✕</button>
                      )}
                    </div>
                  ))}
                </div>

                {context === 'officina' && (
                  <div className="form-group">
                    <label>MAN Ore</label>
                    <input
                      type="number" step="0.5"
                      value={sections[context]?.man_hours || ''}
                      onChange={(e) => updateSection(context, 'man_hours', parseFloat(e.target.value) || '')}
                      className="input" placeholder="2.5"
                    />
                  </div>
                )}

                {context === 'carrozzeria' && (
                  <>
                    <div className="form-group">
                      <label>MAC Ore</label>
                      <input
                        type="number" step="0.5"
                        value={sections[context]?.mac_hours || ''}
                        onChange={(e) => updateSection(context, 'mac_hours', parseFloat(e.target.value) || '')}
                        className="input" placeholder="2.5"
                      />
                    </div>
                    <div className="form-group">
                      <label>Materiali (€)</label>
                      <input
                        type="number" step="0.01"
                        value={sections[context]?.materials_amount || ''}
                        onChange={(e) => updateSection(context, 'materials_amount', parseFloat(e.target.value) || '')}
                        className="input" placeholder="150.00"
                      />
                    </div>
                    <div className="form-group">
                      <label className="inline-checkbox">
                        <input
                          type="checkbox"
                          checked={sections[context]?.waste_apply || false}
                          onChange={(e) => updateSection(context, 'waste_apply', e.target.checked)}
                        />
                        Applica smaltimento rifiuti
                      </label>
                      {sections[context]?.waste_apply && (
                        <div className="revealed-fields">
                          <input
                            type="number" step="0.1"
                            value={sections[context]?.waste_percentage || 2}
                            onChange={(e) => updateSection(context, 'waste_percentage', parseFloat(e.target.value) || 2)}
                            className="input" placeholder="Percentuale smaltimento %" min="0" max="100"
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}

                {(context === 'officina' || context === 'carrozzeria') && (
                  <div className="form-group">
                    <div className="section-inline-actions">
                      <label>Pezzi / ricambi</label>
                      <button type="button" onClick={() => addPart(context)} className="button-add" aria-label={`Aggiungi pezzo a ${context}`}>+ Aggiungi pezzo</button>
                    </div>
                    {getPartsForContext(context).map((part, index) => (
                      <div key={part._key || index} className="description-row">
                        <input
                          type="text" value={part.name}
                          onChange={(e) => updatePart(context, index, 'name', e.target.value)}
                          className="input" placeholder="Es. Pastiglie freno"
                        />
                        <input
                          type="text" value={part.quantity}
                          onChange={(e) => updatePart(context, index, 'quantity', e.target.value)}
                          className="input" placeholder="1 pz"
                          style={{ maxWidth: '100px' }}
                        />
                        <button type="button" onClick={() => removePart(context, index)} className="button-remove" aria-label={`Rimuovi pezzo ${index + 1} da ${context}`}>✕</button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor={`notes_${context}`}>Note interne</label>
                  <textarea
                    id={`notes_${context}`}
                    value={sections[context]?.notes || ''}
                    onChange={(e) => updateSection(context, 'notes', e.target.value)}
                    className="textarea"
                    rows="3"
                    placeholder="Note per questo reparto..."
                    aria-label={`Note interne ${context}`}
                  />
                </div>
              </div>
            ))}

            {!browserPreviewMode && renderYapPreviewPanel(formYapPreview, formYapPreviewLoading, {
              title: '📅 Anteprima YAP (live)',
            })}

            {saveProgress && (
              <div className={`save-progress ${saveProgress.status === 'error' ? 'save-progress-error' : saveProgress.status === 'success' ? 'save-progress-success' : 'save-progress-running'}`}>
                <div className="save-progress-header">
                  {saveProgress.status === 'running' && <span className="loading-spinner sm"></span>}
                  <span className="save-progress-label">{saveProgress.label}</span>
                  <span className="save-progress-percent">{Math.round(saveProgress.percent)}%</span>
                </div>
                <div className="upload-progress-bar" aria-hidden="true">
                  <div
                    className="upload-progress-bar-fill"
                    style={{ width: `${Math.min(100, Math.max(0, saveProgress.percent))}%` }}
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={saving}
              className={`button-submit ${saving ? 'btn-loading' : ''}`}
            >
              {saving ? 'Salvataggio in corso...' : (practice ? '✓ Aggiorna' : '✓ Salva')}
            </button>

            {practice && practice.id && (
              <button
                type="button"
                onClick={() => deletePractice()}
                disabled={saving}
                className="button-delete"
              >
                🗑 Elimina
              </button>
            )}
          </form>
        </div>
      </div>
    );
  };

  // --- Main Render ---
  if (loading && currentView === 'form') {
    return (
      <div className="App">
        <SkeletonLoader />
        {slowRequest && <div className="slow-request-warning">Richiesta lenta: se e' una sync YAP, guarda la barra progresso per la fase corrente.</div>}
      </div>
    );
  }

  return (
    <div className="App">
      <Toast toasts={toasts} removeToast={removeToast} />
      {yapActionProgress && renderGlobalYapActionProgressBar()}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          onConfirm={confirmModal.onConfirm}
          onCancel={confirmModal.onCancel}
        />
      )}
      {currentView === 'dashboard' && renderDashboard()}
      {currentView === 'detail' && renderDetail()}
      {currentView === 'form' && renderForm()}
      {typeof window !== 'undefined' && (!window.Telegram?.WebApp || browserPreviewMode) && currentView !== 'dashboard' && (
        <button
          type="button"
          className="telegram-dashboard-fab"
          onClick={openDashboard}
          aria-label="Apri dashboard"
        >
          📋 Dashboard
        </button>
      )}
    </div>
  );
}

export default App;
