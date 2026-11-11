@echo off
REM Double-click to download the LANDFIRE clips for Vail: vegetation type (EVT) into raw\vail\landfire\,
REM vegetation cover (EVC) and height (EVH) into landfire\evc\ and landfire\evh\ (DATA-010).
REM LFPS asks for an email address for its usage statistics.
REM Optional: pass the raw folder that holds vail\ as the first argument (default: raw\ in the repo).
cd /d "%~dp0"
set /p LFEMAIL=Email address for the LANDFIRE service:
set RAWOPT=
if not "%~1"=="" set RAWOPT=--raw "%~1"
for %%P in (EVT EVC EVH) do node "%~dp0pipeline\fetch_landfire.mjs" vail %LFEMAIL% %%P %RAWOPT%
echo.
echo Done. You can close this window.
pause
