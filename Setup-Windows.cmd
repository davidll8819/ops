@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 from https://nodejs.org/en/download then reopen this file.
  pause
  exit /b 1
)
node scripts/windows-local.mjs setup
set "OFFICE_EXIT=%ERRORLEVEL%"
pause
exit /b %OFFICE_EXIT%
