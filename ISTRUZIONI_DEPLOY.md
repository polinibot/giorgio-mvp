# 🚀 Istruzioni Deploy Completo - Giorgio MVP

Hai già fatto 90% del lavoro! Ora ti guido per finire.

## ✅ Stato Attuale
- [x] Email: polini.bot@gmail.com
- [x] Cloudinary: configurato
- [x] GitHub: polinibot creato
- [x] Vercel: connesso a GitHub
- [x] Railway: connesso a GitHub
- [ ] Repository GitHub: da creare
- [ ] Deploy Mini App: da fare
- [ ] Deploy Backend: da fare

---

## 📋 Step 1: Crea Repository GitHub (2 minuti)

1. Vai su https://github.com
2. Login con `polinibot`
3. Clicca "New repository"
4. **Repository name**: `giorgio-mvp`
5. **Description**: `Bot Telegram per pratiche meccanico`
6. **Public**: ✅ (per deploy automatico)
7. **Add README**: ✅
8. **Create repository**

---

## 📋 Step 2: Push Codice su GitHub (5 minuti)

### Metodo A: GitHub Desktop (Più facile)
1. Scarica GitHub Desktop
2. Clone il repository `giorgio-mvp`
3. Copia tutti i file dalla cartella `C:\Users\Anas\giorgio`
4. Incolla nella cartella del repository
5. Commit: "Initial commit - Giorgio MVP"
6. Push

### Metodo B: Git CLI (Se sai usare Git)
```bash
# Nella cartella C:\Users\Anas\giorgio
git init
git add .
git commit -m "Initial commit - Giorgio MVP"
git remote add origin https://github.com/polinibot/giorgio-mvp.git
git push -u origin main
```

---

## 📋 Step 3: Deploy Mini App su Vercel (2 minuti)

1. Vai su https://vercel.com
2. Login con GitHub `polinibot`
3. "Add New..." → "Project"
4. Seleziona `giorgio-mvp`
5. **Root Directory**: `mini-app`
6. "Deploy"

**URL Mini App**: `https://giorgio-mvp.vercel.app` (o simile)

---

## 📋 Step 4: Deploy Backend su Railway (3 minuti)

1. Vai su https://railway.app
2. Login con GitHub `polinibot`
3. "New Project" → "Deploy from GitHub"
4. Seleziona `giorgio-mvp`
5. Aspetta deployment (2-3 minuti)

### Aggiungi Variabili Ambiente su Railway:
1. Vai sul progetto Railway
2. Settings → Variables
3. Aggiungi queste variabili:

```
TELEGRAM_BOT_TOKEN=8508131785:AAEjUwy-qIlcCZVMc4wVWYHGK3XXHuROOjM
WHITELIST_TELEGRAM_IDS=[761118078]
OCR_CONFIDENCE_THRESHOLD=0.6
SECRET_KEY=polini_bot_secret_key_2024_secure_change_in_production
CLOUDINARY_CLOUD_NAME=ddkgev5ui
CLOUDINARY_API_KEY=861438236345898
CLOUDINARY_API_SECRET=YyekpPln63QnAU6rBFfXTCRZDi0
```

4. Aggiungi PostgreSQL service
5. Copia la `DATABASE_URL` dal PostgreSQL
6. Aggiungila alle Variables

7. "Redeploy"

**URL Backend**: `https://giorgio-mvp-production.up.railway.app` (o simile)

---

## 📋 Step 5: Configura BotFather (1 minuto)

1. Vai su @BotFather in Telegram
2. `/mybots` → `Polini_OfficinaBot`
3. `Bot Settings` → `Menu Button`
4. `Open Mini App`
5. Inserisci URL Mini App: `https://giorgio-mvp.vercel.app`

---

## 📋 Step 6: Test Finale (2 minuti)

1. **Test API**: Visita URL backend → dovresti vedere `{"status": "ok"}`
2. **Test Mini App**: Visita URL Mini App → dovresti vedere l'interfaccia
3. **Test Bot**: Apri @Polini_OfficinaBot → `/start` → "Nuova pratica"

---

## 🎉 RISULTATO FINALE

### URLs Produzione:
- **Mini App**: https://giorgio-mvp.vercel.app
- **Backend**: https://giorgio-mvp-production.up.railway.app
- **Bot**: @Polini_OfficinaBot

### Costi:
- **Railway**: $5/mese (già configurato con tua carta)
- **Vercel**: $0/mese
- **Cloudinary**: $0/mese
- **TOTALE**: $5/mese

---

## 🔧 Se Qualcosa Non Va

### Bot non risponde:
- Controlla logs Railway (vedrai errori)
- Verifica variabili ambiente
- Controlla Bot Token

### Mini App non si apre:
- Verifica deploy Vercel
- Controlla console browser (F12)

### API non funziona:
- Controlla logs Railway
- Verifica DATABASE_URL
- Redeploy su Railway

---

## 📞 Hai Bisogno di Aiuto?

Se hai problemi durante qualsiasi step:
1. Controlla i logs delle piattaforme
2. Verifica di aver copiato esattamente le variabili
3. Fai uno screenshot dell'errore

**Il sistema è pronto per essere usato dopo circa 15 minuti di lavoro!**
