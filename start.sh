#!/bin/bash

# Script di avvio per Giorgio MVP
echo "🚀 Avvio Giorgio MVP Telegram..."

# Controlla se Docker è in esecuzione
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker non è in esecuzione. Avvia Docker prima di continuare."
    exit 1
fi

# Avvia PostgreSQL
echo "📦 Avvio PostgreSQL..."
docker-compose up -d postgres

# Attendi che PostgreSQL sia pronto
echo "⏳ Attesa avvio PostgreSQL..."
sleep 10

# Controlla se il virtual environment esiste
if [ ! -d "backend/venv" ]; then
    echo "🐍 Creazione virtual environment Python..."
    cd backend
    python -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt
    cd ..
fi

# Avvia backend in background
echo "🔧 Avvio backend FastAPI..."
cd backend
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
cd ..

# Attendi avvio backend
echo "⏳ Attesa avvio backend..."
sleep 5

# Controlla se node_modules esiste
if [ ! -d "mini-app/node_modules" ]; then
    echo "📦 Installazione dipendenze Mini App..."
    cd mini-app
    npm install
    cd ..
fi

# Avvia Mini App in background
echo "📱 Avvio Mini App React..."
cd mini-app
npm run dev &
MINIAPP_PID=$!
cd ..

# Avvia bot Telegram in background
echo "🤖 Avvio bot Telegram..."
cd backend
source venv/bin/activate
python bot.py &
BOT_PID=$!
cd ..

echo ""
echo "✅ Giorgio MVP avviato!"
echo ""
echo "📊 Servizi attivi:"
echo "   • PostgreSQL: localhost:5432"
echo "   • Backend API: http://localhost:8000"
echo "   • Mini App: http://localhost:3000"
echo "   • Bot Telegram: in esecuzione"
echo ""
echo "🛑 Per fermare tutti i servizi:"
echo "   kill $BACKEND_PID $MINIAPP_PID $BOT_PID"
echo "   docker-compose down"
echo ""
echo "📝 Logs:"
echo "   • Backend: tail -f backend/logs/app.log"
echo "   • Mini App: visibile nel terminale"
echo "   • Bot: visibile nel terminale"
echo ""

# Mantieni lo script in esecuzione
wait
