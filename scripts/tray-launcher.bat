@echo off
:: scripts/tray-launcher.bat
:: Boot launcher for the Electron tray companion. Invoked by the OutreachAgent-Tray scheduled
:: task ~30 seconds after user logon.
::
:: Resolution order — first match wins:
::   1. Packaged installer:  %LOCALAPPDATA%\Programs\Outreach Agent\Outreach Agent.exe
::   2. Per-user portable:   %APPDATA%\OutreachAgent\OutreachAgent.exe
::   3. From-source dev:     desktop\node_modules\.bin\electron.cmd  desktop\
::
:: Single-instance: skip if a tray process is already running. The Phase A daemon survives
:: agent restarts; the tray is a pure overlay so duplicates would just stack icons.

setlocal EnableDelayedExpansion

set "REPO=%~dp0.."
set "REPO=%REPO:\scripts\..=%"

set "LOGDIR=%APPDATA%\.outreach-agent\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOG=%LOGDIR%\tray-launcher.log"

:: Single-instance check via image name. tasklist's filter syntax is touchy through bash,
:: but plain cmd handles it fine here.
tasklist /FI "imagename eq Outreach Agent.exe" 2>nul | find /i "Outreach Agent.exe" >nul
if not errorlevel 1 (
    echo [%DATE% %TIME%] Tray already running (packaged) — skipping. >> "%LOG%"
    endlocal
    exit /b 0
)
tasklist /FI "imagename eq electron.exe" 2>nul | find /i "electron.exe" >nul
if not errorlevel 1 (
    echo [%DATE% %TIME%] Tray already running (electron) — skipping. >> "%LOG%"
    endlocal
    exit /b 0
)

:: Path 1: installed via NSIS
set "PKG=%LOCALAPPDATA%\Programs\Outreach Agent\Outreach Agent.exe"
if exist "%PKG%" (
    echo [%DATE% %TIME%] Launching packaged tray: %PKG% >> "%LOG%"
    start "" "%PKG%"
    endlocal
    exit /b 0
)

:: Path 2: portable
set "POR=%APPDATA%\OutreachAgent\OutreachAgent.exe"
if exist "%POR%" (
    echo [%DATE% %TIME%] Launching portable tray: %POR% >> "%LOG%"
    start "" "%POR%"
    endlocal
    exit /b 0
)

:: Path 3: from source — npm install must have run in desktop\
set "ELECTRON=%REPO%\desktop\node_modules\.bin\electron.cmd"
if exist "%ELECTRON%" (
    echo [%DATE% %TIME%] Launching dev tray: %ELECTRON% %REPO%\desktop >> "%LOG%"
    pushd "%REPO%\desktop"
    start "" "%ELECTRON%" .
    popd
    endlocal
    exit /b 0
)

echo [%DATE% %TIME%] No tray binary found — install or run `npm run tray:install`. >> "%LOG%"
endlocal
exit /b 0
