@echo off
rem Skript pro nastaveni Windows Task Scheduleru
rem MUSI se spustit jako spravce (pravym tlacitkem -> Spustit jako spravce)
rem
rem Uloha bezi pod uctem SYSTEM => zadne heslo, bezi i kdyz nikdo neni prihlasen.
rem Sync saha na trvale bezici mServer na portu 7777 (viz .env), zadnou Pohodu
rem nestartuje. Spousti se 4x denne (9:00, 13:00, 17:00, 21:00) jako pojistka,
rem aby vypadek jednoho behu dohnal dalsi tentyz den.

set TASK_NAME=BalikobotSync
set SCRIPT_DIR=%~dp0
set BAT_FILE=%SCRIPT_DIR%run_sync.bat

echo Vytvarim naplanovanou ulohu: %TASK_NAME%
echo Skript: %BAT_FILE%
echo Ucet:   SYSTEM (bez hesla, bezi i bez prihlaseni)
echo Interval: 4x denne (9:00, 13:00, 17:00, 21:00)
echo.

schtasks /delete /tn "%TASK_NAME%" /f 2>nul

schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%BAT_FILE%\"" ^
  /sc DAILY ^
  /st 09:00 ^
  /ri 240 ^
  /du 12:00 ^
  /ru "SYSTEM" ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% == 0 (
    echo.
    echo Uloha uspesne vytvorena!
    echo.
    echo Pro rucni spusteni:
    echo   schtasks /run /tn "%TASK_NAME%"
    echo.
    echo Pro zobrazeni stavu:
    echo   schtasks /query /tn "%TASK_NAME%" /fo LIST /v
    echo   ^(overit: Run As User: SYSTEM, Logon Mode: Interactive/Background, Last Result: 0^)
) else (
    echo.
    echo CHYBA: Ulohu se nepodarilo vytvorit.
    echo Zkontrolujte, ze jste skript spustili jako spravce.
)

pause
