# ghost_lines: playbook for agents

Main menu ghost riders from lines Drew draws on the menu's backdrop (FEAT-181). Read this first; it is the short
path. The method and the history: `docs/research/ghost-lines-prototype/README.md` (Learnings at the end). The
how-to for people: `docs/developer-guide.md` > Ghost riders from lines drawn on the menu.

## The 60-second version

```
cd game && npx vite build                                        # the tool serves game/dist; rebuild after src changes
node tools/ghost_lines.mjs <pack> status                         # where the resort is
node tools/ghost_lines.mjs <pack> shot                           # Drew picks a view: Shift+P in the eye camera
node tools/ghost_lines.mjs <pack> candidates [shots.json ...]    # render saved candidates to compare
node tools/ghost_lines.mjs <pack> pick <name>                    # one becomes the menu shot (+ still + drawing frame)
node tools/ghost_lines.mjs <pack> lines [img ...]                # read the lines; later images replace a colour
node tools/ghost_lines.mjs <pack> ride [--per ...] [--trial]     # cast, ride, write takes + index.json
node tools/ghost_lines.mjs <pack> takes take-1.json take-2.json  # variants of Drew's own recorded runs (preferred)
node tools/ghost_lines.mjs <pack> extend take-2.json             # a take ending in view goes on down the slope
node tools/ghost_lines.mjs <pack> check [--no-open]              # compare, gaps, draw calls, menu headed
```

**What Drew chose on Breckenridge (2026-11-10): his own recorded runs for the riders near the camera, the bot's
rides further out.** Close up, Drew judged the bot's riding wobbly next to his (not every bot rider: only the near
ones; ask which before replacing); `takes` turns his runs
(recorded with `?debug`, K, I / O, L on the dev server: `take-<n>.json`) into variants that move exactly as he
rode. Offer that path first when riding quality matters; use drawn lines + `ride` to cover slopes he hasn't
ridden.

Always `--gpu` is the default on Drew's PC (headless real GPU). A step takes 20 s to 2 min; `ride` with 25+
variants about 2 min. Nothing needs a dev server, but Drew watching the result does: start one on the worktree
(`npx vite --port <free> --strictPort`, see CLAUDE.md) and give him `http://localhost:<port>/?pack=<pack>`; takes
are read from disk on every load, so after `ride` he just reloads.

## Working with Drew (what saved the most time)

- **Shot**: Drew flies the eye camera and presses **Shift+P** (needs `&debug`). The form has "Use as menu shot"
  (Enter) and "Keep as a candidate". It posts to `/__attract/shot` on whatever served the page: the tool's own
  server (`shot` step, a random port, gone when the step ends) or a Vite dev server. If no server answers, the page
  **downloads `shots.json`** instead: pass that file to `candidates <file>` or copy its entry. Plain P is the
  compare-photo key, not the shot.
- **Drawing**: anything works. The clean frame `game/shots/ghost-lines/<pack>/<shot>/draw-<shot>.png` (no fit
  needed), a Snipping Tool grab of the browser (bars, taskbar, menu UI and the `?debug` slider panel are fine), or a
  **screenshot of Paint** with the drawing open (the toolbar is outside the fitted frame). Drew pastes images into
  the chat; they land in the session's `images/` folder as PNG: use those paths.
- **Paint doesn't save until Ctrl+S**: check the file's mtime before reading it; a screenshot of the Paint window
  works meanwhile.
- **One line wrong? Ask Drew to redraw just that line** (Drew's own suggestion) instead of tuning: `lines a.png
  b.png` takes the colour from the later image. Redrawing beats a new code path.
- Show progress in the real menu early; Drew judges riders on screen, not from numbers.
- `--per` by colour or line name: `red:3`, `blue:2:ski`, `yellow-2:3:1ski`, `pink:0` (skip), `green:2:straight`
  (a straightliner: tucked, no carving, fast; one variant unless `:v3`).
- Default per line: 2 riders x 3 variants (`group.variants`), the variants sent off a third of a cycle apart
  (takes carry `delay` and `every`; `world/AttractGhosts.ts` holds a take back until its delay and restarts it every
  `every` seconds). Lines are offset from each other too, so riders set off all the time, never all at once.
- `takes`: each recorded run is trimmed 0.5 s before its first fall, ridden on by the bot while it still ends in view
  (`bot.extendMaxS`, 40 s; that tail is bot steering, keep it short if Drew notices), then copied: the run itself and
  copies `group.takeShiftM` (10 m) to either side, each with a partner. The recorded files leave the menu (the first
  variant is the run itself) but stay on disk. `ride` and `takes` each replace only their own takes (`*-run-<n>-*`
  are `takes`'): drop a bot line the runs replace with `ride --per name:0`. `ride --takes a.json,b.json` instead rides
  the runs as lines with the bot (`ridden-<n>`).

## What the tool decides, and the numbers to expect

- **Fit** (snips only): match 0.6 to 0.8 is good; under 0.3 is a wrong shot or pack. Scale 0.84 = Drew's browser
  window (912 px of game), 1.0 = a full 1080 frame. Phase k is 0 for anything taken in the eye camera or Paint.
- **Line names**: colour name, numbered left to right when a colour repeats (`yellow-1`). Two strokes of one
  colour join across up to 70 px when the gap continues both (a crossing); a sharp hook at a crossing doesn't join:
  ask for a redraw.
- **Report per ride**: crashes must be 0; `reached` all waypoints; lead to partner 4 to 12 m; `start` out of sight or
  far crest. `end in view (fades out)` is normal where the camera sees down a whole valley (rides end `bot.tailS` = 8 s
  after the last waypoint). Far riders barely on screen are fine (Drew).
- **Line used** `80/126 pts, 34..164 m out`: the longest unbroken run of the cast. A line drawn over a ridge or rim
  keeps only the visible stretch; that is intended (a rider can't follow a face the camera doesn't see).
- **Cost**: each rider is up to 19 draw calls (fewer far out). Breckenridge, 50 takes: see `check`. FEAT-182 (#424)
  batches far riders.

## Gotchas already paid for (don't rediscover)

- **Wobble = the brake.** The physics brake swings the board 84 degrees across (a hockey stop) and snaps it back on
  release; a bot that brakes to hold a speed cap flickers. The bot now steers linked turns along a smoothed path
  (pure pursuit, a sine across it, wider when too fast) and brakes only 6 m/s over the speed it wants
  (`bot.brakeBand`); the floor is 10 m/s near the camera. Measure smoothness from a take: edge changes per second
  (Drew: 0.17 to 0.4), share of samples with the board over 0.6 rad off travel (Drew: 1 to 5%), airborne share (Drew:
  16 to 27% on Imperial Bowl). Compare against Drew's own takes before tuning.
- Moguls: `pack.mogulAmp(x, y)`; the bot holds `bot.mogulOver` there and doesn't tuck.

- Ride in the menu's frame (1920 x 1080): "in sight" decides starts, cuts and ends. Casting uses each image's own
  frame and fit. (A snip's 2600 px fit frame once leaked into the ride.)
- Airborne bots must grab and stop steering, or a crooked landing over 8 m/s impact crashes (`rider/Tricks.ts`).
  Steep summit starts launch immediately; this fixed every Breckenridge crash.
- Near lines (under ~80 m) need distance-scaled reach, swing and speed (`waypoints.reachFrac`, `bot.swingNearM`,
  `bot.brakeFrac`); the Vail numbers ignore them otherwise.
- Hue peaks: busiest bin first, at the bin's mean hue, 15 degrees apart; JPEG input gets `extract.jpeg` thresholds.
  A red roof in the shot once hid an orange line (fixed); `GHOST_DEBUG=1` prints the peaks.
- Old-build snips: the render changed (snow-flocked trees), so dark pines in the snip read as black lines. Use a
  snip from the current build when black lines matter.
- `dt = 0` steps are fine for grabs; the whole-scene look is the still's look (white flocked trees are current).
- Writing Python edit scripts through bash heredocs mangles backslashes and `\n`: write them with the Write tool.
- The still re-renders on every `check` / `still` (tree sway): revert `game/public/attract/<pack>/<shot>.jpg` if
  only noise changed, or commit it with the takes.

## Files

- Takes: `game/public/attract/<pack>/<shot>-<line>[-v<n>]-<i>.json` (`backdrop`, `shot`, `build`, `delay`,
  `every`); listed in `game/public/attract/index.json` under `ghosts` and `shotGhosts.<shot>`. A rerun of `ride`
  replaces the shot's takes; a new shot removes them.
- Shot: `game/public/attract/<pack>/shots.json`. Candidates: `game/shots/ghost-lines/<pack>/candidates.json` and
  `candidates/*.png`.
- Work (gitignored): `game/shots/ghost-lines/<pack>/<shot>/` clean.png, draw-<shot>.png, lines.json, lines-*.png,
  world.json, report.json, ride.png (first variant's rides over the cast lines), menu-t*.png.
- Code: `tools/ghost_lines.mjs` (steps), `ghost_lines/image.mjs` (fit, line finding), `ghost_lines/page.mjs` (in the
  game page: cast, ride, pictures), `tools/attract_files.mjs` (shared with the dev server), tunables
  `tools/ghost_lines.config.json` (per-resort overrides under `resorts.<slug>`).
- Game side: `world/AttractGhosts.ts` (`delay` / `every`), `world/AttractShots.ts` (shots as data),
  `ui/MenuShotForm.ts` + `session/devSaves.ts` (Shift+P).

## Regression after a change

Vail keeps its hand-made `line*` takes. To check a change didn't hurt: `lines <Drew's vail-2 snip>` then `ride
--trial` on vail (writes to the work folder only); expect 11 lines, 0 crashes, every waypoint, pairs about 5 to 11 m.
Note the change in the prototype README's Learnings.
