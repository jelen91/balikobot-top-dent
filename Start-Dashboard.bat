@echo off
cd /d "%~dp0"

echo  Top-Dent Sync Dashboard
echo ========================

REM Zkontrolovat jestli uz server bezi na portu 3001
netstat -ano | findstr ":3001 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 (
    echo  Server uz bezi, oteviru dashboard...
    start "" "http://localhost:3001/dashboard.html"
    exit /b 0
)

REM Zkontrolovat jestli existuje Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  CHYBA: Node.js neni nainstalovan!
    echo  Stahnete Node.js z: https://nodejs.org
    pause
    exit /b 1
)

REM Zkontrolovat jestli existuje .env soubor
if not exist ".env" (
    echo  UPOZORNENI: Soubor .env neexistuje!
    echo  Kopirujte .env.example jako .env a doplnte udaje.
    copy ".env.example" ".env" >nul 2>&1
    echo  Soubor .env byl vytvoren z .env.example - upravte ho!
    notepad ".env"
    pause
    exit /b 1
)

REM Zkontrolovat node_modules
if not exist "node_modules" (
    echo  Instaluji zavislosti (npm install)...
    npm install
    if %errorlevel% neq 0 (
        echo  CHYBA: npm install selhal!
        pause
        exit /b 1
    )
)

REM Spustit server na pozadi a otevrit prohlizec
echo  Spoustim server...
start "Top-Dent Sync Server" /min node server.js

REM Pockat na start serveru (max 10 sekund)
set /a attempts=0
:waitloop
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":3001 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% == 0 goto :serverready
set /a attempts+=1
if %attempts% lss 10 goto :waitloop
echo  UPOZORNENI: Server se nespustil do 10 sekund, zkousite otevrit dashboard...

:serverready
echo  Server bezi! Oteviru dashboard...
start "" "http://localhost:3001/dashboard.html"
exit /b 0
