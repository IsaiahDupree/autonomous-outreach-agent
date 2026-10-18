@echo off
title Chrome CDP
echo Starting Chrome with CDP debugging port...
echo.

:: Use the existing Chrome profile for saved sessions
set PROFILE=%APPDATA%\.outreach-agent-chrome-profile
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
    --remote-debugging-port=9223 ^
    --user-data-dir="%PROFILE%" ^
    --no-first-run ^
    --disable-default-apps ^
    https://www.upwork.com

echo [OK] Chrome launched on port 9223
echo     Profile: %PROFILE%
echo.
echo You can now run start.bat to launch the agent.
timeout /t 3 /nobreak >nul
