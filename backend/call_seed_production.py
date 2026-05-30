#!/usr/bin/env python3
"""
Script per chiamare l'endpoint admin di seeding su produzione.
"""
import os
import sys

import requests

PRODUCTION_API_URL = os.getenv("PRODUCTION_API_URL", "https://giorgio-mvp-production.up.railway.app")
ADMIN_SECRET = os.getenv("ADMIN_SECRET", "")

def call_seed_endpoint():
    """Chiama l'endpoint admin per seeding."""
    if not ADMIN_SECRET:
        print("❌ ADMIN_SECRET non impostato. Esporta ADMIN_SECRET nell'ambiente prima di eseguire.")
        sys.exit(1)
    url = f"{PRODUCTION_API_URL}/admin/seed-test-practices"
    headers = {
        "Content-Type": "application/json",
        "X-Admin-Secret": ADMIN_SECRET,
    }
    
    try:
        response = requests.post(url, headers=headers, timeout=30)
        response.raise_for_status()
        result = response.json()
        print(f"✅ Seeding completato!")
        print(f"   Totale create: {result['data']['total']}")
        for p in result['data']['created']:
            print(f"   - {p['plate']}: {p['customer']} (ID: {p['id']})")
    except requests.exceptions.RequestException as e:
        print(f"❌ Errore: {e}")
        if hasattr(e, 'response') and e.response:
            print(f"   Response: {e.response.text}")

if __name__ == "__main__":
    print(f"🌱 Chiamata endpoint seeding su produzione...")
    print(f"📍 URL: {PRODUCTION_API_URL}/admin/seed-test-practices")
    call_seed_endpoint()
