@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js install nahi hai. Pehle https://nodejs.org se Node 20 ya 22 LTS install karein.
  pause
  exit /b
)
if not exist node_modules (
  echo Dependencies install ho rahi hain, thora intezar karein...
  call npm install
)
start "" http://localhost:3000
call npm start
pause
