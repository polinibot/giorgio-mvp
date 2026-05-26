@echo off
REM Retry read-only quando YAP risponde (nessuna scrittura)
if "%YAP_USERNAME%"=="" (
  echo Imposta YAP_USERNAME e YAP_PASSWORD
  exit /b 1
)
echo Scan 16/03...
node "%~dp0yap-readonly-day-scan.mjs" --date 2026-03-16
echo Popup officina 2025-04-04...
node "%~dp0yap-agenda-inspector.mjs" --date 2025-04-04 --search DP126GZ
echo Patch evidenze...
node "%~dp0patch-open-items.mjs"
pause
