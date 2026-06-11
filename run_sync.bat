@echo off
cd /d "%~dp0"

rem mServer na portu 7777 (Ateosys) bezi trvale v session 0,
rem proto uz nestartujeme/nezastavujeme zadnou Pohodu - jen spustime sync.

echo. >> logs\scheduler.log
echo ============================================ >> logs\scheduler.log
echo [%date% %time%] START >> logs\scheduler.log

node sync.js >> logs\scheduler.log 2>&1

echo [%date% %time%] HOTOVO >> logs\scheduler.log
