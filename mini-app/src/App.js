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
  if (status === 401 || status === 403) return 'Sessione scaduta. Chiudi e riapri la Mini App.';
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

// --- Main App ---

function App() {
  // Navigation state
  const [currentView, setCurrentView] = useState('dashboard');
  const [selectedPracticeId, setSelectedPracticeId] = useState(null);
  const [editingPractice, setEditingPractice] = useState(null);
  const [navigationStack, setNavigationStack] = useState([]);

  // Shared state
  const [initData, setInitData] = useState('');
  const [toasts, setToasts] = useState([]);
  const [confirmModal, setConfirmModal] = useState(null);

  const [startedFromBot, setStartedFromBot] = useState(false);

  // Dashboard state
  const [practices, setPractices] = useState([]);
  const [stats, setStats] = useState({ total: 0, this_month: 0, pending_sync: 0 });
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState({ officina: false, carrozzeria: false, revisione: false, synced: null });

  // Detail state
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [deletingPhotoId, setDeletingPhotoId] = useState(null);
  const detailFileInputRef = useRef(null);

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

  const { register, control, handleSubmit, setValue, watch, getValues, formState: { errors } } = useForm();

  // --- Toast helpers ---
  const addToast = useCallback((message, type = 'success', duration = 4000) => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type, exiting: false }]);
    setTimeout(() => {
      setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 350);
    }, duration);
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
  const getHeaders = useCallback(() => ({ 'X-Telegram-Init-Data': initData }), [initData]);

  // --- Dashboard: Load practices ---
  const loadDashboard = useCallback(async (search = '', filters = {}) => {
    if (!initData) return;
    setDashboardLoading(true);
    try {
      const params = {};
      if (search) params.search = search;
      const contextFilters = Object.entries(filters).filter(([k, v]) => v === true && k !== 'synced').map(([k]) => k);
      if (contextFilters.length) params.context = contextFilters.join(',');
      if (filters.synced === true) params.synced = 'true';
      if (filters.synced === false) params.synced = 'false';
      params.sort = 'date_desc';

      const [practicesRes, statsRes] = await Promise.all([
        fetchWithRetry(() => axios.get(`${API_BASE_URL}/api/practices`, { params, headers: getHeaders(), timeout: 15000 })),
        fetchWithRetry(() => axios.get(`${API_BASE_URL}/api/practices/stats`, { headers: getHeaders(), timeout: 15000 }))
      ]);

      setPractices(practicesRes.data?.data || practicesRes.data || []);
      setStats(statsRes.data?.data || statsRes.data || { total: 0, this_month: 0, pending_sync: 0 });
    } catch (err) {
      addToast(classifyError(err), 'error');
    } finally {
      setDashboardLoading(false);
    }
  }, [initData, getHeaders, addToast]);

  // Load dashboard on view mount
  useEffect(() => {
    if (currentView === 'dashboard' && initData) {
      loadDashboard(searchQuery, activeFilters);
    }
  }, [currentView, initData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  useEffect(() => {
    if (currentView !== 'dashboard') return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadDashboard(searchQuery, activeFilters);
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery, activeFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Detail: Load practice ---
  const loadDetail = useCallback(async (id) => {
    if (!initData || !id) return;
    setDetailLoading(true);
    setDetailData(null);
    try {
      const res = await fetchWithRetry(() =>
        axios.get(`${API_BASE_URL}/api/practices/${id}`, { headers: getHeaders(), timeout: 15000 })
      );
      setDetailData(res.data?.data || res.data);
    } catch (err) {
      addToast(classifyError(err), 'error');
      navigateBack();
    } finally {
      setDetailLoading(false);
    }
  }, [initData, getHeaders, addToast, navigateBack]);

  useEffect(() => {
    if (currentView === 'detail' && selectedPracticeId) {
      loadDetail(selectedPracticeId);
    }
  }, [currentView, selectedPracticeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Photo upload (detail view) ---

  const validateFile = useCallback((file) => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      addToast('Tipo file non supportato. Usa JPG, PNG o WebP.', 'error');
      return false;
    }
    if (file.size > MAX_FILE_SIZE) {
      addToast('File troppo grande. Massimo 10MB.', 'error');
      return false;
    }
    return true;
  }, [addToast]);

  const uploadPhotoToDetail = useCallback(async (file) => {
    const practiceObj = detailData?.practice || detailData;
    if (!practiceObj?.id || !validateFile(file)) return;
    setUploadingPhoto(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API_BASE_URL}/api/practices/${practiceObj.id}/photos`, {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': initData },
        body: formData
      });
      if (!res.ok) throw new Error('Upload failed');
      const json = await res.json();
      if (json.success) {
        setDetailData(prev => ({ ...prev, photos: [...(prev.photos || []), json.data] }));
        addToast('Foto caricata con successo!', 'success');
      } else {
        throw new Error(json.detail || 'Upload failed');
      }
    } catch (err) {
      addToast('Errore durante il caricamento della foto.', 'error');
    } finally {
      setUploadingPhoto(false);
      if (detailFileInputRef.current) detailFileInputRef.current.value = '';
    }
  }, [detailData, initData, addToast, validateFile]);

  const deletePhoto = useCallback((photoId) => {
    const practiceObj = detailData?.practice || detailData;
    if (!practiceObj?.id) return;
    setConfirmModal({
      title: '🗑 Eliminare questa foto?',
      message: 'La foto verrà rimossa definitivamente.',
      onConfirm: async () => {
        setConfirmModal(null);
        setDeletingPhotoId(photoId);
        try {
          const res = await fetch(`${API_BASE_URL}/api/practices/${practiceObj.id}/photos/${photoId}`, {
            method: 'DELETE',
            headers: { 'X-Telegram-Init-Data': initData }
          });
          if (!res.ok) throw new Error('Delete failed');
          setDetailData(prev => ({ ...prev, photos: (prev.photos || []).filter(p => p.id !== photoId) }));
          addToast('Foto eliminata.', 'success');
        } catch (err) {
          addToast('Errore durante l\'eliminazione della foto.', 'error');
        } finally {
          setDeletingPhotoId(null);
        }
      },
      onCancel: () => setConfirmModal(null)
    });
  }, [detailData, initData, addToast]);

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
    let successCount = 0;
    let failCount = 0;
    for (let i = 0; i < formPhotos.length; i++) {
      setFormPhotoUploadProgress(`Caricamento foto ${i + 1}/${formPhotos.length}...`);
      try {
        const fd = new FormData();
        fd.append('file', formPhotos[i].file);
        const res = await fetch(`${API_BASE_URL}/api/practices/${practiceId}/photos`, {
          method: 'POST',
          headers: { 'X-Telegram-Init-Data': initData },
          body: fd
        });
        if (res.ok) successCount++;
        else failCount++;
      } catch {
        failCount++;
      }
    }
    setFormPhotoUploadProgress('');
    if (successCount > 0) addToast(`${successCount} foto caricate con successo!`, 'success');
    if (failCount > 0) addToast(`${failCount} foto non caricate.`, 'error');
    // Cleanup previews
    formPhotos.forEach(p => URL.revokeObjectURL(p.preview));
    setFormPhotos([]);
  }, [formPhotos, initData, addToast]);

  // --- Toggle sync ---
  const toggleSync = useCallback(async (id, currentSynced) => {
    try {
      await fetchWithRetry(() =>
        axios.patch(`${API_BASE_URL}/api/practices/${id}/sync`, { synced: !currentSynced }, { headers: getHeaders(), timeout: 10000 })
      );
      setDetailData(prev => prev ? { ...prev, synced: !currentSynced } : prev);
      setPractices(prev => prev.map(p => p.id === id ? { ...p, synced: !currentSynced } : p));
      addToast(currentSynced ? 'Pratica segnata come non sincronizzata' : 'Pratica segnata come sincronizzata', 'success');
    } catch (err) {
      addToast(classifyError(err), 'error');
    }
  }, [getHeaders, addToast]);

  // --- Form: Load practice for editing ---
  const loadPractice = useCallback(async (practiceId, currentInitData, plateFromUrl = '') => {
    startSlowTimer();
    try {
      const response = await fetchWithRetry(() =>
        axios.get(`${API_BASE_URL}/mini-app/data`, {
          params: { practice_id: practiceId },
          headers: { 'X-Telegram-Init-Data': currentInitData },
          timeout: 30000
        })
      );

      if (response.data.success) {
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

      const currentInitData = webApp.initData;
      setInitData(currentInitData);

      const urlParams = new URLSearchParams(window.location.search);
      const practiceId = urlParams.get('practice_id');
      const plate = urlParams.get('plate');

      if (practiceId || plate) {
        // Opened from bot with params -> show form
        setStartedFromBot(true);
        setCurrentView('form');
        if (practiceId) {
          loadPractice(practiceId, currentInitData, plate || '');
        } else {
          if (plate) setValue('plate_confirmed', plate);
          const hadDraft = restoreDraft();
          if (hadDraft) setShowDraftBanner(true);
          setSelectedContexts(prev => prev.length ? prev : []);
          setLoading(false);
        }
      } else {
        // Opened from menu -> show dashboard
        setCurrentView('dashboard');
        setLoading(false);
      }
    } else {
      setError('Mini App deve essere eseguita in Telegram');
      setLoading(false);
    }
  }, [loadPractice, setValue, restoreDraft]); // eslint-disable-line react-hooks/exhaustive-deps

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
            axios.delete(`${API_BASE_URL}/practices/${p.id}`, { headers: getHeaders(), timeout: 30000 })
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
      const payload = {
        plate_confirmed: data.plate_confirmed,
        phone: data.phone,
        customer_name: data.customer_name,
        customer_type: data.customer_type,
        billing_to_complete: data.billing_to_complete || false,
        appointment_date: data.appointment_date.toISOString().split('T')[0],
        appointment_time: data.appointment_time,
        practice_type: data.practice_type,
        contexts: selectedContexts,
        internal_notes: data.internal_notes || null,
      };

      let response;
      if (practice) {
        response = await fetchWithRetry(() =>
          axios.put(`${API_BASE_URL}/practices/${practice.id}`, payload, { headers: getHeaders(), timeout: 30000 })
        );
      } else {
        response = await fetchWithRetry(() =>
          axios.post(`${API_BASE_URL}/practices`, payload, { headers: getHeaders(), timeout: 30000 })
        );
      }

      if (response.data.success) {
        const responseData = response.data.data || {};
        const practiceId = responseData.id || (practice && practice.id);

        // Save sections
        const sectionErrors = [];
        for (const context of selectedContexts) {
          const section = sections[context];
          if (!section) continue;
          const hasNonEmptyRows = section.description_rows?.some(row => (row || '').trim());
          const hasOtherData = section.man_hours || section.mac_hours || section.materials_amount || section.waste_apply || (section.notes || '').trim();
          if (!hasNonEmptyRows && !hasOtherData) continue;
          // Ensure at least one non-empty row for backend validation
          const rowsToSend = hasNonEmptyRows
            ? section.description_rows
            : [''];
          const sectionPayload = { ...section, context, description_rows: rowsToSend };
          try {
            await fetchWithRetry(() =>
              axios.post(`${API_BASE_URL}/practices/${practiceId}/sections`, sectionPayload, { headers: getHeaders(), timeout: 30000 })
            );
          } catch (sectionErr) {
            sectionErrors.push(context);
          }
        }
        if (sectionErrors.length > 0) {
          addToast(`Errore salvataggio sezioni: ${sectionErrors.join(', ')}`, 'error');
        }

        // Save parts — try bulk first
        const allParts = [];
        for (const context of selectedContexts) {
          const list = (parts[context] || []).filter(p => (p.name || '').trim());
          for (const p of list) {
            allParts.push({ context, name: p.name.trim(), quantity: (p.quantity || '').trim() || null });
          }
        }

        let bulkSuccess = false;
        if (allParts.length > 0 || selectedContexts.length > 0) {
          try {
            await fetchWithRetry(() =>
              axios.post(`${API_BASE_URL}/practices/${practiceId}/parts/bulk`, { parts: allParts }, { headers: getHeaders() }), { maxRetries: 1 }
            );
            bulkSuccess = true;
          } catch (bulkErr) {
            if (bulkErr.response?.status === 404) bulkSuccess = false;
            else throw bulkErr;
          }
        }

        if (!bulkSuccess) {
          try {
            await axios.delete(`${API_BASE_URL}/practices/${practiceId}/parts`, { headers: getHeaders() });
          } catch (_) {}
          for (const p of allParts) {
            await axios.post(`${API_BASE_URL}/practices/${practiceId}/parts`, p, { headers: getHeaders() });
          }
        }

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

  // ==================== RENDER ====================

  // --- Dashboard View ---
  const renderDashboard = () => (
    <div className="view-dashboard view-enter">
      <div className="container">
        <h1>🔧 Giorgio</h1>

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
                  <span className={`sync-dot ${p.synced ? 'sync-dot-green' : 'sync-dot-red'}`} />
                </div>
                <div className="practice-card-customer">{p.customer_name || '—'}</div>
                <div className="practice-card-footer">
                  <span className="practice-card-date">📅 {formatDate(p.appointment_date || p.created_at)}</span>
                  <div className="practice-card-badges">
                    {normalizeContexts(p.contexts).map(ctx => (
                      <span key={ctx} className="context-badge" style={{ background: CONTEXT_COLORS[ctx]?.bg, color: CONTEXT_COLORS[ctx]?.color, borderColor: CONTEXT_COLORS[ctx]?.border }}>
                        {ctx.charAt(0).toUpperCase() + ctx.slice(1).substring(0, 4)}
                      </span>
                    ))}
                  </div>
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

    return (
      <div className="view-detail view-enter">
        <div className="container">
          <button className="back-button" onClick={navigateBack} type="button">← Indietro</button>

          {/* Header info */}
          <div className="detail-header section">
            <div className="detail-plate">{practice.plate_confirmed || practice.plate || '—'}</div>
            <div className="detail-customer">{practice.customer_name || '—'}</div>
            {practice.phone && <div className="detail-phone">📞 {practice.phone}</div>}
            <div className="detail-date">📅 {formatDate(practice.appointment_date || practice.created_at)}</div>
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
                <div key={i} className="detail-section-item">
                  <span className="context-badge" style={{ background: CONTEXT_COLORS[s.context]?.bg, color: CONTEXT_COLORS[s.context]?.color, borderColor: CONTEXT_COLORS[s.context]?.border }}>
                    {s.context?.charAt(0).toUpperCase() + s.context?.slice(1)}
                  </span>
                  <div className="detail-section-hours">
                    {s.man_hours ? `Ore MAN: ${s.man_hours}` : ''}
                    {s.man_hours && s.mac_hours ? ' | ' : ''}
                    {s.mac_hours ? `Ore MAC: ${s.mac_hours}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Parts */}
          {dParts.length > 0 && (
            <div className="section">
              <h2>🔩 Ricambi</h2>
              {dParts.map((p, i) => (
                <div key={i} className="detail-part-item">
                  <span>• {p.name}</span>
                  {p.context && (
                    <span className="context-badge-small" style={{ background: CONTEXT_COLORS[p.context]?.bg, color: CONTEXT_COLORS[p.context]?.color }}>
                      {p.context?.substring(0, 4)}
                    </span>
                  )}
                  {p.quantity && <span className="detail-part-qty">×{p.quantity}</span>}
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
                    <button
                      className="photo-remove-btn"
                      type="button"
                      onClick={(e) => { e.stopPropagation(); deletePhoto(photo.id); }}
                      disabled={deletingPhotoId === photo.id}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="photo-empty-state">Nessuna foto. Aggiungi la prima foto.</div>
            )}
            <input
              type="file"
              ref={detailFileInputRef}
              className="photo-file-input"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              onChange={(e) => { if (e.target.files[0]) uploadPhotoToDetail(e.target.files[0]); }}
            />
            <button
              className="photo-upload-btn"
              type="button"
              disabled={uploadingPhoto}
              onClick={() => detailFileInputRef.current?.click()}
            >
              {uploadingPhoto ? <><span className="loading-spinner sm"></span> Caricamento...</> : '📷 Aggiungi foto'}
            </button>
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
                                fetch(`${API_BASE_URL}/api/practices/${practice.id}/photos/${photo.id}`, {
                                  method: 'DELETE',
                                  headers: { 'X-Telegram-Init-Data': initData }
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
                  <label>Righe Descrittive*</label>
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
                  <button type="button" onClick={() => addDescriptionRow(context)} className="button-add">+ Aggiungi riga</button>
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

                {(context === 'officina' || context === 'carrozzeria') && (
                  <div className="form-group">
                    <label>Pezzi / ricambi</label>
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
                    <button type="button" onClick={() => addPart(context)} className="button-add">+ Aggiungi pezzo</button>
                  </div>
                )}
              </div>
            ))}

            {/* Note generali */}
            <div className="section">
              <h2>📝 Note Generali</h2>
              <textarea
                {...register('internal_notes')}
                className="textarea"
                rows="3"
                placeholder="Note generali per la pratica..."
              />
            </div>

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
