import React, { useState, useEffect, useCallback } from 'react';
import { useForm, Controller } from 'react-hook-form';
import axios from 'axios';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import './App.css';

// Configurazione axios
const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://giorgio-mvp-production.up.railway.app';

function App() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [practice, setPractice] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [initData, setInitData] = useState('');
  const [debugInfo, setDebugInfo] = useState({
    phase: 'init',
    practiceId: '',
    plate: '',
    hasTelegram: false,
    hasInitData: false,
    lastError: ''
  });
  
  // Stato per i contesti selezionati
  const [selectedContexts, setSelectedContexts] = useState([]);
  
  // Stato per le sezioni dinamiche
  const [sections, setSections] = useState({});

  const normalizeContexts = (contexts) => {
    if (Array.isArray(contexts)) {
      return contexts;
    }
    if (typeof contexts === 'string') {
      return contexts
        .split(',')
        .map((context) => context.trim())
        .filter(Boolean);
    }
    return [];
  };
  
  const { register, control, handleSubmit, setValue, watch, formState: { errors } } = useForm();

  const loadPractice = useCallback(async (practiceId, currentInitData) => {
    const fullUrl = `${API_BASE_URL}/mini-app/data?practice_id=${practiceId}`;
    setDebugInfo(prev => ({
      ...prev,
      phase: 'loading_practice',
      practiceId,
      hasInitData: !!currentInitData,
      apiUrl: fullUrl,
      apiBaseUrl: API_BASE_URL
    }));
    try {
      console.log('Chiamata API a:', fullUrl);
      console.log('InitData:', currentInitData ? 'presente' : 'mancante');
      
      const response = await axios.get(`${API_BASE_URL}/mini-app/data`, {
        params: { practice_id: practiceId },
        headers: { 'X-Telegram-Init-Data': currentInitData },
        timeout: 30000 // 30 secondi timeout
      });
      
      if (response.data.success) {
        const practiceData = response.data.data.practice;
        setPractice(practiceData);
        setSelectedContexts(normalizeContexts(practiceData.contexts));
        
        // Popola form
        Object.keys(practiceData).forEach(key => {
          if (key !== 'contexts' && key !== 'appointment_date') {
            setValue(key, practiceData[key]);
          }
        });
        
        // Converte data se presente
        if (practiceData.appointment_date) {
          setValue('appointment_date', new Date(practiceData.appointment_date));
        }
        
        // Carica sezioni
        if (response.data.data.sections) {
          const sectionsData = {};
          response.data.data.sections.forEach(section => {
            sectionsData[section.context] = section;
          });
          setSections(sectionsData);
        }

        setDebugInfo(prev => ({
          ...prev,
          phase: 'practice_loaded'
        }));
      }
    } catch (err) {
      const status = err.response?.status;
      const detailedError = err.response?.data?.detail || err.message || 'Errore caricamento pratica';

      if (status === 404) {
        // Pratica non trovata: trattiamo come nuova pratica con form vuoto
        setPractice(null);
        setSelectedContexts([]);
        setError('');
        setDebugInfo(prev => ({
          ...prev,
          phase: 'practice_not_found_404',
          lastError: '' // Nascondiamo l'errore per il 404
        }));
      } else {
        setError(`Errore caricamento pratica: ${detailedError}`);
        setDebugInfo(prev => ({
          ...prev,
          phase: 'load_practice_error',
          lastError: detailedError
        }));
      }
    } finally {
      setLoading(false);
    }
  }, [setValue]);

  useEffect(() => {
    const handleError = (event) => {
      setError(`Errore JavaScript: ${event.message}`);
      setDebugInfo(prev => ({
        ...prev,
        phase: 'js_error',
        lastError: event.message
      }));
    };

    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  // Inizializzazione Telegram WebApp
  useEffect(() => {
    if (window.Telegram && window.Telegram.WebApp) {
      const webApp = window.Telegram.WebApp;
      setDebugInfo(prev => ({
        ...prev,
        phase: 'telegram_detected',
        hasTelegram: true
      }));
      webApp.ready();
      webApp.expand();
      
      // Imposta colore tema
      webApp.setHeaderColor('#ffffff');
      webApp.setBackgroundColor('#f8fafc');
      
      // Ottieni initData
      const currentInitData = webApp.initData;
      setInitData(currentInitData);
      
      // Estrai parametri URL
      const urlParams = new URLSearchParams(window.location.search);
      const practiceId = urlParams.get('practice_id');
      const plate = urlParams.get('plate');
      setDebugInfo(prev => ({
        ...prev,
        phase: 'telegram_ready',
        practiceId: practiceId || '',
        plate: plate || '',
        hasInitData: !!currentInitData
      }));
      
      if (practiceId) {
        loadPractice(practiceId, currentInitData);
      } else if (plate) {
        setValue('plate_confirmed', plate);
        setDebugInfo(prev => ({
          ...prev,
          phase: 'plate_prefilled'
        }));
        setLoading(false);
      } else {
        setDebugInfo(prev => ({
          ...prev,
          phase: 'empty_form'
        }));
        setSelectedContexts([]);
        setLoading(false);
      }
    } else {
      setError('Mini App deve essere eseguita in Telegram');
      setDebugInfo(prev => ({
        ...prev,
        phase: 'telegram_missing',
        lastError: 'window.Telegram.WebApp non disponibile'
      }));
      setLoading(false);
    }
  }, [loadPractice, setValue]);

  const toggleContext = (context) => {
    const newContexts = selectedContexts.includes(context)
      ? selectedContexts.filter(c => c !== context)
      : [...selectedContexts, context];
    
    setSelectedContexts(newContexts);
    setValue('contexts', newContexts);
    
    // Inizializza sezione se non esiste
    if (!sections[context]) {
      setSections(prev => ({
        ...prev,
        [context]: {
          description_rows: [''],
          man_hours: '',
          mac_hours: '',
          materials_amount: '',
          waste_apply: false,
          waste_percentage: 2
        }
      }));
    }
  };

  const updateSection = (context, field, value) => {
    setSections(prev => ({
      ...prev,
      [context]: {
        ...prev[context],
        [field]: value
      }
    }));
  };

  const addDescriptionRow = (context) => {
    setSections(prev => ({
      ...prev,
      [context]: {
        ...prev[context],
        description_rows: [...prev[context].description_rows, '']
      }
    }));
  };

  const removeDescriptionRow = (context, index) => {
    setSections(prev => ({
      ...prev,
      [context]: {
        ...prev[context],
        description_rows: prev[context].description_rows.filter((_, i) => i !== index)
      }
    }));
  };

  const updateDescriptionRow = (context, index, value) => {
    setSections(prev => ({
      ...prev,
      [context]: {
        ...prev[context],
        description_rows: prev[context].description_rows.map((row, i) => 
          i === index ? value : row
        )
      }
    }));
  };

  const onSubmit = async (data) => {
    setSaving(true);
    setError('');
    
    try {
      const payload = {
        ...data,
        contexts: selectedContexts,
        appointment_date: data.appointment_date.toISOString().split('T')[0]
      };

      let response;
      if (practice) {
        // Aggiorna pratica esistente
        response = await axios.put(`${API_BASE_URL}/practices/${practice.id}`, payload, {
          headers: { 'X-Telegram-Init-Data': initData }
        });
      } else {
        // Crea nuova pratica
        response = await axios.post(`${API_BASE_URL}/practices`, payload, {
          headers: { 'X-Telegram-Init-Data': initData }
        });
      }

      if (response.data.success) {
        const practiceId = response.data.data.id || practice.id;
        
        // Salva sezioni
        for (const context of selectedContexts) {
          const section = sections[context];
          if (section && section.description_rows.some(row => row.trim())) {
            await axios.post(`${API_BASE_URL}/practices/${practiceId}/sections`, section, {
              headers: { 'X-Telegram-Init-Data': initData }
            });
          }
        }
        
        setSuccess('Pratica salvata con successo!');
        
        // Chiudi Mini App dopo 2 secondi
        setTimeout(() => {
          if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.close();
          }
        }, 2000);
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Errore salvataggio pratica');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="App">
        <div className="loading">Caricamento Mini App...</div>
        <div className="debug-box">
          <div><strong>Fase:</strong> {debugInfo.phase}</div>
          <div><strong>Telegram:</strong> {debugInfo.hasTelegram ? 'sì' : 'no'}</div>
          <div><strong>InitData:</strong> {debugInfo.hasInitData ? 'presente' : 'assente'}</div>
          <div><strong>Practice ID:</strong> {debugInfo.practiceId || '-'}</div>
          <div><strong>Plate:</strong> {debugInfo.plate || '-'}</div>
          {debugInfo.lastError && <div><strong>Errore:</strong> {debugInfo.lastError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="App">
      <div className="container">
        <h1>🔧 Dati Pratica</h1>
        <div className="debug-box">
          <div><strong>Fase:</strong> {debugInfo.phase}</div>
          <div><strong>Telegram:</strong> {debugInfo.hasTelegram ? 'sì' : 'no'}</div>
          <div><strong>InitData:</strong> {debugInfo.hasInitData ? 'presente' : 'assente'}</div>
          <div><strong>Practice ID:</strong> {debugInfo.practiceId || '-'}</div>
          <div><strong>Plate:</strong> {debugInfo.plate || '-'}</div>
          {debugInfo.apiUrl && <div><strong>API URL:</strong> {debugInfo.apiUrl}</div>}
          {debugInfo.apiBaseUrl && <div><strong>API Base:</strong> {debugInfo.apiBaseUrl}</div>}
          {debugInfo.lastError && <div><strong>Errore:</strong> {debugInfo.lastError}</div>}
        </div>
        
        {error && <div className="error">{error}</div>}
        {success && <div className="success">{success}</div>}
        
        <form onSubmit={handleSubmit(onSubmit)} className="form">
          {/* Dati cliente */}
          <div className="section">
            <h2>👤 Dati Cliente</h2>
            
            <div className="form-group">
              <label>Targa*</label>
              <input
                {...register('plate_confirmed', { required: 'Targa obbligatoria' })}
                className="input"
                placeholder="AB123CD"
              />
              {errors.plate_confirmed && <span className="error-text">{errors.plate_confirmed.message}</span>}
            </div>
            
            <div className="form-group">
              <label>Telefono*</label>
              <input
                {...register('phone', { required: 'Telefono obbligatorio' })}
                className="input"
                placeholder="3351234567"
              />
              {errors.phone && <span className="error-text">{errors.phone.message}</span>}
            </div>
            
            <div className="form-group">
              <label>Cliente/Riferimento*</label>
              <input
                {...register('customer_name', { required: 'Nome obbligatorio' })}
                className="input"
                placeholder="Mario Rossi"
              />
              {errors.customer_name && <span className="error-text">{errors.customer_name.message}</span>}
            </div>
            
            <div className="form-group">
              <label>Tipo Cliente*</label>
              <select {...register('customer_type')} className="select">
                <option value="privato">Privato</option>
                <option value="azienda">Azienda</option>
              </select>
            </div>
            
            {watch('customer_type') === 'azienda' && (
              <div className="form-group">
                <label>
                  <input
                    type="checkbox"
                    {...register('billing_to_complete')}
                  />
                  Dati fatturazione da completare
                </label>
              </div>
            )}
          </div>

          {/* Appuntamento */}
          <div className="section">
            <h2>📅 Appuntamento</h2>
            
            <div className="form-group">
              <label>Data*</label>
              <Controller
                control={control}
                name="appointment_date"
                rules={{ required: 'Data obbligatoria' }}
                render={({ field }) => (
                  <DatePicker
                    selected={field.value}
                    onChange={field.onChange}
                    className="input"
                    dateFormat="dd/MM/yyyy"
                    placeholderText="GG/MM/AAAA"
                  />
                )}
              />
              {errors.appointment_date && <span className="error-text">{errors.appointment_date.message}</span>}
            </div>
            
            <div className="form-group">
              <label>Ora (slot 30 min)*</label>
              <select {...register('appointment_time', { required: 'Ora obbligatoria' })} className="select">
                {Array.from({ length: 24 }, (_, i) => 
                  ['00', '30'].map(min => 
                    <option key={`${i.toString().padStart(2, '0')}:${min}`} value={`${i.toString().padStart(2, '0')}:${min}`}>
                      {i.toString().padStart(2, '0')}:{min}
                    </option>
                  )
                ).flat()}
              </select>
              {errors.appointment_time && <span className="error-text">{errors.appointment_time.message}</span>}
            </div>
            
            <div className="form-group">
              <label>Tipo Pratica*</label>
              <select {...register('practice_type')} className="select">
                <option value="preventivo">Preventivo</option>
                <option value="ordine_di_lavoro">Ordine di Lavoro</option>
              </select>
            </div>
          </div>

          {/* Contesti */}
          <div className="section">
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
            {selectedContexts.length === 0 && (
              <span className="error-text">Seleziona almeno un contesto</span>
            )}
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
                    />
                    {sections[context].description_rows.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeDescriptionRow(context, index)}
                        className="button-remove"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => addDescriptionRow(context)}
                  className="button-add"
                >
                  + Aggiungi riga
                </button>
              </div>

              {context === 'officina' && (
                <div className="form-group">
                  <label>MAN Ore</label>
                  <input
                    type="number"
                    step="0.5"
                    value={sections[context]?.man_hours || ''}
                    onChange={(e) => updateSection(context, 'man_hours', parseFloat(e.target.value) || '')}
                    className="input"
                    placeholder="2.5"
                  />
                </div>
              )}

              {context === 'carrozzeria' && (
                <>
                  <div className="form-group">
                    <label>MAC Ore</label>
                    <input
                      type="number"
                      step="0.5"
                      value={sections[context]?.mac_hours || ''}
                      onChange={(e) => updateSection(context, 'mac_hours', parseFloat(e.target.value) || '')}
                      className="input"
                      placeholder="2.5"
                    />
                  </div>
                  
                  <div className="form-group">
                    <label>Materiali (€)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={sections[context]?.materials_amount || ''}
                      onChange={(e) => updateSection(context, 'materials_amount', parseFloat(e.target.value) || '')}
                      className="input"
                      placeholder="150.00"
                    />
                  </div>
                  
                  <div className="form-group">
                    <label>
                      <input
                        type="checkbox"
                        checked={sections[context]?.waste_apply || false}
                        onChange={(e) => updateSection(context, 'waste_apply', e.target.checked)}
                      />
                      Applica smaltimento rifiuti
                    </label>
                    {sections[context]?.waste_apply && (
                      <input
                        type="number"
                        step="0.1"
                        value={sections[context]?.waste_percentage || 2}
                        onChange={(e) => updateSection(context, 'waste_percentage', parseFloat(e.target.value) || 2)}
                        className="input"
                        placeholder="2"
                        min="0"
                        max="100"
                      />
                    )}
                  </div>
                </>
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
            />
          </div>

          <button type="submit" disabled={saving} className="button-submit">
            {saving ? 'Salvataggio...' : (practice ? 'Aggiorna Pratica' : 'Crea Pratica')}
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;
