@echo off
REM Dry-run sicuro: login + navigazione + screenshot, nessun salvataggio YAP
if "%YAP_USERNAME%"=="" (
  echo Imposta YAP_USERNAME e YAP_PASSWORD
  exit /b 1
)
node "%~dp0yap-worker.mjs" --payload-file "%~dp0sample-payload.json" %*
