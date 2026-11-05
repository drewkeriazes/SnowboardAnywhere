# SnowboardAnywhere – working notes for Claude

- Stack: Three.js 0.172 + TypeScript + Vite in `game/`; Python (rasterio/numpy/scipy/shapely/laspy) in `pipeline/process/`; PowerShell fetch scripts (`pipeline/fetch.ps1`, `pipeline/fetch_static.ps1`) run on Drew's PC.
- Plan of record: `docs/bonvo-teardown-and-build-plan.md`. Follow its data sources, pack format and milestones; update it when a decision changes.
- Data hosts (USGS, Planetary Computer, Overpass, Mapterhorn, OpenSkiData) are NOT reachable from the cloud sandbox. Fetch runs on Drew's PC; processing can run anywhere on the staged raw files.
- Canonical checkout on Drew's PC: `C:\Users\Drew\git\SnowboardAnywhere`. Raw data lives at `raw\vail\` inside it (gitignored). Every session attaches this same GitHub repo (drewkeriazes/SnowboardAnywhere) and commits to it; nothing lives only in a sandbox.
- Research and data notes live in `docs/` (index: `docs/README.md`). Read `docs/data/vail-raw-data-inventory.md` before touching raw data, and the matching `docs/research/*.md` before starting a milestone. The claude.ai Project docs are a mirror; the repo copy is canonical.
- Do not run two fetches at once; the downloader assumes a single writer.
- All game-space coordinates are local metres (UTM, resort origin in `meta.json`). Never put lat/lon in the renderer or physics.
- Typecheck before committing: `cd game && npx tsc --noEmit`.
- Do not assert Bonvo internals from memory; the verified capture is in the plan doc.
- No em dashes in prose.
