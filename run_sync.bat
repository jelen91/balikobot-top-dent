@echo off
cd /d "%~dp0"
node sync.js >> logs\scheduler.log 2>&1
