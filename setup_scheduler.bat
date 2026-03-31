@echo off
rem Skript pro nastavení Windows Task Scheduleru
rem Spustit jako správce (pravé tlačítko → Spustit jako správce)

set TASK_NAME=BalikobotSync
set SCRIPT_DIR=%~dp0
set BAT_FILE=%SCRIPT_DIR%run_sync.bat

echo Vytvářím naplánovanou úlohu: %TASK_NAME%
echo Skript: %BAT_FILE%
echo Interval: každých 15 minut

schtasks /delete /tn "%TASK_NAME%" /f 2>nul

schtasks /create ^
  /tn "%TASK_NAME%" ^
  /tr "\"%BAT_FILE%\"" ^
  /sc MINUTE ^
  /mo 15 ^
  /st 00:00 ^
  /ru "%USERNAME%" ^
  /rl HIGHEST ^
  /f

if %ERRORLEVEL% == 0 (
    echo.
    echo Úloha úspěšně vytvořena!
    echo Spustí se automaticky každých 15 minut.
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
