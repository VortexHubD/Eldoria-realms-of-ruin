@echo off
title Eldoria: Realms of Ruin - Servidor
cd /d "%~dp0"
echo =======================================================
echo   Iniciando Eldoria: Realms of Ruin...
echo =======================================================
start http://localhost:8080
where node >nul 2>&1
if %ERRORLEVEL%==0 (
    node server.js
) else (
    echo Node.js no esta instalado. Usando Python sin red global.
    python -m http.server 8080
    if %ERRORLEVEL% NEQ 0 (
        python3 -m http.server 8080
    )
)
pause
