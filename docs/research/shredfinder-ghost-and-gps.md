# Research: ShredFinder data for a ghost rider and for resort mapping

Researched 2026-11-06 from the ShredFinder repo (github.com/drewkeriazes/shredfinder) and its checked-in GPMF test dumps.

Epic: import a real GoPro run from ShredFinder and replay it in the game as a ghost that follows Drew's actual line down the mountain. Side question: can the same data improve our resort maps?

## 1. What ShredFinder has today

- Python package `shredfinder/`. `telemetry.py` pulls the GPMF track out of a GoPro MP4 with ffprobe/ffmpeg, `gpmf_parser.py` decodes it, `detector.py` finds jumps, spins, speed peaks and crashes, `gpx_export.py` writes a GPX track, `trail_map.py` draws a map. Plus a FastAPI + React web editor for cutting clips.
- Per file it builds pandas DataFrames: `gps_df` (ts_sec, lat, lon, alt_m, speed_2d_ms, speed_mph), `accl_df` and `gyro_df` (200 Hz), and segments classified as `riding`, `chairlift`, `stationary`.
- Events carry `peak_ts`, `airtime_sec`, `spin_degrees`, `peak_speed_mph`, `crash_severity`, `confidence`.

### What the real files contain (checked with the parser on the 4 test dumps)
- Camera: **HERO11 Black**.
- Streams present: ACCL, GYRO, GPS5, GPS9, GPSF (fix), GPSP (DOP), GPSU (UTC time), **CORI** (camera orientation quaternion), **GRAV** (gravity vector).
- GPS rate: **10 Hz** (10 samples per ~1 s block).
- None of the test dumps are from a mountain. One has a fix (recorded 2022-12-26 near home, 2D fix, DOP 3.1); three have no fix at all. GPS altitude in that file swings 120 m in under a minute, so **GPS altitude is useless; take height from our DEM**.
- We need one real ride MP4 (or its GPMF dump) from the PC to validate anything below.

### Gaps to fix in ShredFinder before it feeds the game
1. GPSF and GPSP are parsed past but thrown away, so there is no way to drop bad fixes. Keep them as `fix` and `dop` columns.
2. Timestamps are synthesised as `block_index + i/n`, assuming 1 s blocks. Measured drift on the test file: 56 blocks over 56.4 s (about 0.7 %). Fine for now; use GPSU for absolute time later if we sync with other riders.
3. CORI is not parsed. It gives the camera's orientation for free, which is the best source for the ghost's body heading and lean.
4. `gpx_export.py` writes event waypoints at lat 0, lon 0 (bug). Events need a position looked up from `gps_df` at `peak_ts`.

## 2. Ghost rider: the simple version

Keep the split we already have: ShredFinder exports, the SnowboardAnywhere pipeline converts, the game replays.

**Step 1, ShredFinder: `shredfinder ghost <mp4> -o ride.json`** (new command, ~80 lines)
```json
{
  "camera": "HERO11 Black",
  "start_utc": "2027-01-14T16:02:11Z",
  "gps": [[t, lat, lon, speed_ms, fix, dop], ...],
  "segments": [{"start": 0.0, "end": 312.4, "activity": "riding"}, ...],
  "events": [{"type": "jump", "t": 41.2, "airtime": 0.8}, ...]
}
```
Raw values only, no smoothing here. Later: add `cori: [[t, w, x, y, z], ...]` at 10 Hz.

**Step 2, pipeline: `pipeline/ghost_build.py <ride.json> <slug>`** (~120 lines, numpy + pyproj, both already deps)
1. Keep riding segments only; drop points with fix < 2 or dop > 5.
2. lat/lon to EPSG:26913 with pyproj, subtract the pack origin from `meta.json`, same as every other feature.
3. Smooth x, y: Savitzky-Golay over ~1.5 s (scipy) is enough to start. Upgrade to a Kalman/RTS smoother using `speed_ms` only if the line looks jittery.
4. Optional snap: if a point is within 15 m of an OSM piste way, pull it 50 % toward the centreline. Off-piste points are left alone.
5. z = bilinear sample of the 1 m DEM. Ignore GPS altitude.
6. For each jump event, add a ballistic hop: `z += g * u * (airtime - u) / 2` for u in [0, airtime].
7. Resample to 20 Hz and write `packs/<slug>/ghosts/<ride_id>.json`: `{"t": [...], "x": [...], "y": [...], "z": [...], "speed": [...]}` plus heading computed from the path.

**Step 3, game: `Ghost.ts`** (~100 lines)
- Load the ghost JSON, draw a translucent rider plus a fading trail line.
- Clock starts when the player drops in at the ghost's start point; position is linear interpolation by time, heading from the path tangent.
- No physics, no collisions. It is a recording.

**Later, cheap wins**
- Picture-in-picture: the video and the ghost share one clock, so a corner window can play the real GoPro footage in sync.
- Race your ghost: timed runs (M6) with the ghost as the target time.
- Body lean from CORI instead of the path tangent.

## 3. Can ShredFinder data help the maps?

Short answer: not for terrain or trees (several metre GPS cannot beat 1 m lidar), but yes as a **reality check and a physics tuning source**.

| Use | How | Value |
|---|---|---|
| Physics tuning | Real speeds per run and slope (we know the run and the DEM pitch at every point). Compare to the targets in `rider-physics.md` | High. Real numbers beat guesses |
| Run polyline check | Overlay ridden tracks on OSM pistes; big offsets mean a bad OSM line or a missing connector/cat track | Medium |
| Lift check | `chairlift` segments are lift lines; compare to OSM aerialway ways and our tower positions | Low, OSM is already good |
| Surface check | ACCL vibration variance per run should be high on bump runs and low on corduroy; compare with our groomed/chop masks | Medium, later (M5) |
| Visual reference | Grab frames from the video at known positions to compare our render to reality | Medium, good for screenshots |
| Terrain heights | No. GPS altitude is too noisy | None |

## 4. Order of work
1. Drew: drop one real ride MP4 (or just its GPMF dump, `ffmpeg -i in.mp4 -map 0:3 -f rawvideo ride.bin`) into a shared folder.
2. ShredFinder: keep fix/dop, add `ghost` export, fix the waypoint bug.
3. SnowboardAnywhere: `ghost_build.py`, then `Ghost.ts`.
4. Validate: ghost line over the top-down render and the trail map; speed per run vs our physics.

## 5. Where Drew's footage lives (checked 2026-11-06)

All clips are HERO11 Black. Originals are `GX01xxxx.MP4`; files with a long numeric suffix (`GX010181_1706100760011.MP4`) are short trims made in the GoPro app, skip them.

| Resort | Dates | Clips (riding-length) | Where |
|---|---|---|---|
| **Vail** | 2024-01-22 to 01-24 | GX010166 to GX0101xx, ~25 clips, ~77 min | GoPro cloud (gopro.com/media-library) |
| **Vail** | 2024-02-10 to 02-11 | GX010190 to GX010207, ~17 clips, ~43 min | GoPro cloud |
| **Breckenridge** | 2023-01-07 (folders "Day 1" and "Day 2") | GX010046 to GX010102, ~43 clips, ~55 GB | `M:\GoPro\Breck Day 1\`, `M:\GoPro\Breck Day 2\` (external SSD); also GoPro cloud. `G:\Photo Storage\gopro\` holds copies of GX010100 to 102 |
| Park City | 2023-02-06 to 02-09 | GX010103 to GX010114 | `M:\GoPro\Park city\` and GoPro cloud |
| Unknown, ask Drew | 2023-01-02 (17 clips), 2025-01-03 (14 clips) | | GoPro cloud |

Good first test clips: Vail GX010182 (1.9 GB, 4.2 min, 2024-01-23), Breck `M:\GoPro\Breck Day 1\GX010070.MP4` (1.6 GB).
Open question: does the GoPro cloud download keep the GPMF telemetry track? Verify on the first download before pulling more.
