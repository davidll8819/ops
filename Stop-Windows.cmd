@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 is required.
  pause
  exit /b 1
)
node scripts/windows-local.mjs stop
set "OFFICE_EXIT=%ERRORLEVEL%"
pause
exit /b %OFFICE_EXIT%
