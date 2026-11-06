@echo off
REM Double-click to build packs\breckenridge\ from raw\breckenridge\ (run fetch_breckenridge.cmd first).
REM Optional: build_breckenridge.cmd C:\Users\Drew\Documents\snowboard-sim\raw
cd /d "%~dp0"
set RAW=raw\breckenridge
if not "%~1"=="" set RAW=%~1\breckenridge
python pipeline\build_pack.py breckenridge "%RAW%" packs\breckenridge
echo.
echo Done. Start the game (cd game ^&^& npm run dev) and pick Breckenridge on the menu.
pause
