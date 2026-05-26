#!/usr/bin/env python3
"""
Script per creare pratiche di test nel database.
Usa le variabili d'ambiente DATABASE_URL per connettersi.
"""
import os
import sys
from datetime import datetime
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

# Aggiungi la directory backend al path
sys.path.insert(0, os.path.dirname(__file__))

from database_sqlite import engine, SessionLocal, Base, Practice, PracticeSection, PracticePart
from models import PracticeStatus, PracticeType, CustomerType, Context
import json

def seed_test_practices():
    """Crea pratiche di test diverse per YAP."""
    db = SessionLocal()
    
    try:
        # Telegram user ID per test (sostituisci con il tuo reale)
        telegram_user_id = int(os.getenv("GIORGIO_TELEGRAM_USER_ID", "123456789"))
        
        # Data comune: 12 novembre 2026
        base_date = datetime(2026, 11, 12)
        
        # Pratiche di test diverse
        test_practices = [
            {
                "plate": "TEST01AA",
                "customer": "Mario Rossi",
                "phone": "3331234567",
                "customer_type": CustomerType.PRIVATO,
                "practice_type": PracticeType.ORDINE_DI_LAVORO,
                "contexts": [Context.OFFICINA],
                "time": "09:00",
                "sections": [
                    {
                        "context": Context.OFFICINA,
                        "description_rows": ["Cambio olio", "Controllo freni", "Verifica livelli"],
                        "man_hours": 1.5,
                        "mac_hours": 0.5,
                        "materials_amount": 50.0
                    }
                ]
            },
            {
                "plate": "TEST02BB",
                "customer": "Luigi Bianchi",
                "phone": "3339876543",
                "customer_type": CustomerType.PRIVATO,
                "practice_type": PracticeType.ORDINE_DI_LAVORO,
                "contexts": [Context.CARROZZERIA],
                "time": "10:30",
                "sections": [
                    {
                        "context": Context.CARROZZERIA,
                        "description_rows": ["Riparazione paraurti anteriore", "Sverniciatura e riverniciatura"],
                        "man_hours": 3.0,
                        "mac_hours": 1.0,
                        "materials_amount": 150.0
                    }
                ]
            },
            {
                "plate": "TEST03CC",
                "customer": "Giuseppe Verdi",
                "phone": "3334567890",
                "customer_type": CustomerType.AZIENDA,
                "practice_type": PracticeType.PREVENTIVO,
                "contexts": [Context.REVISIONE],
                "time": "14:00",
                "sections": [
                    {
                        "context": Context.REVISIONE,
                        "description_rows": ["Revisione periodica", "Controllo emissioni", "Verifica pneumatici"],
                        "man_hours": 2.0,
                        "mac_hours": 0.5,
                        "materials_amount": 30.0
                    }
                ]
            },
            {
                "plate": "TEST04DD",
                "customer": "AutoSas Srl",
                "phone": "021234567",
                "customer_type": CustomerType.AZIENDA,
                "practice_type": PracticeType.ORDINE_DI_LAVORO,
                "contexts": [Context.OFFICINA, Context.CARROZZERIA],
                "time": "15:30",
                "sections": [
                    {
                        "context": Context.OFFICINA,
                        "description_rows": ["Cambio batteria", "Controllo alternatore"],
                        "man_hours": 1.0,
                        "mac_hours": 0.3,
                        "materials_amount": 80.0
                    },
                    {
                        "context": Context.CARROZZERIA,
                        "description_rows": ["Toccatura portiera sinistra"],
                        "man_hours": 1.5,
                        "mac_hours": 0.5,
                        "materials_amount": 40.0
                    }
                ]
            },
            {
                "plate": "TEST05EE",
                "customer": "Anna Neri",
                "phone": "3331112223",
                "customer_type": CustomerType.PRIVATO,
                "practice_type": PracticeType.ORDINE_DI_LAVORO,
                "contexts": [Context.OFFICINA],
                "time": "16:00",
                "sections": [
                    {
                        "context": Context.OFFICINA,
                        "description_rows": ["Sostituzione filtri aria e abitacolo", "Controllo climatizzatore"],
                        "man_hours": 0.8,
                        "mac_hours": 0.2,
                        "materials_amount": 25.0
                    }
                ]
            },
            {
                "plate": "TEST06FF",
                "customer": "Marco Gialli",
                "phone": "3334445556",
                "customer_type": CustomerType.PRIVATO,
                "practice_type": PracticeType.PREVENTIVO,
                "contexts": [Context.CARROZZERIA],
                "time": "17:00",
                "sections": [
                    {
                        "context": Context.CARROZZERIA,
                        "description_rows": ["Riparazione cofano", "Lucidatura completa"],
                        "man_hours": 4.0,
                        "mac_hours": 1.5,
                        "materials_amount": 200.0
                    }
                ]
            }
        ]
        
        created_count = 0
        for i, practice_data in enumerate(test_practices, 1):
            # Crea pratica
            practice = Practice(
                created_by_telegram_id=telegram_user_id,
                status=PracticeStatus.CONFIRMED,
                plate_detected=practice_data["plate"],
                plate_confirmed=practice_data["plate"],
                phone=practice_data["phone"],
                customer_name=practice_data["customer"],
                customer_type=practice_data["customer_type"],
                appointment_date=base_date,
                appointment_time=practice_data["time"],
                practice_type=practice_data["practice_type"],
                contexts_list=practice_data["contexts"],
                synced=False
            )
            
            db.add(practice)
            db.flush()  # Per ottenere l'ID
            
            # Crea sezioni
            for section_data in practice_data["sections"]:
                section = PracticeSection(
                    practice_id=practice.id,
                    context=section_data["context"],
                    description_rows=json.dumps(section_data["description_rows"]),
                    man_hours=section_data.get("man_hours"),
                    mac_hours=section_data.get("mac_hours"),
                    materials_amount=section_data.get("materials_amount"),
                    waste_apply=False,
                    waste_percentage=2.0
                )
                db.add(section)
            
            created_count += 1
            print(f"✓ Creata pratica {i}: {practice_data['plate']} - {practice_data['customer']} ({practice_data['time']})")
        
        db.commit()
        print(f"\n✅ Creato {created_count} pratiche di test con successo!")
        print(f"📅 Data: {base_date.strftime('%d/%m/%Y')}")
        print(f"👤 Telegram User ID: {telegram_user_id}")
        
    except Exception as e:
        db.rollback()
        print(f"❌ Errore durante la creazione delle pratiche: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    print("🌱 Seeding pratiche di test per YAP...\n")
    seed_test_practices()
