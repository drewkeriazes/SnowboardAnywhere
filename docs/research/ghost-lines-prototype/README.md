# Ghost lines prototype (FEAT-181)

How the 24 backdrop ghost takes on Vail (`game/public/attract/vail/line-*.json` and `line2-*.json`) were made, by
hand, in the FEAT-177 / FEAT-179 session (PR #420, 2026-11-10). It is the starting point for FEAT-181 (#423): a
`game/tools/ghost_lines.mjs` that takes a menu screenshot with downhill lines drawn on it and writes the ghosts.

Drew's two screenshots are in `docs/screenshots/ghost-lines/` (JPEG copies; see Extraction for why the line
data here came from the PNG originals).

## The steps, and the scripts

Run from the repo root after `cd game && npx vite build` (the scripts serve `game/dist` and `packs/` like the
check tools, on the GPU).

1. `extract_lines.py <screenshot> <spec.json> <out.lines.json>`: the coloured lines as pixel polylines.
   `vail-1.spec.json` and `vail-2.spec.json` are the colour bands and screen boxes used; `vail-1.lines.json` and
   `vail-2.lines.json` are the result from the original PNGs.
2. `fit_and_cast.mjs <pack> <in.lines.json> <out.world.json> --top <px> --height <px> --fov <deg> --obs '[[x,y],[x,y]]'`:
   fits the screenshot's camera to two landmark points and casts every line pixel onto the terrain.
   `vail-1.world.json` and `vail-2.world.json` are the results.
   - Screenshot 1 (browser window, canvas from y 52, 911 px tall, cropped on the right): drift phase k 0.44, image
     centre x 972, fit error 6.1 px, footing tops at (1067.5, 639) and (1315, 655).
   - Screenshot 2 (full screen, canvas from y 10, 911 px tall, 1919 wide): k 1.0, centre x 958.5, error 6.9 px,
     footing tops at (1047.5, 625) and (1315, 642.5).
3. `ride_lines.mjs <pack> <in.world.json> <out dir> --prefix <name>`: rides each line with the rider physics, two
   riders per line, and writes the takes. Copy them to `game/public/attract/<pack>/` and add them to
   `index.json`. `vail-2.world.json` reproduces the `line2-*` takes exactly. The `line-*` takes (screenshot 1) came
   from an earlier version of the ride script (longest-run, crest and near-camera rules not yet in), with outfits
   picked by hand.

`common.mjs` opens the headless page (`?pack=<slug>&headless&cam=eye`, `window.__sim`) the other two use.

## What each step learned

**Canvas and camera.** The screenshot is a browser window or a full screen, with Chrome's bars above and the
Windows taskbar below; find the rows where the game starts and ends (a flat colour change). The vertical fov is
the shot's own (50 degrees on Vail), so the focal length in px is (canvas height / 2) / tan(fov / 2) whatever the
window width. The menu camera drifts (`shotPose`: 4 m dolly and 1.5 degrees of pan over 26 s), so the screenshot's
pose is unknown along that drift; the window may also be cropped, so the image centre is unknown. Both were fitted
to the two footing tops of the Back Bowls gateway (0.88 m above the snow, `world/Landmarks.ts`), scanning k in
0..1 in steps of 0.02. A resort without a landmark needs another fit: the open design question on the card.

**Extraction.** Hue bands with saturation over 0.45 and value over 90: a pure (255, 128, 255) pink has saturation
0.498, so 0.5 misses it. Black lines are (0, 0, 0): max channel under 6 (shaded trees are darker than you'd think
but not 0). A colour used twice (yellow, pink and purple on screenshot 2) is split by screen box. Keep UI out of
the boxes: the taskbar's yellow weather icon was read as a line. Lines are bucketed into 6 px cells and walked
greedily from the cell farthest from the mean. Extract from the PNG: on the JPEG copies the thin pink strokes break
up (compression shifts their colour) and walk only 1 or 2 cells.

**Casting.** Ray-march each pixel 1 m at a time against `pack.groundHeight`, then bisect. The cast is only a guide:
where a line crosses an edge (the near ridge, the skyline, the sign, trees) neighbouring pixels land hundreds of
metres apart on different slopes, and a line that runs along a gully alternates between its near and far sides.
On screenshot 1 the lines went 1.1 to 1.4 km out on the far slope; blue's last points hit the near ridge (a 990 m
jump); purple started 25 m from the camera and dropped off the ridge. On screenshot 2 red ran onto mountains
2.9 km out above the skyline, and right yellow zigzagged across the sign.

**Riding: what failed first.**
- Pure pursuit of the smoothed raw line with the physics: 5 of 6 lines crashed or wandered 100 to 250 m off.
- A kinematic rider moved along the line (speed from the slope, pose fields fitted to Drew's takes:
  `lg ~ 0.87 * v * turn rate / g`, `e ~ 0.71 * lg`, lean 0, `h = hd`): it followed the drawn line exactly, so it
  rode through faces the camera can't see and was hidden for 80 to 100 s at a time. Drew: the lines are a guide,
  you can't draw down a face we can't see.
- Edge catches and washouts: a new `Rider` has the Realistic fall line (`fallLine = 1`), whose catches crash a bot
  that traverses; full steer at speed washes out. Fall line off and steer capped at 0.75 (gain 1.6) fixed both.
- Stalls: a waypoint up the far side of a dip; skip waypoints not below the rider, and skip after 2 s under 2.5 m/s.
- Starting over a crest: backing the start up until out of sight crossed the skyline, so the rider had to climb
  back and stalled at 6 m/s. Beyond 300 m, stop backing up where it would climb (the rider comes over the crest,
  the game fades it in). Near the camera keep backing up until out of frame, and start at 8 m/s.
- A simulated partner on the same waypoints drifted up to 470 m away (it stalled and skipped differently); one
  following the lead's ridden line drifted 90 m. The partner as a shifted copy of the lead's take (5 m across,
  0.5 s back) stays 5 to 11 m away on every line.

**What worked** is in `ride_lines.mjs`, commented: the longest run of each cast line (split at jumps over
max(30 m, 5% of the distance)), every run of 5 or more points when the rider is then never on screen (right cyan on
screenshot 2), ridden from the high end; waypoints that keep descending, about 6% of their distance apart (8 to
50 m); a 7 m carving swing on a 40 m wave; brake over 16 m/s; past the last waypoint down the fall line; end 1.5 s
after the rider is out of sight (frustum plus terrain occlusion from the shot's pose at t = 0); the partner on the
other side if it would start in view close up; both trimmed to 1 s before the first of them comes into sight.
Results on screenshot 2: 12 leads, every waypoint reached, no crashes, 20 to 56 s each, pairs 5 to 11 m apart.

## In the game

- Every take now starts from its beginning when the menu goes live and loops on its own length (FEAT-179, Drew's
  call). A take that starts in frame is at opacity 0 on the crossfade frame and fades in over 0.5 s; one that ends
  in frame fades out. `backdrop: true` only marks the generated takes.
- Recorded takes of the same line pass through each other when they start together (takes 11 and 12 come within
  0.3 m, 1 and 5 within 0.7 m). Generated riders of one line must keep their gap (check every sample, 2.5 m at least).
- Cost: each rider is 19 meshes, so draw calls, not triangles, are what riders cost (about 8 us of CPU per call).
  With 52 takes and about 46 on screen they first added about 6 ms a frame on Drew's GPU (1,128 calls against 493
  with none). `AttractGhosts.update` now skips riders behind the terrain, poses far riders less often and draws them
  with named mesh LODs (`MID_KEEP` past 80 m, `FAR_KEEP` past 250 m: board or skis, torso, sleeves, pants), which
  brought it to about 4.8 ms and 956 calls; Drew judged that good enough. Picking LOD meshes by size was wrong (a
  far skier kept only skis and poles): keep them by name, and name any new rider part. FEAT-182 (#424) batches the
  far riders into one draw. A generator should treat riders as a budget, not free.
- Visibility: far riders are about 2 px tall and Drew sees them clearly (they move on white snow). Judge on a
  rendered frame, never from the pixel size.
- To compare two renders of one moment: a headless page, load the takes (`__sim.ghosts.load('./', files)`), put the
  camera on `shotPose(0)`, `ghosts.restartOutOfView(camera)`, step the ghosts with `ghosts.update(dt)` to the moment,
  then `__shot()` twice with the change in between. Two grabs from the live menu differ by the drift and riders moving.
- Takes recorded on a dev server from the main checkout land in that checkout, and once files are moved out the
  recorder reuses their numbers (take-6 several times, and one take saved twice): number from the highest existing
  take, and save into the worktree the server runs from.

## Learnings (FEAT-181, `game/tools/ghost_lines.mjs`)

The tool replaces these scripts (`docs/developer-guide.md` > Ghost riders from lines drawn on the menu). One line per
change the build or a resort needed: what broke, what changed, the config key in `game/tools/ghost_lines.config.json`.

- **No landmark (Breckenridge has none).** The snip is fitted to frames of the shot rendered across the drift (11
  phases, 2600 px wide at the shot's fov): FFT cross-correlation of edge images over scale at low resolution, then a
  local search for scale, offset and phase at 256, 512 and 1024 px. On Drew's snips it matched the landmark fit within
  2 px (vail-1: k 0.4, centre x 974, canvas 912 px from y 52; vail-2: k 1, centre 960, 909 px from y 11) in about
  20 s, though both snips are from a build before the snow-flocked trees. `fit.*`.
- **Drawing on the tool's own frame** (`draw-<shot>.png`, no UI, drift at its start) needs no fit, and its clean copy
  is the exact "not in the render" reference, so nothing but the strokes is found.
- **The canvas** is the render's footprint in the snip (its full height): a colour test per row fails because the
  menu darkens the backdrop behind its text and cards.
- **UI in a snip**: the RIDE button (filled: a 7 x 7 block of the colour inside), the selected card (a rectangle
  outline, or just its straight bottom edge), the sky (filled) are dropped by shape, not by place.
- **Hue alone mixed a dark purple and a light pink** (vail-2's right purple joined pink): a pixel joins the hue peak
  nearest in hue + 0.3 x value. `extract.valueWeight`, `extract.joinCost`. Clustering in RGB instead split every JPEG
  stroke into several colours (edges blend with the snow); not used.
- **Hue peaks were relative to all coloured pixels**, which a blue sky in the snip dominates; small lines (green, teal)
  were missed. Now an absolute floor (30 px) and 0.2% of the total.
- **JPEG**: light pink drops to saturation 0.42 and pure black breaks up. `extract.jpeg` (saturation 0.33, black under
  12) applies to .jpg input only. On an old-build snip the dark pines are not dark in today's render, so they read as
  black lines (or a scribble, dropped when its walk is over 4 x its box diagonal).
- **A stroke broken where it crosses another line** (vail-2's right yellow): two of one colour whose ends are within
  30 px join. `extract.joinPx`.
- **Near lines (under about 80 m) were ignored**: an 18 m "reached" radius swallowed a 25 m line, and the 7 m carving
  swing and 16 m/s brake are far-line numbers. Reach is 0.6 x the waypoint spacing there (3 to 18 m), the swing fades
  out inside 200 m (none inside 30 m) and the speed is held to 0.15 x the distance from the camera (6 to 16 m/s).
  `waypoints.reachFrac`, `waypoints.minM` (now 4), `bot.swingNearM`, `bot.swingFullM`, `bot.brakeFrac`, `bot.brakeMin`.
  Far lines ride as before (vail-2 trial: 11 leads, every waypoint, no crashes, 15 to 57 s, pairs 4.9 to 11.4 m).
- **The start backed up along the first leg**, which on a wiggly line points sideways: now along the line's direction
  over its first 40 m (or quarter).
- **Takes of different lines pass through each other** too: `check` lists pairs closer than 2.5 m while both are in
  frame. On Vail's current set: 7 pairs (takes 1, 3, 4, 5, 14 against generated takes, and two between generated lines).
- Drew: riders too far out to see are fine; the report says so but doesn't count it.
