@echo off
setlocal
cd /d "%~dp0"
set "FUND_HOST=127.0.0.1"
set "FUND_PORT=5000"
set "FUND_OPEN_BROWSER=1"
set "FUND_DEBUG=0"
start "" "%~dp0FundStrategyManager.exe"
