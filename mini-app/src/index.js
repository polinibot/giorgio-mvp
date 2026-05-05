import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const renderFatalError = (message) => {
  const rootElement = document.getElementById('root');
  if (rootElement) {
    rootElement.innerHTML = `
      <div style="min-height:100vh;padding:16px;background:#fff7ed;color:#9a3412;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
        <h2 style="margin-top:0;">Errore Mini App</h2>
        <div style="padding:12px;border:1px solid #fdba74;border-radius:8px;background:#ffffff;white-space:pre-wrap;word-break:break-word;">${message}</div>
      </div>
    `;
  }
};

window.addEventListener('error', (event) => {
  renderFatalError(`JavaScript error: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.message || event.reason || 'Promise rejection non gestita';
  renderFatalError(`Unhandled promise rejection: ${reason}`);
});

try {
  const bootstrapStatus = document.getElementById('bootstrap-status');
  if (bootstrapStatus) {
    bootstrapStatus.textContent = 'Caricamento interfaccia...';
  }
  window.__GiorgioAppMounted = false;
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(
    <App />
  );
  window.__GiorgioAppMounted = true;
  if (bootstrapStatus) {
    bootstrapStatus.textContent = 'Interfaccia caricata.';
    setTimeout(() => {
      bootstrapStatus.remove();
    }, 1000);
  }
} catch (error) {
  renderFatalError(error?.message || 'Errore sconosciuto in fase di bootstrap');
}
