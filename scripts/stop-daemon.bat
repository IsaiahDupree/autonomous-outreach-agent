@echo off
:: scripts/stop-daemon.bat — manual full-stack shutdown.
:: Kills the agent on :3500 and the Chrome on :9223. Used when you want the system
:: completely off (vs the watchdog's "kill agent so daemon loop respawns it").

setlocal

set "LOGDIR=%APPDATA%\.outreach-agent\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo Stopping outreach agent stack...

:: 0. Tray companion (electron / packaged exe) — kill so it doesn't keep polling a dead agent
taskkill /F /IM "Outreach Agent.exe" /T >nul 2>&1
taskkill /F /IM "electron.exe" /T >nul 2>&1

:: 1. Agent on :3500
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3500" ^| findstr "LISTENING"') do (
    echo   killing agent PID %%a
    taskkill /PID %%a /T /F >nul 2>&1
)

:: 2. Chrome on :9223 — find the parent chrome.exe whose CDP port matches
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":9223" ^| findstr "LISTENING"') do (
    echo   killing chrome PID %%a
    taskkill /PID %%a /T /F >nul 2>&1
)

:: 3. daemon-launcher.bat itself — tagged window title "Chrome CDP" already closed via above
::    but the launcher cmd window may still be looping. Find & kill it.
tasklist /FI "WINDOWTITLE eq Chrome CDP" /FO CSV 2>nul | findstr /i "cmd.exe" >nul
if not errorlevel 1 (
    taskkill /FI "WINDOWTITLE eq Chrome CDP" /T /F >nul 2>&1
)

echo [%DATE% %TIME%] Manual stop-daemon called >> "%LOGDIR%\daemon-actions.log"
echo Done.
endlocal
