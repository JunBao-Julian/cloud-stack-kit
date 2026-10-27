@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Clean-Claude.ps1"
set "cleanup_exit=%ERRORLEVEL%"
echo.
if not "%cleanup_exit%"=="0" echo Cleanup did not complete. Review the messages above.
pause
exit /b %cleanup_exit%
