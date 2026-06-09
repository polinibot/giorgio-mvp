import React from 'react';
import { createRoot } from 'react-dom/client';
import axios from 'axios';
import App from './App';

const act = React.act;

jest.mock('axios');

jest.mock('react-datepicker', () => {
  const React = require('react');

  return function MockDatePicker({ id, selected, onChange, className, placeholderText }) {
    const value = selected instanceof Date ? selected.toISOString().slice(0, 10) : '';

    return React.createElement('input', {
      id,
      type: 'date',
      className,
      placeholder: placeholderText,
      value,
      onChange: (e) => onChange(e.target.value ? new Date(`${e.target.value}T00:00:00Z`) : null),
      'data-testid': 'mock-datepicker',
    });
  };
});

const TELEGRAM_MOCK = () => ({
  WebApp: {
    initData: 'mock-init-data',
    ready: jest.fn(),
    expand: jest.fn(),
    setHeaderColor: jest.fn(),
    setBackgroundColor: jest.fn(),
    close: jest.fn(),
    BackButton: {
      show: jest.fn(),
      hide: jest.fn(),
      onClick: jest.fn(),
      offClick: jest.fn(),
    },
  },
});

function setRoute(query = '') {
  window.history.pushState({}, '', query || '/');
}

function installTelegramMock() {
  window.Telegram = TELEGRAM_MOCK();
}

function renderApp(query = '?plate=AB123CD') {
  setRoute(query);
  installTelegramMock();

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<App />);
  });

  return { container, root };
}

async function waitFor(check, timeout = 4000) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeout) {
    try {
      const result = check();
      if (result) return result;
    } catch (err) {
      lastError = err;
    }

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  throw lastError || new Error('Timed out waiting for UI update');
}

function setValueBySelector(selector, value) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  act(() => {
    const prototype = el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  return el;
}

function setValueWithin(root, selector, value) {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Element not found in section: ${selector}`);

  act(() => {
    const prototype = el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  return el;
}

function clickElement(el) {
  if (!el) throw new Error('Element not found for click');
  act(() => {
    el.click();
  });
}

function getCheckboxLabel(text) {
  return Array.from(document.querySelectorAll('label')).find((label) =>
    label.textContent && label.textContent.includes(text)
  );
}

function getSection(text) {
  const heading = Array.from(document.querySelectorAll('h2')).find((el) =>
    el.textContent && el.textContent.includes(text)
  );
  return heading ? heading.closest('.section') : null;
}

function getButton(text) {
  return Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent && button.textContent.includes(text)
  );
}

function getFormInput(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing form input: ${id}`);
  return el;
}

function getDashboardSearchInput() {
  const el = document.querySelector('input.search-input');
  if (!el) throw new Error('Dashboard search input not found');
  return el;
}

function getFilterChip(labelText) {
  return Array.from(document.querySelectorAll('button.filter-chip')).find((button) =>
    button.textContent && button.textContent.includes(labelText)
  );
}

const CONTEXT_MATRIX = [
  ['officina'],
  ['carrozzeria'],
  ['revisione'],
  ['officina', 'carrozzeria'],
  ['officina', 'revisione'],
  ['carrozzeria', 'revisione'],
  ['officina', 'carrozzeria', 'revisione'],
];

const DEFAULT_YAP_SYNC_RESPONSE = {
  data: {
    success: true,
    data: {
      status: 'partial_synced',
      message: 'Agenda presente, mancano ODL/materiali/ricambi/note.',
      syncScope: {
        mode: 'agenda_only',
        complete: false,
        summary: 'Agenda sincronizzata. ODL/materiali/ricambi pianificati.',
        agenda: {
          written: ['Cosa', 'Quando', 'Dalle', 'Alle', 'Tag'],
          used_contexts: ['officina', 'carrozzeria'],
          notes: ['Note interne', 'Note reparto'],
        },
        odl: {
          planned: ['MAN', 'MAC', 'Materiali', 'Ricambi', 'Smaltimento'],
        },
      },
      audit: {
        status: 'partial_synced',
        message: 'Agenda presente, mancano ODL/materiali/ricambi/note.',
        present: [{ field: 'agenda.cosa', label: 'Cosa', expected: 'TEST123', found: 'TEST123' }],
        missing: [{ field: 'odl.officina.man', label: 'MAN officina', expected: 'MAN 1', found: null }],
        mismatch: [],
      },
      preSync: { ready: true, score: 100, issues: [] },
      yap: {
        result: {
          saved: true,
          mode: 'commit',
          message: 'Appuntamento salvato su YAP.',
          telemetry: { saveAttempts: 1 },
        },
        message: 'Appuntamento salvato su YAP.',
      },
      practice: {
        synced: false,
        management_sync_status: 'partial_synced',
        management_last_sync_at: '2026-11-15T10:05:00.000Z',
        management_external_id: null,
        management_sync_scope: {
          mode: 'agenda_only',
          complete: false,
          summary: 'Agenda sincronizzata. ODL/materiali/ricambi pianificati.',
        },
        management_audit_result: {
          status: 'partial_synced',
          message: 'Agenda presente, mancano ODL/materiali/ricambi/note.',
          present: [{ field: 'agenda.cosa', label: 'Cosa', expected: 'TEST123', found: 'TEST123' }],
          missing: [{ field: 'odl.officina.man', label: 'MAN officina', expected: 'MAN 1', found: null }],
          mismatch: [],
        },
      },
    },
  },
};

const DEFAULT_YAP_AUDIT_RESPONSE = {
  data: {
    success: true,
    data: {
      status: 'partial_synced',
      message: 'Agenda presente, mancano ODL/materiali/ricambi/note.',
      audit: {
        status: 'partial_synced',
        message: 'Agenda presente, mancano ODL/materiali/ricambi/note.',
        present: [{ field: 'agenda.cosa', label: 'Cosa', expected: 'TEST123', found: 'TEST123' }],
        missing: [{ field: 'odl.officina.man', label: 'MAN officina', expected: 'MAN 1', found: null }],
        mismatch: [],
      },
    },
  },
};

const DEFAULT_YAP_DELETE_RESPONSE = {
  data: {
    success: true,
    data: {
      status: 'deleted',
      message: 'Appuntamento eliminato da YAP.',
      yap: {
        result: {
          deleted: true,
          mode: 'commit',
        },
        message: 'Appuntamento eliminato da YAP.',
      },
    },
  },
};

beforeEach(() => {
  axios.get.mockReset();
  axios.post.mockReset();
  axios.put.mockReset();
  axios.delete?.mockReset?.();
  axios.post.mockImplementation((url) => {
    if (String(url).includes('/yap/sync')) {
      return Promise.resolve(DEFAULT_YAP_SYNC_RESPONSE);
    }
    if (String(url).includes('/yap/audit')) {
      return Promise.resolve(DEFAULT_YAP_AUDIT_RESPONSE);
    }
    if (String(url).includes('/yap/notify-error')) {
      return Promise.resolve({ data: { success: true, data: { notified: true } } });
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
  axios.delete?.mockImplementation?.((url) => {
    if (String(url).includes('/yap/appointment')) {
      return Promise.resolve(DEFAULT_YAP_DELETE_RESPONSE);
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
  delete window.Telegram;
});

afterEach(() => {
  if (document.body._reactRootContainer) {
    // no-op legacy fallback
  }
});

let currentRoot;

function mount(query = '?plate=AB123CD') {
  const { container, root } = renderApp(query);
  currentRoot = root;
  return container;
}

async function unmountCurrentRoot() {
  if (!currentRoot) return;

  await act(async () => {
    currentRoot.unmount();
  });
  currentRoot = null;
}

afterEach(async () => {
  await unmountCurrentRoot();
});

describe('Mini App user-simulation suite', () => {
  test('limits appointment time choices to the YAP visible range', async () => {
    mount('?demo=complete');

    await waitFor(() => document.querySelector('form'));

    const select = getFormInput('appointment_time');
    const values = Array.from(select.querySelectorAll('option')).map((option) => option.value).filter(Boolean);

    expect(values[0]).toBe('08:00');
    expect(values[values.length - 1]).toBe('18:00');
    expect(values).not.toContain('00:40');
    expect(values).not.toContain('07:55');
    expect(values).toContain('09:30');
  });

  test('opens a fully prefilled demo form with one URL', async () => {
    mount('?demo=complete');

    await waitFor(() => document.querySelector('form'));

    expect(getFormInput('plate_confirmed').value).toBe('AB123CD');
    expect(getFormInput('phone').value).toBe('3331234567');
    expect(getFormInput('customer_name').value).toBe('Mario Rossi');
    expect(getFormInput('customer_type').value).toBe('azienda');
    expect(getFormInput('appointment_time').value).toBe('09:30');
    expect(getFormInput('practice_type').value).toBe('preventivo');

    await waitFor(() => getSection('Officina'));
    await waitFor(() => getSection('Carrozzeria'));
    await waitFor(() => getSection('Revisione'));

    expect(document.querySelector('textarea[placeholder="Note generali per la pratica..."]')).toBeNull();
    expect(getSection('Officina').querySelector('textarea#notes_officina').value).toBe('Demo officina');
    expect(getSection('Carrozzeria').querySelector('textarea#notes_carrozzeria').value).toBe('Demo carrozzeria');
    expect(getSection('Revisione').querySelector('textarea#notes_revisione').value).toBe('Demo revisione');
    expect(document.body.textContent).not.toMatch(/da_completare/i);
  });

  test('walks dashboard -> detail -> form -> back with search and filter checks', async () => {
    const practices = [
      {
        id: 1,
        plate: 'AB123CD',
        customer_name: 'Mario Rossi',
        contexts: ['officina'],
        synced: false,
        appointment_date: '2026-11-10T09:00:00.000Z',
        created_at: '2026-11-10T09:00:00.000Z',
      },
      {
        id: 2,
        plate: 'XZ987YZ',
        customer_name: 'Luca Bianchi',
        contexts: ['carrozzeria'],
        synced: true,
        appointment_date: '2026-11-11T10:00:00.000Z',
        created_at: '2026-11-11T10:00:00.000Z',
      },
    ];

    axios.get.mockImplementation((url, config = {}) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 2, this_month: 2, pending_sync: 1 } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                internal_notes: 'Controllo iniziale',
                synced: false,
                sections: [{ context: 'officina', description_rows: ['Tagliando'], man_hours: 1, notes: 'OK' }],
                parts: [{ context: 'officina', name: 'Filtro olio', quantity: '1 pz' }],
              },
              sections: [
                { context: 'officina', description_rows: ['Tagliando'], man_hours: 1, mac_hours: null, materials_amount: null, waste_apply: false, waste_percentage: null, notes: 'OK' },
              ],
              parts: [
                { context: 'officina', name: 'Filtro olio', quantity: '1 pz' },
              ],
              photos: [{ id: 10, url: 'https://example.com/photo.jpg', thumbnail: 'https://example.com/thumb.jpg' }],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        const search = (config.params?.search || '').toLowerCase();
        const context = config.params?.context || '';
        const synced = config.params?.synced;
        let filtered = practices;

        if (search) {
          filtered = filtered.filter((p) => p.plate.toLowerCase().includes(search) || p.customer_name.toLowerCase().includes(search));
        }
        if (context) {
          const contexts = context.split(',');
          filtered = filtered.filter((p) => contexts.some((ctx) => p.contexts.includes(ctx)));
        }
        if (synced === 'true') filtered = filtered.filter((p) => p.synced);
        if (synced === 'false') filtered = filtered.filter((p) => !p.synced);

        return Promise.resolve({ data: { success: true, data: filtered } });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 2);
    expect(document.body.textContent).toContain('Totale');
    expect(document.body.textContent).toContain('Mario Rossi');
    expect(document.body.textContent).toContain('Luca Bianchi');

    setValueBySelector('.search-input', 'Mario');
    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    expect(document.body.textContent).toContain('Mario Rossi');
    expect(document.body.textContent).not.toContain('Luca Bianchi');

    setValueBySelector('.search-input', '');
    await waitFor(() => document.querySelectorAll('.practice-card').length === 2);

    clickElement(getFilterChip('Carrozzeria'));
    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    expect(document.body.textContent).toContain('Luca Bianchi');
    expect(document.body.textContent).not.toContain('Mario Rossi');

    clickElement(getFilterChip('Carrozzeria'));
    await waitFor(() => document.querySelectorAll('.practice-card').length === 2);

    clickElement(document.querySelectorAll('.practice-card')[0]);
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    expect(document.body.textContent).toContain('AB123CD');
    expect(document.body.textContent).toContain('Mario Rossi');
    expect(document.body.textContent).toContain('Filtro olio');
    expect(document.body.textContent).toContain('Sincronizza con YAP');
    expect(document.body.textContent).toContain('Dettagli YAP');

    clickElement(getButton('✏️ Modifica'));
    await waitFor(() => document.querySelector('form'));
    expect(getFormInput('plate_confirmed').value).toBe('AB123CD');
    expect(getFormInput('customer_name').value).toBe('Mario Rossi');

    setValueBySelector('#customer_name', 'Mario Rossi SRL');
    expect(getFormInput('customer_name').value).toBe('Mario Rossi SRL');

    clickElement(getButton('← Indietro'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));

    clickElement(getButton('← Indietro'));
    await waitFor(() => document.querySelectorAll('.practice-card').length === 2);
  });

  test('shows incomplete YAP audit as actionable partial state without empty zero-count grid', async () => {
    const incompleteAudit = {
      ok: false,
      completed: false,
      technical_failure: true,
      status: 'partial_synced',
      status_reason: 'audit_not_completed',
      message: 'Appuntamento YAP scritto, ma audit non completato. Da ricontrollare: note, materiali.',
      error_code: 'YAP_AUDIT_INCOMPLETE',
      next_action: 'Verifica YAP',
      action_target: 'audit',
      present: [],
      missing: [],
      mismatch: [],
      feedback: {
        summary: 'Audit non completato: YAP ha ricevuto la scrittura, ma la verifica automatica non ha chiuso.',
        nextSteps: ['Apri la tab YAP e premi Verifica YAP.'],
      },
    };

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: false,
                management_sync_status: 'partial_synced',
                management_audit_result: incompleteAudit,
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: false,
              management_sync_status: 'partial_synced',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('YAP'));

    await waitFor(() => document.body.textContent.includes('Automazione YAP'));
    await waitFor(() => document.body.textContent.includes('Completa targa'));
    await waitFor(() => document.body.textContent.includes('Audit non completato'));
    expect(document.body.textContent).toContain('YAP_AUDIT_INCOMPLETE');
    expect(document.body.textContent).toContain('Azione: Verifica YAP');
    expect(document.body.textContent).not.toContain('Presenti (0)');
    expect(document.body.textContent).not.toContain('Mancanti (0)');
    expect(document.body.textContent).not.toContain('Diversi (0)');
  });

  test('shows sync_failed in red even when the cached synced flag is stale', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 0 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: true,
                management_sync_status: 'sync_failed',
                management_audit_result: {
                  status: 'sync_failed',
                  message: 'Errore di rete. Controlla la connessione internet e riprova.',
                },
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: true,
              management_sync_status: 'sync_failed',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    const card = document.querySelector('.practice-card');
    expect(card.querySelector('.sync-pill').className).toContain('sync-pill-red');
    clickElement(card);

    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    const toggle = document.querySelector('.detail-sync-toggle');
    expect(toggle.className).toContain('not-synced');
    expect(toggle.querySelector('.sync-dot').className).toContain('sync-dot-red');
    expect(document.body.textContent).toContain('Sync YAP fallita');
  });

  test('shows partial YAP state as warning instead of green success', async () => {
    const partialAudit = {
      status: 'partial_synced',
      message: 'Appuntamento scritto su YAP. Verifica automatica parziale.',
      present: [{ field: 'agenda', expected: 'appuntamento salvato in agenda' }],
      missing: [{ field: 'odl.ricambio', expected: 'Filtro olio' }],
      mismatch: [],
    };

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: false,
                management_sync_status: 'partial_synced',
                management_audit_result: partialAudit,
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: false,
              management_sync_status: 'partial_synced',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    const card = document.querySelector('.practice-card');
    expect(card.querySelector('.sync-pill').className).toContain('sync-pill-warning');
    clickElement(card);

    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    const toggle = document.querySelector('.detail-sync-toggle');
    expect(toggle.className).toContain('partial-synced');
    expect(toggle.querySelector('.sync-dot').className).toContain('sync-dot-warning');
    expect(document.body.textContent).toContain('Parziale');
  });

  test('shows agenda-written YAP state without raw audit or write-report codes', async () => {
    axios.post.mockImplementation((url) => {
      if (String(url).includes('/yap/sync')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              status: 'agenda_synced',
              message: 'Appuntamento scritto su YAP. Premi Verifica YAP per controllare tutti i campi.',
              status_reason: 'audit_deferred',
              preSync: { ready: true, score: 92, issues: [] },
              phase_timeline: [
                { name: 'precheck', status: 'completed', duration_ms: 1000 },
                { name: 'write', status: 'completed', duration_ms: 8000 },
                { name: 'audit', status: 'skipped', duration_ms: 50 },
              ],
              telemetry: {
                session_mode: 'browser_context',
                agenda_unstable: true,
                total_elapsed_ms: 27000,
              },
              write_report: {
                attempted: true,
                ok: false,
                notes: { attempted: true, success: false, error: 'notes_field_not_found' },
              },
              yap: {
                result: {
                  saved: true,
                  mode: 'commit',
                  message: 'Appuntamento salvato su YAP.',
                  telemetry: { saveAttempts: 1 },
                },
              },
              practice: {
                id: 1,
                synced: true,
                management_sync_status: 'agenda_synced',
              },
            },
          },
        });
      }
      if (String(url).includes('/yap/audit')) {
        return Promise.resolve(DEFAULT_YAP_AUDIT_RESPONSE);
      }
      if (String(url).includes('/yap/notify-error')) {
        return Promise.resolve({ data: { success: true, data: { notified: true } } });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: false,
                management_sync_status: 'sync_failed',
                management_audit_result: {
                  status: 'sync_failed',
                  technical_failure: true,
                  worker_phases: [
                    { phase: 'save_attempt', status: 'try_3', elapsed_ms: 65742 },
                    { phase: 'save_result', status: 'failed', elapsed_ms: 84162 },
                  ],
                  runner: {
                    script: 'yap-worker.mjs',
                    finished_at: '2026-06-03T15:42:05.362758+00:00',
                    timeout_seconds: 210,
                  },
                  stderr_tail: '{"event":"yap:phase","phase":"save_result","status":"failed"}',
                },
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: false,
              management_sync_status: 'sync_failed',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('Riprova sync YAP') || getButton('Sincronizza con YAP'));

    await waitFor(() => document.body.textContent.includes('YAP agenda scritta'));
    expect(document.body.textContent).toContain('Tempo 27s');
    expect(document.body.textContent).toContain('Agenda instabile rilevata');
    expect(document.body.textContent).toContain('Sessione isolata');
    expect(document.body.textContent).toContain('Post-scrittura: note da ricontrollare');
    expect(document.body.textContent).toContain('Stato verifica completa in attesa');
    expect(document.body.textContent).not.toContain('appointment_not_verified');
    expect(document.body.textContent).not.toContain('notes_field_not_found');
  });

  test('hides generic post-write warning when agenda sync has no field-specific write errors', async () => {
    axios.post.mockImplementation((url) => {
      if (String(url).includes('/yap/sync')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              status: 'agenda_synced',
              message: 'Pratica creata. Appuntamento scritto su YAP. Premi Verifica YAP per controllare tutti i campi.',
              status_reason: 'audit_deferred',
              preSync: { ready: true, score: 92, issues: [] },
              phase_timeline: [
                { name: 'precheck', status: 'completed', duration_ms: 1000 },
                { name: 'write', status: 'completed', duration_ms: 82000 },
                { name: 'audit', status: 'skipped', duration_ms: 50 },
                { name: 'finalize', status: 'completed', duration_ms: 20 },
              ],
              telemetry: {
                session_mode: 'browser_context',
                total_elapsed_ms: 82000,
                saveAttempts: 1,
              },
              write_report: {
                attempted: true,
                ok: false,
                notes: { attempted: true, success: false },
                odl: { attempted: true, success: false },
              },
              practice: {
                id: 1,
                synced: true,
                management_sync_status: 'agenda_synced',
              },
            },
          },
        });
      }
      if (String(url).includes('/yap/audit')) {
        return Promise.resolve(DEFAULT_YAP_AUDIT_RESPONSE);
      }
      if (String(url).includes('/yap/notify-error')) {
        return Promise.resolve({ data: { success: true, data: { notified: true } } });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: false,
                management_sync_status: 'sync_failed',
                management_audit_result: {
                  status: 'sync_failed',
                  technical_failure: true,
                  worker_phases: [
                    { phase: 'save_attempt', status: 'try_3', elapsed_ms: 65742 },
                    { phase: 'save_result', status: 'failed', elapsed_ms: 84162 },
                  ],
                  runner: {
                    script: 'yap-worker.mjs',
                    finished_at: '2026-06-03T15:42:05.362758+00:00',
                    timeout_seconds: 210,
                  },
                  stderr_tail: '{"event":"yap:phase","phase":"save_result","status":"failed"}',
                },
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: false,
              management_sync_status: 'sync_failed',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('Riprova sync YAP') || getButton('Sincronizza con YAP'));

    await waitFor(() => document.body.textContent.includes('YAP agenda scritta'));
    expect(document.body.textContent).toContain('Stato verifica completa in attesa');
    expect(document.body.textContent).not.toContain('Post-scrittura: controlli incompleti');
  });

  test('does not render orphaned Stato/Causa prefix when status_reason yields empty formatted string', async () => {
    axios.post.mockImplementation((url) => {
      if (String(url).includes('/yap/sync')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              status: 'agenda_synced',
              message: 'Appuntamento scritto su YAP.',
              status_reason: '   ',
              preSync: { ready: true, score: 100, issues: [] },
              write_report: { attempted: true, ok: true },
              practice: { id: 1, synced: true, management_sync_status: 'agenda_synced' },
            },
          },
        });
      }
      if (String(url).includes('/yap/audit')) return Promise.resolve(DEFAULT_YAP_AUDIT_RESPONSE);
      if (String(url).includes('/yap/notify-error')) return Promise.resolve({ data: { success: true, data: { notified: true } } });
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: false,
                management_sync_status: 'sync_failed',
                management_audit_result: {
                  status: 'sync_failed',
                  technical_failure: true,
                  worker_phases: [
                    { phase: 'save_attempt', status: 'try_3', elapsed_ms: 65742 },
                    { phase: 'save_result', status: 'failed', elapsed_ms: 84162 },
                  ],
                  runner: {
                    script: 'yap-worker.mjs',
                    finished_at: '2026-06-03T15:42:05.362758+00:00',
                    timeout_seconds: 210,
                  },
                  stderr_tail: '{"event":"yap:phase","phase":"save_result","status":"failed"}',
                },
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: false,
              management_sync_status: 'sync_failed',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('Riprova sync YAP') || getButton('Sincronizza con YAP'));

    await waitFor(() => document.body.textContent.includes('YAP agenda scritta'));
    // status_reason was whitespace-only — formatYapStatusReason returns '' — banner must not
    // contain a bare "Stato " or "Causa " prefix with no content after it
    expect(document.body.textContent).not.toMatch(/\bStato\s*$/m);
    expect(document.body.textContent).not.toMatch(/\bCausa\s*$/m);
  });

  test('shows inline technical diagnostics for save-not-confirmed failures', async () => {
    axios.post.mockImplementation((url) => {
      if (String(url).includes('/yap/sync')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              status: 'sync_failed',
              message: 'Salvataggio YAP non confermato dopo 3 tentativi',
              status_reason: 'salvataggio_yap_non_confermato_dopo_3_tentativi',
              error_code: 'YAP_SAVE_NOT_CONFIRMED',
              preSync: { ready: true, score: 92, issues: [] },
              phase_timeline: [
                { name: 'precheck', status: 'completed', duration_ms: 1000 },
                { name: 'write', status: 'failed', duration_ms: 82000 },
                { name: 'finalize', status: 'completed', duration_ms: 40 },
              ],
              failed_phase: 'save',
              runner: {
                script: 'yap-worker.mjs',
                finished_at: '2026-06-03T15:42:05.362758+00:00',
                timeout_seconds: 210,
              },
              worker_phases: [
                { phase: 'save_attempt', status: 'try_3', elapsed_ms: 65742 },
                { phase: 'save_result', status: 'failed', elapsed_ms: 84162 },
              ],
              stderr_tail: '{"event":"yap:phase","phase":"save_result","status":"failed"}',
              telemetry: { total_elapsed_ms: 82000 },
              practice: {
                id: 1,
                synced: false,
                management_sync_status: 'sync_failed',
              },
            },
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: false,
                management_sync_status: 'sync_failed',
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: false,
              management_sync_status: 'sync_failed',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('Riprova sync YAP') || getButton('Sincronizza con YAP'));

    await waitFor(() => document.body.textContent.includes('Salvataggio YAP non confermato dopo 3 tentativi'));
    expect(document.body.textContent).toContain('Crash log YAP');
    expect(document.body.textContent).toContain('last_phase: save_result:failed');
    expect(document.body.textContent).toContain('script: yap-worker.mjs  timeout: 210s');
    expect(document.body.textContent).toContain('stderr:');
  });

  test('surfaces interrupted YAP sync responses as verification guidance instead of generic network error', async () => {
    axios.post.mockImplementation((url) => {
      if (String(url).includes('/yap/sync')) {
        return Promise.reject({
          code: 'ECONNABORTED',
          message: 'timeout of 240000ms exceeded',
          config: { url: '/api/practices/1/yap/sync' },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: false,
                management_sync_status: 'sync_failed',
                management_audit_result: {
                  status: 'sync_failed',
                  technical_failure: true,
                  worker_phases: [
                    { phase: 'save_attempt', status: 'try_3', elapsed_ms: 65742 },
                    { phase: 'save_result', status: 'failed', elapsed_ms: 84162 },
                  ],
                  runner: {
                    script: 'yap-worker.mjs',
                    finished_at: '2026-06-03T15:42:05.362758+00:00',
                    timeout_seconds: 210,
                  },
                  stderr_tail: '{"event":"yap:phase","phase":"save_result","status":"failed"}',
                },
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: false,
              management_sync_status: 'sync_failed',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('Riprova sync YAP') || getButton('Sincronizza con YAP'));

    await waitFor(() => document.body.textContent.includes('La richiesta di sync YAP si è interrotta prima della risposta.'));
    expect(document.body.textContent).toContain('Verifica YAP');
    expect(document.body.textContent).toContain('Crash log YAP');
    expect(document.body.textContent).toContain('last_phase: save_result:failed');
    expect(document.body.textContent).not.toContain('Errore di rete. Controlla la connessione internet e riprova.');
  });

  test('keeps persisted crash diagnostics visible when YAP audit response is interrupted', async () => {
    axios.post.mockImplementation((url) => {
      if (String(url).includes('/yap/audit')) {
        return Promise.reject({
          code: 'ECONNABORTED',
          message: 'timeout of 275000ms exceeded',
          config: { url: '/api/practices/1/yap/audit' },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: false,
                management_sync_status: 'sync_failed',
                management_audit_result: {
                  status: 'sync_failed',
                  technical_failure: true,
                  worker_phases: [
                    { phase: 'save_attempt', status: 'try_3', elapsed_ms: 65742 },
                    { phase: 'save_result', status: 'failed', elapsed_ms: 84162 },
                  ],
                  runner: {
                    script: 'yap-worker.mjs',
                    finished_at: '2026-06-03T15:42:05.362758+00:00',
                    timeout_seconds: 210,
                  },
                  stderr_tail: '{"event":"yap:phase","phase":"save_result","status":"failed"}',
                },
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: false,
              management_sync_status: 'sync_failed',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('Verifica YAP'));

    await waitFor(() => document.body.textContent.includes('La verifica YAP si è interrotta prima della risposta.'));
    expect(document.body.textContent).toContain('Verifica YAP fallita');
    expect(document.body.textContent).toContain('Crash log YAP');
    expect(document.body.textContent).toContain('last_phase: save_result:failed');
    expect(document.body.textContent).not.toContain('Errore di rete. Controlla la connessione internet e riprova.');
  });

  test('keeps persisted crash diagnostics visible when YAP delete response is interrupted', async () => {
    axios.delete.mockImplementation((url) => {
      if (String(url).includes('/yap/appointment')) {
        return Promise.reject({
          code: 'ECONNABORTED',
          message: 'timeout of 240000ms exceeded',
          config: { url: '/api/practices/1/yap/appointment' },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331112222',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                synced: false,
                management_sync_status: 'partial_synced',
                management_audit_result: {
                  status: 'partial_synced',
                  technical_failure: true,
                  worker_phases: [
                    { phase: 'save_attempt', status: 'try_3', elapsed_ms: 65742 },
                    { phase: 'save_result', status: 'failed', elapsed_ms: 84162 },
                  ],
                  runner: {
                    script: 'yap-worker.mjs',
                    finished_at: '2026-06-03T15:42:05.362758+00:00',
                    timeout_seconds: 210,
                  },
                  stderr_tail: '{"event":"yap:phase","phase":"save_result","status":"failed"}',
                },
              },
              sections: [],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{
              id: 1,
              plate: 'AB123CD',
              customer_name: 'Mario Rossi',
              contexts: ['officina'],
              synced: false,
              management_sync_status: 'partial_synced',
              appointment_date: '2026-11-10T09:00:00.000Z',
              created_at: '2026-11-10T09:00:00.000Z',
            }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('Dettagli YAP'));
    await waitFor(() => document.body.textContent.includes('Automazione YAP'));
    clickElement(getButton('Elimina da YAP'));

    await waitFor(() => document.body.textContent.includes('La richiesta di eliminazione YAP si è interrotta prima della risposta.'));
    expect(document.body.textContent).toContain('Eliminazione YAP fallita');
    expect(document.body.textContent).toContain('Crash log YAP');
    expect(document.body.textContent).toContain('last_phase: save_result:failed');
    expect(document.body.textContent).not.toContain('Errore di rete. Controlla la connessione internet e riprova.');
  });

  test('empty audit object in sync response does not produce partial_synced status', async () => {
    // Bug: result.audit = {} è truthy → status inferred come partial_synced invece di agenda_synced.
    // La risposta non ha status top-level né management_sync_status: forza il path di inferenza.
    axios.post.mockImplementation((url) => {
      if (String(url).includes('/yap/sync')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              // status assente: normalizeYapResult lo inferisce da yap.result.saved + audit
              message: 'Appuntamento scritto su YAP.',
              yap: { result: { saved: true, mode: 'commit', message: 'Salvato.' } },
              audit: {}, // oggetto vuoto (era truthy → bug: partial_synced)
              practice: { id: 1, synced: true }, // niente management_sync_status
              preSync: { ready: true, score: 100, issues: [] },
            },
          },
        });
      }
      if (String(url).includes('/yap/audit')) return Promise.resolve(DEFAULT_YAP_AUDIT_RESPONSE);
      if (String(url).includes('/yap/notify-error')) return Promise.resolve({ data: { success: true, data: { notified: true } } });
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1, status: 'confirmed', plate_confirmed: 'AB123CD', phone: '3331112222',
                customer_name: 'Mario Rossi', customer_type: 'privato', billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z', appointment_time: '09:00',
                practice_type: 'preventivo', contexts: 'officina', synced: false,
                management_sync_status: 'sync_failed',
              },
              sections: [], parts: [], photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{ id: 1, plate: 'AB123CD', customer_name: 'Mario Rossi', contexts: ['officina'], synced: false, management_sync_status: 'sync_failed', appointment_date: '2026-11-10T09:00:00.000Z', created_at: '2026-11-10T09:00:00.000Z' }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('Riprova sync YAP') || getButton('Sincronizza con YAP'));

    await waitFor(() => document.body.textContent.includes('YAP agenda scritta'));
    expect(document.body.textContent).not.toContain('YAP parziale');
  });

  test('all-skipped phase_timeline does not render zero-completion diagnostic', async () => {
    // Bug: summarizePhaseTimeline con tutte le fasi skipped ritornava "0/N fasi completate (0s)"
    // che è rumore inutile. Ora deve ritornare fallback ('') e non comparire nei diagnostici.
    axios.post.mockImplementation((url) => {
      if (String(url).includes('/yap/sync')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              status: 'agenda_synced',
              message: 'Appuntamento scritto su YAP.',
              status_reason: 'audit_deferred',
              preSync: { ready: true, score: 100, issues: [] },
              phase_timeline: [
                { name: 'precheck', status: 'skipped', duration_ms: 0 },
                { name: 'write', status: 'skipped', duration_ms: 0 },
                { name: 'audit', status: 'skipped', duration_ms: 0 },
              ],
              write_report: { attempted: false, ok: true },
              practice: { id: 1, synced: true, management_sync_status: 'agenda_synced' },
            },
          },
        });
      }
      if (String(url).includes('/yap/audit')) return Promise.resolve(DEFAULT_YAP_AUDIT_RESPONSE);
      if (String(url).includes('/yap/notify-error')) return Promise.resolve({ data: { success: true, data: { notified: true } } });
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/practices/1/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1, status: 'confirmed', plate_confirmed: 'AB123CD', phone: '3331112222',
                customer_name: 'Mario Rossi', customer_type: 'privato', billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z', appointment_time: '09:00',
                practice_type: 'preventivo', contexts: 'officina', synced: false,
                management_sync_status: 'sync_failed',
              },
              sections: [], parts: [], photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [{ id: 1, plate: 'AB123CD', customer_name: 'Mario Rossi', contexts: ['officina'], synced: false, management_sync_status: 'sync_failed', appointment_date: '2026-11-10T09:00:00.000Z', created_at: '2026-11-10T09:00:00.000Z' }],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));
    clickElement(getButton('Riprova sync YAP') || getButton('Sincronizza con YAP'));

    await waitFor(() => document.body.textContent.includes('YAP agenda scritta'));
    expect(document.body.textContent).not.toMatch(/0\/\d+ fasi completate/);
  });

  test('editing an existing practice preserves section rows when updating notes only', async () => {
    axios.put.mockResolvedValueOnce({ data: { success: true, data: { id: 1 } } });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 1 } } });
      }
      if (url.includes('/api/practices/1')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 1,
                status: 'confirmed',
                plate_confirmed: 'EG487YR',
                phone: '3331112222',
                customer_name: 'Cliente Demo',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                appointment_time: '09:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                internal_notes: 'Nota iniziale',
                synced: false,
              },
              sections: [
                { context: 'officina', description_rows: ['Tagliando completo'], man_hours: 1, mac_hours: null, materials_amount: null, waste_apply: false, waste_percentage: null, notes: 'OK' },
              ],
              parts: [
                { context: 'officina', name: 'Filtro olio', quantity: '1 pz' },
              ],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              {
                id: 1,
                plate: 'EG487YR',
                customer_name: 'Cliente Demo',
                contexts: ['officina'],
                synced: false,
                appointment_date: '2026-11-10T09:00:00.000Z',
                created_at: '2026-11-10T09:00:00.000Z',
              },
            ],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));

    clickElement(document.querySelector('.detail-actions .button-submit'));
    await waitFor(() => document.querySelector('form'));

    const officinaSection = getSection('Officina');
    expect(officinaSection).toBeTruthy();
    expect(officinaSection.querySelector('input[placeholder="Descrizione lavoro..."]').value).toBe('Tagliando completo');

    setValueWithin(officinaSection, 'textarea#notes_officina', 'Nota aggiornata');
    clickElement(document.querySelector('form button[type="submit"]'));

    await waitFor(() => axios.put.mock.calls.length === 1);
    const payload = axios.put.mock.calls[0][1];
    expect(payload.sections).toHaveLength(1);
    expect(payload.sections[0].description_rows).toEqual(['Tagliando completo']);
    expect(payload.sections[0].notes).toBe('Nota aggiornata');
    expect(document.body.textContent).not.toContain('Inserisci almeno una riga descrittiva per officina');
  });

  test('draft restore preserves contexts, section rows, parts, and appointment values after remount', async () => {
    mount('?plate=AB123CD');

    await waitFor(() => document.querySelector('form'));

    setValueBySelector('#phone', '3331234567');
    setValueBySelector('#customer_name', 'Bozza Cliente');
    setValueBySelector('#appointment_date', '2026-11-01');
    setValueBySelector('#appointment_time', '10:30');

    clickElement(getCheckboxLabel('Officina').querySelector('input[type="checkbox"]'));
    await waitFor(() => getSection('Officina'));

    setValueWithin(getSection('Officina'), 'input[placeholder="Descrizione lavoro..."]', 'Controllo generale');
    clickElement(getButton('Aggiungi pezzo'));
    setValueWithin(getSection('Officina'), 'input[placeholder="Es. Pastiglie freno"]', 'Filtro aria');
    setValueWithin(getSection('Officina'), 'input[placeholder="1 pz"]', '1 pz');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    await unmountCurrentRoot();

    mount('?plate=AB123CD');

    await waitFor(() => document.querySelector('form'));
    await waitFor(() => getSection('Officina'));

    expect(getFormInput('phone').value).toBe('3331234567');
    expect(getFormInput('customer_name').value).toBe('Bozza Cliente');
    expect(getFormInput('appointment_time').value).toBe('10:30');
    expect(getSection('Officina').querySelector('input[placeholder="Descrizione lavoro..."]').value).toBe('Controllo generale');
    expect(getSection('Officina').querySelector('input[placeholder="Es. Pastiglie freno"]').value).toBe('Filtro aria');
    expect(getSection('Officina').querySelector('input[placeholder="1 pz"]').value).toBe('1 pz');
  });

  test('toggling a context off and on does not silently lose previously entered section content', async () => {
    mount('?plate=AB123CD');

    await waitFor(() => document.querySelector('form'));

    clickElement(getCheckboxLabel('Officina').querySelector('input[type="checkbox"]'));
    await waitFor(() => getSection('Officina'));

    setValueWithin(getSection('Officina'), 'input[placeholder="Descrizione lavoro..."]', 'Sostituzione olio');
    setValueWithin(getSection('Officina'), 'textarea#notes_officina', 'Da riconfermare col cliente');

    clickElement(getCheckboxLabel('Officina').querySelector('input[type="checkbox"]'));
    await waitFor(() => !getSection('Officina'));

    clickElement(getCheckboxLabel('Officina').querySelector('input[type="checkbox"]'));
    await waitFor(() => getSection('Officina'));

    expect(getSection('Officina').querySelector('input[placeholder="Descrizione lavoro..."]').value).toBe('Sostituzione olio');
    expect(getSection('Officina').querySelector('textarea#notes_officina').value).toBe('Da riconfermare col cliente');
  });

  test.each(CONTEXT_MATRIX.map((combo) => [combo]))(
    'draft restore preserves context combination %s without losing section rows',
    async (combo) => {
      localStorage.clear();
      sessionStorage.clear();

      mount(`?plate=AB123CD&matrix=${combo.join('-')}`);
      await waitFor(() => document.querySelector('form'));

      for (const context of combo) {
        const label = getCheckboxLabel(context.charAt(0).toUpperCase() + context.slice(1));
        clickElement(label.querySelector('input[type="checkbox"]'));
      }

      for (const context of combo) {
        const title = context.charAt(0).toUpperCase() + context.slice(1);
        await waitFor(() => getSection(title));
        setValueWithin(
          getSection(title),
          'input[placeholder="Descrizione lavoro..."]',
          `Riga ${context}`
        );
      }

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });

      await unmountCurrentRoot();

      mount(`?plate=AB123CD&matrix=${combo.join('-')}`);
      await waitFor(() => document.querySelector('form'));

      for (const context of combo) {
        const title = context.charAt(0).toUpperCase() + context.slice(1);
        await waitFor(() => getSection(title));
        expect(
          getSection(title).querySelector('input[placeholder="Descrizione lavoro..."]').value
        ).toBe(`Riga ${context}`);
      }

      for (const context of ['officina', 'carrozzeria', 'revisione']) {
        if (!combo.includes(context)) {
          const title = context.charAt(0).toUpperCase() + context.slice(1);
          expect(getSection(title)).toBeNull();
        }
      }

      await unmountCurrentRoot();
      localStorage.clear();
      sessionStorage.clear();
    }
  );

  test('editing an existing multi-context practice preserves all contexts and parts on submit', async () => {
    axios.put.mockResolvedValueOnce({ data: { success: true, data: { id: 7 } } });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 1, this_month: 1, pending_sync: 0 } } });
      }
      if (url.includes('/api/practices/7')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 7,
                status: 'confirmed',
                plate_confirmed: 'ZZ123YY',
                phone: '3390001122',
                customer_name: 'Flotta Test',
                customer_type: 'azienda',
                billing_to_complete: false,
                appointment_date: '2026-11-05T08:30:00.000Z',
                appointment_time: '08:30',
                practice_type: 'ordine_di_lavoro',
                contexts: 'officina,carrozzeria',
                internal_notes: 'Pratica complessa',
                synced: true,
              },
              sections: [
                { context: 'officina', description_rows: ['Diagnosi iniziale'], man_hours: 1, mac_hours: null, materials_amount: null, waste_apply: false, waste_percentage: null, notes: 'Off note' },
                { context: 'carrozzeria', description_rows: ['Ripresa paraurti'], man_hours: null, mac_hours: 2, materials_amount: 120, waste_apply: true, waste_percentage: 5, notes: 'Car note' },
              ],
              parts: [
                { context: 'officina', name: 'Filtro olio', quantity: '1 pz' },
                { context: 'carrozzeria', name: 'Primer', quantity: '1 kit' },
              ],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              {
                id: 7,
                plate: 'ZZ123YY',
                customer_name: 'Flotta Test',
                contexts: ['officina', 'carrozzeria'],
                synced: true,
                appointment_date: '2026-11-05T08:30:00.000Z',
                created_at: '2026-11-05T08:30:00.000Z',
              },
            ],
          },
        });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    mount('/');

    await waitFor(() => document.querySelectorAll('.practice-card').length === 1);
    clickElement(document.querySelector('.practice-card'));
    await waitFor(() => document.body.textContent.includes('Stato sincronizzazione'));

    clickElement(document.querySelector('.detail-actions .button-submit'));
    await waitFor(() => document.querySelector('form'));

    expect(getSection('Officina')).toBeTruthy();
    expect(getSection('Carrozzeria')).toBeTruthy();
    expect(getSection('Officina').querySelector('input[placeholder="Es. Pastiglie freno"]').value).toBe('Filtro olio');
    expect(getSection('Carrozzeria').querySelector('input[placeholder="Es. Pastiglie freno"]').value).toBe('Primer');

    setValueBySelector('#customer_name', 'Flotta Test Aggiornata');
    clickElement(document.querySelector('form button[type="submit"]'));

    await waitFor(() => axios.put.mock.calls.length === 1);
    const payload = axios.put.mock.calls[0][1];
    expect(payload.practice.contexts).toEqual(['officina', 'carrozzeria']);
    expect(payload.sections).toHaveLength(2);
    expect(payload.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ context: 'officina', name: 'Filtro olio' }),
        expect.objectContaining({ context: 'carrozzeria', name: 'Primer' }),
      ])
    );
  });

  test('renders the form, reveals dependent checkboxes/fields, and never shows placeholder text', async () => {
    mount('?plate=AB123CD');

    await waitFor(() => document.querySelector('form'));

    expect(getFormInput('plate_confirmed').value).toBe('AB123CD');
    expect(document.body.textContent).not.toMatch(/da_completare/i);

    expect(getCheckboxLabel('Dati fatturazione da completare')).toBeFalsy();

    setValueBySelector('#customer_type', 'azienda');
    await waitFor(() => getCheckboxLabel('Dati fatturazione da completare'));

    const billingCheckbox = getCheckboxLabel('Dati fatturazione da completare').querySelector('input[type="checkbox"]');
    clickElement(billingCheckbox);

    await waitFor(() => document.getElementById('company_name'));
    expect(document.getElementById('vat_number')).toBeTruthy();
    expect(document.getElementById('fiscal_code')).toBeTruthy();
    expect(document.getElementById('billing_address')).toBeTruthy();

    clickElement(billingCheckbox);
    await waitFor(() => !document.getElementById('company_name'));

    ['officina', 'carrozzeria', 'revisione'].forEach((context) => {
      const label = getCheckboxLabel(context.charAt(0).toUpperCase() + context.slice(1));
      clickElement(label.querySelector('input[type="checkbox"]'));
    });

    await waitFor(() => getSection('Officina'));
    await waitFor(() => getSection('Carrozzeria'));
    await waitFor(() => getSection('Revisione'));

    const carrozzeriaSection = getSection('Carrozzeria');
    const wasteToggle = carrozzeriaSection.querySelector('label.inline-checkbox input[type="checkbox"]');
    clickElement(wasteToggle);

    await waitFor(() => carrozzeriaSection.querySelector('input[placeholder="Percentuale smaltimento %"]'));

    clickElement(wasteToggle);
    await waitFor(() => !carrozzeriaSection.querySelector('input[placeholder="Percentuale smaltimento %"]'));

    const revisioneLabel = getCheckboxLabel('Revisione');
    clickElement(revisioneLabel.querySelector('input[type="checkbox"]'));
    await waitFor(() => !getSection('Revisione'));
  });

  test('blocks submission and shows validation errors for missing required fields', async () => {
    mount('?plate=AB123CD');

    await waitFor(() => document.querySelector('form'));

    setValueBySelector('#plate_confirmed', '');
    setValueBySelector('#phone', '');
    setValueBySelector('#customer_name', '');
    setValueBySelector('#appointment_time', '');

    const saveButton = getButton('Salva');
    clickElement(saveButton);

    await waitFor(() => document.body.textContent.includes('Targa obbligatoria'));

    expect(document.body.textContent).toContain('Targa obbligatoria');
    expect(document.body.textContent).toContain('Telefono obbligatorio');
    expect(document.body.textContent).toContain('Nome obbligatorio');
    expect(document.body.textContent).toContain('Data obbligatoria');
    expect(document.body.textContent).toContain('Ora obbligatoria');
    expect(document.body.textContent).toContain('Seleziona almeno un tipo di sezione');
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.put).not.toHaveBeenCalled();
  });

  test('creates a practice with all fields, checkboxes, sections, and parts', async () => {
    axios.post.mockResolvedValueOnce({ data: { success: true, data: { id: 42 } } });

    mount('?plate=AB123CD');

    await waitFor(() => document.querySelector('form'));

    setValueBySelector('#plate_confirmed', 'AB123CD');
    setValueBySelector('#phone', '+393331234567');
    setValueBySelector('#customer_name', 'Mario Rossi');
    setValueBySelector('#customer_type', 'azienda');
    setValueBySelector('#appointment_date', '2026-11-15');
    setValueBySelector('#appointment_time', '09:30');
    setValueBySelector('#practice_type', 'ordine_di_lavoro');

    const billingCheckbox = await waitFor(() => getCheckboxLabel('Dati fatturazione da completare').querySelector('input[type="checkbox"]'));
    clickElement(billingCheckbox);
    await waitFor(() => document.getElementById('company_name'));
    setValueBySelector('#company_name', 'Rossi SRL');
    setValueBySelector('#vat_number', 'IT12345678901');
    setValueBySelector('#fiscal_code', 'RSSMRA80A01H501U');
    setValueBySelector('#billing_address', 'Via Roma 1');
    setValueBySelector('#billing_city', 'Milano');
    setValueBySelector('#billing_zip', '20100');

    const officinaCheckbox = getCheckboxLabel('Officina').querySelector('input[type="checkbox"]');
    const carrozzeriaCheckbox = getCheckboxLabel('Carrozzeria').querySelector('input[type="checkbox"]');
    const revisioneCheckbox = getCheckboxLabel('Revisione').querySelector('input[type="checkbox"]');
    clickElement(officinaCheckbox);
    clickElement(carrozzeriaCheckbox);
    clickElement(revisioneCheckbox);

    await waitFor(() => getSection('Officina'));
    await waitFor(() => getSection('Carrozzeria'));
    await waitFor(() => getSection('Revisione'));

    const officinaSection = getSection('Officina');
    setValueWithin(officinaSection, '#notes_officina', 'Controllo rapido e diagnosi');
    setValueWithin(officinaSection, 'input[placeholder="Descrizione lavoro..."]', 'Tagliando completo');
    const addPartButton = Array.from(officinaSection.querySelectorAll('button')).find((btn) => btn.textContent.includes('Aggiungi pezzo'));
    clickElement(addPartButton);
    await waitFor(() => officinaSection.querySelectorAll('input[placeholder="Es. Pastiglie freno"]').length === 1);
    const partName = officinaSection.querySelector('input[placeholder="Es. Pastiglie freno"]');
    const partQty = officinaSection.querySelector('input[placeholder="1 pz"]');
    setValueWithin(officinaSection, 'input[placeholder="Es. Pastiglie freno"]', 'Filtro olio');
    setValueWithin(officinaSection, 'input[placeholder="1 pz"]', '1 pz');
    void partName;
    void partQty;

    const carrozzeriaSection = getSection('Carrozzeria');
    const wasteToggle = carrozzeriaSection.querySelector('label.inline-checkbox input[type="checkbox"]');
    clickElement(wasteToggle);
    await waitFor(() => carrozzeriaSection.querySelector('input[placeholder="Percentuale smaltimento %"]'));
    setValueWithin(carrozzeriaSection, 'input[placeholder="Percentuale smaltimento %"]', '7.5');
    setValueWithin(carrozzeriaSection, 'input[placeholder="Descrizione lavoro..."]', 'Riparazione paraurti');
    setValueWithin(carrozzeriaSection, 'input[type="number"]', '2.5');

    const revisioneSection = getSection('Revisione');
    setValueWithin(revisioneSection, 'input[placeholder="Descrizione lavoro..."]', 'Controllo revisione');
    setValueWithin(revisioneSection, '#notes_revisione', 'Note revisione');

    const submit = getButton('Salva');
    clickElement(submit);

    await waitFor(() => axios.post.mock.calls.length === 2);

    expect(axios.post).toHaveBeenCalledTimes(2);
    const [url, payload, options] = axios.post.mock.calls[0];
    expect(url).toContain('/practices/full');
    expect(options.headers['X-Telegram-Init-Data']).toBe('mock-init-data');
    expect(axios.post.mock.calls[1][0]).toContain('/yap/sync');
    expect(payload.practice).toEqual(expect.objectContaining({
      plate_confirmed: 'AB123CD',
      phone: '+393331234567',
      customer_name: 'Mario Rossi',
      customer_type: 'azienda',
      billing_to_complete: true,
      appointment_time: '09:30',
      practice_type: 'ordine_di_lavoro',
      internal_notes: null,
      contexts: ['officina', 'carrozzeria', 'revisione'],
    }));
    expect(payload.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ context: 'officina' }),
      expect.objectContaining({ context: 'carrozzeria' }),
      expect.objectContaining({ context: 'revisione' }),
    ]));
    expect(payload.parts).toEqual([
      expect.objectContaining({ context: 'officina', name: 'Filtro olio', quantity: '1 pz' }),
    ]);
  });

  test('starts from bot flow and ends on YAP detail with a valid new practice', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/practices/stats')) {
        return Promise.resolve({ data: { success: true, data: { total: 0, this_month: 0, pending_sync: 0 } } });
      }
      if (url.includes('/practices/99/yap-mapping-preview')) {
        return Promise.resolve({ data: { success: true, data: { proposedYap: { fieldMapping: {} }, confidence: {} } } });
      }
      if (url.includes('/api/practices/99')) {
        return Promise.resolve({
          data: {
            success: true,
            data: {
              practice: {
                id: 99,
                status: 'confirmed',
                plate_confirmed: 'AB123CD',
                phone: '3331234567',
                customer_name: 'Mario Rossi',
                customer_type: 'privato',
                billing_to_complete: false,
                appointment_date: '2026-11-20T00:00:00.000Z',
                appointment_time: '10:00',
                practice_type: 'preventivo',
                contexts: 'officina',
                internal_notes: null,
                synced: false,
                management_sync_status: 'partial_synced',
                management_audit_result: DEFAULT_YAP_SYNC_RESPONSE.data.data.audit,
              },
              sections: [
                { context: 'officina', description_rows: ['Tagliando completo'], man_hours: null, mac_hours: null, materials_amount: null, waste_apply: false, waste_percentage: null, notes: null },
              ],
              parts: [],
              photos: [],
            },
          },
        });
      }
      if (url.includes('/api/practices')) {
        return Promise.resolve({ data: { success: true, data: [] } });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    axios.post.mockResolvedValueOnce({ data: { success: true, data: { id: 99 } } });

    mount('?plate=AB123CD');

    await waitFor(() => document.querySelector('form'));

    setValueBySelector('#plate_confirmed', 'AB123CD');
    setValueBySelector('#phone', '3331234567');
    setValueBySelector('#customer_name', 'Mario Rossi');
    setValueBySelector('#customer_type', 'privato');
    setValueBySelector('#appointment_date', '2026-11-20');
    setValueBySelector('#appointment_time', '10:00');
    setValueBySelector('#practice_type', 'preventivo');

    clickElement(getCheckboxLabel('Officina').querySelector('input[type="checkbox"]'));
    await waitFor(() => getSection('Officina'));
    setValueWithin(getSection('Officina'), 'input[placeholder="Descrizione lavoro..."]', 'Tagliando completo');

    clickElement(getButton('Salva'));
    await waitFor(() => axios.post.mock.calls.length === 2);
    await waitFor(() => document.body.textContent.includes('Automazione YAP'));
    expect(document.body.textContent).not.toContain('Pratica salvata!');
    expect(document.body.textContent).toContain('YAP parziale');
    expect(document.body.textContent).toContain('Sincronizza con YAP');
    expect(document.body.textContent).toContain('Verifica YAP');
    expect(axios.post.mock.calls[0][0]).toContain('/practices/full');
    expect(axios.post.mock.calls[1][0]).toContain('/yap/sync');

    await waitFor(() => document.body.textContent.includes('Automazione YAP'));
    expect(document.body.textContent).not.toContain('Nessuna pratica trovata');
  });

  test('loads an existing practice and sends updates through PUT', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          practice: {
            id: 77,
            status: 'confirmed',
            plate_confirmed: 'AA111AA',
            phone: '3331112222',
            customer_name: 'Mario Rossi',
            customer_type: 'privato',
            billing_to_complete: false,
            appointment_date: '2026-11-15T00:00:00.000Z',
            appointment_time: '09:00',
            practice_type: 'preventivo',
            contexts: 'officina',
            internal_notes: 'Vecchie note',
            synced: false,
          },
          sections: [
            { context: 'officina', description_rows: ['Tagliando'], man_hours: 1, mac_hours: null, materials_amount: null, waste_apply: false, waste_percentage: null, notes: 'OK' },
          ],
          parts: [
            { context: 'officina', name: 'Filtro aria', quantity: '1 pz' },
          ],
          photos: [],
        },
      },
    });
    axios.put.mockResolvedValueOnce({ data: { success: true, data: { id: 77 } } });

    mount('?practice_id=77');

    await waitFor(() => document.querySelector('form'));
    await waitFor(() => getFormInput('plate_confirmed').value === 'AA111AA');

    expect(getFormInput('phone').value).toBe('3331112222');
    expect(getFormInput('customer_name').value).toBe('Mario Rossi');
    expect(getFormInput('appointment_time').value).toBe('09:00');

    setValueBySelector('#customer_name', 'Mario Bianchi');
    expect(getFormInput('customer_name').value).toBe('Mario Bianchi');
    const submit = getButton('Aggiorna');
    clickElement(submit);

    await waitFor(() => axios.put.mock.calls.length === 1);

    const [url, payload] = axios.put.mock.calls[0];
    expect(url).toContain('/practices/77/full');
    expect(payload.practice.customer_name).toBe('Mario Bianchi');
    expect(payload.practice.plate_confirmed).toBe('AA111AA');
  });
});
