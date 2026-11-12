# Workspace layout and multi-session rules

Decided 2026-11-05. Drew runs more than one Claude session on this project. This is the contract between them.

## Single source of truth: this repo
- `drewkeriazes/SnowboardAnywhere`, branch `main`.
- Canonical checkout on Drew's PC: `C:\Users\Drew\git\SnowboardAnywhere`.
- The pipeline that builds packs is not here: since EPIC-16 it lives in the sibling clone `C:\Users\Drew\git\MapPacker-SnowboardAnywhere`, with its own `CLAUDE.md` and board rules. Raw data still sits in this checkout's `raw/` (gitignored); MapPacker reads it through `SBA_RAW_ROOT` until it moves there.
- Code that exists only in a session's cloud sandbox is not done. Every session attaches the repo, pulls `main` before starting, commits its work, and pushes. Rebase on conflict.
- Shared notes live in `docs/` here (mirrored to the claude.ai Project docs under `claude/`). The repo copy is canonical.

## Layout
```
SnowboardAnywhere/
  game/                              # Vite + TypeScript + Three.js 0.172 (src/pack, src/terrain, src/sim, src/world)
    tools/get_pack.mjs               # npm run get: a published pack from MapPacker, or --from a local build
  .claude/skills/                    # repo-local skills: render-check, perf-check, pr-feedback, ghost-lines, webapp-testing
  docs/
    bonvo-teardown-and-build-plan.md # plan of record
    workspace-and-sessions.md        # this file
    data/                            # what is in raw/, formats, fetch lessons
    research/                        # rendering, physics, vegetation, resort facts
  raw/      (gitignored)             # source data MapPacker builds from (~1.6 GB for Vail), until it moves there
  packs/    (gitignored)             # resort packs (npm run get, or --from a MapPacker build), served at /packs/<slug>/ by a Vite dev middleware
```

## Known divergences for code written before 2026-11-05 (the pipeline lines are history: that code is in MapPacker now)
- The 10 m mid ring is `raw/vail/dem10m/mid_{0,1}_{0,1}.tif` (four 2000 px quarters), not `mid.tif`. `build_pack.py` mosaics them from the manifest bboxes (no rasterio needed).
- The 1 m DEM is 64 chunks `dem_{i}_{j}.tif`, i,j in 0..7, 1500 px each.
- NAIP crops came back at 2048 px (about 2 m) regardless of the requested size; `build_pack.py` works at 2 m for imagery-derived masks.
- `raw/vail/osm/` has four or five files; `places_far.json` and `raw/vail/names/gnis.json` are optional.
- `game/vite.config.ts` serves `../packs` at `/packs/` through a dev middleware (not `publicDir`), so `packs/vail/` is at `/packs/vail/...` and the game loads `?pack=vail`.
