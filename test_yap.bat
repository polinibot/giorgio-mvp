@echo off
cd /d "%~dp0"
set YAP_USERNAME=anasilsupremo@offcarchiuduno
set YAP_PASSWORD=Qweasdzxc@123
echo Avvio test commit YAP...
node automation/yap/yap-worker.mjs --payload-file automation/yap/test-commit-payload.json --commit --debug > automation\yap\test-output.log 2>&1
echo Exit code: %ERRORLEVEL% >> automation\yap\test-output.log
echo Done. Vedi automation\yap\test-output.log
pause
