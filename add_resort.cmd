@echo off
REM Double-click to add a resort by name (FEAT-224): resolve, plan, fetch, build, report, headless ride, publish.
REM The first run stops after the plan so you can read the data plan (pipeline\resorts\<slug>-plan.md) before
REM a 1+ GB fetch; run it again to go on. Every stage is skipped when done, so it is safe to re-run.
REM Optional: add_resort.cmd "<name>" [resort.py add options, e.g. --with Brandywine or --no-publish].
REM Set LANDFIRE_EMAIL to skip the email prompt. More: python pipeline\resort.py add --help
cd /d "%~dp0"
set NAME=%~1
if "%NAME%"=="" set /p NAME=Resort name as OpenSkiMap has it (e.g. Boston Mills):
if "%NAME%"=="" goto :eof
set REST=
:more
shift
if "%~1"=="" goto run
set REST=%REST% %1
goto more
:run
python pipeline\resort.py add "%NAME%" --review-plan%REST%
echo.
pause
