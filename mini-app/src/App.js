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

/** Retry with exponential backoff (max 3 attempts) */
async function fetchWithRetry(fn, { maxRetries = 3, baseDelay = 1000 } = {}) {
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

/** Italian phone validation: 10 digits or +39 prefix */
function isValidItalianPhone(val) {
  const cleaned = val.replace(/[\s.()-]/g, '');
  return /^(\+39)?3\d{8,9}$/.test(cleaned) || /^0\d{5,10}$/.test(cleaned);
}

/** Italian license plate: 2 letters + 3 digits + 2 letters */
function isValidItalianPlate(val) {
  const cleaned = val.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z]{2}\d{3}[A-Z]{2}$/.test(cleaned);
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

// --- Main App ---

function App() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [practice, setPractice] = useState(null);
  const [error, setError] = useState('');
  const [successDone, setSuccessDone] = useState(false);
  const [initData, setInitData] = useState('');
  const [urlPlate, setUrlPlate] = useState('');
  const [showDraftBanner, setShowDraftBanner] = useState(false);
  const [slowRequest, setSlowRequest] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [confirmModal, setConfirmModal] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const [debugInfo, setDebugInfo] = useState({
    phase: 'init', practiceId: '', plate: '',
    hasTelegram: false, hasInitData: false, lastError: ''
  });

  const [selectedContexts, setSelectedContexts] = useState([]);
  const [sections, setSections] = useState({});
  const [parts, setParts] = useState({});

  const slowTimerRef = useRef(null);
  const toastIdRef = useRef(0);
  const formRef = useRef(null);

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
    try {
      const data = getValues();
      const draft = {
        formData: data,
        selectedContexts,
        sections,
        parts,
        timestamp: Date.now()
      };
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch (_) { /* storage full or private mode */ }
  }, [getValues, selectedContexts, sections, parts]);

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch (_) {}
  }, []);

  const restoreDraft = useCallback(() => {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      // Only restore if less than 24h old
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
      if (draft.sections) setSections(draft.sections);
      if (draft.parts) setParts(draft.parts);
      return true;
    } catch (_) { return false; }
  }, [setValue]);

  // Save draft on data change (debounced via effect)
  const watchedValues = watch();
  useEffect(() => {
    if (!loading && !successDone) {
      const timer = setTimeout(() => saveDraft(), 500);
      return () => clearTimeout(timer);
    }
  }, [watchedValues, selectedContexts, sections, parts, loading, successDone, saveDraft]);

  // --- Load practice ---
  const loadPractice = useCallback(async (practiceId, currentInitData, plateFromUrl = '') => {
    const fullUrl = `${API_BASE_URL}/mini-app/data?practice_id=${practiceId}`;
    setDebugInfo(prev => ({ ...prev, phase: 'loading_practice', practiceId, hasInitData: !!currentInitData, apiUrl: fullUrl, apiBaseUrl: API_BASE_URL }));
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
          Object.keys(practiceData).forEach(key => {
            if (key !== 'contexts' && key !== 'appointment_date') setValue(key, practiceData[key]);
          });
          if (practiceData.appointment_date) setValue('appointment_date', new Date(practiceData.appointment_date));
        }

        if (!isDraft && response.data.data.sections) {
          const sectionsData = {};
          response.data.data.sections.forEach(s => { sectionsData[s.context] = s; });
          setSections(sectionsData);
        }

        if (!isDraft && response.data.data.parts) {
          const partsData = {};
          response.data.data.parts.forEach(p => {
            if (!partsData[p.context]) partsData[p.context] = [];
            partsData[p.context].push({ name: p.name || '', quantity: p.quantity || '' });
          });
          setParts(partsData);
        }

        setDebugInfo(prev => ({ ...prev, phase: 'practice_loaded' }));
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) {
        setPractice(null);
        setSelectedContexts([]);
        setError('');
        if (plateFromUrl) setValue('plate_confirmed', plateFromUrl);
        setDebugInfo(prev => ({ ...prev, phase: 'practice_not_found_404', lastError: '' }));
      } else {
        setError(classifyError(err));
        setDebugInfo(prev => ({ ...prev, phase: 'load_practice_error', lastError: err.message }));
      }
    } finally {
      clearSlowTimer();
      setLoading(false);
    }
  }, [setValue, startSlowTimer, clearSlowTimer]);

  // Global JS error handler
  useEffect(() => {
    const handleError = (event) => {
      setError(`Errore JavaScript: ${event.message}`);
      setDebugInfo(prev => ({ ...prev, phase: 'js_error', lastError: event.message }));
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  // Prefill plate from URL after load
  useEffect(() => {
    if (!loading && debugInfo.phase === 'practice_not_found_404' && urlPlate) {
      setValue('plate_confirmed', urlPlate);
    }
  }, [loading, debugInfo.phase, urlPlate, setValue]);

  // Telegram WebApp init
  useEffect(() => {
    if (window.Telegram && window.Telegram.WebApp) {
      const webApp = window.Telegram.WebApp;
      setDebugInfo(prev => ({ ...prev, phase: 'telegram_detected', hasTelegram: true }));
      webApp.ready();
      webApp.expand();
      webApp.setHeaderColor('#ffffff');
      webApp.setBackgroundColor('#f8fafc');

      const currentInitData = webApp.initData;
      setInitData(currentInitData);

      const urlParams = new URLSearchParams(window.location.search);
      const practiceId = urlParams.get('practice_id');
      const plate = urlParams.get('plate');
      setUrlPlate(plate || '');
      setDebugInfo(prev => ({ ...prev, phase: 'telegram_ready', practiceId: practiceId || '', plate: plate || '', hasInitData: !!currentInitData }));

      if (practiceId) {
        loadPractice(practiceId, currentInitData, plate || '');
      } else {
        // No existing practice — try restoring draft
        if (plate) setValue('plate_confirmed', plate);
        const hadDraft = restoreDraft();
        if (hadDraft) setShowDraftBanner(true);
        if (plate) setValue('plate_confirmed', plate); // override draft plate with URL
        setDebugInfo(prev => ({ ...prev, phase: plate ? 'plate_prefilled' : 'empty_form' }));
        setSelectedContexts(prev => prev.length ? prev : []);
        setLoading(false);
      }
    } else {
      setError('Mini App deve essere eseguita in Telegram');
      setDebugInfo(prev => ({ ...prev, phase: 'telegram_missing', lastError: 'window.Telegram.WebApp non disponibile' }));
      setLoading(false);
    }
  }, [loadPractice, setValue, restoreDraft]);

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
        [context]: { description_rows: [''], man_hours: '', mac_hours: '', materials_amount: '', waste_apply: false, waste_percentage: 2 }
      }));
    }
  };

  const updateSection = (context, field, value) => {
    setSections(prev => ({ ...prev, [context]: { ...prev[context], [field]: value } }));
  };

  const addDescriptionRow = (context) => {
    setSections(prev => ({ ...prev, [context]: { ...prev[context], description_rows: [...prev[context].description_rows, ''] } }));
  };

  const removeDescriptionRow = (context, index) => {
    setSections(prev => ({ ...prev, [context]: { ...prev[context], description_rows: prev[context].description_rows.filter((_, i) => i !== index) } }));
  };

  const updateDescriptionRow = (context, index, value) => {
    setSections(prev => ({ ...prev, [context]: { ...prev[context], description_rows: prev[context].description_rows.map((row, i) => i === index ? value : row) } }));
  };

  // --- Parts ---
  const getPartsForContext = (context) => parts[context] || [];

  const addPart = (context) => {
    setParts(prev => ({ ...prev, [context]: [...(prev[context] || []), { name: '', quantity: '' }] }));
  };

  const removePart = (context, index) => {
    setParts(prev => ({ ...prev, [context]: (prev[context] || []).filter((_, i) => i !== index) }));
  };

  const updatePart = (context, index, field, value) => {
    setParts(prev => ({ ...prev, [context]: (prev[context] || []).map((p, i) => i === index ? { ...p, [field]: value } : p) }));
  };

  // --- Delete practice (with custom modal) ---
  const deletePractice = () => {
    if (!practice || !practice.id) return;
    setConfirmModal({
      title: '🗑 Cancellare pratica?',
      message: 'Questa operazione non è reversibile dall\'app. Vuoi procedere?',
      onConfirm: async () => {
        setConfirmModal(null);
        setSaving(true);
        startSlowTimer();
        try {
          await fetchWithRetry(() =>
            axios.delete(`${API_BASE_URL}/practices/${practice.id}`, {
              headers: { 'X-Telegram-Init-Data': initData }
            })
          );
          clearDraft();
          addToast('Pratica cancellata con successo', 'success');
          setTimeout(() => {
            if (window.Telegram && window.Telegram.WebApp) window.Telegram.WebApp.close();
          }, 2000);
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

    // Customer name
    const name = (data.customer_name || '').trim();
    if (!name) errs.customer_name = 'Nome obbligatorio';
    else if (name.length < 2) errs.customer_name = 'Nome troppo corto (min 2 caratteri)';
    else if (name.length > 100) errs.customer_name = 'Nome troppo lungo (max 100 caratteri)';

    // Plate
    const plate = (data.plate_confirmed || '').trim();
    if (!plate) errs.plate_confirmed = 'Targa obbligatoria';
    else if (!isValidItalianPlate(plate)) errs.plate_confirmed = 'Formato targa non valido (es. AB123CD)';

    // Phone
    const phone = (data.phone || '').trim();
    if (!phone) errs.phone = 'Telefono obbligatorio';
    else if (!isValidItalianPhone(phone)) errs.phone = 'Numero di telefono italiano non valido';

    // Date
    if (!data.appointment_date) errs.appointment_date = 'Data obbligatoria';

    // Time
    if (!data.appointment_time) errs.appointment_time = 'Ora obbligatoria';

    // Contexts
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
    // Client-side validation
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
        ...data,
        contexts: selectedContexts,
        appointment_date: data.appointment_date.toISOString().split('T')[0]
      };

      let response;
      if (practice) {
        response = await fetchWithRetry(() =>
          axios.put(`${API_BASE_URL}/practices/${practice.id}`, payload, {
            headers: { 'X-Telegram-Init-Data': initData }
          })
        );
      } else {
        response = await fetchWithRetry(() =>
          axios.post(`${API_BASE_URL}/practices`, payload, {
            headers: { 'X-Telegram-Init-Data': initData }
          })
        );
      }

      if (response.data.success) {
        const responseData = response.data.data || {};
        const practiceId = responseData.id || (practice && practice.id);

        // Save sections
        for (const context of selectedContexts) {
          const section = sections[context];
          if (section && section.description_rows.some(row => row.trim())) {
            const sectionPayload = { ...section, context };
            await fetchWithRetry(() =>
              axios.post(`${API_BASE_URL}/practices/${practiceId}/sections`, sectionPayload, {
                headers: { 'X-Telegram-Init-Data': initData }
              })
            );
          }
        }

        // Save parts — try bulk endpoint first, fallback to individual
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
              axios.post(`${API_BASE_URL}/practices/${practiceId}/parts/bulk`, { parts: allParts }, {
                headers: { 'X-Telegram-Init-Data': initData }
              }), { maxRetries: 1 }
            );
            bulkSuccess = true;
          } catch (bulkErr) {
            if (bulkErr.response?.status === 404) {
              bulkSuccess = false; // fallback
            } else {
              throw bulkErr;
            }
          }
        }

        if (!bulkSuccess) {
          // Fallback: delete-all + individual POSTs
          try {
            await axios.delete(`${API_BASE_URL}/practices/${practiceId}/parts`, {
              headers: { 'X-Telegram-Init-Data': initData }
            });
          } catch (_) {}
          for (const p of allParts) {
            await axios.post(`${API_BASE_URL}/practices/${practiceId}/parts`, p, {
              headers: { 'X-Telegram-Init-Data': initData }
            });
          }
        }

        clearDraft();
        setSuccessDone(true);
      }
    } catch (err) {
      setError(classifyError(err));
      addToast(classifyError(err), 'error');
    } finally {
      clearSlowTimer();
      setSaving(false);
    }
  };

  // --- Create another practice ---
  const handleCreateAnother = () => {
    setSuccessDone(false);
    setPractice(null);
    setSelectedContexts([]);
    setSections({});
    setParts({});
    setError('');
    setFieldErrors({});
    // Reset form values
    setValue('plate_confirmed', '');
    setValue('phone', '');
    setValue('customer_name', '');
    setValue('customer_type', 'privato');
    setValue('appointment_date', null);
    setValue('appointment_time', '');
    setValue('practice_type', 'preventivo');
    setValue('internal_notes', '');
    setValue('billing_to_complete', false);
  };

  // --- Render: Loading ---
  if (loading) {
    return (
      <div className="App">
        <SkeletonLoader />
        {slowRequest && (
          <div className="slow-request-warning">⏳ La richiesta sta impiegando più del previsto...</div>
        )}
      </div>
    );
  }

  // --- Render: Success ---
  if (successDone) {
    return (
      <div className="App">
        <Toast toasts={toasts} removeToast={removeToast} />
        <div className="container">
          <div className="success-screen">
            <div className="success-icon">✅</div>
            <h2>Pratica salvata!</h2>
            <p>La pratica è stata salvata con successo.</p>
            <button className="button-submit" onClick={handleCreateAnother} type="button">
              ➕ Crea un'altra pratica
            </button>
            <button
              className="btn-secondary"
              onClick={() => { if (window.Telegram && window.Telegram.WebApp) window.Telegram.WebApp.close(); }}
              type="button"
            >
              Chiudi Mini App
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Helper for field error display
  const renderFieldError = (name) => {
    const msg = fieldErrors[name] || errors[name]?.message;
    if (!msg) return null;
    return <div className="field-error">{msg}</div>;
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

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

      <div className="container">
        <h1>🔧 Dati Pratica</h1>

        {showDraftBanner && (
          <div className="draft-banner">
            <span>📝 Bozza ripristinata</span>
            <button type="button" onClick={() => { clearDraft(); setShowDraftBanner(false); handleCreateAnother(); }}>
              Scarta
            </button>
          </div>
        )}

        {error && <div className="error">{error}</div>}

        {slowRequest && (
          <div className="slow-request-warning">⏳ La richiesta sta impiegando più del previsto...</div>
        )}

        <form ref={formRef} onSubmit={handleSubmit(onSubmit)} className="form" noValidate>
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
                aria-invalid={!!fieldErrors.plate_confirmed}
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
                aria-label="Numero di telefono"
                aria-invalid={!!fieldErrors.phone}
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
                aria-label="Nome del cliente"
                aria-invalid={!!fieldErrors.customer_name}
                autoComplete="name"
              />
              {renderFieldError('customer_name')}
            </div>

            <div className="form-group">
              <label htmlFor="customer_type">Tipo Cliente*</label>
              <select id="customer_type" {...register('customer_type')} className="select" aria-label="Tipo di cliente">
                <option value="privato">Privato</option>
                <option value="azienda">Azienda</option>
              </select>
            </div>

            {watch('customer_type') === 'azienda' && (
              <div className="form-group">
                <label>
                  <input type="checkbox" {...register('billing_to_complete')} aria-label="Dati fatturazione da completare" />
                  Dati fatturazione da completare
                </label>
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
                    minDate={today}
                    aria-label="Data dell'appuntamento"
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
                aria-label="Orario dell'appuntamento"
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
              <select id="practice_type" {...register('practice_type')} className="select" aria-label="Tipo di pratica">
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
                    aria-label={`Contesto ${context}`}
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
                {sections[context]?.description_rows.map((row, index) => (
                  <div key={index} className="description-row">
                    <input
                      type="text"
                      value={row}
                      onChange={(e) => updateDescriptionRow(context, index, e.target.value)}
                      className="input"
                      placeholder="Descrizione lavoro..."
                      aria-label={`Descrizione riga ${index + 1} per ${context}`}
                    />
                    {sections[context].description_rows.length > 1 && (
                      <button type="button" onClick={() => removeDescriptionRow(context, index)} className="button-remove" aria-label="Rimuovi riga">
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => addDescriptionRow(context)} className="button-add" aria-label="Aggiungi riga descrittiva">
                  + Aggiungi riga
                </button>
              </div>

              {context === 'officina' && (
                <div className="form-group">
                  <label>MAN Ore</label>
                  <input
                    type="number" step="0.5"
                    value={sections[context]?.man_hours || ''}
                    onChange={(e) => updateSection(context, 'man_hours', parseFloat(e.target.value) || '')}
                    className="input" placeholder="2.5"
                    aria-label="Ore manodopera officina"
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
                      aria-label="Ore macchina carrozzeria"
                    />
                  </div>
                  <div className="form-group">
                    <label>Materiali (€)</label>
                    <input
                      type="number" step="0.01"
                      value={sections[context]?.materials_amount || ''}
                      onChange={(e) => updateSection(context, 'materials_amount', parseFloat(e.target.value) || '')}
                      className="input" placeholder="150.00"
                      aria-label="Importo materiali carrozzeria"
                    />
                  </div>
                  <div className="form-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={sections[context]?.waste_apply || false}
                        onChange={(e) => updateSection(context, 'waste_apply', e.target.checked)}
                        aria-label="Applica smaltimento rifiuti"
                      />
                      Applica smaltimento rifiuti
                    </label>
                    {sections[context]?.waste_apply && (
                      <input
                        type="number" step="0.1"
                        value={sections[context]?.waste_percentage || 2}
                        onChange={(e) => updateSection(context, 'waste_percentage', parseFloat(e.target.value) || 2)}
                        className="input" placeholder="2" min="0" max="100"
                        aria-label="Percentuale smaltimento rifiuti"
                      />
                    )}
                  </div>
                </>
              )}

              {(context === 'officina' || context === 'carrozzeria') && (
                <div className="form-group">
                  <label>Pezzi / ricambi</label>
                  {getPartsForContext(context).map((part, index) => (
                    <div key={index} className="description-row">
                      <input
                        type="text" value={part.name}
                        onChange={(e) => updatePart(context, index, 'name', e.target.value)}
                        className="input" placeholder="Es. Pastiglie freno"
                        aria-label={`Nome pezzo ${index + 1} per ${context}`}
                      />
                      <input
                        type="text" value={part.quantity}
                        onChange={(e) => updatePart(context, index, 'quantity', e.target.value)}
                        className="input" placeholder="1 pz"
                        style={{ maxWidth: '100px' }}
                        aria-label={`Quantità pezzo ${index + 1} per ${context}`}
                      />
                      <button type="button" onClick={() => removePart(context, index)} className="button-remove" aria-label="Rimuovi pezzo">
                        ✕
                      </button>
                    </div>
                  ))}
                  <button type="button" onClick={() => addPart(context)} className="button-add" aria-label="Aggiungi pezzo">
                    + Aggiungi pezzo
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* Note interne */}
          <div className="section">
            <h2>📝 Note Interne</h2>
            <textarea
              {...register('internal_notes')}
              className="textarea"
              rows="3"
              placeholder="Note interne per la pratica..."
              aria-label="Note interne"
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className={`button-submit ${saving ? 'btn-loading' : ''}`}
          >
            {saving ? 'Salvataggio in corso...' : (practice ? 'Aggiorna Pratica' : 'Crea Pratica')}
          </button>

          {practice && practice.id && (
            <button
              type="button"
              onClick={deletePractice}
              disabled={saving}
              className="button-remove"
              style={{ marginTop: '12px', width: '100%', minHeight: '48px', borderRadius: '12px', fontSize: '15px' }}
              aria-label="Cancella pratica"
            >
              🗑 Cancella pratica
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

export default App;
