import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  if (!err.response) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return 'Connessione scaduta. Controlla la tua connessione e riprova.';
    }
    return 'Errore di rete. Controlla la connessione internet e riprova.';
  }
  const status = err.response.status;
  const detail = extractErrorDetail(err.response.data?.detail || err.response.data?.message || err.response.data?.error);
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

/** Italian phone validation */
function isValidItalianPhone(val) {
  const cleaned = val.replace(/[\s.()-]/g, '');
  return /^(\+39)?3\d{8,9}$/.test(cleaned) || /^0\d{5,10}$/.test(cleaned);
}

/** Italian license plate */
function isValidItalianPlate(val) {
  const cleaned = val.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(cleaned);
}

function isLocalDevHost() {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1'].includes(window.location.hostname);
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
    else if (result.yap?.result?.saved || result.yap?.result?.mode === 'commit') status = 'agenda_synced';
    else if (normalizedMessage.includes('agenda sincronizzata')) status = 'agenda_synced';
    else if (normalizedMessage.includes('appuntamento eliminato')) status = 'deleted';
    else if (normalizedMessage.includes('fallita') || normalizedMessage.includes('errore')) status = 'sync_failed';
  }

  return {
    ...result,
    status,
    message,
    retryable: status === 'sync_failed' || status === 'not_ready' ? true : result.retryable,
    duplicate: isDuplicate || result.duplicate || false,
    dryRun: dryRun || result.dryRun || false,
  };
}

function getYapSyncScope(result) {
  return result?.syncScope || result?.practice?.management_sync_scope || null;
}

function getYapAuditResult(resultOrPractice) {
  return resultOrPractice?.audit || resultOrPractice?.management_audit_result || resultOrPractice?.practice?.management_audit_result || null;
}

function isAgendaOnlyYapSync(result) {
  const scope = getYapSyncScope(result);
  if (!scope) return false;
  return scope.mode === 'agenda_only' || scope.complete === false || scope.partial === true || scope.full === false;
}

function formatYapSyncScopeSummary(result) {
  const scope = getYapSyncScope(result);
  if (!scope) return '';
  if (scope.summary) return scope.summary;

  const agenda = scope.agenda?.written || scope.written?.agenda || [];
  const contexts = scope.agenda?.used_contexts || scope.usedContexts || scope.contexts || [];
  const odl = scope.odl?.planned || scope.planned?.odl || [];
  const parts = [];

  if (agenda.length) parts.push(`Agenda: ${agenda.join(', ')}`);
  if (contexts.length) parts.push(`Contesti: ${contexts.join(', ')}`);
  if (odl.length) parts.push(`ODL pianificati: ${odl.join(', ')}`);

  return parts.join(' | ');
}

function formatYapPracticeStatus(practice) {
  const status = String(practice?.management_sync_status || '').trim();
  if (status === 'complete_synced') return 'Completa';
  if (status === 'partial_synced') return 'Parziale';
  if (status === 'agenda_synced') return 'Agenda verificata';
  if (status === 'sync_failed') return 'Sync YAP fallita';
  if (status === 'deleted') return 'Appuntamento eliminato da YAP';
  if (status === 'blocked_by_odl') return 'Eliminazione bloccata da ODL';
  if (status === 'duplicate') return 'Agenda già presente in YAP';
  if (status === 'not_ready') return 'Pratica non pronta per YAP';
  if (status) return status;
  return practice?.synced ? 'Sincronizzata' : 'Non sincronizzata';
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

/** Opzioni orario ogni 5 min (allineato a YAP / messaggi Telegram, es. 09:24). */
function buildAppointmentTimeOptions() {
  const options = [];
  for (let h = 0; h < 24; h += 1) {
    for (let m = 0; m < 60; m += 5) {
      options.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return options;
}

const APPOINTMENT_TIME_OPTIONS = buildAppointmentTimeOptions();

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
const RANDOM_REVISIONE_ROWS = [
  'Revisione periodica',
  'Controllo emissioni',
  'Verifica fari',
  'Prova freni',
  'Controllo pneumatici',
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
      rows: RANDOM_REVISIONE_ROWS,
      manHours: [0.5, 2],
      macHours: null,
      materialsMin: null,
      materialsMax: null,
      wasteApply: false,
      parts: [],
    },
  }[context];

  const descriptionRows = randomSubset(contextConfig.rows, 1, Math.min(3, contextConfig.rows.length));
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
        <button className="lightbox-close" onClick={onClose} type="button">✕</button>
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
  appointment_time: '09:30',
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
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    if (!draft || typeof draft !== 'object') return null;

    const timestamp = Number(draft.timestamp || 0);
    if (!timestamp || Date.now() - timestamp > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
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
      appointment_time: formData.appointment_time || '',
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

const isDebugUiEnabled = () => (
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug_ui') === '1'
);

function DebugPanel({ authMode, initData, telegramUserId, practiceAccessToken, lastApiDebug }) {
  const showDebugUi = isDebugUiEnabled();
  if (!showDebugUi) return null;

  const search = typeof window !== 'undefined' ? window.location.search : '';
  const hash = typeof window !== 'undefined' ? window.location.hash : '';

  return (
    <div className="debug-panel">
      <div className="debug-panel-title">Debug Sessione</div>
      <div className="debug-panel-line">authMode: {authMode}</div>
      <div className="debug-panel-line">initData presente: {initData ? 'si' : 'no'}</div>
      <div className="debug-panel-line">initData len: {initData?.length || 0}</div>
      <div className="debug-panel-line">initData hash=: {initData?.includes('hash=') ? 'si' : 'no'}</div>
      <div className="debug-panel-line">telegramUserId: {telegramUserId || '-'}</div>
      <div className="debug-panel-line">accessToken presente: {practiceAccessToken ? 'si' : 'no'}</div>
      <div className="debug-panel-line">accessToken len: {practiceAccessToken?.length || 0}</div>
      <div className="debug-panel-line">search: {search || '-'}</div>
      <div className="debug-panel-line">hash: {hash || '-'}</div>
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

  const [startedFromBot, setStartedFromBot] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Dashboard state
  const [practices, setPractices] = useState([]);
  const [stats, setStats] = useState({ total: 0, this_month: 0, pending_sync: 0 });
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardDraftCard, setDashboardDraftCard] = useState(null);
  const [preSyncByPractice, setPreSyncByPractice] = useState({});
  const [seedingDemoPractices, setSeedingDemoPractices] = useState(false);
  const [previewPractices, setPreviewPractices] = useState(BROWSER_PREVIEW_PRACTICES);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState({ officina: false, carrozzeria: false, revisione: false, synced: null });

  // Detail state
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [yapPreview, setYapPreview] = useState(null);
  const [yapPreviewLoading, setYapPreviewLoading] = useState(false);
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
  const [successDone, setSuccessDone] = useState(false);
  const [saveProgress, setSaveProgress] = useState(null);

  const [showDraftBanner, setShowDraftBanner] = useState(false);
  const [slowRequest, setSlowRequest] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [selectedContexts, setSelectedContexts] = useState([]);
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
  const toastIdRef = useRef(0);
  const formRef = useRef(null);
  const searchTimerRef = useRef(null);
  const previewSeqRef = useRef(BROWSER_PREVIEW_PRACTICES.length + 1);

  const { register, control, handleSubmit, setValue, watch, getValues, formState: { errors } } = useForm();
  const authMode = browserPreviewMode ? 'preview browser' : (initData ? 'initData' : (telegramUserId ? 'fallback user_id' : 'non autenticato'));
  const showDeveloperUi = isDebugUiEnabled();

  // --- Draft persistence ---
  const persistDraft = useCallback(() => {
    try {
      const data = getValues();
      const draft = { formData: data, selectedContexts, sections, parts, timestamp: Date.now(), practiceId: practice?.id || null };
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
      return true;
    } catch (_) {
      return false;
    }
  }, [getValues, selectedContexts, sections, parts, practice]);

  const hasMeaningfulDraft = useCallback(() => {
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
  }, [getValues, selectedContexts, sections, parts]);

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
    setSaveProgress({
      label,
      stage,
      status: 'running',
      percent: 8,
    });
    saveProgressTimerRef.current = setInterval(() => {
      setSaveProgress((current) => {
        if (!current || current.status !== 'running') return current;
        const caps = {
          validate: 18,
          save: 45,
          photos: 72,
          sync: 92,
        };
        const cap = caps[current.stage] ?? 92;
        const increment = current.percent < 20 ? 3.5 : current.percent < 60 ? 1.6 : 0.6;
        const nextPercent = Math.min(cap, Number((current.percent + increment).toFixed(1)));
        if (nextPercent === current.percent) return current;
        return { ...current, percent: nextPercent };
      });
    }, 340);
  }, [stopSaveProgressTimers]);

  const updateSaveProgress = useCallback((patch) => {
    setSaveProgress((current) => (current ? { ...current, ...patch } : current));
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
    setYapActionProgress({
      action,
      practiceId,
      label,
      status: 'running',
      percent: 6,
    });
    yapActionProgressTimerRef.current = setInterval(() => {
      setYapActionProgress((current) => {
        if (!current || current.status !== 'running') return current;
        const caps = { sync: 90, delete: 88, audit: 86 };
        const cap = caps[current.action] ?? 88;
        const increment = current.percent < 20 ? 4 : current.percent < 60 ? 1.9 : 0.7;
        const nextPercent = Math.min(cap, Number((current.percent + increment).toFixed(1)));
        if (nextPercent === current.percent) return current;
        return { ...current, percent: nextPercent };
      });
    }, 320);
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
    if (clearDelay > 0) {
      yapActionProgressClearTimerRef.current = setTimeout(() => {
        setYapActionProgress((current) => {
          if (!current || current.status !== status) return current;
          return null;
        });
      }, clearDelay);
    }
  }, [stopYapActionProgressTimers]);

  const watchedValues = watch();

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch (_) {}
    setDashboardDraftCard(null);
  }, []);

  const restoreDraft = useCallback((targetPracticeId = null) => {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      if (Date.now() - draft.timestamp > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
        return false;
      }
      if (draft.practiceId !== targetPracticeId) {
        return false;
      }
      if (draft.formData) {
        Object.keys(draft.formData).forEach(key => {
          if (key === 'appointment_date' && draft.formData[key]) {
            setValue(key, new Date(draft.formData[key]));
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

  useEffect(() => {
    if (currentView !== 'form' || loading || successDone) return undefined;

    const persistDraftOnLeave = () => {
      if (hasMeaningfulDraft()) persistDraft();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && hasMeaningfulDraft()) persistDraft();
    };

    const timer = setTimeout(() => {
      if (hasMeaningfulDraft()) persistDraft();
    }, 250);
    window.addEventListener('beforeunload', persistDraftOnLeave);
    window.addEventListener('pagehide', persistDraftOnLeave);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('beforeunload', persistDraftOnLeave);
      window.removeEventListener('pagehide', persistDraftOnLeave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [watchedValues, currentView, loading, successDone, selectedContexts, sections, parts, persistDraft, hasMeaningfulDraft, stopSaveProgressTimers]);

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

    window.__GIORGIO_DEBUG__ = hiddenDebug;
    try {
      sessionStorage.setItem('giorgio_hidden_debug', JSON.stringify(hiddenDebug));
    } catch (_) {
      // no-op
    }
  }, [authMode, browserPreviewMode, initData, telegramUserId, practiceAccessToken, lastApiDebug]);

  const rememberRequest = (label, { method = 'GET', url, params = {}, headers = {} } = {}) => {
    setLastApiDebug(prev => ({
      ...(prev || {}),
      timestamp: new Date().toISOString(),
      label,
      method,
      url,
      params,
      headerKeys: Object.keys(headers || {}),
      status: 'pending',
      error: null,
    }));
  };

  const rememberResponse = (label, extra = {}) => {
    setLastApiDebug(prev => ({
      ...(prev || {}),
      ...(prev?.label === label ? {} : { label }),
      timestamp: new Date().toISOString(),
      status: 'ok',
      error: null,
      ...extra,
    }));
  };

  const rememberError = (label, err, extra = {}) => {
    setLastApiDebug(prev => ({
      ...(prev || {}),
      ...(prev?.label === label ? {} : { label }),
      timestamp: new Date().toISOString(),
      status: 'error',
      error: {
        message: err?.message || null,
        status: err?.response?.status || null,
        detail: err?.response?.data?.detail || null,
        code: err?.response?.data?.code || err?.code || null,
      },
      ...extra,
    }));
  };

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
    if (currentView === 'form' && !successDone && hasMeaningfulDraft()) {
      persistDraft();
    }
    setCurrentView('dashboard');
    setNavigationStack([]);
    setSelectedPracticeId(null);
    setEditingPractice(null);
    setDetailData(null);
    setLoading(false);
  }, [persistDraft, currentView, successDone, hasMeaningfulDraft]);

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
    setSuccessDone(false);
    setYapLastPracticeId(null);
    setYapLastResult(null);
    setError('');
    setShowDraftBanner(false);
    setFieldErrors({});
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
      try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch (_) {}
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

    const entries = await Promise.all(
      list.map(async (p) => {
        try {
          const res = await axios.get(`${API_BASE_URL}/practices/${p.id}/pre-sync-check`, {
            params: getAuthParams(),
            headers: getHeaders(),
            timeout: 10000,
          });
          return [p.id, res.data?.data || null];
        } catch (_) {
          return [p.id, null];
        }
      })
    );

    const map = {};
    entries.forEach(([id, value]) => { map[id] = value; });
    setPreSyncByPractice(map);
  }, [getAuthParams, getHeaders]);

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
      rememberError('dashboard.list', err);
      addToast(classifyError(err), 'error');
      refreshDashboardDraftCard(search, filters, []);
    } finally {
      setDashboardLoading(false);
    }
  }, [browserPreviewMode, previewPractices, getAuthParams, getHeaders, addToast, loadPreSyncChecks, refreshDashboardDraftCard]);

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
      setDetailData(res.data?.data || res.data);
      rememberResponse('practice.detail');
      setYapPreviewLoading(true);
      try {
        rememberRequest('yap.preview', { method: 'GET', url: `${API_BASE_URL}/practices/${id}/yap-mapping-preview`, params: getAuthParams(), headers: getHeaders() });
        const yapRes = await fetchWithRetry(() =>
          axios.get(`${API_BASE_URL}/practices/${id}/yap-mapping-preview`, { params: getAuthParams(), headers: getHeaders(), timeout: 15000 })
        );
        setYapPreview(yapRes.data?.data || yapRes.data);
        rememberResponse('yap.preview');
      } catch (yapErr) {
        rememberError('yap.preview', yapErr);
        setYapPreview(null);
      } finally {
        setYapPreviewLoading(false);
      }
    } catch (err) {
      rememberError('practice.detail', err);
      addToast(classifyError(err), 'error');
      navigateBack();
    } finally {
      setDetailLoading(false);
    }
  }, [browserPreviewMode, previewPractices, getAuthParams, getHeaders, addToast, navigateBack]);

  useEffect(() => {
    if (currentView === 'detail' && selectedPracticeId) {
      loadDetail(selectedPracticeId);
    }
  }, [currentView, selectedPracticeId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (successCount > 0) addToast(`${successCount} foto caricate con successo!`, 'success');
    if (failCount > 0) addToast(`${failCount} foto non caricate.`, 'error');
    // Cleanup previews
    formPhotos.forEach(p => URL.revokeObjectURL(p.preview));
    setFormPhotos([]);
  }, [formPhotos, initData, telegramUserId, addToast]);

  // --- Toggle sync ---
  const toggleSync = useCallback(async (id, currentSynced) => {
    if (browserPreviewMode) {
      const nextSynced = !currentSynced;
      setPreviewPractices(prev => prev.map(p => String(p.id) === String(id) ? { ...p, synced: nextSynced } : p));
      setPractices(prev => prev.map(p => String(p.id) === String(id) ? { ...p, synced: nextSynced } : p));
      setDetailData(prev => {
        if (!prev) return prev;
        const practiceData = prev.practice || prev;
        if (String(practiceData.id) !== String(id)) return prev;
        return { ...prev, practice: { ...practiceData, synced: nextSynced } };
      });
      addToast(nextSynced ? 'Pratica segnata come completata' : 'Pratica riaperta', 'success');
      return;
    }

    try {
      rememberRequest('practice.sync', { method: 'PATCH', url: `${API_BASE_URL}/api/practices/${id}/sync`, params: getAuthParams(), headers: getHeaders() });
      await fetchWithRetry(() =>
        axios.patch(`${API_BASE_URL}/api/practices/${id}/sync`, { synced: !currentSynced }, { params: getAuthParams(), headers: getHeaders(), timeout: 10000 })
      );
      setDetailData(prev => prev ? { ...prev, synced: !currentSynced } : prev);
      setPractices(prev => prev.map(p => p.id === id ? { ...p, synced: !currentSynced } : p));
      rememberResponse('practice.sync');
      addToast(currentSynced ? 'Pratica segnata come non sincronizzata' : 'Pratica segnata come sincronizzata', 'success');
    } catch (err) {
      rememberError('practice.sync', err);
      addToast(classifyError(err), 'error');
    }
  }, [browserPreviewMode, getAuthParams, getHeaders, addToast]);

  // --- YAP Automation ---
  const [yapSyncLoading, setYapSyncLoading] = useState(false);
  const [yapDeleteLoading, setYapDeleteLoading] = useState(false);
  const [yapAuditLoading, setYapAuditLoading] = useState(false);
  const [yapLastResult, setYapLastResult] = useState(null);
  const [yapActionProgress, setYapActionProgress] = useState(null);

  const syncToYap = useCallback(async (id, options = {}) => {
    const silent = options.silent || false;
    const apiOptions = { ...options };
    delete apiOptions.silent;
    if (browserPreviewMode) {
      if (!silent) addToast('Anteprima: sync YAP simulato', 'success');
      setYapLastPracticeId(id);
      setYapLastResult({ status: 'synced', simulated: true, message: 'Sync simulata in anteprima browser.' });
      return { status: 'synced', simulated: true };
    }
    if (!silent) {
      startYapActionProgress('sync', id, 'Sincronizzazione YAP in corso...');
    }
    setYapSyncLoading(true);
    setYapLastResult(null);
    setYapLastPracticeId(id);
    try {
      rememberRequest('yap.sync', { method: 'POST', url: `${API_BASE_URL}/practices/${id}/yap/sync`, params: getAuthParams(), headers: getHeaders() });
      const res = await fetchWithRetry(() =>
        axios.post(`${API_BASE_URL}/practices/${id}/yap/sync`, apiOptions, { params: getAuthParams(), headers: getHeaders(), timeout: 180000 })
      );
      const data = normalizeYapResult(res.data?.data || {}, { dryRun: Boolean(apiOptions.dry_run) });
      setYapLastResult(data);
      rememberResponse('yap.sync');
      if (['complete_synced', 'partial_synced', 'agenda_synced', 'synced', 'duplicate'].includes(data.status)) {
        const scopeSummary = formatYapSyncScopeSummary(data);
        if (!silent) {
          addToast(data.status === 'duplicate'
            ? (scopeSummary || 'Agenda già presente in YAP: nessuna modifica necessaria')
            : (data.message || scopeSummary || 'Verifica YAP completata'),
            data.status === 'complete_synced' ? 'success' : 'warning');
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
        const progressLabel = data.message
          || (data.status === 'agenda_synced' ? 'Agenda sincronizzata.' : 'Sync YAP completata.');
        const progressStatus = ['sync_failed', 'not_ready'].includes(data.status) ? 'error' : 'success';
        finishYapActionProgress(progressLabel, progressStatus, progressStatus === 'error' ? 0 : 1200);
      }
      return data;
    } catch (err) {
      rememberError('yap.sync', err);
      const errorResult = {
        status: 'sync_failed',
        message: classifyError(err),
        retryable: true,
        error: err?.response?.data?.detail || err?.response?.data || err?.message || 'sync_failed',
      };
      setYapLastResult(errorResult);
      if (!silent) addToast(errorResult.message, 'error');
      if (!silent) finishYapActionProgress(errorResult.message || 'Sync YAP fallita', 'error', 0);
      return errorResult;
    } finally {
      setYapSyncLoading(false);
    }
  }, [browserPreviewMode, getAuthParams, getHeaders, addToast, loadDetail, startYapActionProgress, finishYapActionProgress]);

  const deleteYapAppointment = useCallback(async (id, options = {}) => {
    if (browserPreviewMode) {
      addToast('Anteprima: delete YAP simulato', 'success');
      setYapLastPracticeId(id);
      setYapLastResult({ status: 'deleted', simulated: true, message: 'Eliminazione simulata in anteprima browser.' });
      return { status: 'deleted', simulated: true };
    }
    startYapActionProgress('delete', id, 'Eliminazione appuntamento YAP in corso...');
    setYapDeleteLoading(true);
    setYapLastResult(null);
    setYapLastPracticeId(id);
    try {
      rememberRequest('yap.delete', { method: 'DELETE', url: `${API_BASE_URL}/practices/${id}/yap/appointment`, params: getAuthParams(), headers: getHeaders() });
      const res = await fetchWithRetry(() =>
        axios.delete(`${API_BASE_URL}/practices/${id}/yap/appointment`, { data: options, params: getAuthParams(), headers: getHeaders(), timeout: 180000 })
      );
      const data = normalizeYapResult(res.data?.data || {});
      setYapLastResult(data);
      rememberResponse('yap.delete');
      if (data.status === 'deleted') {
        addToast('Appuntamento eliminato da YAP', 'success');
        loadDetail(id);
      } else if (data.status === 'blocked_by_odl') {
        addToast('Impossibile eliminare: associato a ordine di lavoro', 'warning');
      } else {
        addToast(data.message || `Delete YAP: ${data.status}`, 'info');
      }
      finishYapActionProgress(
        data.message || (data.status === 'deleted' ? 'Appuntamento eliminato da YAP.' : 'Eliminazione YAP completata.'),
        ['delete_failed', 'blocked_by_odl'].includes(data.status) ? 'error' : 'success',
        ['delete_failed', 'blocked_by_odl'].includes(data.status) ? 0 : 1200,
      );
      return data;
    } catch (err) {
      rememberError('yap.delete', err);
      const errorResult = {
        status: 'delete_failed',
        message: classifyError(err),
        retryable: true,
        error: err?.response?.data?.detail || err?.response?.data || err?.message || 'delete_failed',
      };
      setYapLastResult(errorResult);
      addToast(errorResult.message, 'error');
      finishYapActionProgress(errorResult.message || 'Eliminazione YAP fallita', 'error', 0);
      return errorResult;
    } finally {
      setYapDeleteLoading(false);
    }
  }, [browserPreviewMode, getAuthParams, getHeaders, addToast, loadDetail, startYapActionProgress, finishYapActionProgress]);

  const auditYapAppointment = useCallback(async (id, options = {}) => {
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
    setYapAuditLoading(true);
    setYapLastResult(null);
    setYapLastPracticeId(id);
    try {
      rememberRequest('yap.audit', { method: 'POST', url: `${API_BASE_URL}/practices/${id}/yap/audit`, params: getAuthParams(), headers: getHeaders() });
      const res = await fetchWithRetry(() =>
        axios.post(`${API_BASE_URL}/practices/${id}/yap/audit`, options, { params: getAuthParams(), headers: getHeaders(), timeout: 180000 })
      );
      const data = normalizeYapResult(res.data?.data || {});
      setYapLastResult(data);
      rememberResponse('yap.audit');
      const tone = data.status === 'complete_synced' ? 'success' : (data.status === 'sync_failed' ? 'error' : 'warning');
      addToast(data.message || 'Controllo YAP completato', tone);
      loadDetail(id);
      return data;
    } catch (err) {
      rememberError('yap.audit', err);
      const errorResult = {
        status: 'sync_failed',
        message: classifyError(err),
        retryable: true,
        error: err?.response?.data?.detail || err?.response?.data || err?.message || 'audit_failed',
      };
      setYapLastResult(errorResult);
      addToast(errorResult.message, 'error');
      return errorResult;
    } finally {
      setYapAuditLoading(false);
    }
  }, [browserPreviewMode, getAuthParams, getHeaders, addToast, loadDetail]);

  const renderYapResultBanner = (result, { practiceId = null, showRetry = false, showDelete = false } = {}) => {
    if (!result) return null;
    const statusCandidate = [
      result.status,
      result.practice?.management_sync_status,
      result.yap?.status,
    ].find((value) => String(value || '').trim().length > 0);
    let status = String(statusCandidate || 'unknown').trim();
    const scopeSummary = formatYapSyncScopeSummary(result);
    const agendaOnly = isAgendaOnlyYapSync(result);
    const audit = getYapAuditResult(result);
    const titleMap = {
      complete_synced: 'YAP completo',
      partial_synced: 'YAP parziale',
      agenda_synced: 'Agenda verificata',
      synced: agendaOnly ? 'Agenda sincronizzata' : 'Sync YAP completata',
      duplicate: 'Duplicato rilevato',
      dry_run: 'Dry-run YAP completato',
      not_ready: 'Pratica non pronta',
      blocked_by_odl: 'Eliminazione bloccata da ODL',
      deleted: 'Appuntamento eliminato',
      sync_failed: 'Sync YAP fallita',
      delete_failed: 'Eliminazione YAP fallita',
      unknown: 'Stato YAP sconosciuto',
    };
    const message = result.message
      || result.yap?.result?.message
      || result.yap?.message
      || ((status === 'synced' || status === 'duplicate') && scopeSummary ? scopeSummary : '')
      || (status === 'deleted' ? 'Appuntamento eliminato da YAP.' : '')
      || '';
    if (status === 'unknown') {
      const normalizedMessage = String(message || '').toLowerCase();
      if (normalizedMessage.includes('agenda sincronizzata')) status = 'agenda_synced';
      if (normalizedMessage.includes('appuntamento eliminato')) status = 'deleted';
      if (normalizedMessage.includes('fallita') || normalizedMessage.includes('errore')) status = 'sync_failed';
    }
    const isSuccess = status === 'complete_synced' || status === 'deleted' || status === 'duplicate';
    const isWarning = ['partial_synced', 'agenda_synced', 'synced', 'not_ready', 'blocked_by_odl', 'dry_run'].includes(status);
    const toneClass = isSuccess ? 'yap-success' : (isWarning ? 'yap-warning' : 'yap-error');
    const meta = [];
    if (Number.isFinite(result.preSync?.score)) meta.push(`Pre-sync ${result.preSync.score}/100`);
    if (result.yap?.result?.telemetry?.saveAttempts) meta.push(`${result.yap.result.telemetry.saveAttempts} tentativi`);
    if (result.screenshot) meta.push('Screenshot salvato');
    if (result.duplicate) meta.push('Dedup attivo');
    if (audit) meta.push(`Audit: ${audit.present?.length || 0} presenti, ${audit.missing?.length || 0} mancanti, ${audit.mismatch?.length || 0} diversi`);
    const normalizedMessage = String(message || '').toLowerCase();
    const normalizedScopeSummary = String(scopeSummary || '').toLowerCase();
    if (scopeSummary && normalizedScopeSummary && !normalizedMessage.includes(normalizedScopeSummary)) meta.push(scopeSummary);
    const resolvedPracticeId = practiceId || yapLastPracticeId;
    const canRetry = showRetry && resolvedPracticeId && ['sync_failed', 'not_ready', 'dry_run', 'duplicate'].includes(status);
    const canAudit = showRetry && resolvedPracticeId && ['complete_synced', 'partial_synced', 'agenda_synced', 'synced', 'duplicate', 'sync_failed'].includes(status);
    const canDelete = showDelete && resolvedPracticeId && ['complete_synced', 'partial_synced', 'agenda_synced', 'synced', 'duplicate', 'dry_run', 'not_ready'].includes(status);

    return (
      <div className={`yap-result-banner ${toneClass}`}>
        <div className="yap-result-summary">
          <div>
            <div className="yap-result-status">{titleMap[status] || titleMap.unknown}</div>
            {message && <div className="yap-result-message">{message}</div>}
            {meta.length > 0 && <div className="yap-result-meta">{meta.join(' • ')}</div>}
          </div>
        </div>
        {(canRetry || canAudit || canDelete) && (
          <div className="yap-result-actions">
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
          </div>
        )}
      </div>
    );
  };

  const renderYapAuditReport = (audit) => {
    if (!audit) return null;
    const groups = [
      { key: 'present', title: 'Presenti', items: audit.present || [] },
      { key: 'missing', title: 'Mancanti', items: audit.missing || [] },
      { key: 'mismatch', title: 'Diversi', items: audit.mismatch || [] },
    ];

    return (
      <div className="section yap-audit-section">
        <div className="section-title-row">
          <h2>Controllo YAP</h2>
          <span className={`yap-audit-status yap-audit-status-${audit.status || 'unknown'}`}>
            {formatYapPracticeStatus({ management_sync_status: audit.status })}
          </span>
        </div>
        {audit.message && <div className="yap-audit-message">{audit.message}</div>}
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
                      {item.found && group.key === 'mismatch' && <small>trovato: {String(item.found).slice(0, 120)}</small>}
                    </li>
                  ))}
                  {group.items.length > 8 && <li className="yap-audit-more">+{group.items.length - 8} altri campi</li>}
                </ul>
              ) : (
                <div className="yap-audit-empty">Nessun campo</div>
              )}
            </div>
          ))}
        </div>
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
  }, [setValue, startSlowTimer, clearSlowTimer]);

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
        setValue('appointment_time', p.appointment_time || '');
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
    if (!plate || !phone || !name || !data.appointment_date || !data.appointment_time || selectedContexts.length === 0) {
      return null;
    }
    const hasRows = selectedContexts.every((ctx) =>
      (sections[ctx]?.description_rows || []).some((row) => (row || '').trim())
    );
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
        appointment_date: formatDateForBackend(data.appointment_date),
        appointment_time: data.appointment_time,
        practice_type: data.practice_type || 'ordine_di_lavoro',
        contexts: selectedContexts,
        internal_notes: data.internal_notes || null,
      },
      sections: sectionPayloads,
      parts: partPayloads,
    };
  }, [getValues, selectedContexts, sections, parts]);

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
              {preview.preSync.issues.map((issue, index) => (
                <div
                  key={`${issue.type}-${index}`}
                  className={`yap-preview-issue ${issue.blocking ? 'blocking' : 'warning'}`}
                >
                  <div className="yap-preview-issue-head">
                    <span>{issue.blocking ? 'Bloccante' : 'Attenzione'}</span>
                    <span>{issue.type}</span>
                  </div>
                  <div className="yap-preview-issue-body">{issue.message}</div>
                </div>
              ))}
            </div>
          )}
          {showOdl && preview.proposedYap?.odl && (
            <div className="yap-odl-preview">
              <h3 className="yap-odl-title">Gestione pratica / ODL</h3>
              <p className="yap-odl-reason">{preview.proposedYap.odl.reason}</p>
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
        <div className="yap-preview-empty">Completa targa, data, ora, contesti e almeno una riga descrittiva per vedere l&apos;anteprima.</div>
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
        startSlowTimer();
        try {
          await fetchWithRetry(() =>
            axios.delete(`${API_BASE_URL}/practices/${p.id}`, { params: getAuthParams(), headers: getHeaders(), timeout: 30000 })
          );
          clearDraft();
          addToast('Pratica cancellata con successo', 'success');
          setCurrentView('dashboard');
          setNavigationStack([]);
          setSelectedPracticeId(null);
          setDetailData(null);
          setPractices(prev => prev.filter(pr => pr.id !== p.id));
          setStats(prev => prev ? { ...prev, total: prev.total - 1, pending_sync: p.synced ? prev.pending_sync : prev.pending_sync - 1 } : prev);
        } catch (err) {
          addToast(classifyError(err), 'error');
        } finally {
          clearSlowTimer();
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

    if (!data.appointment_date) errs.appointment_date = 'Data obbligatoria';
    if (!data.appointment_time) errs.appointment_time = 'Ora obbligatoria';
    if (selectedContexts.length === 0) errs.contexts = 'Seleziona almeno un contesto';
    selectedContexts.forEach(context => {
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
    setError('');
    startSlowTimer();
    startSaveProgress('Verifica dati e salvataggio in corso...', 'validate');

    try {
      const practicePayload = {
        plate_confirmed: data.plate_confirmed,
        phone: data.phone,
        customer_name: data.customer_name,
        customer_type: data.customer_type,
        billing_to_complete: data.billing_to_complete || false,
        appointment_date: formatDateForBackend(data.appointment_date),
        appointment_time: data.appointment_time,
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

        if (selectedPracticeId) {
          setSelectedPracticeId(previewId);
          setDetailData(buildPreviewDetail(previewItem));
          setCurrentView('detail');
          setNavigationStack(['dashboard']);
        } else {
          setCurrentView('dashboard');
          setNavigationStack([]);
        }
        setEditingPractice(null);
        setPractice(null);
        setFormPhotos([]);
        setExistingPhotos(previewPhotos);
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
          label: 'Sincronizzazione YAP in corso...',
          stage: 'sync',
          percent: 72,
          status: 'running',
        });
        addToast('Salvataggio completato. Sincronizzazione YAP in corso...', 'info');

        // Keep YAP aligned automatically after a successful save, without showing a final result early.
        if (practiceId) {
          void (async () => {
            const syncResult = await syncToYap(practiceId, { dry_run: false, silent: true });
            const actionLabel = practice ? 'aggiornata' : 'creata';
            const scopeSummary = formatYapSyncScopeSummary(syncResult);
            const finalMessage = syncResult.status === 'complete_synced'
              ? `Pratica ${actionLabel}. YAP completo verificato.`
              : ['partial_synced', 'agenda_synced', 'synced', 'duplicate'].includes(syncResult.status)
                ? `Pratica ${actionLabel}. ${syncResult.message || scopeSummary || 'YAP verificato parzialmente.'}`
              : syncResult.status === 'dry_run'
                ? `Pratica ${actionLabel}. Dry-run YAP completato.`
                : syncResult.status === 'not_ready'
                  ? `Pratica ${actionLabel}, ma non pronta per YAP.`
                  : `Pratica ${actionLabel}, ma sync YAP fallita: ${syncResult.message || 'errore sconosciuto'}`;
            const finalSyncResult = { ...syncResult, message: finalMessage };
            setYapLastResult(finalSyncResult);
            finishSaveProgress(finalMessage, syncResult.status === 'sync_failed' ? 'error' : 'success', syncResult.status === 'sync_failed' ? 0 : 1400);
            if (startedFromBot && !practice) {
              setSuccessDone(true);
            } else if (selectedPracticeId) {
              setSelectedPracticeId(practiceId);
              setCurrentView('detail');
              setNavigationStack(['dashboard']);
            } else {
              setCurrentView('dashboard');
              setNavigationStack([]);
            }
            const toastTone = syncResult.status === 'sync_failed'
              ? 'error'
              : (['partial_synced', 'agenda_synced', 'not_ready', 'dry_run'].includes(syncResult.status) ? 'warning' : 'success');
            addToast(finalMessage, toastTone);
          })();
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
      clearSlowTimer();
      setSaving(false);
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
    setSuccessDone(false);
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
      setValue('appointment_time', p.appointment_time || '');
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
      setValue('appointment_time', randomDraft.formData.appointment_time);
    }

    setCurrentView('form');
    setNavigationStack(['dashboard']);
  };

  // --- Dashboard View ---
  const renderDashboard = () => {
    const dashboardItems = dashboardDraftCard ? [dashboardDraftCard, ...practices] : practices;
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
        <DebugPanel authMode={authMode} initData={initData} telegramUserId={telegramUserId} practiceAccessToken={practiceAccessToken} lastApiDebug={lastApiDebug} />

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
            <button className="search-clear" onClick={() => setSearchQuery('')} type="button">✕</button>
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
              return (
              <div
                key={p.id}
                className={`practice-card ${isLocalDraft ? 'practice-card-draft' : ''}`}
                onClick={() => (isLocalDraft ? openNewPracticeForm() : navigateTo('detail', { practiceId: p.id }))}
              >
                <div className="practice-card-header">
                  <span className="practice-plate">{p.plate || (isLocalDraft ? 'BOZZA' : '—')}</span>
                  <span className={`sync-pill ${isLocalDraft ? 'sync-pill-draft' : (p.synced ? 'sync-pill-green' : 'sync-pill-red')}`}>
                    <span className={`sync-dot ${isLocalDraft ? 'sync-dot-draft' : (p.synced ? 'sync-dot-green' : 'sync-dot-red')}`} />
                    {isLocalDraft ? 'Bozza locale' : (formatYapPracticeStatus(p) === 'Non sincronizzata' ? 'Da sincronizzare' : formatYapPracticeStatus(p))}
                  </span>
                </div>
                <div className="practice-card-customer-row">
                  <div className="practice-card-customer">{p.customer_name || (isLocalDraft ? 'Compilazione non completata' : '—')}</div>
                  {showDeveloperUi && <div className="practice-card-id">#{p.id}</div>}
                </div>
                <div className="practice-card-badges">
                  {normalizeContexts(p.contexts).map(ctx => (
                    <span key={ctx} className="context-badge" style={{ background: CONTEXT_COLORS[ctx]?.bg, color: CONTEXT_COLORS[ctx]?.color, borderColor: CONTEXT_COLORS[ctx]?.border }}>
                      {ctx.charAt(0).toUpperCase() + ctx.slice(1)}
                    </span>
                  ))}
                  {showDeveloperUi && preSync && (
                    <span className={`pre-sync-pill ${preSyncReady ? 'pre-sync-pill-ready' : 'pre-sync-pill-not-ready'}`}>
                      {preSyncReady ? 'Ready' : 'Non ready'}
                      {preSyncScore !== null ? ` • Score ${preSyncScore}/100` : ''}
                    </span>
                  )}
                </div>
                <div className="practice-card-footer">
                  <span className="practice-card-date">📅 {formatDate(p.appointment_date || p.created_at)}</span>
                  <span className="practice-card-open">{isLocalDraft ? 'Riprendi bozza →' : 'Apri dettagli →'}</span>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* FAB */}
      <button
        className="fab"
        type="button"
        onClick={openNewPracticeForm}
        aria-label="Nuova pratica"
      >
        +
      </button>
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

          {yapLastPracticeId === practice.id && renderYapResultBanner(yapLastResult, { practiceId: practice.id, showRetry: true, showDelete: true })}

          {renderYapAuditReport(getYapAuditResult(yapLastPracticeId === practice.id ? yapLastResult : null) || practice.management_audit_result)}

          {!browserPreviewMode && renderYapPreviewPanel(yapPreview, yapPreviewLoading)}

          {/* YAP Automation Controls */}
          {!browserPreviewMode && (
            <div className="section">
              <h2>🔧 Automazione YAP</h2>
              <div className="yap-controls-grid">
                <button
                  type="button"
                  className="yap-control-button"
                  onClick={() => syncToYap(practice.id, { dry_run: false })}
                  disabled={yapSyncLoading}
                >
                  {yapSyncLoading ? 'Sincronizzazione...' : 'Sincronizza con YAP'}
                </button>
                <button
                  type="button"
                  className="yap-control-button"
                  onClick={() => auditYapAppointment(practice.id, { debug: false })}
                  disabled={yapAuditLoading}
                >
                  {yapAuditLoading ? 'Verifica...' : 'Verifica YAP'}
                </button>
                <button
                  type="button"
                  className="yap-control-button yap-delete-button"
                  onClick={() => deleteYapAppointment(practice.id, { dry_run: false })}
                  disabled={yapDeleteLoading}
                >
                  {yapDeleteLoading ? 'Eliminazione...' : 'Elimina appuntamento YAP'}
                </button>
              </div>
              {yapActionProgress && String(yapActionProgress.practiceId) === String(practice.id) && (
                <div className={`yap-action-progress ${yapActionProgress.status === 'error' ? 'save-progress-error' : yapActionProgress.status === 'success' ? 'save-progress-success' : 'save-progress-running'}`}>
                  <div className="save-progress-header">
                    {yapActionProgress.status === 'running' && <span className="loading-spinner sm"></span>}
                    <span className="save-progress-label">{yapActionProgress.label}</span>
                    <span className="save-progress-percent">{Math.round(yapActionProgress.percent)}%</span>
                  </div>
                  <div className="upload-progress-bar" aria-hidden="true">
                    <div
                      className="upload-progress-bar-fill"
                      style={{ width: `${Math.max(0, Math.min(100, yapActionProgress.percent))}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Sync status */}
          <div className="section detail-sync-section" onClick={() => toggleSync(practice.id, practice.synced)}>
            <div className="detail-sync-label">Stato sincronizzazione</div>
            <div className={`detail-sync-toggle ${practice.synced ? 'synced' : 'not-synced'}`}>
              <span className={`sync-dot ${practice.synced ? 'sync-dot-green' : 'sync-dot-red'}`} />
              {formatYapPracticeStatus(practice)}
            </div>
          </div>

          {/* Sections */}
          {dSections.length > 0 && (
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
          {dParts.length > 0 && (
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
        </div>

        {lightboxPhoto && <Lightbox src={lightboxPhoto} onClose={() => setLightboxPhoto(null)} />}
      </div>
    );
  };

  // --- Form View ---
  const renderForm = () => {
    if (successDone) {
      return (
        <div className="view-form view-enter">
          <div className="container">
            <div className="success-screen">
              <div className="success-icon">✅</div>
              <h2>Pratica salvata!</h2>
              <p>La pratica è stata salvata con successo.</p>
              <button className="button-submit" onClick={() => { openDashboard(); setSuccessDone(false); }} type="button">
                📋 Vai alla Dashboard
              </button>
              <button
                className="btn-secondary"
                onClick={() => { if (window.Telegram?.WebApp) window.Telegram.WebApp.close(); }}
                type="button"
              >
                Chiudi Mini App
              </button>
            </div>
          </div>
        </div>
      );
    }

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
          <DebugPanel authMode={authMode} initData={initData} telegramUserId={telegramUserId} practiceAccessToken={practiceAccessToken} lastApiDebug={lastApiDebug} />

          {showDraftBanner && (
            <div className="draft-banner">
              <span>📝 Bozza ripristinata</span>
              <button type="button" onClick={discardDraft}>
                Scarta
              </button>
            </div>
          )}

          {error && <div className="error">{error}</div>}

          {slowRequest && (
            <div className="slow-request-warning">⏳ La richiesta sta impiegando più del previsto...</div>
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

            {/* Appuntamento */}
            <div className="section">
              <h2>📅 Appuntamento</h2>
              <div className="form-group">
                <label htmlFor="appointment_date">Data*</label>
                <Controller
                  control={control}
                  name="appointment_date"
                  rules={{ required: 'Data obbligatoria' }}
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

              <div className="form-group">
                <label htmlFor="appointment_time">Ora inizio appuntamento*</label>
                <select
                  id="appointment_time"
                  {...register('appointment_time', { required: 'Ora obbligatoria' })}
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

              <div className="form-group">
                <label htmlFor="practice_type">Tipo Pratica*</label>
                <select id="practice_type" {...register('practice_type')} className="select">
                  <option value="preventivo">Preventivo</option>
                  <option value="ordine_di_lavoro">Ordine di Lavoro</option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="internal_notes">Note interne (pratica)</label>
                <textarea
                  id="internal_notes"
                  {...register('internal_notes')}
                  className="textarea"
                  rows="2"
                  placeholder="Note generali visibili nel mapping verso YAP (non nel popup agenda)"
                />
              </div>
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

            {/* Sezioni dinamiche */}
            {selectedContexts.map(context => (
              <div key={context} className="section">
                <h2>📋 {context.charAt(0).toUpperCase() + context.slice(1)}</h2>

                <div className="form-group">
                  <div className="section-inline-actions">
                    <label>Righe Descrittive*</label>
                    <button type="button" onClick={() => addDescriptionRow(context)} className="button-add">+ Aggiungi riga</button>
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
                        <button type="button" onClick={() => removeDescriptionRow(context, index)} className="button-remove">✕</button>
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
                      <button type="button" onClick={() => addPart(context)} className="button-add">+ Aggiungi pezzo</button>
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
                        <button type="button" onClick={() => removePart(context, index)} className="button-remove">✕</button>
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
        {slowRequest && <div className="slow-request-warning">⏳ La richiesta sta impiegando più del previsto...</div>}
      </div>
    );
  }

  return (
    <div className="App">
      <Toast toasts={toasts} removeToast={removeToast} />
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
