import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useForm, Controller } from 'react-hook-form';
import axios from 'axios';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import './App.css';

// Configurazione axios
const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://giorgio-mvp-production.up.railway.app';

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
function classifyError(err) {
  if (!err.response) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return 'Connessione scaduta. Controlla la tua connessione e riprova.';
    }
    return 'Errore di rete. Controlla la connessione internet e riprova.';
  }
  const status = err.response.status;
  const detail = err.response.data?.detail;
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
  if (status >= 500) return 'Errore del server. Riprova tra qualche istante.';
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

/** Format date to DD/MM/YYYY */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateForBackend(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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
const FORM_FIELDS = ['plate_confirmed', 'phone', 'customer_name', 'customer_type', 'billing_to_complete', 'appointment_date', 'appointment_time', 'practice_type', 'internal_notes'];

// Precompiled demo data used for fast QA testing in browser/Telegram preview
const DEMO_DRAFT = {
  plate_confirmed: 'AB123CD',
  phone: '3331234567',
  customer_name: 'Mario Rossi',
  customer_type: 'azienda',
  billing_to_complete: true,
  appointment_date: '2026-06-20',
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
      appointment_date: '2026-06-24T09:00:00',
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
      appointment_date: '2026-06-25T14:30:00',
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
      appointment_date: '2026-06-26T11:00:00',
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
      appointment_date: '2026-06-27T08:30:00',
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
      appointment_date: '2026-06-27T16:00:00',
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

function DebugPanel({ authMode, initData, telegramUserId, lastApiDebug }) {
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

  // Navigation state
  const [currentView, setCurrentView] = useState('dashboard');
  const [selectedPracticeId, setSelectedPracticeId] = useState(null);
  const [editingPractice, setEditingPractice] = useState(null);
  const [navigationStack, setNavigationStack] = useState([]);

  // Shared state
  const [initData, setInitData] = useState('');
  const [telegramUserId, setTelegramUserId] = useState('');
  const [lastApiDebug, setLastApiDebug] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [confirmModal, setConfirmModal] = useState(null);

  const [startedFromBot, setStartedFromBot] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Dashboard state
  const [practices, setPractices] = useState([]);
  const [stats, setStats] = useState({ total: 0, this_month: 0, pending_sync: 0 });
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [seedingDemoPractices, setSeedingDemoPractices] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState({ officina: false, carrozzeria: false, revisione: false, synced: null });

  // Detail state
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);

  // Form state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [practice, setPractice] = useState(null);
  const [error, setError] = useState('');
  const [successDone, setSuccessDone] = useState(false);

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
  const toastIdRef = useRef(0);
  const formRef = useRef(null);
  const searchTimerRef = useRef(null);

  const { register, control, handleSubmit, setValue, watch, getValues, formState: { errors } } = useForm();

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
    if (opts.editingPractice) setEditingPractice(opts.editingPractice);
    if (opts.existingPhotos) setExistingPhotos(opts.existingPhotos);
  }, [currentView]);

  const navigateBack = useCallback(() => {
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
  }, [navigationStack]);

  // --- Telegram BackButton ---
  useEffect(() => {
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
  }, [currentView, navigateBack]);

  // --- Slow request indicator ---
  const startSlowTimer = useCallback(() => {
    slowTimerRef.current = setTimeout(() => setSlowRequest(true), 10000);
  }, []);
  const clearSlowTimer = useCallback(() => {
    if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    slowTimerRef.current = null;
    setSlowRequest(false);
  }, []);

  // --- localStorage draft ---
  const saveDraft = useCallback(() => {
    if (currentView !== 'form') return;
    try {
      const data = getValues();
      const draft = { formData: data, selectedContexts, sections, parts, timestamp: Date.now() };
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch (_) {}
  }, [getValues, selectedContexts, sections, parts, currentView]);

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch (_) {}
  }, []);

  const applyDemoTemplate = useCallback(() => {
    setPractice(null);
    setEditingPractice(null);
    setStartedFromBot(false);
    setSuccessDone(false);
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

  const restoreDraft = useCallback(() => {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      if (Date.now() - draft.timestamp > 24 * 60 * 60 * 1000) {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
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
      if (draft.sections) setSections(normalizeSections(Object.values(draft.sections)));
      if (draft.parts) setParts(draft.parts);
      return true;
    } catch (_) { return false; }
  }, [setValue]);

  // Save draft on data change (debounced)
  const watchedValues = watch();
  useEffect(() => {
    if (currentView === 'form' && !loading && !successDone) {
      const timer = setTimeout(() => saveDraft(), 500);
      return () => clearTimeout(timer);
    }
  }, [watchedValues, selectedContexts, sections, parts, loading, successDone, saveDraft, currentView]);

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
    return params;
  }, [telegramUserId]);

  // --- Dashboard: Load practices ---
  const loadDashboard = useCallback(async (search = '', filters = {}) => {
    setDashboardLoading(true);
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

      setPractices(practicesRes.data?.data || practicesRes.data || []);
      setStats(statsRes.data?.data || statsRes.data || { total: 0, this_month: 0, pending_sync: 0 });
      rememberResponse('dashboard.list');
    } catch (err) {
      rememberError('dashboard.list', err);
      addToast(classifyError(err), 'error');
    } finally {
      setDashboardLoading(false);
    }
  }, [getAuthParams, getHeaders, addToast]);

  const seedDemoPractices = useCallback(async () => {
    if (seedingDemoPractices) return;
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
  }, [seedingDemoPractices, getAuthParams, getHeaders, addToast, loadDashboard, searchQuery, activeFilters]);

  // Load dashboard on view mount
  useEffect(() => {
    if (!bootstrapped) return;
    if (currentView === 'dashboard' && (initData || telegramUserId || standaloneBrowserMode)) {
      loadDashboard(searchQuery, activeFilters);
    }
  }, [bootstrapped, currentView, initData, telegramUserId, standaloneBrowserMode, loadDashboard, searchQuery, activeFilters]);

  // Debounced search
  useEffect(() => {
    if (!bootstrapped) return;
    if (currentView !== 'dashboard') return;
    if (!initData && !telegramUserId && !standaloneBrowserMode) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadDashboard(searchQuery, activeFilters);
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [bootstrapped, currentView, initData, telegramUserId, standaloneBrowserMode, searchQuery, activeFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Detail: Load practice ---
  const loadDetail = useCallback(async (id) => {
    if (!id) return;
    setDetailLoading(true);
    setDetailData(null);
    try {
      rememberRequest('practice.detail', { method: 'GET', url: `${API_BASE_URL}/api/practices/${id}`, params: getAuthParams(), headers: getHeaders() });
      const res = await fetchWithRetry(() =>
        axios.get(`${API_BASE_URL}/api/practices/${id}`, { params: getAuthParams(), headers: getHeaders(), timeout: 15000 })
      );
      setDetailData(res.data?.data || res.data);
      rememberResponse('practice.detail');
    } catch (err) {
      rememberError('practice.detail', err);
      addToast(classifyError(err), 'error');
      navigateBack();
    } finally {
      setDetailLoading(false);
    }
  }, [getAuthParams, getHeaders, addToast, navigateBack]);

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

  const uploadQueuedPhotos = useCallback(async (practiceId) => {
    if (formPhotos.length === 0) return;
    const currentTelegramUserId = telegramUserId;
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < formPhotos.length; i++) {
      setFormPhotoUploadProgress(`Caricamento foto ${i + 1}/${formPhotos.length}...`);
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
      } catch (err) {
        failCount++;
        rememberError('photo.upload', err);
      }
    }
    setFormPhotoUploadProgress('');
    if (successCount > 0) addToast(`${successCount} foto caricate con successo!`, 'success');
    if (failCount > 0) addToast(`${failCount} foto non caricate.`, 'error');
    // Cleanup previews
    formPhotos.forEach(p => URL.revokeObjectURL(p.preview));
    setFormPhotos([]);
  }, [formPhotos, initData, telegramUserId, addToast]);

  // --- Toggle sync ---
  const toggleSync = useCallback(async (id, currentSynced) => {
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
  }, [getAuthParams, getHeaders, addToast]);

  // --- Form: Load practice for editing ---
  const loadPractice = useCallback(async (practiceId, currentInitData, plateFromUrl = '', currentTelegramUserId = '') => {
    startSlowTimer();
    try {
      rememberRequest('miniapp.load_practice', {
        method: 'GET',
        url: `${API_BASE_URL}/mini-app/data`,
        params: { practice_id: practiceId, ...(currentTelegramUserId ? { user_id: currentTelegramUserId } : {}) },
        headers: {
          ...(currentInitData ? { 'X-Telegram-Init-Data': currentInitData } : {}),
          ...(currentTelegramUserId ? { 'X-Telegram-User-Id': currentTelegramUserId } : {}),
        }
      });
      const response = await fetchWithRetry(() =>
        axios.get(`${API_BASE_URL}/mini-app/data`, {
          params: { practice_id: practiceId, ...(currentTelegramUserId ? { user_id: currentTelegramUserId } : {}) },
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
      setValue('plate_confirmed', p.plate_confirmed || p.plate || '');
      setValue('phone', p.phone || '');
      setValue('customer_name', p.customer_name || '');
      setValue('customer_type', p.customer_type || 'privato');
      setValue('appointment_time', p.appointment_time || '');
      setValue('practice_type', p.practice_type || 'preventivo');
      setValue('internal_notes', p.internal_notes || p.notes || '');
      setValue('billing_to_complete', p.billing_to_complete || false);
      if (p.appointment_date) setValue('appointment_date', new Date(p.appointment_date));
      setSelectedContexts(normalizeContexts(p.contexts));
      setError('');
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
      setLoading(false);
    }
  }, [currentView, editingPractice, setValue]);

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
      setInitData(currentInitData);
      setTelegramUserId(currentTelegramUserId);

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
          loadPractice(practiceId, currentInitData, plate || '', currentTelegramUserId);
        } else {
          if (plate) setValue('plate_confirmed', plate);
          const hadDraft = restoreDraft();
          if (hadDraft) setShowDraftBanner(true);
          setSelectedContexts(prev => prev.length ? prev : []);
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
      const currentTelegramUserId = extractTelegramUserIdFromLocation() || extractTelegramUserIdFromRuntime();
      setTelegramUserId(currentTelegramUserId);
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
          loadPractice(practiceId, '', plate || '', currentTelegramUserId);
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

  // --- Delete practice ---
  const deletePractice = (practiceToDelete) => {
    const p = practiceToDelete || practice;
    if (!p || !p.id) return;
    setConfirmModal({
      title: '🗑 Cancellare pratica?',
      message: 'Questa operazione non è reversibile. Vuoi procedere?',
      onConfirm: async () => {
        setConfirmModal(null);
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

        // Upload queued photos after practice creation
        if (formPhotos.length > 0 && practiceId) {
          await uploadQueuedPhotos(practiceId);
        }

        addToast(practice ? 'Pratica aggiornata con successo!' : 'Pratica creata con successo!', 'success');

        if (startedFromBot && !practice) {
          // Created from bot startapp
          setSuccessDone(true);
        } else {
          // Navigate back: if editing, go to detail; otherwise dashboard
          if (selectedPracticeId) {
            setSelectedPracticeId(practiceId);
            setCurrentView('detail');
            setNavigationStack(['dashboard']);
          } else {
            setCurrentView('dashboard');
            setNavigationStack([]);
          }
          setEditingPractice(null);
          setPractice(null);
        }
      }
    } catch (err) {
      rememberError(practice ? 'practice.update' : 'practice.create', err);
      setError(classifyError(err));
      addToast(classifyError(err), 'error');
    } finally {
      clearSlowTimer();
      setSaving(false);
    }
  };

  // --- Reset form for new practice ---
  const resetFormForNew = () => {
    setPractice(null);
    setEditingPractice(null);
    setSelectedContexts([]);
    setSections({});
    setParts({});
    setError('');
    setFieldErrors({});
    setSuccessDone(false);
    setValue('plate_confirmed', '');
    setValue('phone', '');
    setValue('customer_name', '');
    setValue('customer_type', 'privato');
    setValue('appointment_date', null);
    setValue('appointment_time', '');
    setValue('practice_type', 'preventivo');
    setValue('internal_notes', '');
    setValue('billing_to_complete', false);
    setFormPhotos([]);
    setExistingPhotos([]);
    setFormPhotoUploadProgress('');
    setLoading(false);
  };

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
  const authMode = initData ? 'initData' : (telegramUserId ? 'fallback user_id' : 'non autenticato');

  // ==================== RENDER ====================

  // --- Dashboard View ---
  const renderDashboard = () => (
    <div className="view-dashboard view-enter">
      <div className="container">
        <h1>🔧 Giorgio</h1>
        <div className="field-hint" style={{ marginBottom: 12 }}>
          Auth: <strong>{authMode}</strong>
        </div>
        <DebugPanel authMode={authMode} initData={initData} telegramUserId={telegramUserId} lastApiDebug={lastApiDebug} />

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
          <div className="stat-card">
            <div className="stat-number">{stats.pending_sync}</div>
            <div className="stat-label">Da sincr.</div>
          </div>
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
          <button
            type="button"
            className={`filter-chip ${activeFilters.synced !== null ? 'filter-chip-active' : ''}`}
            onClick={() => toggleFilter('synced')}
          >
            {activeFilters.synced === null ? 'Sincr.' : activeFilters.synced ? '🟢 Sincr.' : '🔴 Non sincr.'}
          </button>
        </div>

        <div className="detail-actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={seedDemoPractices}
            disabled={seedingDemoPractices}
          >
            {seedingDemoPractices ? 'Creazione pratiche demo...' : `Crea ${DASHBOARD_DEMO_PRACTICES.length} pratiche esempio piene`}
          </button>
        </div>

        {/* Practice list */}
        {dashboardLoading ? (
          <DashboardSkeleton />
        ) : practices.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <h3>Nessuna pratica trovata</h3>
            <p>Prova a modificare i filtri o crea una nuova pratica.</p>
          </div>
        ) : (
          <div className="practice-list">
            {practices.map(p => (
              <div
                key={p.id}
                className="practice-card"
                onClick={() => navigateTo('detail', { practiceId: p.id })}
              >
                <div className="practice-card-header">
                  <span className="practice-plate">{p.plate || '—'}</span>
                  <span className={`sync-pill ${p.synced ? 'sync-pill-green' : 'sync-pill-red'}`}>
                    <span className={`sync-dot ${p.synced ? 'sync-dot-green' : 'sync-dot-red'}`} />
                    {p.synced ? 'Sincronizzata' : 'Da sincronizzare'}
                  </span>
                </div>
                <div className="practice-card-customer-row">
                  <div className="practice-card-customer">{p.customer_name || '—'}</div>
                  <div className="practice-card-id">#{p.id}</div>
                </div>
                <div className="practice-card-badges">
                  {normalizeContexts(p.contexts).map(ctx => (
                    <span key={ctx} className="context-badge" style={{ background: CONTEXT_COLORS[ctx]?.bg, color: CONTEXT_COLORS[ctx]?.color, borderColor: CONTEXT_COLORS[ctx]?.border }}>
                      {ctx.charAt(0).toUpperCase() + ctx.slice(1)}
                    </span>
                  ))}
                </div>
                <div className="practice-card-footer">
                  <span className="practice-card-date">📅 {formatDate(p.appointment_date || p.created_at)}</span>
                  <span className="practice-card-open">Apri dettagli →</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* FAB */}
      <button
        className="fab"
        type="button"
        onClick={() => { resetFormForNew(); navigateTo('form'); }}
        aria-label="Nuova pratica"
      >
        +
      </button>
    </div>
  );

  // --- Detail View ---
  const renderDetail = () => {
    if (detailLoading || !detailData) {
      return (
        <div className="view-detail view-enter">
          <div className="container">
            <button className="back-button" onClick={navigateBack} type="button">← Indietro</button>
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
              <div className="detail-meta-item">
                <span className="detail-meta-label">Stato pratica</span>
                <span className="detail-meta-value">{practice.status || '—'}</span>
              </div>
              <div className="detail-meta-item">
                <span className="detail-meta-label">Contesti</span>
                <span className="detail-meta-value">{contexts.length ? contexts.join(', ') : '—'}</span>
              </div>
            </div>
          </div>

          {/* Sync status */}
          <div className="section detail-sync-section" onClick={() => toggleSync(practice.id, practice.synced)}>
            <div className="detail-sync-label">Stato sincronizzazione</div>
            <div className={`detail-sync-toggle ${practice.synced ? 'synced' : 'not-synced'}`}>
              <span className={`sync-dot ${practice.synced ? 'sync-dot-green' : 'sync-dot-red'}`} />
              {practice.synced ? 'Sincronizzata' : 'Non sincronizzata'}
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

          {/* Notes */}
          {(practice.internal_notes || practice.notes) && (
            <div className="section">
              <h2>📝 Note</h2>
              <p className="detail-notes">{practice.internal_notes || practice.notes}</p>
            </div>
          )}

          {/* Actions */}
          <div className="detail-actions">
            <button
              className="button-submit"
              type="button"
              onClick={() => navigateTo('form', { editingPractice: practice, existingPhotos: photos })}
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
              <button className="button-submit" onClick={() => { setCurrentView('dashboard'); setNavigationStack([]); setSuccessDone(false); }} type="button">
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
            <button className="back-button" onClick={() => { navigateBack(); resetFormForNew(); }} type="button">← Indietro</button>
          )}
          {(currentView === 'form' && startedFromBot) && (
            <button className="back-button" onClick={() => { setCurrentView('dashboard'); setNavigationStack([]); setStartedFromBot(false); setLoading(false); }} type="button">← Dashboard</button>
          )}

          <h1>🔧 Dati Pratica</h1>
          <div className="field-hint" style={{ marginBottom: 12 }}>
            Auth: <strong>{authMode}</strong>
          </div>
          <DebugPanel authMode={authMode} initData={initData} telegramUserId={telegramUserId} lastApiDebug={lastApiDebug} />

          {showDraftBanner && (
            <div className="draft-banner">
              <span>📝 Bozza ripristinata</span>
              <button type="button" onClick={() => { clearDraft(); setShowDraftBanner(false); resetFormForNew(); }}>
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
                <label htmlFor="appointment_time">Ora (slot 30 min)*</label>
                <select
                  id="appointment_time"
                  {...register('appointment_time', { required: 'Ora obbligatoria' })}
                  className={`select ${fieldErrors.appointment_time ? 'input-error' : ''}`}
                >
                  <option value="">-- Seleziona --</option>
                  {Array.from({ length: 24 }, (_, i) =>
                    ['00', '30'].map(min =>
                      <option key={`${i.toString().padStart(2, '0')}:${min}`} value={`${i.toString().padStart(2, '0')}:${min}`}>
                        {i.toString().padStart(2, '0')}:{min}
                      </option>
                    )
                  ).flat()}
                </select>
                {renderFieldError('appointment_time')}
              </div>

              <div className="form-group">
                <label htmlFor="practice_type">Tipo Pratica*</label>
                <select id="practice_type" {...register('practice_type')} className="select">
                  <option value="preventivo">Preventivo</option>
                  <option value="ordine_di_lavoro">Ordine di Lavoro</option>
                </select>
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
    </div>
  );
}

export default App;
