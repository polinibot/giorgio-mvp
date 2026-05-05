import React, { useState, useEffect, useCallback } from 'react';
import { useForm, Controller } from 'react-hook-form';
import axios from 'axios';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import './App.css';

// --- Constants & Helpers ---
const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://giorgio-mvp-production.up.railway.app';


const CONTEXT_COLORS = {
  officina: { bg: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: 'rgba(59, 130, 246, 0.3)' },
  carrozzeria: { bg: 'rgba(251, 146, 60, 0.15)', color: '#fb923c', border: 'rgba(251, 146, 60, 0.3)' },
  revisione: { bg: 'rgba(74, 222, 128, 0.15)', color: '#4ade80', border: 'rgba(74, 222, 128, 0.3)' },
};

const formatDate = (d) => d ? new Date(d).toLocaleDateString('it-IT') : '---';

// --- Components ---

const Toast = ({ toasts, onRemove }) => (
  <div className="toast-container">
    {toasts.map(t => (
      <div key={t.id} className={`toast toast-${t.type} glass-card ${t.exiting ? 'exit' : ''}`} onClick={() => onRemove(t.id)}>
        <span className="toast-icon">{t.type === 'success' ? '✅' : '❌'}</span>
        <p className="toast-message">{t.message}</p>
      </div>
    ))}
  </div>
);

const Loader = ({ full }) => (
  <div className={`loader-container ${full ? 'full-screen' : ''}`}>
    <div className="loader-ring"></div>
  </div>
);

const ContextBadge = ({ ctx, small }) => (
  <span className={`context-badge ${small ? 'small' : ''}`} style={{ 
    background: CONTEXT_COLORS[ctx]?.bg, 
    color: CONTEXT_COLORS[ctx]?.color,
    borderColor: CONTEXT_COLORS[ctx]?.border 
  }}>
    {ctx}
  </span>
);

// --- Sub-Views ---

const Dashboard = ({ stats, searchQuery, setSearchQuery, activeFilters, toggleFilter, practices, loading, onNavigate }) => (
  <div className="view-dashboard view-enter container">
    <h1>🔧 Giorgio</h1>
    
    <div className="stats-row">
      {[
        { label: 'Totale', value: stats.total, icon: '📋' },
        { label: 'Mese', value: stats.this_month, icon: '📅' },
        { label: 'Sync', value: stats.pending_sync, icon: '🔄' }
      ].map((s, i) => (
        <div key={i} className="stat-card glass-card">
          <span className="stat-number">{s.value}</span>
          <span className="stat-label">{s.label}</span>
        </div>
      ))}
    </div>

    <div className="search-bar">
      <span className="search-icon">🔍</span>
      <input 
        type="text" 
        className="search-input" 
        placeholder="Cerca targa o cliente..." 
        value={searchQuery} 
        onChange={e => setSearchQuery(e.target.value)} 
      />
    </div>

    <div className="filter-chips">
      {['officina', 'carrozzeria', 'revisione'].map(ctx => (
        <button 
          key={ctx} 
          className={`filter-chip ${activeFilters[ctx] ? 'active' : ''}`} 
          onClick={() => toggleFilter(ctx)}
          style={activeFilters[ctx] ? { background: CONTEXT_COLORS[ctx].bg, color: CONTEXT_COLORS[ctx].color, borderColor: CONTEXT_COLORS[ctx].border } : {}}
        >
          {ctx}
        </button>
      ))}
    </div>

    <div className="practice-list">
      {loading ? <Loader /> : practices.length === 0 ? (
        <div className="empty-state">📂 <h3>Nessuna pratica</h3><p>Prova a cambiare i filtri.</p></div>
      ) : (
        practices.map(p => (
          <div key={p.id} className="practice-card glass-card" onClick={() => onNavigate('detail', p.id)}>
            <div className="practice-card-header">
              <span className="practice-plate">{p.plate || p.plate_confirmed || '---'}</span>
              <div className={`sync-dot ${p.synced ? 'sync-dot-green' : 'sync-dot-red'}`} />
            </div>
            <div className="practice-card-customer">{p.customer_name || 'Riferimento mancante'}</div>
            <div className="practice-card-footer">
              <span className="practice-card-date">📅 {formatDate(p.appointment_date || p.created_at)}</span>
              <div className="practice-card-badges">
                {(Array.isArray(p.contexts) ? p.contexts : (p.contexts || '').split(',')).map(ctx => ctx && ctx.trim() && (
                  <ContextBadge key={ctx} ctx={ctx.trim()} small />
                ))}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
    
    <button className="fab" onClick={() => onNavigate('form')}>+</button>
  </div>
);

// --- Main App ---

function App() {
  const [view, setView] = useState('dashboard');
  const [initData, setInitData] = useState('');
  const [toasts, setToasts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  
  // Dashboard state
  const [stats, setStats] = useState({ total: 0, this_month: 0, pending_sync: 0 });
  const [practices, setPractices] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState({ officina: false, carrozzeria: false, revisione: false, synced: null });

  // Form & Detail state
  const [selectedId, setSelectedId] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [selectedContexts, setSelectedContexts] = useState([]);


  const { register, control, handleSubmit, reset } = useForm();

  const addToast = useCallback((message, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type, exiting: false }]);
    setTimeout(() => {
      setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 300);
    }, 3000);
  }, []);

  const loadDashboard = useCallback(async () => {
    if (!initData) return;
    setLoading(true);
    try {
      const params = { search: searchQuery };
      const ctxs = Object.entries(filters).filter(([k, v]) => v === true && k !== 'synced').map(([k]) => k);
      if (ctxs.length) params.context = ctxs.join(',');
      const [pRes, sRes] = await Promise.all([
        axios.get(`${API_BASE_URL}/api/practices`, { params, headers: { 'X-Telegram-Init-Data': initData } }),
        axios.get(`${API_BASE_URL}/api/practices/stats`, { headers: { 'X-Telegram-Init-Data': initData } })
      ]);
      setPractices(pRes.data.data || []);
      setStats(sRes.data.data || { total: 0, this_month: 0, pending_sync: 0 });
    } catch (err) { addToast('Errore caricamento', 'error'); }
    setLoading(false);
  }, [initData, searchQuery, filters, addToast]);

  const loadDetail = useCallback(async (id) => {
    setLoading(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/practices/${id}`, { headers: { 'X-Telegram-Init-Data': initData } });
      setDetailData(res.data.data);
    } catch (err) { addToast('Errore caricamento dettagli', 'error'); }
    setLoading(false);
  }, [initData, addToast]);

  useEffect(() => {
    if (window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      tg.ready();
      tg.expand();
      setInitData(tg.initData);
      const params = new URLSearchParams(window.location.search);
      if (params.get('practice_id')) {
        setSelectedId(params.get('practice_id'));
        setView('form');
      }
    }
  }, []);

  useEffect(() => { if (view === 'dashboard') loadDashboard(); }, [view, loadDashboard]);
  useEffect(() => { if (view === 'detail' && selectedId) loadDetail(selectedId); }, [view, selectedId, loadDetail]);

  const onNavigate = (v, id = null) => {
    setSelectedId(id);
    setView(v);
    if (v === 'form' && !id) reset();
  };

  const handleToggleSync = async (id, current) => {
    try {
      await axios.patch(`${API_BASE_URL}/api/practices/${id}/sync`, { synced: !current }, { headers: { 'X-Telegram-Init-Data': initData } });
      addToast('Stato sync aggiornato');
      loadDetail(id);
    } catch (err) { addToast('Errore sync', 'error'); }
  };

  const onSubmit = async (data) => {
    setSaving(true);
    try {
      const payload = {
        practice: {
          ...data,
          appointment_date: data.appointment_date instanceof Date ? data.appointment_date.toISOString().split('T')[0] : data.appointment_date,
          contexts: selectedContexts
        },
        sections: selectedContexts.map(ctx => ({ context: ctx, description_rows: ['Lavoro da eseguire'], man_hours: 1 })),
        parts: []
      };
      
      if (selectedId) {
        await axios.put(`${API_BASE_URL}/practices/${selectedId}/full`, payload, { headers: { 'X-Telegram-Init-Data': initData } });
      } else {
        await axios.post(`${API_BASE_URL}/practices/full`, payload, { headers: { 'X-Telegram-Init-Data': initData } });
      }
      
      addToast('Pratica salvata con successo');
      setView('dashboard');
    } catch (err) { addToast('Errore salvataggio', 'error'); }
    setSaving(false);
  };

  return (
    <div className="App">
      {view === 'dashboard' && <Dashboard stats={stats} searchQuery={searchQuery} setSearchQuery={setSearchQuery} activeFilters={filters} toggleFilter={k => setFilters(f => ({ ...f, [k]: !f[k] }))} practices={practices} loading={loading} onNavigate={onNavigate} />}
      
      {view === 'detail' && detailData && (
        <div className="view-detail view-enter container">
          <button className="back-button" onClick={() => setView('dashboard')}>← Dashboard</button>
          <div className="glass-card section detail-header">
            <div className="detail-plate">{detailData.practice.plate_confirmed || detailData.practice.plate}</div>
            <div className="detail-customer">{detailData.practice.customer_name}</div>
            <div className="detail-phone">📞 {detailData.practice.phone}</div>
            <div className="detail-date">📅 {formatDate(detailData.practice.appointment_date)}</div>
          </div>
          <div className="detail-actions">
            <button className="button-submit" onClick={() => setView('form')}>✏️ Modifica</button>
            <button className="button-submit" style={{background: 'rgba(255,255,255,0.05)', color: '#666'}} onClick={() => handleToggleSync(selectedId, detailData.practice.synced)}>
              {detailData.practice.synced ? '🟢 Sincronizzata' : '🔴 Da Sincronizzare'}
            </button>
          </div>
        </div>
      )}

      {view === 'form' && (
        <div className="view-form view-enter container">
          <button className="back-button" onClick={() => setView('dashboard')}>← Dashboard</button>
          <div className="glass-card section">
            <h1>{selectedId ? 'Modifica' : 'Nuova'} Pratica</h1>
            <form className="form" onSubmit={handleSubmit(onSubmit)}>
              <div className="form-group"><label>Targa</label><input className="input" {...register('plate_confirmed')} placeholder="AA123BB" /></div>
              <div className="form-group"><label>Cliente</label><input className="input" {...register('customer_name')} placeholder="Nome Cliente" /></div>
              <div className="form-group"><label>Telefono</label><input className="input" {...register('phone')} placeholder="335..." /></div>
              
              <div className="form-group">
                <label>Appuntamento</label>
                <Controller 
                  control={control} 
                  name="appointment_date" 
                  render={({ field }) => (
                    <DatePicker selected={field.value} onChange={field.onChange} className="input" dateFormat="dd/MM/yyyy" placeholderText="GG/MM/AAAA" />
                  )} 
                />
              </div>

              <div className="form-group">
                <label>Contesti</label>
                <div className="filter-chips">
                  {['officina', 'carrozzeria', 'revisione'].map(ctx => (
                    <button type="button" key={ctx} className={`filter-chip ${selectedContexts.includes(ctx) ? 'active' : ''}`} onClick={() => setSelectedContexts(prev => prev.includes(ctx) ? prev.filter(c => c !== ctx) : [...prev, ctx])}>
                      {ctx}
                    </button>
                  ))}
                </div>
              </div>

              <button type="submit" className="button-submit" disabled={saving}>{saving ? 'Salvataggio...' : 'Salva Pratica'}</button>
            </form>
          </div>
        </div>
      )}

      <Toast toasts={toasts} onRemove={id => setToasts(t => t.filter(x => x.id !== id))} />
    </div>
  );
}

export default App;
