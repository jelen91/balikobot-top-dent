@echo off
rem Skript pro nastavení Windows Task Scheduleru
rem Spustit jako správce (pravé tlačítko → Spustit jako správce)

set TASK_NAME=BalikobotSync
set SCRIPT_DIR=%~dp0
set BAT_FILE=%SCRIPT_DIR%run_sync.bat

echo Vytvářím naplánovanou úlohu: %TASK_NAME%
echo Skript: %BAT_FILE%
echo Interval: každý den v 17:00
echo.
echo Pro spuštění i když nikdo není přihlášen zadejte heslo uživatele %USERNAME%:
set /p TASK_PASS=Heslo:

schtasks /delete /tn "%TASK_NAME%" /f 2>nul

schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%BAT_FILE%\"" ^
  /sc DAILY ^
  /st 17:00 ^
  /ru "%USERNAME%" ^
  /rp "%TASK_PASS%" ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% == 0 (
    echo.
    echo Úloha úspěšně vytvořena!
    echo Spustí se každý den v 17:00 - i když nikdo není přihlášen.
    echo.
    echo Pro ruční spuštění:
    echo   schtasks /run /tn "%TASK_NAME%"
    echo.
    echo Pro zobrazení stavu:
    echo   schtasks /query /tn "%TASK_NAME%" /fo LIST /v
) else (
    echo.
    echo CHYBA: Úlohu se nepodařilo vytvořit.
    echo Zkontrolujte, že jste spustili jako správce.
)

pause
