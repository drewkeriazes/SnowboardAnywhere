@echo off
REM Double-click to build a resort end to end (FEAT-175): node lists, manifest, fetch, LANDFIRE, grooming,
REM build, packs\index.json and the DATA-022 report. Finished stages are skipped, so it is safe to re-run.
REM Optional: build_resort.cmd <slug> [raw folder that holds <slug>\] (default: asks for the slug, raw\ in the repo).
REM Set LANDFIRE_EMAIL to skip the email prompt. More: python pipeline\build_resort.py --help
cd /d "%~dp0"
set SLUG=%~1
if "%SLUG%"=="" set /p SLUG=Resort slug (vail, breckenridge, bigsky, or one resort.py made):
if "%SLUG%"=="" goto :eof
set RAW=raw\%SLUG%
if not "%~2"=="" set RAW=%~2\%SLUG%
python pipeline\build_resort.py %SLUG% "%RAW%" packs\%SLUG%
echo.
echo Done. Start the game (cd game ^&^& npm run dev) and pick the resort on the menu.
pause
