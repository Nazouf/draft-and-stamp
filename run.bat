@echo off
REM Double-click this file to start Draft & Stamp.
cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing dependencies (first run only)...
  call npm install
)

if not exist ".env" (
  copy .env.example .env >nul
  echo.
  echo ================================================================
  echo  First-time setup needed:
  echo  1. Open the new ".env" file in this folder with Notepad
  echo  2. Replace "your-key-here" with your real Gemini API key
  echo     (free, no card: https://aistudio.google.com)
  echo  3. Save the file, then double-click this script again
  echo ================================================================
  pause
  exit /b
)

echo Starting Draft ^& Stamp...
echo Open this in your browser:  http://localhost:3000
echo (Close this window to stop it)
call npm start
