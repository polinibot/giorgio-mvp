@echo off
cd /d "%~dp0"
if "%YAP_USERNAME%"=="" (
  echo Imposta YAP_USERNAME prima di lanciare il test.
  exit /b 1
)
if "%YAP_PASSWORD%"=="" (
  echo Imposta YAP_PASSWORD prima di lanciare il test.
  exit /b 1
)
echo Avvio test commit YAP...
node automation/yap/yap-worker.mjs --payload-file automation/yap/test-commit-payload.json --commit --debug > automation\yap\test-output.log 2>&1
echo Exit code: %ERRORLEVEL% >> automation\yap\test-output.log
echo Done. Vedi automation\yap\test-output.log
pause
