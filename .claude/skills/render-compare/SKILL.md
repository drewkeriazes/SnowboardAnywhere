---
name: render-compare
description: Make a before / after slider of two game builds (an old commit's saved baseline, this worktree, an experiment build) with their own packs, shot from the exact same world camera on Drew's GPU, with game/tools/compare.mjs. Also keeps baselines (an old commit built once with its pack, untracked). Use when Drew asks to compare looks between commits, builds, packs or settings, wants a before / after or A/B, wants to see how far the game has come, or wants an experiment judged against main.
---

# Render comparison (before / after slider)

Drew's preferred output is the **slider page with the two stills side by side under it**. Give him its full path. A
static side-by-side PNG alone is not enough.

## Run (from `game/` on Drew's PC, after `npx vite build`)
```
node tools/compare.mjs baselines                                            # what is saved
node tools/compare.mjs --a baseline:aaa8454 --b here --shot back-bowls      # first real Vail against this build
node tools/compare.mjs --a here --b dist:dist-exp --b-query "&myFlag" --view sign-sunup
node tools/compare.mjs --a here --b here --b-settings forestDensity=0 --view aerial --name crowns-only
node tools/compare.mjs --a here --b here --b-packs ../../MapPacker-SnowboardAnywhere/packs --shot back-bowls   # a fresh MapPacker build
```
- Sides: `here` (this worktree's `dist/`), `dist:<path>` (another build folder, relative to `game/`; build an experiment with `npx vite build --outDir dist-exp` and revert the source), or `baseline:<name>`.
- Per side: `--a-packs` / `--b-packs` (a folder holding `<slug>/meta.json`), `--a-query` / `--b-query` (URL flags), `--a-settings` / `--b-settings k=v,...` (seeded saved settings, e.g. `forestDensity=0`), and `--a-label` / `--b-label`.
- `here` and `dist:` read packs from `SHOT_PACKS` or the repo's `packs/` (`npm run get vail` first).
- Camera: `--shot <id>` (the menu shot, at the start of its drift and in its conditions), `--view <label>` (`tools/canopy-views.json`) or `--at x,y,h,pitch,fov,eye`. a = left / before, b = right / after.
- Output: `game/shots/compare/<name>/index.html`, plus `a.jpg`, `b.jpg` and `compare.json`.
- Check the "cameras match exactly" line. `compare.json` has each side's world camera and direction, its pack build, and the drawn crown cover (crown disc area / ground) at 250, 600 and 1,500 m round the camera.

## Baselines (old builds kept for later)
- `node tools/compare.mjs baseline <ref> --pack-release vail-v1 --slug vail [--name N] [--notes "..."]` checks the commit out in a temp worktree, runs its own `npm ci` / `npm install` and `vite build`, and keeps `dist/`. It downloads the release zip into `packs/<slug>/` and writes `baseline.json`. You can also pass `--from-dist` / `--from-pack` instead.
- Baselines live in `<main checkout>/baselines/<name>/`. That folder is gitignored and every worktree sees it. Never commit them.
- Saved so far: **`aaa8454`** (2026-11-05), the first commit that drew real Vail, with vail-v1. Read its `baseline.json` notes:
  - free camera only;
  - trees spawn round the rider, as black cones of 0.234 h (spruce) and 0.378 h (every other conifer id);
  - no stems, cover or far trees;
  - its own 11-05 pack is gone; vail-v1 loads in it, and its `trees/` is byte-identical to v4.

## Picking a pack an old commit can load
- Packs are GitHub releases on MapPacker, tagged `<slug>-v<N>` with a dash (`vail-v1`). `RELEASES.md` shows `vail/v1`, but `gh release download vail-v1 -R drewkeriazes/MapPacker-SnowboardAnywhere`.
- Check `meta.json` `version` and the `terrain` layout against the old commit's `game/src/pack/types.ts`. Format 1 has loaded back to the first client.
- Raw data to rebuild an old pack is in `C:\Users\Drew\Documents\snowboard-sim\raw\<slug>` (and the game checkout's `raw/`), but the old pipeline is slow. Try a release first.

## Gotchas already paid for
- **Wait for the terrain to finish building.** Old builds build at most 10 chunks a frame. A still taken while the stats merely repeat shows see-through ground, with trees and lift towers visible through the hill. The tool waits for builds, pending tiles and veg loading to read 0 three times in a row.
- **Pin the camera in world height, every settle step.** Eye height is over `groundHeight`, which changes as tiles land and differs between packs.
- **The eye camera clamps eye height to 200 m** (`updateEye`). The `aerial` view's `"eye": 700` is really 200 m, in `canopy_compare.mjs` too. The old free camera has no clamp, so an old side as the reference would sit higher. The match check warns.
- **The old free camera** uses yaw clockwise from north, forces fov 70 each frame (the tool holds the shot's fov), and loads trees round the RIDER: the tool passes `x`, `y`, `h` so the rider spawns under the camera.
- **Saved settings** apply only with `v: 1` in the `settings` object. Check `__sim.veg.stats.stems` (0 with Forest 0).
- Real GPU only (`--gpu`; the first line names the GPU). Python with PIL is `python -E -P` here, not `-I`.
- Old builds take today's npm and Playwright fine. If an install or build fails, try a couple of times, then report what broke rather than digging in.

## When it is about trees
The background on the tree findings (lidar crowns vs generated stems, crown widths, the canopy cover check) is in
`C:\Users\Drew\Documents\snowboard-sim\notes\2026-11-13-vail-before-after\FEAT-292-notes.md`. Compare the drawn
crown cover in `compare.json` with the lidar canopy share before calling a width change "fuller": the shipped game
already matches the lidar's cover near the Back Bowls sign.
