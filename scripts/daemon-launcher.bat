@echo off
:: scripts/daemon-launcher.bat
:: Boot-time launcher invoked by the Windows scheduled task installed via install-startup.ps1.
::
:: Responsibilities:
::   1. Ensure %APPDATA%\.outreach-agent\logs\ exists
::   2. Spawn Chrome with CDP on 9223 if not already up (uses the saved profile so login persists)
::   3. Wait for Chrome's CDP to be reachable
::   4. Spawn the agent (npm run dev) and pipe stdout+stderr to a rolling log file
::   5. Restart the agent if it exits — infinite loop with a 10s backoff so we don't hammer
::      Chrome/Upwork on persistent failures.
::
:: All paths are anchored at this script's repo so the task can run from any working directory.
:: Stop the daemon manually by running scripts\stop-daemon.bat or by killing the conhost window.

setlocal EnableDelayedExpansion

:: ── 0. Resolve repo root (one level up from scripts\) ──────────────────────
set "REPO=%~dp0.."
set "REPO=%REPO:\scripts\..=%"
pushd "%REPO%" >nul

:: ── 1. Log directory + filenames ───────────────────────────────────────────
set "LOGDIR=%APPDATA%\.outreach-agent\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
:: Each launcher run gets its own log to keep the rolling history readable.
for /f "tokens=2 delims==" %%a in ('wmic os get LocalDateTime /value 2^>nul ^| find "="') do set DT=%%a
if not defined DT set "DT=%date:~-4%%date:~3,2%%date:~0,2%-%time:~0,2%%time:~3,2%%time:~6,2%"
set "DT=%DT: =0%"
set "DT=%DT:~0,8%-%DT:~8,6%"
set "AGENT_LOG=%LOGDIR%\agent-%DT%.log"
set "CHROME_LOG=%LOGDIR%\chrome-%DT%.log"
set "DAEMON_LOG=%LOGDIR%\daemon-%DT%.log"

call :log "Daemon launcher starting (repo=%REPO%, logs=%LOGDIR%)"

:: ── 2. Chrome on 9223 if not already up ────────────────────────────────────
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:9223/json/version 2>nul | findstr /b "200" >nul
if errorlevel 1 (
    call :log "Chrome not running on 9223 — launching"
    set "PROFILE=%APPDATA%\.outreach-agent-chrome-profile"
    if not exist "!PROFILE!" mkdir "!PROFILE!"
    start "Chrome CDP" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
        --remote-debugging-port=9223 ^
        --user-data-dir="!PROFILE!" ^
        --no-first-run ^
        --disable-default-apps ^
        https://www.upwork.com/nx/find-work/

    :wait_chrome
    timeout /t 2 /nobreak >nul
    curl -s -o nul -w "%%{http_code}" http://127.0.0.1:9223/json/version 2>nul | findstr /b "200" >nul
    if errorlevel 1 goto wait_chrome
    call :log "Chrome CDP up on 9223"
) else (
    call :log "Chrome already up on 9223 — reusing"
)

:: ── 3. Agent supervisor loop ──────────────────────────────────────────────
:agent_loop
:: If port 3500 is already taken, do nothing — another launcher instance is running and
:: we should NOT spawn a duplicate. The watchdog will restart the dead one if it dies.
netstat -ano | findstr ":3500" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    call :log "Agent already running on :3500 — daemon-launcher exiting (single-instance)"
    popd >nul
    endlocal
    exit /b 0
)

call :log "Spawning agent (npm run dev) — log=%AGENT_LOG%"
:: Use cmd /c so the agent inherits a real console for ANSI logs.
:: Append (>>) to the log so multiple restarts within one launcher run all land in one file.
cmd /c "npm run dev >> "%AGENT_LOG%" 2>&1"
set "AGENT_EXIT=!errorlevel!"
call :log "Agent exited with code !AGENT_EXIT! — backoff 10s then restart"
timeout /t 10 /nobreak >nul
goto agent_loop

:log
echo [%DATE% %TIME%] %~1 >> "%DAEMON_LOG%"
exit /b 0
