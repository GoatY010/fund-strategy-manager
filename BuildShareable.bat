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

echo [INFO] Installing build dependency (pyinstaller)...
"%VENV_PY%" -m pip install pyinstaller==6.15.0
if errorlevel 1 (
    echo [ERROR] Failed to install pyinstaller.
    pause
    exit /b 1
)

set "PYI_WORK=.pyi_work"
set "PYI_DIST=.pyi_dist"
set "RELEASE_DIR=release\FundStrategyManager"
set "RELEASE_ZIP=release\FundStrategyManager.zip"

if exist "%PYI_WORK%" rmdir /s /q "%PYI_WORK%"
if exist "%PYI_DIST%" rmdir /s /q "%PYI_DIST%"
if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%"
if exist "%RELEASE_ZIP%" del /q "%RELEASE_ZIP%" >nul

echo [INFO] Building executable...
"%VENV_PY%" -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --name FundStrategyManager ^
  --onedir ^
  --workpath "%PYI_WORK%" ^
  --distpath "%PYI_DIST%" ^
  --specpath "%PYI_WORK%" ^
  --add-data "%CD%\templates;templates" ^
  --add-data "%CD%\static;static" ^
  app.py
if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

mkdir release 2>nul
mkdir "%RELEASE_DIR%" 2>nul
xcopy /E /I /Y "%PYI_DIST%\FundStrategyManager" "%RELEASE_DIR%" >nul
copy /Y "Run_Portable.bat" "%RELEASE_DIR%\DoubleClickStart.bat" >nul
copy /Y "README_SHARE.txt" "%RELEASE_DIR%\README.txt" >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%CD%\%RELEASE_DIR%\*' -DestinationPath '%CD%\%RELEASE_ZIP%' -Force"
if errorlevel 1 (
    echo [WARN] Zip packaging failed. You can still share folder: %RELEASE_DIR%
) else (
    echo [INFO] Zip package created: %RELEASE_ZIP%
)

echo.
echo [OK] Shareable build completed.
echo Folder: %RELEASE_DIR%
echo Zip   : %RELEASE_ZIP%
echo.
pause
exit /b 0

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
