@echo off
REM Double-click to download the Vail source data (about 1.2 GB) into raw\vail\.
REM Safe to re-run; it resumes where it left off.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pipeline\fetch.ps1" -Slug vail
echo.
echo Done. You can close this window.
pause
