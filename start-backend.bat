@echo off
rem Starts the backend (the part that holds the rules and talks to the database).
rem Leave this window open while the shop system is in use. Press Ctrl+C to stop it.
cd /d "%~dp0backend"
echo Starting the MERIBA backend on http://127.0.0.1:8000 ...
".venv\Scripts\python.exe" manage.py migrate
".venv\Scripts\python.exe" manage.py runserver 127.0.0.1:8000
pause
