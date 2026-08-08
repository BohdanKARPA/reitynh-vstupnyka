@echo off
rem Only ASCII here: cmd.exe garbles non-Latin text in .bat files.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js not found / Nemaye Node.js
    echo   Install LTS from https://nodejs.org and run this file again.
    echo.
    pause
    exit /b 1
)

node server.js

echo.
pause
