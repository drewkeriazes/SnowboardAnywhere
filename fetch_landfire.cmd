@echo off
REM Double-click to download the LANDFIRE clips for a resort: vegetation type (EVT) into raw\<slug>\landfire\,
REM vegetation cover (EVC) and height (EVH) into landfire\evc\ and landfire\evh\ (DATA-010).
REM LFPS asks for an email address for its usage statistics.
REM Optional: fetch_landfire.cmd <slug> [raw folder that holds <slug>\] (default: asks for the slug, raw\ in the repo).
cd /d "%~dp0"
set SLUG=%~1
if "%SLUG%"=="" set /p SLUG=Resort (vail, breckenridge, bigsky):
if "%SLUG%"=="" set SLUG=vail
set /p LFEMAIL=Email address for the LANDFIRE service:
set RAWOPT=
if not "%~2"=="" set RAWOPT=--raw "%~2"
for %%P in (EVT EVC EVH) do node "%~dp0pipeline\fetch_landfire.mjs" %SLUG% %LFEMAIL% %%P %RAWOPT%
echo.
echo Done. You can close this window.
pause
