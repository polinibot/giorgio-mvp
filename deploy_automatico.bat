@echo off
echo 🚀 Deploy Automatico Giorgio MVP
echo.

REM Controlla se Git è installato
git --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Git non installato. Installalo da https://git-scm.com
    pause
    exit /b 1
)

echo 📋 Step 1: Inizializzazione Git Repository...
cd /d "C:\Users\Anas\giorgio"

if not exist ".git" (
    git init
    git add .
    git commit -m "Initial commit - Giorgio MVP"
    echo ✅ Repository locale creato
) else (
    echo ✅ Repository Git già esistente
)

echo.
echo 📋 Step 2: Connessione a GitHub...
echo.
echo ⚠️  ATTENZIONE: Devi fare questi passaggi manualmente:
echo.
echo 1. Vai su https://github.com/polinibot
echo 2. Crea nuovo repository: "giorgio-mvp"
echo 3. Copia l'URL del repository (es: https://github.com/polinibot/giorgio-mvp.git)
echo 4. Incollalo qui sotto e premi Invio:
echo.

set /p github_url="URL Repository GitHub: "

if "%github_url%"=="" (
    echo ❌ URL non valido
    pause
    exit /b 1
)

echo.
echo 📋 Step 3: Push su GitHub...
git remote add origin %github_url% 2>nul
git branch -M main
git push -u origin main

if errorlevel 1 (
    echo ❌ Errore push. Controlla credenziali GitHub.
    pause
    exit /b 1
)

echo ✅ Push completato!
echo.
echo 📋 Step 4: Istruzioni per Deploy...
echo.
echo 🌐 Vercel (Mini App):
echo    1. Vai su https://vercel.com
echo    2. Login con GitHub: polinibot
echo    3. New Project → giorgio-mvp
echo    4. Root Directory: mini-app
echo    5. Deploy
echo.
echo 🚂 Railway (Backend):
echo    1. Vai su https://railway.app
echo    2. Login con GitHub: polinibot
echo    3. New Project → giorgio-mvp
echo    4. Aggiungi PostgreSQL
echo    5. Aggiungi queste variabili:
echo       TELEGRAM_BOT_TOKEN=8508131785:AAEjUwy-qIlcCZVMc4wVWYHGK3XXHuROOjM
echo       WHITELIST_TELEGRAM_IDS=[761118078]
echo       SECRET_KEY=polini_bot_secret_key_2024_secure_change_in_production
echo       CLOUDINARY_CLOUD_NAME=ddkgev5ui
echo       CLOUDINARY_API_KEY=861438236345898
echo       CLOUDINARY_API_SECRET=YyekpPln63QnAU6rBFfXTCRZDi0
echo       DATABASE_URL=[copia da Railway PostgreSQL]
echo    6. Redeploy
echo.
echo 🤖 BotFather:
echo    1. /mybots → Polini_OfficinaBot
echo    2. Bot Settings → Menu Button
echo    3. Open Mini App → https://giorgio-mvp.vercel.app
echo.
echo ✅ Sistema pronto in 10 minuti!
echo.

pause
