@echo off
cd /d "%~dp0"

if not exist .server.pid (
    echo [ERROR] .server.pid not found. Server may not be running.
    pause
    exit /b 1
)

set /p PID=<.server.pid

tasklist /FI "PID eq %PID%" 2>nul | find /I "node.exe" >nul
if errorlevel 1 (
    echo [WARN] Process PID %PID% no longer exists.
    del .server.pid
    pause
    exit /b 1
)

taskkill /PID %PID% /F >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to stop process (PID: %PID%)
) else (
    echo [STOPPED] fastmd-explorer stopped (PID: %PID%)
    del .server.pid
)

pause
