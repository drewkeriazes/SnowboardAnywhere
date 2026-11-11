@echo off
REM Double-click to download the Big Sky source data (about 2.5 GB, incl. the land cover tiles) into raw\bigsky\.
REM Optional: fetch_bigsky.cmd -RawDir C:\Users\Drew\Documents\snowboard-sim\raw
REM Safe to re-run; it resumes where it left off. Do not run two fetches at once.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pipeline\fetch.ps1" -Slug bigsky %*
echo.
echo Done. Next: double-click build_bigsky.cmd
pause
