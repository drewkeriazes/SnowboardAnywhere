@echo off
REM Double-click to build packs\bigsky\ from raw\bigsky\ (run fetch_bigsky.cmd first).
REM Optional: build_bigsky.cmd C:\Users\Drew\Documents\snowboard-sim\raw
cd /d "%~dp0"
set RAW=raw\bigsky
if not "%~1"=="" set RAW=%~1\bigsky
python pipeline\build_pack.py bigsky "%RAW%" packs\bigsky
echo.
echo Done. Start the game (cd game ^&^& npm run dev) and pick Big Sky on the menu.
pause
