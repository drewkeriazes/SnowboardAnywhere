# ghost_lines: how to give a resort its main menu (playbook for agents)

`game/tools/ghost_lines.mjs` takes a resort from "no menu backdrop" to "a menu shot, its still and ghost riders"
(FEAT-181). Read this page first; it is the short path. Background only if you need it: the method and its history
in `docs/research/ghost-lines-prototype/README.md` (Learnings at the end), the reference for people in
`docs/developer-guide.md` > Ghost riders from lines drawn on the menu.

All commands run from `game/` on Drew's PC (they need the GPU and `packs/<pack>`). Rebuild first and after any
change under `game/src`: `npx vite build` (the tool serves `game/dist`). Each step takes 20 s to 3 min.

## The recipe for a new resort (what worked on Breckenridge, 2026-11-10)

1. **Start a dev server for Drew** on the worktree (`npx vite --port <free> --strictPort`, CLAUDE.md "Dev servers on
   demand") and give him the link: `http://localhost:<port>/?pack=<pack>&debug&cam=eye`.
2. **Drew picks the shot.** In that tab: click the game, fly the eye camera (mouse to look, WASD, Q / E height, [ ]
   zoom; the menu's title covers the top-left third and the cards the bottom 20%), then **Shift+P** (plain P is the
   compare photo). The form: "Use as menu shot" (Enter) or "Keep as a candidate" to compare several. To compare:
   `node tools/ghost_lines.mjs <pack> candidates` (renders each into `game/shots/ghost-lines/<pack>/candidates/`, show
   Drew the PNGs), then `node tools/ghost_lines.mjs <pack> pick <name>`. A shot saved with no server answering
   downloads `shots.json` to Downloads: `candidates <that file>` takes it.
3. **The still and the drawing frame:** `pick` does this, or `node tools/ghost_lines.mjs <pack> still`. It renders
   `game/public/attract/<pack>/<shot>.jpg` and `game/shots/ghost-lines/<pack>/<shot>/draw-<shot>.png`.
4. **Drew draws lines** in Paint on `draw-<shot>.png`, one strong colour per line, downhill (a colour can repeat far
   apart; black works). A browser snip with lines on it works too, and so does a screenshot of the Paint window; he
   pastes images into the chat, which land in this session's `images/` folder.
5. **Read them:** `node tools/ghost_lines.mjs <pack> lines <img> [<img2> ...]`. Look at the `lines*.png` it writes
   and list the lines for Drew. A line that reads wrong: **ask Drew to redraw just that line** (on the clean frame) and
   pass both images; a colour in a later image replaces it. Don't tune code for one stroke.
6. **Ride the far lines with the bot:** `node tools/ghost_lines.mjs <pack> ride [--per ...]`. Default per line: 3
   variants of 2 riders, sent off at intervals. Then show Drew the menu: `http://localhost:<port>/?pack=<pack>`
   (takes load from disk; he just reloads).
7. **Near the camera, use Drew's own riding.** Ask him to record a run or two on that slope: with `&debug` (not
   `cam=eye`), ride, K for the replay viewer, I at the start, O at the end, L to save. It lands as
   `game/public/attract/<pack>/take-<n>.json`. Then `node tools/ghost_lines.mjs <pack> takes take-1.json take-2.json`:
   each run trimmed before any fall, carried on down the slope, and copied into 3 staggered variants with partners.
   Drop the bot's lines those runs replace: `ride --per "orange:0,red:0"`. **Ask which bot riders to replace**; Drew
   wanted only the wobbly near ones gone, not all of them.
8. **Check:** `node tools/ghost_lines.mjs <pack> check --no-open`: still against the live menu (must say ok), riders
   closer than 2.5 m on screen (crossing paths once is fine; riding on top of each other is not), the draw calls they
   add. Revert the re-rendered still if only tree sway changed (`git checkout <shot>.jpg`).
9. **Commit** `game/public/attract/<pack>/` (shots.json, the still, take-*.json, the generated takes) and
   `game/public/attract/index.json`. Note anything learned in the prototype README's Learnings.

`node tools/ghost_lines.mjs <pack>` alone is a wizard that runs the next step the resort needs;
`node tools/ghost_lines.mjs <pack> status` says where it is.

## Options

- `--per` by colour or line name, comma-separated: `red:3` (3 riders), `blue:2:ski` (on skis), `yellow-2:3:1ski` (one
  of 3), `pink:0` (none), `green:2:straight` (a straightliner: tucked, no turns, fast; one variant unless `:v3`).
- `--riders N`, `--variants N` for every line; `--trial` writes the takes to the work folder only (for tuning).
- `extend <take>`: a recorded take that ends in view goes on down the slope (the bot), the original kept.
- `ride --takes a.json,b.json`: ride recorded runs as lines with the bot instead (`ridden-<n>`); `takes` is better.
- `ride` and `takes` each replace only their own takes for the shot (`*-run-<n>-*` are `takes`'); a new shot removes
  all the old shot's generated takes. Recorded `take-*` files are never deleted.
- Tunables: `tools/ghost_lines.config.json` (the Vail and Breckenridge values as defaults, `resorts.<slug>` for
  overrides). `GHOST_DEBUG=1` prints the colour peaks.

## Reading the output

- **Fit** (snips only): match 0.6 to 0.8 is good, under 0.3 means another shot or pack. Scale 0.84 is Drew's browser
  window, 1.0 a full 1080 frame; phase k is 0 for anything taken in the eye camera or Paint.
- **Lines**: named by colour, numbered left to right when a colour repeats (`yellow-1`). Strokes of one colour broken
  at a crossing join (up to 70 px, when the gap continues them); a sharp hook at the crossing doesn't: ask for a redraw.
- **Ride report**: crashes 0; `reached` every waypoint; lead to partner about 4 to 12 m; start "out of sight" or "far
  crest". "End in view (fades out)" is normal where the camera sees down a whole valley. `line used 80/126 pts` is the
  stretch of the cast the camera sees: a line drawn over a rim keeps only its visible part, on purpose.
- **Far riders** a few px tall or briefly on screen are fine (Drew).
- **Cost**: Breckenridge's 32 riders add about 380 draw calls at 1920 x 1080 (`check`). FEAT-182 (#424) batches far ones.

## Gotchas already paid for (don't rediscover)

- **The bot's wobble was the brake**: the physics brake swings the board 84 degrees across and back. The bot rides
  linked turns along a smoothed line, controls speed by how wide it turns, and brakes only 6 m/s over the speed it
  wants. Compare a change against Drew's own takes: his edge changes 0.17 to 0.4 times a second, skids 1 to 5% of the
  time, and is airborne 16 to 27% of it on Imperial Bowl.
- **Crashes on landing**: a bot steering in the air lands crooked, and a crooked landing over an impact of 8 crashes
  without a grab (`sim/rider/Tricks.ts`). The bot grabs and lets go of the steering in the air.
- Moguls (`pack.mogulAmp`): the bot slows to `bot.mogulOver` there and doesn't tuck.
- "In sight" (starts, cuts, ends) is judged in the menu's 1920 x 1080 frame; casting uses each image's own fit.
- Line colours: hue peaks are picked busiest first, 15 degrees apart (a red roof once hid an orange line); JPEG input
  gets softer thresholds (`extract.jpeg`), but PNG is better.
- Snips from an older build: the render changed (white snow-flocked trees), so dark pines in an old snip read as black.
- Writing edit scripts through bash heredocs mangles backslashes and `\n`: write them with the Write tool.
- Paint doesn't save until Ctrl+S: check the file's time before reading; a screenshot of the window works meanwhile.

## Files

- Shot: `game/public/attract/<pack>/shots.json` (the menu uses the first). Still: `<shot>.jpg`, with its look key in
  `index.json`.
- Takes: `game/public/attract/<pack>/<shot>-<line>[-v<n>]-<i>.json` (`backdrop`, `shot`, `build`, `delay`, `every`),
  listed in `game/public/attract/index.json` under `ghosts` and `shotGhosts.<shot>`.
- Work (gitignored): `game/shots/ghost-lines/<pack>/` candidates, and per shot clean.png, draw-<shot>.png, lines.json,
  lines-*.png, world.json, report.json, ride.png (the lines as cast and each line's first ride), menu-t*.png.
- Code: `tools/ghost_lines.mjs` (steps), `tools/ghost_lines/image.mjs` (fit, line finding), `tools/ghost_lines/page.mjs`
  (in the game page: cast, ride, takes, pictures), `tools/attract_files.mjs` (the attract files, shared with the dev
  server). Game side: `world/AttractGhosts.ts` (`delay` / `every`), `world/AttractShots.ts` (shots as data),
  `ui/MenuShotForm.ts` and `session/devSaves.ts` (Shift+P).

## Regression after changing the tool

Vail keeps its hand-made `line*` takes. Check a change didn't hurt with Drew's Vail drawing:
`node tools/ghost_lines.mjs vail lines ../docs/screenshots/ghost-lines/vail-2.jpg` then
`node tools/ghost_lines.mjs vail ride --trial --variants 1` (writes to the work folder only). Expect 11 lines, 0
crashes, every waypoint reached, far lines starting at a crest and near ones out of sight.
