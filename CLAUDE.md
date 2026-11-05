# SnowboardAnywhere – working notes for Claude

- Stack: Three.js 0.172 + TypeScript + Vite in `game/`; Python (rasterio/numpy/scipy/shapely/laspy) in `pipeline/process/`; Node fetch scripts in `pipeline/fetch/`.
- Plan of record: `docs/bonvo-teardown-and-build-plan.md`. Follow its data sources, pack format and milestones; update it when a decision changes.
- Data hosts (USGS, Planetary Computer, Overpass, Mapterhorn, OpenSkiData) are NOT reachable from the cloud sandbox. Fetch runs on Drew's PC; processing can run anywhere on the staged raw files.
- All game-space coordinates are local metres (UTM, resort origin in `meta.json`). Never put lat/lon in the renderer or physics.
- Typecheck before committing: `cd game && npx tsc --noEmit`.
- Do not assert Bonvo internals from memory; the verified capture is in the plan doc.
- No em dashes in prose.
