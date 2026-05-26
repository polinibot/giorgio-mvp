@echo off
chcp 65001 >nul
title Configurazione Canale Errori Telegram - Giorgio

echo.
echo ============================================================
echo   Configurazione Automatica Canale Errori Telegram
echo ============================================================
echo.

:: Verifica Python
echo [*] Verifica Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo [X] Python non trovato!
    echo Installa Python da https://python.org
    pause
    exit /b 1
)
echo [OK] Python trovato

:: Imposta PYTHONPATH
set "PYTHONPATH=C:\Users\Anas\giorgio\backend"
set "CURRENT_DIR=%CD%"

:: Vai nella directory backend
cd /d "C:\Users\Anas\giorgio\backend" 2>nul
if errorlevel 1 (
    echo [X] Directory backend non trovata!
    echo Assicurati di essere in: C:\Users\Anas\giorgio
    pause
    exit /b 1
)

echo.
echo [*] Avvio configurazione interattiva...
echo.
echo Segui le istruzioni a schermo per:
echo   1. Creare il canale Telegram
echo   2. Aggiungere il bot come amministratore
echo   3. Configurare il .env automaticamente
echo.
pause

echo.
python setup_error_channel.py
if errorlevel 1 (
    echo.
    echo [X] Configurazione fallita
    echo Controlla gli errori sopra
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   Configurazione completata!
echo ============================================================
echo.
echo Vuoi inviare un messaggio di test? (S/N)
set /p test_choice=
if /I "%test_choice%"=="S" (
    echo.
    echo [*] Invio messaggio di test...
    python test_error_channel.py
)

echo.
echo [OK] Setup completato!
echo.
echo Comandi utili:
echo   - Test configurazione:   test_error_channel.py --check-only
echo   - Messaggio personalizzato: test_error_channel.py --custom "test"
echo   - Verifica stato:        http://127.0.0.1:8000/yap/error-channel-status
echo.

:: Torna alla directory originale
cd /d "%CURRENT_DIR%"

pause
