@echo off
REM Double-click to download the Breckenridge source data (about 1.4 GB) into raw\breckenridge\.
REM Optional: fetch_breckenridge.cmd -RawDir C:\Users\Drew\Documents\snowboard-sim\raw
REM Safe to re-run; it resumes where it left off. Do not run two fetches at once.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pipeline\fetch.ps1" -Slug breckenridge %*
echo.
echo Done. Next: double-click build_breckenridge.cmd
pause
