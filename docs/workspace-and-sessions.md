# Workspace layout and multi-session rules

Decided 2026-11-05. Drew runs more than one Claude session on this project. This is the contract between them.

## Single source of truth: this repo
- `drewkeriazes/SnowboardAnywhere`, branch `main`.
- Canonical checkout on Drew's PC: `C:\Users\Drew\git\SnowboardAnywhere`. Raw data lives at `C:\Users\Drew\Documents\snowboard-sim\raw` for now (pass it to `fetch.ps1 -RawDir` and `build_pack.py`), or move it to `raw/` inside the repo (gitignored).
- Code that exists only in a session's cloud sandbox is not done. Every session attaches the repo, pulls `main` before starting, commits its work, and pushes. Rebase on conflict.
- Shared notes live in `docs/` here (mirrored to the claude.ai Project docs under `claude/`). The repo copy is canonical.
- Do not run two fetches at once; the downloader assumes a single writer.

## Layout
```
SnowboardAnywhere/
  fetch_vail.cmd, fetch_static.cmd   # double-click launchers (Windows)
  pipeline/
    fetch.ps1, fetch_static.ps1      # downloaders (run on Drew's PC; data hosts are blocked from the sandbox)
    gen_manifest.py                  # resorts/<slug>.json -> manifests/<slug>.json
    extract_osm.py                   # PBF + GNIS -> raw/<slug>/osm/*.json, names/gnis.json
    manifests/, resorts/             # per-resort config and manifests
    build_pack.py                    # raw/<slug>/ -> packs/<slug>/ (packwriter.py shared with synth_pack.py)
    synth_pack.py                    # synthetic mountain in the pack format, for client work
  game/                              # Vite + TypeScript + Three.js 0.172 (src/pack, src/terrain, src/sim, src/world)
  .claude/skills/                    # repo-local skills: pack-build, render-check, perf-check
  docs/
    bonvo-teardown-and-build-plan.md # plan of record
    workspace-and-sessions.md        # this file
    data/                            # what is in raw/, formats, fetch lessons
    research/                        # rendering, physics, vegetation, resort facts
  raw/      (gitignored)             # downloaded source data (~1.6 GB for Vail)
  packs/    (gitignored)             # generated resort packs, served at /packs/<slug>/ by a Vite dev middleware
```

## Known divergences for code written before 2026-11-05
- The 10 m mid ring is `raw/vail/dem10m/mid_{0,1}_{0,1}.tif` (four 2000 px quarters), not `mid.tif`. `build_pack.py` mosaics them from the manifest bboxes (no rasterio needed).
- The 1 m DEM is 64 chunks `dem_{i}_{j}.tif`, i,j in 0..7, 1500 px each.
- NAIP crops came back at 2048 px (about 2 m) regardless of the requested size; `build_pack.py` works at 2 m for imagery-derived masks.
- `raw/vail/osm/` has four or five files; `places_far.json` and `raw/vail/names/gnis.json` are optional.
- `game/vite.config.ts` serves `../packs` at `/packs/` through a dev middleware (not `publicDir`), so `packs/vail/` is at `/packs/vail/...` and the game loads `?pack=vail`.
