@echo off
REM Anteprima mapping v2 su tutti i sample (nessun browser YAP)
node "%~dp0audit-agenda-v1.mjs"
if errorlevel 1 exit /b 1
node "%~dp0run-mapping-dry-batch.mjs"
exit /b %ERRORLEVEL%
