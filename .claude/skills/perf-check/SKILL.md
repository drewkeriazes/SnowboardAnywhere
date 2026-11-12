---
name: perf-check
description: Profile the running game in a real browser with the Chrome DevTools MCP (performance trace, insights, console) and compare against the project's frame budgets. Use when the user asks why the game is slow, before and after optimisation work, or when adding anything that scales with the scene (trees, chunks, shadows, particles).
---

# Performance check

Requires the Chrome DevTools MCP (`claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest`) and the dev server running (`cd game && npm run dev`).

## Three.js DevTools MCP (scene tree, draw calls, textures)
The repo's `.mcp.json` defines `threejs-devtools` (threejs-devtools-mcp 0.5.0) with `DEV_PORT=5173`, `BRIDGE_PORT=9222` and `BROWSER=none`, so it proxies `http://localhost:9222` to the Vite dev server without calling `set_dev_port` and does not open a browser on its own. It is off by default (`disabledMcpjsonServers` in `.claude/settings.json`, FEAT-174) because it otherwise starts, takes a port and opens a window with every chat, and never exits: ask Drew to turn it on in `/mcp` for this session, then open `http://localhost:9222` in the browser (the bridge needs that tab open) and turn it off again afterwards. If you also added it at user scope (`claude mcp add threejs-devtools-mcp ...`), remove that copy (`claude mcp remove threejs-devtools-mcp --scope user`) so the two do not fight over port 9222. Start `npm run dev` first; `bridge_status` should report port 5173. If 9222 is taken by something else the bridge picks another free port, so close stray bridge tabs or old servers first.

## Procedure
Chrome throttles requestAnimationFrame to 1 fps when another window covers it, which silently ruins a DevTools trace (check that the frames in it are not 1,000 ms apart). For numbers that repeat, use `cd game && npx vite build && node tools/playperf.mjs vail --gpu [--ablate] [--vsync]` (FEAT-086): the same real-play loop off screen, with per-system time, slow-frame causes, the heap and per-group cost. With vsync off (its default) frames queue and stall for 100 ms or more; judge stutter only with `--vsync`. Background: `docs/research/perf-pass-2026-11.md`.

1. `navigate_page` to `http://localhost:5173/?pack=vail` (or `synth`). Wait for the HUD to show a non-zero fps (`take_snapshot` and read `#hud`).
2. `performance_start_trace` with reload off. Hold ArrowUp for 10 s via `press_key` (the rider tucks and accelerates, which streams new chunks, trees and tiles), then `performance_stop_trace`.
3. `performance_analyze_insight` for long tasks and the main-thread breakdown; `evaluate_script` reading `window.__sim` for `terrain.stats` (chunks, triangles, builds) and `veg.stats.instances`; `list_console_messages` for warnings (shader recompiles, WebGL context loss).
4. Repeat with `emulate` CPU 4x slowdown to approximate a laptop.

## Budgets (desktop, 1080p, discrete or recent integrated GPU)
- Frame time: under 16 ms average, no main-thread task over 50 ms while riding (chunk builds and tile decodes are the usual culprits; cap `MAX_BUILDS_PER_FRAME` in `game/src/terrain/Terrain.ts` or move decoding to a worker).
- Draw calls: under 1,500. Terrain chunks are one call each (300 to 900); trees are 3 species x 2 LODs per loaded cell; lifts and rocks are instanced.
- Triangles: under 2M on screen.
- Tree instances in memory: under 1.5M; visible near-geometry instances under 150k.
- JS heap: under 600 MB; fine height tiles are 1 MB each as Float32, evicted beyond 3 km.
- Shadow map: 4096 x 4096 once; keep `castShadow` only on near chunks and near trees.
- GPU memory: terrain chunk geometry about 60 KB each; expect under 300 MB total.

## Record
Append a dated row to `docs/research/perf-log.md` (create it if missing): commit hash, pack, scene position, fps, frame time p95, chunks, triangles, instances, heap, and what changed. Regressions over 20% block the commit until explained.
