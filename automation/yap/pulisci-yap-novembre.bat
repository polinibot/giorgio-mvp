@echo off
echo ==========================================
echo   PULIZIA YAP NOVEMBRE 2026
echo ==========================================
echo.
echo Questo script elimina TUTTI gli appuntamenti
echo di test di novembre 2026 da YAP.
echo.
echo Pattern: TEST AUTOMAZIONE, ZZ555ZZ, TEST GIORGIO
echo.

if "%1"=="--confirm" goto ELIMINA
echo MODALITA DRY-RUN (simulazione)
echo Per eliminare davvero: pulisci-yap-novembre.bat --confirm
echo.
pause
goto DRYRUN

:ELIMINA
echo MODALITA ELIMINAZIONE REALE
echo.
pause

for %%d in (01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30) do (
  echo [DATA] 2026-11-%%d
  node "%~dp0yap-delete-appointment.mjs" --date 2026-11-%%d --search "TEST AUTOMAZIONE"
  node "%~dp0yap-delete-appointment.mjs" --date 2026-11-%%d --search "ZZ555ZZ"
  node "%~dp0yap-delete-appointment.mjs" --date 2026-11-%%d --search "TEST GIORGIO"
)

echo.
echo ==========================================
echo PULIZIA COMPLETATA
echo ==========================================
pause
goto FINE

:DRYRUN
echo Simulazione - comandi che verrebbero eseguiti:
echo.
for %%d in (01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30) do (
  echo [DATA] 2026-11-%%d
  echo yap-delete-appointment.mjs --date 2026-11-%%d --search TEST AUTOMAZIONE --dry-run
  echo yap-delete-appointment.mjs --date 2026-11-%%d --search ZZ555ZZ --dry-run
  echo yap-delete-appointment.mjs --date 2026-11-%%d --search TEST GIORGIO --dry-run
)
echo.
echo Per eliminare davvero:
echo pulisci-yap-novembre.bat --confirm
echo ==========================================
pause

:FINE
