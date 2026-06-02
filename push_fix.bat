@echo off
cd /d "%~dp0"
del /f /q ".git\HEAD.lock" 2>nul
del /f /q ".git\index.lock" 2>nul
del /f /q ".git\objects\maintenance.lock" 2>nul
git add Dockerfile automation/yap/yap-audit-appointment.mjs mini-app/src/App.js automation/yap/yap-worker.mjs
git commit -m "fix: Playwright Chromium bundled in Docker + audit scroll a orario atteso (fix 17:00 non trovato)"
git push
pause
