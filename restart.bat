@echo off
cd /d "%~dp0"

:: --- Stop ---
if exist .server.pid (
    set /p PID=<.server.pid
    tasklist /FI "PID eq %PID%" 2>nul | find /I "node.exe" >nul
    if not errorlevel 1 (
        taskkill /PID %PID% /F >nul 2>&1
        echo [STOPPED] fastmd-explorer stopped (PID: %PID%)
    ) else (
        echo [INFO] Process not found, cleaning up pid file.
    )
    del .server.pid
) else (
    echo [INFO] Server was not running.
)

:: --- Start ---
powershell -NoProfile -Command "$p = Start-Process -PassThru -NoNewWindow -FilePath 'node' -ArgumentList 'src/cli.js'; $p.Id | Out-File '.server.pid' -Encoding ascii -NoNewline; Write-Host '[STARTED] fastmd-explorer (PID:' $p.Id ')  http://127.0.0.1:13847'"

timeout /t 3 >nul
