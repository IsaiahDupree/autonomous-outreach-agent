@echo off
title Outreach Agent - Full Startup
echo ============================================
echo   Full Startup: Chrome + Agent
echo ============================================
echo.

:: 1. Start Chrome with CDP
echo [1/2] Starting Chrome...
call start-chrome.bat

:: Wait for Chrome to be ready
echo [*] Waiting for Chrome CDP...
timeout /t 5 /nobreak >nul

:wait_chrome
netstat -ano | findstr "9222 9223" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo     Still waiting...
    timeout /t 2 /nobreak >nul
    goto wait_chrome
)
echo [OK] Chrome ready

:: 2. Start the agent
echo.
echo [2/2] Starting Agent...
call start.bat
