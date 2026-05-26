#!/usr/bin/env python3
"""
Trova automaticamente l'ID del canale Telegram.

Il bot deve essere amministratore del canale.
Lo script proverà diversi metodi per trovare l'ID corretto.
"""

import os
import sys
import asyncio
import aiohttp
from pathlib import Path

# Carica .env
env_path = Path(__file__).parent / '.env'
if env_path.exists():
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                if key not in os.environ:
                    os.environ[key] = value

BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN')
if not BOT_TOKEN:
    print("❌ TELEGRAM_BOT_TOKEN non trovato nel .env")
    sys.exit(1)

BASE_URL = f"https://api.telegram.org/bot{BOT_TOKEN}"


async def try_get_chat(channel_id: str) -> bool:
    """Prova a ottenere info su un canale."""
    url = f"{BASE_URL}/getChat"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json={'chat_id': channel_id}) as response:
                data = await response.json()
                if data.get('ok'):
                    chat_info = data['result']
                    print(f"\n✅ Trovato! ID corretto: {channel_id}")
                    print(f"   Nome: {chat_info.get('title')}")
                    print(f"   Tipo: {chat_info.get('type')}")
                    if 'username' in chat_info:
                        print(f"   Username: @{chat_info['username']}")
                    return True
                return False
    except Exception as e:
        return False


async def find_channel_by_testing_ids():
    """Prova diverse varianti dell'ID."""
    # Leggi l'ID che l'utente ha trovato (dall'URL web.telegram.org)
    print("\n📋 Provo a trovare l'ID corretto...")
    print("Inserisci l'ID che hai trovato nell'URL di Telegram Web")
    print("(esempio: se l'URL è https://web.telegram.org/k/#-3897451745)")
    print("(inserisci: -3897451745)")
    
    web_id = input("\nID dal browser: ").strip()
    
    if not web_id:
        print("❌ ID richiesto")
        return None
    
    # Pulisci l'ID
    web_id = web_id.replace('#', '').strip()
    
    # Prova diverse varianti
    variants = []
    
    # Se inizia con -, prova con e senza -100
    if web_id.startswith('-'):
        num_part = web_id[1:]  # Rimuovi il -
        variants.extend([
            web_id,                    # -3897451745
            f"-100{num_part}",         # -1003897451745 (formato API standard)
            num_part,                  # 3897451745 (senza -)
        ])
    else:
        # Senza -
        variants.extend([
            web_id,                    # 3897451745
            f"-{web_id}",              # -3897451745
            f"-100{web_id}",           # -1003897451745
        ])
    
    print(f"\n🔍 Provo {len(variants)} varianti dell'ID...")
    
    for variant in variants:
        print(f"   Provo: {variant}...", end=' ')
        if await try_get_chat(variant):
            return variant
        print("❌")
    
    return None


async def find_via_get_updates():
    """Cerca nei recenti aggiornamenti del bot."""
    url = f"{BASE_URL}/getUpdates?limit=100"
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as response:
                data = await response.json()
                
                if not data.get('ok') or not data.get('result'):
                    return None
                
                updates = data['result']
                channels_found = []
                
                for update in updates:
                    # Cerca my_chat_member (quando bot viene aggiunto/rimosso)
                    if 'my_chat_member' in update:
                        chat = update['my_chat_member']['chat']
                        if chat.get('type') in ['channel', 'supergroup']:
                            channels_found.append({
                                'id': str(chat['id']),
                                'title': chat.get('title', 'Unknown'),
                                'type': chat.get('type')
                            })
                    
                    # Cerca messaggi in canali
                    if 'message' in update and 'chat' in update['message']:
                        chat = update['message']['chat']
                        if chat.get('type') in ['channel', 'supergroup']:
                            channels_found.append({
                                'id': str(chat['id']),
                                'title': chat.get('title', 'Unknown'),
                                'type': chat.get('type')
                            })
                
                # Rimuovi duplicati
                seen = set()
                unique_channels = []
                for ch in channels_found:
                    if ch['id'] not in seen:
                        seen.add(ch['id'])
                        unique_channels.append(ch)
                
                return unique_channels
                
    except Exception as e:
        print(f"Errore: {e}")
        return None


async def main():
    print("=" * 60)
    print("  Trova ID Canale Telegram")
    print("=" * 60)
    print()
    
    # Metodo 1: Prova varianti dell'ID
    print("🔧 Metodo 1: Test varianti ID")
    correct_id = await find_channel_by_testing_ids()
    
    if correct_id:
        print(f"\n🎉 ID corretto trovato: {correct_id}")
        
        # Salva nel .env
        save = input("\nVuoi salvare questo ID nel .env? (s/n): ").strip().lower()
        if save in ['s', 'si', 'y', 'yes']:
            env_content = env_path.read_text(encoding='utf-8')
            
            # Rimpiazza o aggiungi TELEGRAM_ERROR_CHANNEL_ID
            if 'TELEGRAM_ERROR_CHANNEL_ID=' in env_content:
                lines = env_content.split('\n')
                new_lines = []
                for line in lines:
                    if line.startswith('TELEGRAM_ERROR_CHANNEL_ID='):
                        new_lines.append(f'TELEGRAM_ERROR_CHANNEL_ID={correct_id}')
                    else:
                        new_lines.append(line)
                env_content = '\n'.join(new_lines)
            else:
                env_content += f'\nTELEGRAM_ERROR_CHANNEL_ID={correct_id}\n'
            
            env_path.write_text(env_content, encoding='utf-8')
            print(f"✅ Salvato in {env_path}")
        
        return 0
    
    # Metodo 2: Cerca nei getUpdates
    print("\n🔧 Metodo 2: Cerca nei recenti aggiornamenti...")
    channels = await find_via_get_updates()
    
    if channels:
        print(f"\n📋 Trovati {len(channels)} canali recenti:")
        for i, ch in enumerate(channels, 1):
            print(f"   {i}. {ch['title']} (ID: {ch['id']})")
        
        choice = input("\nQuale canale vuoi usare? (numero o 'n' per nessuno): ").strip()
        
        if choice.isdigit() and 1 <= int(choice) <= len(channels):
            selected = channels[int(choice) - 1]
            correct_id = selected['id']
            
            save = input(f"\nVuoi salvare ID {correct_id} nel .env? (s/n): ").strip().lower()
            if save in ['s', 'si', 'y', 'yes']:
                env_content = env_path.read_text(encoding='utf-8')
                
                if 'TELEGRAM_ERROR_CHANNEL_ID=' in env_content:
                    lines = env_content.split('\n')
                    new_lines = []
                    for line in lines:
                        if line.startswith('TELEGRAM_ERROR_CHANNEL_ID='):
                            new_lines.append(f'TELEGRAM_ERROR_CHANNEL_ID={correct_id}')
                        else:
                            new_lines.append(line)
                    env_content = '\n'.join(new_lines)
                else:
                    env_content += f'\nTELEGRAM_ERROR_CHANNEL_ID={correct_id}\n'
                
                env_path.write_text(env_content, encoding='utf-8')
                print(f"✅ Salvato in {env_path}")
            
            return 0
    
    print("\n❌ Nessun canale trovato automaticamente.")
    print("\n🔧 Soluzione manuale:")
    print("   1. Rimuovi il bot @Polini_OfficinaBot dal canale")
    print("   2. Riaggiungilo immediatamente come amministratore")
    print("   3. Esegui subito questo script di nuovo")
    print("\n   Questo genererà un evento che permette di trovare l'ID.")
    
    return 1


if __name__ == "__main__":
    try:
        exit_code = asyncio.run(main())
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\nInterrotto.")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Errore: {e}")
        sys.exit(1)
