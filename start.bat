@echo off
title Topgrip IPIS / VDC AVDB (192x112) SNMPv3 Trap Controller
color 0b
cls
echo =====================================================================
echo   TOPGRIP IPIS / VDC AVDB (192x112) SNMPv3 TRAP CONTROLLER (PEN 66731)
echo =====================================================================
echo.
echo Target NMS: 10.0.0.252:162 (UDP)
echo Protocol:   SNMPv3 authPriv (HMAC-SHA-256 / AES-128)
echo.
echo Freeing port 8080 if previously in use...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8080" ^| findstr "LISTENING"') do (
    echo Stopping old process on port 8080 (PID: %%a)...
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo Starting Web Server on port 8080...
echo.

if exist "server.js" (
    node server.js
) else if exist "server.py" (
    python server.py
) else (
    echo Error: server.js or server.py not found!
    pause
)
