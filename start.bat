@echo off
setlocal
title PulseGrid - IoT Sensor Platform
cd /d "%~dp0"

echo ============================================================
echo   PulseGrid - starting up
echo ============================================================
echo   This needs PostgreSQL running locally (you said you already
echo   have it - if that changes, see README.md's Setup section).
echo ============================================================
echo.

where py >nul 2>nul
if %errorlevel%==0 (
    set PYCMD=py
) else (
    where python >nul 2>nul
    if %errorlevel%==0 (
        set PYCMD=python
    ) else (
        echo [ERROR] Python was not found.
        echo Install Python 3.11+ from https://www.python.org/downloads/
        echo and tick "Add python.exe to PATH" during setup.
        pause
        exit /b 1
    )
)
echo [OK] Python found: %PYCMD%

echo Checking required packages...
call %PYCMD% -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Package install failed. Check your internet connection.
    pause
    exit /b 1
)
echo [OK] Packages installed.
echo.

if not exist ".env" (
    echo First run: creating .env from .env.example...
    copy .env.example .env >nul
)

echo Checking the database connection...
call %PYCMD% -m scripts.check_db
if errorlevel 1 (
    echo.
    echo [ERROR] Could not connect to the 'pulsegrid' database.
    echo This is expected on a first run if the database/user haven't
    echo been created yet. In a PostgreSQL terminal - psql - run:
    echo.
    echo   CREATE USER pulsegrid WITH PASSWORD 'pulsegrid_dev_pw';
    echo   CREATE DATABASE pulsegrid OWNER pulsegrid;
    echo.
    echo Then run this start.bat again. Full details are in README.md's
    echo "Setup" section if the password/DB name were changed from default.
    pause
    exit /b 1
)
echo [OK] Database reachable.
echo.

call %PYCMD% -m scripts.check_seeded
if errorlevel 1 (
    echo First run: seeding the database and training the model...
    echo Loads sensor_maintenance_data.csv - takes a few seconds
    call %PYCMD% -m scripts.seed_data sensor_maintenance_data.csv
    if errorlevel 1 (
        echo [ERROR] Seeding failed - see the messages above.
        pause
        exit /b 1
    )
) else (
    echo [OK] Database already seeded - skipping.
)
echo.

echo ------------------------------------------------------------
echo Starting the server. The background simulator will start
echo generating readings automatically every few seconds.
echo Keep this window open. Close it, or press CTRL+C, to stop.
echo ------------------------------------------------------------
echo.

start "" open_when_ready.bat

call %PYCMD% -m uvicorn app.main:app --host 127.0.0.1 --port 8000

pause
