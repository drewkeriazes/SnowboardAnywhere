# RPG-style rider stats (EPIC-13, #465)

Researched 2026-11-10, refined the same day against `main` at 30a335a. Drew is not sure about this epic, so it is built to answer one question cheaply: **is a rider report card fun?** Two small cards answer it. Everything else waits on that answer.

## 1. The rule

**Stats measure how well you ride. They never change how the board rides in Realistic feel.** A level 1 rider on Riva Ridge gets the same physics as the real mountain. That keeps the 1 m lidar and the carving model honest. The only exception is the optional Arcade card (FEAT-208), off by default.

Why not count actions (Skyrim style)? Players grind: jump on the flat 500 times. Our stats are an average of *quality* over recent attempts, so repeating an easy thing parks the stat at an easy number.

## 2. What other games do (short)

| Game | System | Take-away |
|---|---|---|
| Tony Hawk's Pro Skater 1+2 | 10 stats, collect tokens, spend points, stats change physics | The stat list fits snowboarding. Tokens need goals we do not have yet. |
| Elder Scrolls | Learn by doing | Feels natural, but gets grinded |
| Steep, Riders Republic | XP and gear unlocks, same physics for everyone | Even big open-mountain games keep physics equal |

## 3. What the code already gives us (checked)

| Need | Where it is today |
|---|---|
| Event bus | `core/Events.ts` (FEAT-163). Systems emit through rider callbacks wired in `session/eventSources.ts` (`rider.onTrick`, `rider.onWashout`, `rider.onPress`, `runStats.onRunEnd`) |
| Carve vs skid each step | `sim/rider/EdgeModel.ts` `grip()`: `skidding = |latAcc| > maxLat` (line ~158); edge angle `psi = |r.edge|` in `carve()` |
| Landing quality | `sim/rider/Tricks.ts` `land()` already computes `clean`, `sketchy` and crash (`r.crashed = 1.3`) plus spin and flip |
| Air time | `r.airTime` in `Jumps.ts` |
| Press result | `pressEnd` event: `how`, `time`, `dist`, `switchStance` |
| Run summary | `RunSummary` in `sim/RunStats.ts` (time, top speed, distance, vertical, max air, names). No falls, no average speed, no carve share yet |
| Snow under the board | `r.snow` (`SnowState`: groomed, powder, chop, ice, slush shares) |
| Moguls under the board | `r.surface.moguls` (mogul amplitude, m) |
| Switch | `rider` switch stance flag (FEAT-139) |
| Run card | `ui/RunCard.ts` (FEAT-055), shows 10 s after each run |
| Toast | `ui/Toast.ts` |
| Storage pattern | `localStorage` in try/catch, one key per thing (`settings`, `session-day`, `run-pbs`, press best, trial and outrun bests) |
| Feel preset | `ui/SettingsRows.ts`: `arcade` = press balance easy + fall line off; `realistic` = press balance on + fall line real |
| Tests | No unit test runner; headless browser checks in `game/tools/*check.mjs` (`carvecheck`, `fallcheck`, `presscheck`, `powdercheck`, `mogulcheck`) |

Nothing new is needed in the physics. Only three callbacks and a scoring file.

## 4. v1: the report card (two cards)

### 4.1 Events (FEAT-203, #475)
Three new events, emitted only at the end of a thing (never per frame):

```ts
| { type: 'turnEnd'; time: number; carve: number; edgePeak: number; speed: number;
    switchStance: boolean; powder: number; moguls: number }
| { type: 'landing'; air: number; spin: number; flip: number; grab: string;
    quality: 'clean' | 'sketchy' | 'crash' }
| { type: 'fall'; why: 'crash' | 'washout' | 'catch' }
```

- A turn = on-snow time between two edge sign changes. `carve` = share of that time not skidding (0..1). `edgePeak` in degrees. `powder` = mean `r.snow.powder` share, `moguls` = max `r.surface.moguls`.
- `RunSummary` gains `falls`, `avgSpeed`, `carve` (time-weighted over the run).
- Same wiring as today: `rider.onTurnEnd`, `rider.onLanding`, `rider.onFall` set in `session/eventSources.ts`.

### 4.2 Scoring (FEAT-194, #462): `sim/RiderStats.ts`
Each qualifying attempt gives a quality `q` from 0 to 100. A stat is the mean of the last 20 `q` values for that stat (ring buffer). New player: every stat starts at 0 with no attempts and shows "-" until it has 5.

| Stat | Attempt | Counts if | q (0 to 100) |
|---|---|---|---|
| Edge | `turnEnd`, not switch | time >= 1 s, speed >= 5 m/s, groomed | `100 * carve * min(1, edgePeak / 55)` |
| Switch | `turnEnd`, switch | same | same as Edge |
| Powder | `turnEnd` | powder >= 0.5 | `100 * min(1, speed / 15)`; 0 if a fall follows within 2 s |
| Bumps | `turnEnd` | moguls >= 0.3 m | `100 * min(1, speed / 12)`; 0 if a fall follows within 2 s |
| Air | `landing` | air >= 0.4 s | clean `100 * min(1, air / 2)`, sketchy half, crash 0 |
| Spin | `landing` | spin >= 180 deg | clean `100 * min(1, spin / 1080)`, sketchy half, crash 0 |
| Balance | `landing` (air >= 0.4 s) and `pressEnd` | always | landing: clean 100, sketchy 50, crash 0. press: clean `min(100, 33 * time)`, else 0 |
| Speed | `runEnd` | distance >= 300 m | `100 * min(1, avgSpeed / 20)`, halved per fall |

All thresholds are tunables at the top of the file. Ride constants (20 m/s, 55 deg) are first guesses; tune them so a decent session on Vail groomers lands Edge around 50 to 70.

Storage: one key, `rider-stats`, `{ v: 1, buffers: {edge: number[], ...}, days: {date: {edge: 63, ...}} }` (the daily snapshot is what FEAT-204 graphs later; a few hundred bytes a day).

v1 UI, kept tiny:
- Run card: one line for the stat that moved most this run ("Edge 58 (+4)").
- Toast when a stat crosses a multiple of 5, at most one per run, never mid-air.
- Pause menu: a "Rider" row listing the 8 numbers. That is the whole UI until the fun check.

### 4.3 The fun check
After v1 ships, Drew rides a few sessions. Questions: does he look at the run card line? Does a stat going up feel good? If yes, build the page (FEAT-204) and profiles (FEAT-205). If no, close the epic and keep the events (they still feed trick scoring and coach tips).

## 5. After the fun check

| Card | What | Depends on |
|---|---|---|
| FEAT-204 (#476) | Rider page: bars, today's change, season graph from `days` | FEAT-194 |
| FEAT-205 (#477) | Rider profiles: one set of rider data per person on the PC | FEAT-194; touches board (EPIC-12) and outfit (EPIC-14) storage too |
| FEAT-206 (#478) | Coach: lowest stat picks a real run nearby and a drill | FEAT-194 |
| FEAT-207 (#479) | Real stats from ShredFinder GoPro runs, display only | ShredFinder `ghost` export (not built) |
| FEAT-208 (#480) | Arcade only: stats nudge physics +/-15 % | FEAT-194; stacks with board mods from FEAT-195 (#467) |

### Profiles: what is per person and what is per PC
- Per person: `rider-stats`, `run-pbs`, `session-day`, press best, time trial bests, Outrun best, board and outfit choice.
- Per PC: graphics, audio, controls, `lastPack`, spawn point.
- Simplest build: a `storage.ts` helper that prefixes per-person keys with `p:<id>:`; the first launch moves today's keys into profile 1.

### Arcade multipliers (FEAT-208)
Stat 0 -> x0.85, 50 -> x1.0, 100 -> x1.15. Only when the setting "Stats change the ride" is on and Feel is Arcade. Realistic always uses 1.0.

| Stat | Scales | Code today |
|---|---|---|
| Edge | `gripEdge`, `psiMax` | `FEEL.board` in `tuning.ts` (or `r.feel` once FEAT-195 lands) |
| Air | jump pop | `Jumps.ts:48` `(2.5 + 4.5 * r.jumpCharge)` |
| Spin | air spin rate | `Jumps.ts:21,22,30` hard-coded `3.5`; lift to an `AIR_SPIN` constant first |
| Balance | landing clean window | `Tricks.ts` `land()` `align > 0.6` |
| Speed | tuck drag | `aeroTuck` |
| Powder | `POWDER_DRAG`, `SINK_DRAG` | `tuning.ts` |

## 6. Out of scope
- XP, levels, unlocks, stat points (approaches B and C from the first draft). Revisit only if the report card is fun and goals (FEAT-056) exist.
- A "trees" stat: canopy under the rider exists (`r.surface.canopy`), but tree riding has no clean quality signal yet.
- Online leaderboards.

## Sources
- [How to increase your stats in Tony Hawk's Pro Skater 1 + 2 (Gamer Journalist)](https://gamerjournalist.com/how-to-increase-your-stats-in-tony-hawks-pro-skater-1-2)
- [Killer Feature: The Elder Scrolls' learning by doing (Film Stories)](https://filmstories.co.uk/?p=45821)
- [Riders Republic review (eXputer)](https://exputer.com/reviews/riders-republic-review-a-thrill-ride/)
- Code at 30a335a: `core/Events.ts`, `session/eventSources.ts`, `sim/rider/EdgeModel.ts`, `Tricks.ts`, `Jumps.ts`, `tuning.ts`, `sim/RunStats.ts`, `ui/RunCard.ts`, `ui/SettingsRows.ts`
