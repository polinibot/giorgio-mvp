@echo off
chcp 65001 >nul
title Configurazione Canale Errori Telegram - Giorgio

:: Colori
set "GREEN=[92m"
set "YELLOW=[93m"
set "RESET=[0m"

echo.
echo %GREEN%============================================================%RESET%
echo   Configurazione Automatica Canale Errori Telegram
echo %GREEN%============================================================%RESET%
echo.

:: Verifica Python
echo %YELLOW%[*] Verifica Python...%RESET%
python --version >nul 2>&1
if errorlevel 1 (
    echo %RED%[X] Python non trovato!%RESET%
    echo Installa Python da https://python.org
    pause
    exit /b 1
)
echo %GREEN%[✓] Python trovato%RESET%

:: Imposta PYTHONPATH
set "PYTHONPATH=C:\Users\Anas\giorgio\backend"
set "CURRENT_DIR=%CD%"

:: Vai nella directory backend
cd /d "C:\Users\Anas\giorgio\backend" 2>nul
if errorlevel 1 (
    echo %RED%[X] Directory backend non trovata!%RESET%
    echo Assicurati di essere in: C:\Users\Anas\giorgio
    pause
    exit /b 1
)

echo.
echo %GREEN%[*] Avvio configurazione interattiva...%RESET%
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
    echo %RED%[X] Configurazione fallita%RESET%
    echo Controlla gli errori sopra
    pause
    exit /b 1
)

echo.
echo %GREEN%============================================================%RESET%
echo   Configurazione completata!
echo %GREEN%============================================================%RESET%
echo.
echo Vuoi inviare un messaggio di test? (S/N)
set /p test_choice=
if /I "%test_choice%"=="S" (
    echo.
    echo %YELLOW%[*] Invio messaggio di test...%RESET%
    python test_error_channel.py
)

echo.
echo %GREEN%[✓] Setup completato!%RESET%
echo.
echo Comandi utili:
echo   - Test configurazione:   test_error_channel.py --check-only
echo   - Messaggio personalizzato: test_error_channel.py --custom "test"
echo   - Verifica stato:        GET /yap/error-channel-status
echo.

:: Torna alla directory originale
cd /d "%CURRENT_DIR%"

pause
