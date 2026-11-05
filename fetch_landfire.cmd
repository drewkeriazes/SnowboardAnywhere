@echo off
REM Double-click to download the LANDFIRE vegetation-type (EVT) clip for Vail into raw\vail\landfire\.
REM LFPS asks for an email address for its usage statistics.
cd /d "%~dp0"
set /p LFEMAIL=Email address for the LANDFIRE service: 
node "%~dp0pipeline\fetch_landfire.mjs" vail %LFEMAIL% 240EVT
echo.
echo Done. You can close this window.
pause
