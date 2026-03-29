@echo off
cd /d "%~dp0"

echo  Top-Dent Sync - Nastaveni automatickeho startu
echo =================================================
echo  Tento skript zaregistruje automaticke spusteni serveru
echo  pri prihlaseni do Windows (Task Scheduler).
echo.

REM Zkontrolovat adminstratorska prava
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  CHYBA: Tento skript vyzaduje administratorska prava!
    echo  Kliknete pravym tlacitkem a vyberte "Spustit jako spravce".
    pause
    exit /b 1
)

REM Zkontrolovat Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  CHYBA: Node.js neni nainstalovan!
    pause
    exit /b 1
)

for /f "delims=" %%i in ('where node') do set NODE_PATH=%%i
echo  Node.js nalezen: %NODE_PATH%

set APP_DIR=%~dp0
set APP_DIR=%APP_DIR:~0,-1%
set TASK_NAME=TopDent-Sync-Server

echo  Adresar aplikace: %APP_DIR%
echo.

REM Smazat existujici ulohu pokud existuje
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

REM Vytvorit novou ulohu - spusti se pri prihlaseni uzivatele
schtasks /create ^
    /tn "%TASK_NAME%" ^
    /tr "\"%NODE_PATH%\" \"%APP_DIR%\server.js\"" ^
    /sc ONLOGON ^
    /delay 0000:30 ^
    /rl HIGHEST ^
    /f ^
    /it

if %errorlevel% == 0 (
    echo.
    echo  Uloha '%TASK_NAME%' uspesne zaregistrovana!
    echo  Server se automaticky spusti pri kazdem prihlaseni.
    echo.
    echo  Spravovat ulohy: Start - Spravce uloh (Task Scheduler)
    echo  Rucni spusteni: Start-Dashboard.bat
) else (
    echo.
    echo  CHYBA: Nepodarilo se zaregistrovat ulohu!
    echo  Zkuste spustit jako administrator.
)

echo.
pause
