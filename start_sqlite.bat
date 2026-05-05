@echo off
echo 🚀 Avvio Giorgio MVP con SQLite (niente Docker)...

REM Verifica se esiste il virtual environment
if not exist "backend\venv" (
    echo 🐍 Creazione virtual environment Python...
    cd backend
    python -m venv venv
    call venv\Scripts\activate
    pip install -r requirements.txt
    echo.
    echo 📦 Creazione database SQLite...
    python database_sqlite.py
    cd ..
)

REM Controlla se node_modules esiste
if not exist "mini-app\node_modules" (
    echo 📦 Installazione dipendenze Mini App...
    cd mini-app
    npm install
    cd ..
)

REM Avvia backend in background
echo 🔧 Avvio backend FastAPI con SQLite...
cd backend
call venv\Scripts\activate
start /B cmd /c "uvicorn main:app --host 0.0.0.0 --port 8000 --reload"
cd ..

REM Attendi avvio backend
echo ⏳ Attesa avvio backend...
timeout /t 5 /nobreak >nul

REM Avvia Mini App
echo 📱 Avvio Mini App React...
cd mini-app
start /B cmd /c "npm run dev"
cd ..

REM Avvia bot Telegram
echo 🤖 Avvio bot Telegram...
cd backend
call venv\Scripts\activate
start /B cmd /c "python bot.py"
cd ..

echo.
echo ✅ Giorgio MVP avviato con SQLite!
echo.
echo 📊 Servizi attivi:
echo    • Database: SQLite (file giorgio.db)
echo    • Backend API: http://localhost:8000
echo    • Mini App: http://localhost:3000
echo    • Bot Telegram: in esecuzione
echo.
echo 🛑 Per fermare i servizi:
echo    • Chiudi le finestre dei terminali aperte
echo.
echo 📝 Controllare i log nelle rispettive finestre
echo.

pause
