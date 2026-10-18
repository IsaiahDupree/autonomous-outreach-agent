@echo off
title Autonomous Outreach Agent
echo ============================================
echo   Autonomous Outreach Agent - Starting...
echo ============================================
echo.

:: Check if Chrome is running with CDP
netstat -ano | findstr "9222 9223" >nul 2>&1
if errorlevel 1 (
    echo [!] Chrome not detected on CDP port 9222/9223
    echo     Start Chrome with: --remote-debugging-port=9222
    echo     Or run: start-chrome.bat first
    echo.
    pause
    exit /b 1
)
echo [OK] Chrome CDP detected

:: Check if port 3500 is already in use
netstat -ano | findstr ":3500" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [!] Port 3500 already in use - killing existing process...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3500" ^| findstr "LISTENING"') do (
        taskkill /PID %%a /F >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
    echo [OK] Old process killed
)

:: Build first
echo.
echo [*] Building TypeScript...
call npm run build
if errorlevel 1 (
    echo [!] Build failed!
    pause
    exit /b 1
)
echo [OK] Build successful

:: Start the agent
echo.
echo ============================================
echo   Agent starting on http://localhost:3500
echo   Press Ctrl+C to stop
echo ============================================
echo.
npm run dev
