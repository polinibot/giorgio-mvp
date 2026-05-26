#!/usr/bin/env python3
"""
Script per creare pratiche di test sul database di produzione via API.
"""
import os
import sys
import requests
import json
from datetime import datetime

# Configurazione
PRODUCTION_API_URL = os.getenv("PRODUCTION_API_URL", "https://giorgio-mvp-production.up.railway.app")
TELEGRAM_USER_ID = os.getenv("GIORGIO_TELEGRAM_USER_ID", "123456789")

def create_practice_via_api(practice_data):
    """Crea una pratica via API di produzione."""
    url = f"{PRODUCTION_API_URL}/practices/full"
    headers = {
        "Content-Type": "application/json",
        "X-Telegram-User-Id": str(TELEGRAM_USER_ID),
    }
    
    try:
        response = requests.post(url, json=practice_data, headers=headers, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"❌ Errore creando pratica {practice_data.get('plate_confirmed')}: {e}")
        if hasattr(e, 'response') and e.response:
            print(f"   Response: {e.response.text}")
        return None

def seed_production_practices():
    """Crea pratiche di test su produzione via API."""
    
    # Data comune: 12 novembre 2026
    base_date = "2026-11-12"
    
    # Pratiche di test diverse
    test_practices = [
        {
            "plate_confirmed": "TEST01AA",
            "phone": "3331234567",
            "customer_name": "Mario Rossi",
            "customer_type": "privato",
            "appointment_date": base_date,
            "appointment_time": "09:00",
            "practice_type": "ordine_di_lavoro",
            "contexts": ["officina"],
            "sections": [
                {
                    "context": "officina",
                    "description_rows": ["Cambio olio", "Controllo freni", "Verifica livelli"],
                    "man_hours": 1.5,
                    "mac_hours": 0.5,
                    "materials_amount": 50.0
                }
            ]
        },
        {
            "plate_confirmed": "TEST02BB",
            "phone": "3339876543",
            "customer_name": "Luigi Bianchi",
            "customer_type": "privato",
            "appointment_date": base_date,
            "appointment_time": "10:30",
            "practice_type": "ordine_di_lavoro",
            "contexts": ["carrozzeria"],
            "sections": [
                {
                    "context": "carrozzeria",
                    "description_rows": ["Riparazione paraurti anteriore", "Sverniciatura e riverniciatura"],
                    "man_hours": 3.0,
                    "mac_hours": 1.0,
                    "materials_amount": 150.0
                }
            ]
        },
        {
            "plate_confirmed": "TEST03CC",
            "phone": "3334567890",
            "customer_name": "Giuseppe Verdi",
            "customer_type": "azienda",
            "appointment_date": base_date,
            "appointment_time": "14:00",
            "practice_type": "preventivo",
            "contexts": ["revisione"],
            "sections": [
                {
                    "context": "revisione",
                    "description_rows": ["Revisione periodica", "Controllo emissioni", "Verifica pneumatici"],
                    "man_hours": 2.0,
                    "mac_hours": 0.5,
                    "materials_amount": 30.0
                }
            ]
        },
        {
            "plate_confirmed": "TEST04DD",
            "phone": "021234567",
            "customer_name": "AutoSas Srl",
            "customer_type": "azienda",
            "appointment_date": base_date,
            "appointment_time": "15:30",
            "practice_type": "ordine_di_lavoro",
            "contexts": ["officina", "carrozzeria"],
            "sections": [
                {
                    "context": "officina",
                    "description_rows": ["Cambio batteria", "Controllo alternatore"],
                    "man_hours": 1.0,
                    "mac_hours": 0.3,
                    "materials_amount": 80.0
                },
                {
                    "context": "carrozzeria",
                    "description_rows": ["Toccatura portiera sinistra"],
                    "man_hours": 1.5,
                    "mac_hours": 0.5,
                    "materials_amount": 40.0
                }
            ]
        },
        {
            "plate_confirmed": "TEST05EE",
            "phone": "3331112223",
            "customer_name": "Anna Neri",
            "customer_type": "privato",
            "appointment_date": base_date,
            "appointment_time": "16:00",
            "practice_type": "ordine_di_lavoro",
            "contexts": ["officina"],
            "sections": [
                {
                    "context": "officina",
                    "description_rows": ["Sostituzione filtri aria e abitacolo", "Controllo climatizzatore"],
                    "man_hours": 0.8,
                    "mac_hours": 0.2,
                    "materials_amount": 25.0
                }
            ]
        },
        {
            "plate_confirmed": "TEST06FF",
            "phone": "3334445556",
            "customer_name": "Marco Gialli",
            "customer_type": "privato",
            "appointment_date": base_date,
            "appointment_time": "17:00",
            "practice_type": "preventivo",
            "contexts": ["carrozzeria"],
            "sections": [
                {
                    "context": "carrozzeria",
                    "description_rows": ["Riparazione cofano", "Lucidatura completa"],
                    "man_hours": 4.0,
                    "mac_hours": 1.5,
                    "materials_amount": 200.0
                }
            ]
        }
    ]
    
    print(f"🌱 Seeding pratiche di test su produzione...")
    print(f"📍 API URL: {PRODUCTION_API_URL}")
    print(f"👤 Telegram User ID: {TELEGRAM_USER_ID}")
    print(f"📅 Data: {base_date}\n")
    
    created_count = 0
    for i, practice_data in enumerate(test_practices, 1):
        result = create_practice_via_api(practice_data)
        if result and result.get("success"):
            created_count += 1
            plate = practice_data["plate_confirmed"]
            customer = practice_data["customer_name"]
            time = practice_data["appointment_time"]
            print(f"✓ Creata pratica {i}: {plate} - {customer} ({time})")
        else:
            print(f"✗ Fallita pratica {i}: {practice_data['plate_confirmed']}")
    
    print(f"\n✅ Creato {created_count}/{len(test_practices)} pratiche di test su produzione!")

if __name__ == "__main__":
    seed_production_practices()
