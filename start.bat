@echo off
rem Starts Prompt Maker on Windows (and LM Studio's local server if needed), then opens it in the browser.
rem Double-click it. The first start also sets it up: a Start menu entry, starting with your computer, and the
rem link the page's Start button uses. To undo that:  start.bat --uninstall   (start.bat --install sets it up again)
rem Not yet tried on a real Windows PC: please report what happens (Settings shows the version).
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set "PORT=5317"
set "URL=http://127.0.0.1:%PORT%"

where node >nul 2>nul
if errorlevel 1 (
  echo Prompt Maker needs Node.js, which isn't on this computer yet.
  echo Install it from https://nodejs.org ^(the LTS version^), then double-click this file again.
  pause
  exit /b 1
)

if /i "%~1"=="--install" (
  node lib\autostart.js install
  echo Prompt Maker is set up: it's in your Start menu and starts with your computer.
  pause
  exit /b 0
)
if /i "%~1"=="--uninstall" (
  node lib\autostart.js uninstall
  echo Removed. Double-click start.bat when you need Prompt Maker.
  pause
  exit /b 0
)

rem Opened from the page's Start button (promptmaker://start): the page reconnects on its own, no new tab.
set "FROM_LINK="
echo %~1 | findstr /b /i "promptmaker://" >nul && set "FROM_LINK=1"
rem Started with the computer: no browser tab either.
if /i "%~1"=="--background" set "FROM_LINK=1"

rem Already running? Just open it.
curl -fs -o nul "%URL%/api/settings" 2>nul
if not errorlevel 1 (
  if not defined FROM_LINK start "" "%URL%"
  exit /b 0
)

rem First start: set it up once (unless you removed the setup before).
node lib\autostart.js first-run >nul 2>nul

set "LMS=%USERPROFILE%\.lmstudio\bin\lms.exe"
if exist "%LMS%" (
  "%LMS%" server status 2>&1 | findstr /i /c:"not running" >nul && "%LMS%" server start
)

if not defined FROM_LINK start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" "%URL%""
echo Prompt Maker is running at %URL%  ^(keep this window open, or close it to stop Prompt Maker^)
node server.js
