from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from datetime import datetime
from copy import deepcopy
import os
import json

INITIAL_STATE = {
    'practices': [
        {
            'id': 1,
            'plate': 'AB123CD',
            'customer_name': 'Mario Rossi',
            'contexts': ['officina'],
            'synced': False,
            'appointment_date': '2026-06-10T09:00:00.000Z',
            'created_at': '2026-06-10T09:00:00.000Z',
        },
        {
            'id': 2,
            'plate': 'XZ987YZ',
            'customer_name': 'Luca Bianchi',
            'contexts': ['carrozzeria'],
            'synced': True,
            'appointment_date': '2026-06-11T10:00:00.000Z',
            'created_at': '2026-06-11T10:00:00.000Z',
        },
    ],
    'details': {
        1: {
            'practice': {
                'id': 1,
                'status': 'confirmed',
                'plate_confirmed': 'AB123CD',
                'phone': '3331112222',
                'customer_name': 'Mario Rossi',
                'customer_type': 'privato',
                'billing_to_complete': False,
                'appointment_date': '2026-06-10T09:00:00.000Z',
                'appointment_time': '09:00',
                'practice_type': 'preventivo',
                'contexts': 'officina',
                'internal_notes': 'Controllo iniziale',
                'synced': False,
            },
            'sections': [
                { 'context': 'officina', 'description_rows': ['Tagliando'], 'man_hours': 1, 'mac_hours': None, 'materials_amount': None, 'waste_apply': False, 'waste_percentage': None, 'notes': 'OK' }
            ],
            'parts': [
                { 'context': 'officina', 'name': 'Filtro olio', 'quantity': '1 pz' }
            ],
            'photos': [
                { 'id': 10, 'url': 'https://example.com/photo.jpg', 'thumbnail': 'https://example.com/thumb.jpg' }
            ]
        },
        2: {
            'practice': {
                'id': 2,
                'status': 'confirmed',
                'plate_confirmed': 'XZ987YZ',
                'phone': '3332223333',
                'customer_name': 'Luca Bianchi',
                'customer_type': 'azienda',
                'billing_to_complete': True,
                'appointment_date': '2026-06-11T10:00:00.000Z',
                'appointment_time': '10:00',
                'practice_type': 'ordine_di_lavoro',
                'contexts': 'carrozzeria',
                'internal_notes': 'Lucidatura',
                'synced': True,
            },
            'sections': [
                { 'context': 'carrozzeria', 'description_rows': ['Riparazione paraurti'], 'man_hours': None, 'mac_hours': 2.5, 'materials_amount': 150, 'waste_apply': True, 'waste_percentage': 7.5, 'notes': 'OK' }
            ],
            'parts': [],
            'photos': []
        }
    },
    'next_id': 3,
}

STATE = deepcopy(INITIAL_STATE)


def _reset_state():
    global STATE
    STATE = deepcopy(INITIAL_STATE)


def _json_response(handler, status_code, payload):
    body = json.dumps(payload).encode('utf-8')
    handler.send_response(status_code)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Headers', '*')
    handler.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    handler.end_headers()
    handler.wfile.write(body)


def _empty_response(handler, status_code=204):
    handler.send_response(status_code)
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Headers', '*')
    handler.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    handler.end_headers()


def _parse_json_body(handler):
    length = int(handler.headers.get('Content-Length', '0') or '0')
    if not length:
        return {}
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    try:
        return json.loads(raw.decode('utf-8'))
    except Exception:
        return {}


def _compute_stats():
    total = len(STATE['practices'])
    this_month = total
    pending_sync = sum(1 for p in STATE['practices'] if not p.get('synced'))
    return {'total': total, 'this_month': this_month, 'pending_sync': pending_sync}


def _find_practice(practice_id):
    return next((p for p in STATE['practices'] if p['id'] == practice_id), None)


def _detail_for(practice_id):
    detail = STATE['details'].get(practice_id)
    if detail:
        return detail

    practice = _find_practice(practice_id)
    if not practice:
        return None

    return {
        'practice': {
            'id': practice['id'],
            'status': 'confirmed',
            'plate_confirmed': practice['plate'],
            'phone': '3330000000',
            'customer_name': practice['customer_name'],
            'customer_type': 'privato',
            'billing_to_complete': False,
            'appointment_date': practice['appointment_date'],
            'appointment_time': '09:00',
            'practice_type': 'preventivo',
            'contexts': ','.join(practice['contexts']),
            'internal_notes': '',
            'synced': practice['synced'],
        },
        'sections': [],
        'parts': [],
        'photos': [],
    }


def _filter_practices(params):
    practices = list(STATE['practices'])
    search = (params.get('search', [''])[0] or '').lower()
    context = (params.get('context', [''])[0] or '')
    synced = params.get('synced', [''])[0]

    if search:
        practices = [p for p in practices if search in p['plate'].lower() or search in p['customer_name'].lower()]
    if context:
        wanted = [c.strip() for c in context.split(',') if c.strip()]
        practices = [p for p in practices if any(ctx in p['contexts'] for ctx in wanted)]
    if synced == 'true':
        practices = [p for p in practices if p['synced']]
    if synced == 'false':
        practices = [p for p in practices if not p['synced']]
    return practices


def _save_practice(payload, practice_id=None):
    practice_payload = payload.get('practice', {})
    sections = payload.get('sections', [])
    parts = payload.get('parts', [])
    plate = practice_payload.get('plate_confirmed') or 'AB123CD'
    customer_name = practice_payload.get('customer_name') or 'Cliente'
    contexts = practice_payload.get('contexts') or ['officina']
    if isinstance(contexts, str):
        contexts = [c.strip() for c in contexts.split(',') if c.strip()]

    if practice_id is None:
        practice_id = STATE['next_id']
        STATE['next_id'] += 1

    practice = {
        'id': practice_id,
        'plate': plate,
        'customer_name': customer_name,
        'contexts': contexts,
        'synced': False,
        'appointment_date': datetime.utcnow().isoformat() + 'Z',
        'created_at': datetime.utcnow().isoformat() + 'Z',
    }
    STATE['practices'] = [p for p in STATE['practices'] if p['id'] != practice_id] + [practice]

    STATE['details'][practice_id] = {
        'practice': {
            'id': practice_id,
            'status': 'confirmed',
            'plate_confirmed': plate,
            'phone': practice_payload.get('phone'),
            'customer_name': customer_name,
            'customer_type': practice_payload.get('customer_type', 'privato'),
            'billing_to_complete': practice_payload.get('billing_to_complete', False),
            'appointment_date': datetime.utcnow().isoformat() + 'Z',
            'appointment_time': practice_payload.get('appointment_time', '09:00'),
            'practice_type': practice_payload.get('practice_type', 'preventivo'),
            'contexts': ','.join(contexts),
            'internal_notes': practice_payload.get('internal_notes'),
            'synced': False,
        },
        'sections': sections,
        'parts': parts,
        'photos': [],
    }
    return {'id': practice_id}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_OPTIONS(self):
        _empty_response(self)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path in ('/', '/health', '/test-connection'):
            return _json_response(self, 200, {'status': 'ok', 'service': 'mock-api', 'timestamp': datetime.utcnow().isoformat() + 'Z'})

        if path == '/api/practices/stats':
            return _json_response(self, 200, {'success': True, 'data': _compute_stats()})

        if path == '/api/practices':
            data = _filter_practices(params)
            return _json_response(self, 200, {'success': True, 'data': data})

        if path.startswith('/api/practices/'):
            try:
                practice_id = int(path.rsplit('/', 1)[-1])
            except ValueError:
                return _json_response(self, 404, {'detail': 'Not found'})
            detail = _detail_for(practice_id)
            if not detail:
                return _json_response(self, 404, {'detail': 'Not found'})
            return _json_response(self, 200, {'success': True, 'data': detail})

        if path == '/mini-app/data':
            try:
                practice_id = int(params.get('practice_id', ['0'])[0])
            except ValueError:
                practice_id = 0
            detail = _detail_for(practice_id)
            if not detail:
                return _json_response(self, 404, {'detail': 'Not found'})
            return _json_response(self, 200, {'success': True, 'data': detail})

        return _json_response(self, 404, {'detail': f'Unhandled GET {path}'})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        payload = _parse_json_body(self)

        if path == '/__reset':
            _reset_state()
            return _json_response(self, 200, {'success': True, 'data': {'reset': True}})

        if path == '/practices/full':
            data = _save_practice(payload)
            return _json_response(self, 200, {'success': True, 'data': data})

        if path.startswith('/api/practices/') and path.endswith('/photos'):
            try:
                practice_id = int(path.split('/')[3])
            except ValueError:
                practice_id = 0
            return _json_response(self, 200, {'success': True, 'data': {'id': 1, 'practice_id': practice_id, 'url': 'https://example.com/uploaded.jpg'}})

        return _json_response(self, 404, {'detail': f'Unhandled POST {path}'})

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        payload = _parse_json_body(self)

        if path.startswith('/practices/') and path.endswith('/full'):
            try:
                practice_id = int(path.split('/')[2])
            except ValueError:
                practice_id = 0
            data = _save_practice(payload, practice_id=practice_id)
            return _json_response(self, 200, {'success': True, 'data': data})

        if path.startswith('/api/practices/') and path.endswith('/sync'):
            try:
                practice_id = int(path.split('/')[3])
            except ValueError:
                practice_id = 0
            practice = _find_practice(practice_id)
            if practice:
                practice['synced'] = bool(payload.get('synced', True))
            return _json_response(self, 200, {'success': True, 'data': {'id': practice_id, 'synced': bool(payload.get('synced', True))}})

        return _json_response(self, 404, {'detail': f'Unhandled PUT {path}'})

    def do_PATCH(self):
        return self.do_PUT()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith('/api/practices/') and '/photos/' in path:
            return _json_response(self, 200, {'success': True})

        if path.startswith('/api/practices/'):
            try:
                practice_id = int(path.split('/')[3])
            except ValueError:
                practice_id = 0
            STATE['practices'] = [p for p in STATE['practices'] if p['id'] != practice_id]
            STATE['details'].pop(practice_id, None)
            return _json_response(self, 200, {'success': True, 'data': {'id': practice_id}})

        return _json_response(self, 404, {'detail': f'Unhandled DELETE {path}'})


def main():
    port = int(os.environ.get('PORT', '8000'))
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'MOCK API READY on http://127.0.0.1:{port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
