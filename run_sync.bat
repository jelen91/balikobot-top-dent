@echo off
cd /d "%~dp0"

set POHODA="C:\POHODA\Pohoda.exe"
set MSERVER=bot

echo. >> logs\scheduler.log
echo ============================================ >> logs\scheduler.log
echo [%date% %time%] START >> logs\scheduler.log

echo [%date% %time%] Spoustim Pohoda.exe (pokud nebezi) >> logs\scheduler.log
tasklist /FI "IMAGENAME eq Pohoda.exe" /FI "SESSIONNAME ne Services" 2>nul | find /I "Pohoda.exe" >nul
if errorlevel 1 (
  start "" %POHODA%
  timeout /t 45 /nobreak >nul
)

echo [%date% %time%] Spoustim mServer "%MSERVER%" >> logs\scheduler.log
start "" %POHODA% /HTTP start "%MSERVER%"
timeout /t 60 /nobreak >nul

echo [%date% %time%] Spoustim sync >> logs\scheduler.log
node sync.js >> logs\scheduler.log 2>&1

echo [%date% %time%] Zastavuji mServer "%MSERVER%" >> logs\scheduler.log
start "" %POHODA% /HTTP stop "%MSERVER%" /f

echo [%date% %time%] HOTOVO >> logs\scheduler.log
