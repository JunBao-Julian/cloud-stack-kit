@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Join.ps1" -Mode join
if errorlevel 1 pause
