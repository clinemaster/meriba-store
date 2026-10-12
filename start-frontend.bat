@echo off
rem Starts the website (the screens people use). Start the backend first.
rem Leave this window open while the shop system is in use. Press Ctrl+C to stop it.
cd /d "%~dp0frontend"
echo Starting the MERIBA website on http://localhost:3000 ...
call npm run dev
pause
