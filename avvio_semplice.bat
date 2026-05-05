@echo off
echo 🚀 Avvio Giorgio MVP - Modalità Semplice
echo.

REM Uccidi processi precedenti sulla porta 8000
echo 🧹 Pulizia porte precedenti...
for /f "tokens=5" %%a in ('netstat -aon ^| find ":8000"') do taskkill /f /pid %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon ^| find ":3000"') do taskkill /f /pid %%a 2>nul

REM Avvia backend
echo 🔧 Avvio Backend API (porta 8000)...
cd backend
call venv\Scripts\activate
start "Backend API" cmd /k "uvicorn main:app --host 0.0.0.0 --port 8000 --reload"
cd ..

REM Attendi 3 secondi
timeout /t 3 /nobreak >nul

REM Avvia Mini App
echo 📱 Avvio Mini App (porta 3000)...
cd mini-app
start "Mini App" cmd /k "npm run dev"
cd ..

REM Attendi 3 secondi
timeout /t 3 /nobreak >nul

REM Avvia Bot
echo 🤖 Avvio Bot Telegram...
cd backend
call venv\Scripts\activate
start "Bot Telegram" cmd /k "python bot.py"
cd ..

echo.
echo ✅ Tutti i servizi avviati!
echo.
echo 📊 Servizi disponibili:
echo    • Backend API: http://localhost:8000
echo    • Mini App: http://localhost:3000
echo    • Bot Telegram: @Polini_OfficinaBot
echo.
echo 💡 Per testare il bot:
echo    1. Apri Telegram
echo    2. Cerca @Polini_OfficinaBot
echo    3. Invia /start
echo.
echo 🛑 Per fermare: chiudi le 3 finestre terminali aperte
echo.

pause
