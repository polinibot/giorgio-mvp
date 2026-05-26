@echo off
REM Read-only RPC interceptor per il popup officina (DP126GZ - 04/04/2025).
REM Richiede YAP_USERNAME e YAP_PASSWORD nell'ambiente.
if "%YAP_USERNAME%"=="" (
  echo Imposta YAP_USERNAME e YAP_PASSWORD prima di lanciare lo script.
  exit /b 1
)
node "%~dp0yap-rpc-interceptor.mjs" --date 2025-04-04 --search DP126GZ --label officina-kit-frizione %*
pause
