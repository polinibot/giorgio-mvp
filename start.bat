@echo off
echo 🚀 Avvio Giorgio MVP Telegram...

REM Controlla se Docker è in esecuzione
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Docker non è in esecuzione. Avvia Docker Desktop prima di continuare.
    pause
    exit /b 1
)

REM Avvia PostgreSQL
echo 📦 Avvio PostgreSQL...
docker-compose up -d postgres

REM Attendi che PostgreSQL sia pronto
echo ⏳ Attesa avvio PostgreSQL...
timeout /t 10 /nobreak >nul

REM Controlla se il virtual environment esiste
if not exist "backend\venv" (
    echo 🐍 Creazione virtual environment Python...
    cd backend
    python -m venv venv
    call venv\Scripts\activate
    pip install -r requirements.txt
    cd ..
)

REM Avvia backend in background
echo 🔧 Avvio backend FastAPI...
cd backend
call venv\Scripts\activate
start /B cmd /c "uvicorn main:app --host 0.0.0.0 --port 8000"
cd ..

REM Attendi avvio backend
echo ⏳ Attesa avvio backend...
timeout /t 5 /nobreak >nul

REM Controlla se node_modules esiste
if not exist "mini-app\node_modules" (
    echo 📦 Installazione dipendenze Mini App...
    cd mini-app
    npm install
    cd ..
)

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
echo ✅ Giorgio MVP avviato!
echo.
echo 📊 Servizi attivi:
echo    • PostgreSQL: localhost:5432
echo    • Backend API: http://localhost:8000
echo    • Mini App: http://localhost:3000
echo    • Bot Telegram: in esecuzione
echo.
echo 🛑 Per fermare i servizi:
echo    • Chiudi le finestre dei terminali aperti
echo    • docker-compose down
echo.
echo 📝 Controllare i log nelle rispettive finestre
echo.

pause
