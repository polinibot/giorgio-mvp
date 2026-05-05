import React, { useState, useEffect, useCallback } from 'react';
import { useForm, Controller } from 'react-hook-form';
import axios from 'axios';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import './App.css';

// Configurazione axios
const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://polini-api.railway.app';

function App() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [practice, setPractice] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [initData, setInitData] = useState('');
  
  // Stato per i contesti selezionati
  const [selectedContexts, setSelectedContexts] = useState([]);
  
  // Stato per le sezioni dinamiche
  const [sections, setSections] = useState({});
  
  const { register, control, handleSubmit, setValue, watch, formState: { errors } } = useForm();

  const loadPractice = useCallback(async (practiceId, currentInitData) => {
    try {
      const response = await axios.get(`${API_BASE_URL}/mini-app/data`, {
        params: { practice_id: practiceId, init_data: currentInitData }
      });
      
      if (response.data.success) {
        const practiceData = response.data.data.practice;
        setPractice(practiceData);
        setSelectedContexts(practiceData.contexts || []);
        
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
      }
    } catch (err) {
      setError('Errore caricamento pratica');
    } finally {
      setLoading(false);
    }
  }, [setValue]);

  // Inizializzazione Telegram WebApp
  useEffect(() => {
    if (window.Telegram && window.Telegram.WebApp) {
      const webApp = window.Telegram.WebApp;
      webApp.ready();
      webApp.expand();
      
      // Imposta colore tema
      webApp.setHeaderColor('#1f2937');
      webApp.setBackgroundColor('#111827');
      
      // Ottieni initData
      const currentInitData = webApp.initData;
      setInitData(currentInitData);
      
      // Estrai parametri URL
      const urlParams = new URLSearchParams(window.location.search);
      const practiceId = urlParams.get('practice_id');
      const plate = urlParams.get('plate');
      
      if (practiceId) {
        loadPractice(practiceId, currentInitData);
      } else if (plate) {
        setValue('plate_confirmed', plate);
        setLoading(false);
      } else {
        setLoading(false);
      }
    } else {
      setError('Mini App deve essere eseguita in Telegram');
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
          params: { init_data: initData }
        });
      } else {
        // Crea nuova pratica
        response = await axios.post(`${API_BASE_URL}/practices`, payload, {
          params: { init_data: initData }
        });
      }

      if (response.data.success) {
        const practiceId = response.data.data.id || practice.id;
        
        // Salva sezioni
        for (const context of selectedContexts) {
          const section = sections[context];
          if (section && section.description_rows.some(row => row.trim())) {
            await axios.post(`${API_BASE_URL}/practices/${practiceId}/sections`, section, {
              params: { init_data: initData }
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
        <div className="loading">Caricamento...</div>
      </div>
    );
  }

  return (
    <div className="App">
      <div className="container">
        <h1>🔧 Dati Pratica</h1>
        
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
