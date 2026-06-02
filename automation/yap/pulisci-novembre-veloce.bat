@echo off
echo ==========================================
echo PULIZIA BATCH YAP NOVEMBRE (VELOCE)
echo ==========================================
echo.
echo Una sola sessione, tutte le date.
echo.
echo MODALITA DRY-RUN (simulazione):
echo   pulisci-novembre-veloce.bat
echo.
echo ELIMINAZIONE REALE:
echo   pulisci-novembre-veloce.bat --confirm
echo.
echo ==========================================
echo.

cd /d "%~dp0"

if "%1"=="--confirm" (
  echo [ELIMINAZIONE REALE]
  echo.
  node pulisci-batch-novembre.mjs
) else (
  echo [DRY-RUN]
  echo.
  node pulisci-batch-novembre.mjs --dry-run
)

echo.
echo ==========================================
pause
