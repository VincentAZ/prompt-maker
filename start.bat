@echo off
rem Starts Prompt Maker on Windows and opens it as its own window. Double-click it, or use the Start menu entry.
rem Prompt Maker then runs in the background with no window of its own (stop it in Settings > Services), and
rem LM Studio's local server is turned on if LM Studio is installed. The first start also sets it up: a Start
rem menu entry, starting with your computer, and the link the page's Start button uses (the installer does the
rem same as it installs).
rem   start.bat --uninstall    undo that setup (start.bat --install does it again)
rem   start.bat --background   start it without opening a window (what the Startup entry and the installer run)
rem It runs on the Node.js that came with the installer (the node folder beside this one), else the one installed
rem on this computer. To see what the server prints, run "node server.js" in this folder instead.
setlocal
cd /d "%~dp0"

set "NODE=%~dp0..\node\node.exe"
if exist "%NODE%" goto :ready
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto :ready
echo Prompt Maker needs Node.js, which isn't on this computer yet.
echo Install it from https://nodejs.org (the LTS version), then double-click this file again.
pause
exit /b 1

:ready
if /i "%~1"=="--install" (
  "%NODE%" lib\autostart.js install >nul
  echo Prompt Maker is set up: it's in your Start menu and starts with your computer.
  pause
  exit /b 0
)
if /i "%~1"=="--uninstall" (
  "%NODE%" lib\autostart.js uninstall >nul
  echo Removed. Double-click start.bat when you need Prompt Maker.
  pause
  exit /b 0
)

rem Set up once, unless you removed the setup before (or the installer did it already).
"%NODE%" lib\autostart.js first-run >nul 2>nul

rem Started with the computer, by the installer, or from the page's Start button (promptmaker://start): no window,
rem the page reconnects on its own.
if /i "%~1"=="--background" goto :quiet
echo %~1 | findstr /b /i "promptmaker://" >nul && goto :quiet
"%NODE%" lib\launch.js open
if errorlevel 1 pause
exit /b 0

:quiet
"%NODE%" lib\launch.js start
exit /b %errorlevel%
