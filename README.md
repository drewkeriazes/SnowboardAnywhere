# SnowboardAnywhere

Browser snowboard game that rebuilds real resorts at 1:1 from topographic data (1 m lidar DEM, canopy-segmented trees, NAIP masks, OSM and OpenSkiData features). Three.js + TypeScript + Vite. First resort: Vail.

Reference and design rationale: `docs/bonvo-teardown-and-build-plan.md`.

## Layout

- `game/` – the client. `cd game && npm install && npm run dev` → http://localhost:5173
- `pipeline/fetch/` – Node scripts that download raw inputs for a resort (run on a machine with open internet): `node pipeline/fetch/fetch-resort.mjs vail`
- `pipeline/process/` – Python that turns raw inputs into a resort pack: `python pipeline/process/build_pack.py vail`
- `packs/` – generated resort packs (gitignored), served by Vite as static tiles
- `docs/` – plans and notes

## Milestones

M0 pipeline (Vail) → M1 terrain viewer → M2 riding physics → M3 trees and rock → M4 lifts and landmarks → M5 snow and atmosphere → M6 second resort, timed runs, multiplayer.
