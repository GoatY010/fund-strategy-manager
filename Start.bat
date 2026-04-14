@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

cd /d "%~dp0"

set "PY_BOOTSTRAP="
where py >nul 2>nul && set "PY_BOOTSTRAP=py -3"
if not defined PY_BOOTSTRAP (
    where python >nul 2>nul && set "PY_BOOTSTRAP=python"
)

if not defined PY_BOOTSTRAP (
    echo [ERROR] Python 3 is not installed.
    echo Please install Python 3.10+ and run this file again.
    pause
    exit /b 1
)

set "VENV_PY=.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
    echo [INFO] Creating virtual environment...
    %PY_BOOTSTRAP% -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create .venv
        pause
        exit /b 1
    )
)

call :calc_hash requirements.txt REQ_HASH
set "NEED_INSTALL=0"
if not exist ".venv\requirements.sha256" set "NEED_INSTALL=1"
if exist ".venv\requirements.sha256" (
    set /p OLD_HASH=<".venv\requirements.sha256"
    if /I not "!OLD_HASH!"=="!REQ_HASH!" set "NEED_INSTALL=1"
)

if "!NEED_INSTALL!"=="1" (
    echo [INFO] Installing dependencies...
    "%VENV_PY%" -m pip install --upgrade pip
    if errorlevel 1 (
        echo [ERROR] Failed to upgrade pip.
        pause
        exit /b 1
    )
    "%VENV_PY%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    > ".venv\requirements.sha256" echo !REQ_HASH!
)

set "FUND_HOST=127.0.0.1"
set "FUND_PORT=5000"
set "FUND_OPEN_BROWSER=1"
set "FUND_DEBUG=0"

echo [INFO] Starting Fund Strategy Manager...
"%VENV_PY%" app.py
exit /b %errorlevel%

:calc_hash
set "target=%~1"
set "outvar=%~2"
set "hash="
for /f "tokens=* delims=" %%H in ('certutil -hashfile "%target%" SHA256 ^| findstr /R "^[0-9A-F][0-9A-F]"') do (
    set "hash=%%H"
    goto :hash_done
)
:hash_done
set "hash=%hash: =%"
set "%outvar%=%hash%"
exit /b 0
