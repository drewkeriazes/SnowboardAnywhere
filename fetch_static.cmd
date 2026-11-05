@echo off
REM Double-click to download the Colorado OSM extract (~300 MB) and USGS GNIS names (~10 MB) into raw\static\.
REM These replace the Overpass queries. Safe to re-run.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pipeline\fetch_static.ps1"
echo.
echo Done. You can close this window.
pause
