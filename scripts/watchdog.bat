@echo off
:: scripts/watchdog.bat
:: Runs every 5 minutes via Windows scheduled task. Pings the agent's /api/health endpoint;
:: if the agent is unresponsive (HTTP != 200), assumes it crashed/hung and triggers a restart
:: by killing any node process bound to :3500 — daemon-launcher.bat's supervisor loop will
:: respawn it within 10 seconds.
::
:: Designed to be cheap (one curl + at most one taskkill) so 12 invocations per hour is fine.

setlocal EnableDelayedExpansion

set "LOGDIR=%APPDATA%\.outreach-agent\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "WATCHLOG=%LOGDIR%\watchdog.log"

:: 1. Health check
curl -s -o nul -w "%%{http_code}" --max-time 8 http://127.0.0.1:3500/api/health 2>nul | findstr /b "200" >nul
if not errorlevel 1 (
    echo [%DATE% %TIME%] OK — /api/health=200 >> "%WATCHLOG%"
    exit /b 0
)

:: 2. Health failed — record it
echo [%DATE% %TIME%] FAIL — /api/health unreachable, killing :3500 listener >> "%WATCHLOG%"

:: 3. Kill any process holding :3500 so the daemon loop can respawn cleanly
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3500" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
    echo [%DATE% %TIME%]   killed PID %%a >> "%WATCHLOG%"
)

:: 4. Also probe Chrome — if it died, no point reviving the agent
curl -s -o nul -w "%%{http_code}" --max-time 5 http://127.0.0.1:9223/json/version 2>nul | findstr /b "200" >nul
if errorlevel 1 (
    echo [%DATE% %TIME%]   Chrome also down — daemon-launcher will respawn both >> "%WATCHLOG%"
)

exit /b 0
