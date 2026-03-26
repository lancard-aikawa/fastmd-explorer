@echo off
cd /d "%~dp0"

if exist .server.pid (
    set /p PID=<.server.pid
    tasklist /FI "PID eq %PID%" 2>nul | find /I "node.exe" >nul
    if not errorlevel 1 (
        echo [RUNNING] fastmd-explorer is already running (PID: %PID%)
        pause
        exit /b 1
    )
    del .server.pid
)

powershell -NoProfile -Command "$p = Start-Process -PassThru -NoNewWindow -FilePath 'node' -ArgumentList 'src/cli.js'; $p.Id | Out-File '.server.pid' -Encoding ascii -NoNewline; Write-Host '[STARTED] fastmd-explorer (PID:' $p.Id ')  http://127.0.0.1:13847'"

timeout /t 3 >nul
