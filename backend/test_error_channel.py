#!/usr/bin/env python3
"""
Script per testare rapidamente la configurazione del canale errori.

Uso:
    python test_error_channel.py [messaggio_personalizzato]

Invia un messaggio di test al canale errori configurato.
"""

__test__ = False

import os
import sys
import asyncio
import argparse
from pathlib import Path

# Aggiungi il parent directory al path
sys.path.insert(0, str(Path(__file__).parent))

from error_notifier import get_error_notifier
from config import settings, ERROR_CHANNEL_ID


def load_env_file():
    """Carica le variabili dal .env."""
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    if key not in os.environ:
                        os.environ[key] = value


async def test_basic_message():
    """Test messaggio base."""
    print("🧪 Test 1: Messaggio base...")
    
    notifier = get_error_notifier()
    result = await notifier.notify_error(
        error_message="Questo è un messaggio di test dal sistema Giorgio",
        context={
            "practice_id": 999,
            "worker": "test-script",
        }
    )
    
    if result:
        print("   ✅ Messaggio base inviato con successo")
    else:
        print("   ❌ Fallito invio messaggio base")
    
    return result


async def test_full_notification():
    """Test notifica completa con contesto."""
    print("🧪 Test 2: Notifica completa...")
    
    notifier = get_error_notifier()
    result = await notifier.notify_error(
        error_message="Errore durante la sincronizzazione con YAP",
        stack_trace="""Traceback (most recent call last):
  File "yap-worker.mjs", line 456, in fillAppointmentPopup
    await page.click(saveButton)
TimeoutError: Element not found after 30s""",
        context={
            "practice_id": 123,
            "customer": {"name": "Mario Rossi", "plate": "AB123CD"},
            "appointment": {"date": "2026-05-30", "time": "14:30"},
            "worker": "yap-worker.mjs",
        }
    )
    
    if result:
        print("   ✅ Notifica completa inviata con successo")
    else:
        print("   ❌ Fallito invio notifica completa")
    
    return result


async def main():
    """Main function."""
    parser = argparse.ArgumentParser(
        description="Testa la configurazione del canale errori Telegram"
    )
    parser.add_argument(
        "--custom",
        type=str,
        help="Messaggio personalizzato da inviare",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Solo verifica configurazione, non inviare messaggi",
    )
    args = parser.parse_args()
    
    # Carica .env
    load_env_file()
    
    print("=" * 60)
    print("  Test Canale Errori Telegram - Giorgio")
    print("=" * 60)
    print()
    
    # Verifica configurazione
    print("📋 Verifica configurazione:")
    print(f"   Bot token: {'✅ Configurato' if settings.telegram_bot_token else '❌ Mancante'}")
    print(f"   Channel ID: {ERROR_CHANNEL_ID or '❌ Non configurato'}")
    print()
    
    if not settings.telegram_bot_token:
        print("❌ ERRORE: TELEGRAM_BOT_TOKEN non configurato!")
        print("   Esegui prima: python setup_error_channel.py")
        return 1
    
    if not ERROR_CHANNEL_ID:
        print("⚠️  AVVISO: TELEGRAM_ERROR_CHANNEL_ID non configurato")
        print("   Esegui: python setup_error_channel.py")
        return 1
    
    if args.check_only:
        print("✅ Configurazione presente")
        return 0
    
    # Invia messaggi di test
    print("🚀 Invio messaggi di test...\n")
    
    if args.custom:
        # Messaggio personalizzato
        print(f"📝 Messaggio personalizzato: {args.custom}")
        notifier = get_error_notifier()
        result = await notifier.notify_error(
            error_message=args.custom,
            context={"worker": "test-manual"}
        )
        print(f"   {'✅ Inviato' if result else '❌ Fallito'}")
    else:
        # Test automatici
        results = []
        results.append(await test_basic_message())
        print()
        results.append(await test_full_notification())
        
        print()
        if all(results):
            print("🎉 Tutti i test sono passati!")
            print("   Il canale errori è configurato correttamente.")
        else:
            print("⚠️  Alcuni test sono falliti.")
            print("   Verifica che il bot sia amministratore del canale.")
    
    print()
    print("💡 Suggerimento:")
    print("   Per ricevere errori reali, assicurati che:")
    print("   1. Il backend sia avviato (python main.py)")
    print("   2. API_BASE_URL sia configurato nei worker YAP")
    print("   3. I worker possano raggiungere il backend")
    
    return 0


if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\nInterrotto.")
        sys.exit(1)
