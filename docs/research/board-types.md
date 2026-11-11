# Board types with stats that change the ride (EPIC-12, #464)

Designed 2026-11-10, refined the same day against `main` at 30a335a. This replaces the first draft (last at cfaf6ec). Cards: #467 to #474 (section 6).

Idea from Drew: pick a board (a real model) and it rides differently. KISS: a board is a small stat table that scales the feel constants the rider already has. No new physics.

## 1. Rules
1. **Default = today.** Every factor is a ratio to the reference board `custom-camber`, so it returns `FEEL.board` exactly and all mods are 1. Existing checks must match `main` to the digit.
2. **Small numbers.** Except sidecut, every ratio is clamped to 0.75 to 1.25.
3. **Gear, not difficulty.** Realistic and Arcade both honour the board.
4. **The UI never lies.** Stat bars are computed from `boardFeel()`.
5. **Real models, our numbers.** Specs from the maker where published, marked design values otherwise. No logos.

## 2. Where it plugs into the code (main, 30a335a)
| What | Where | How the board changes it |
|---|---|---|
| `FEEL.board` (sidecut 7.8, psiMax 72 deg, roll 400 deg/s, gripEdge 0.9, pivot 1.9) | `sim/rider/tuning.ts:89`, read at `EdgeModel.ts:191`, `:207`, `Ride.ts:42` | replaced by `r.feel` |
| jump pop `(2.5 + 4.5 * charge) * spring * flex` | `Jumps.ts:48` | `* mods.pop` (the whole pop, not `OLLIE_POP`) |
| edge catch `CATCH_DIG`, `CATCH_FLAT` | `EdgeModel.ts:174` | `catchRisk * mods.catch` |
| powder `POWDER_DRAG`, `SINK_DRAG` | `Ride.ts:83` | divided by `mods.float` |
| chop `CHOP_KICK`, `CHOP_YAW` | `EdgeModel.ts:126-127` | `* mods.chatter` |
| switch `gripBase * (1 - SWITCH_GRIP)` | `Ride.ts:52` | `1 - SWITCH_GRIP * mods.switchPenalty` (it is a penalty) |
| snow friction `snow.drag0` | `Ride.ts:82` | wax factor (#471) |
| board mesh 156 cm, 0.13 m half-width, topsheet `outfit.board` | `world/RiderRig.ts:66`, `:340` | from the board (#469) |
| bindings +15 / -6, about 58 cm | `RiderRig.ts:356-361` | `bindings` setting (#470) |

Name clashes avoided: `Settings.stance` is regular/goofy and `outfit.board` is a colour, so the new keys are `boardId` and `bindings`.

## 3. The mapping
```
f        = (flex - 5) / 5
ratio(x) = k_x(board) / k_x(REF)            REF = custom-camber
pivot    : (1 - 0.25 f) * (1 - (length - 155) / 100)
roll     : (1 + 0.15 f) * (1 - (waist - 255) / 200)
gripEdge : (1 + 0.15 f) * PROFILE.grip * (detuned ? 0.85 : 1)
sidecut  : board.sidecut (absolute)
pop      : (1 + 0.2 f) * PROFILE.pop
catch    : PROFILE.catch * (detuned ? 0.6 : 1)
float    : PROFILE.float * (1 + (waist - 255) / 150) * (1 + setback / 8)
chatter  : (1 - 0.3 f) * (155 / length)
switchPenalty: twin 0, dirTwin 1, directional 2.5 (absolute)

PROFILE  camber {grip 1.1, pop 1.15, catch 1.2, float 0.9}
         hybrid {1.0, 1.05, 0.9, 1.0}
         flat   {0.95, 0.95, 0.8, 1.05}
         rocker {0.85, 0.9, 0.5, 1.2}
```
Flags: `detuned` (above); `hardboot` (#472: psiMax to `HARD_PSI`, roll x1.3, pivot x0.6, pop x0.7, `HARD_G` x1.2 via mods, no presses or grabs); `split` (#473: pop x0.9, gripEdge x0.95).

## 4. Catalog
v1 (#468), base stats only:
| id | Model | Len | Sidecut | Flex | Profile | Shape | Setback | Waist |
|---|---|---|---|---|---|---|---|---|
| custom-camber (REF) | Burton Custom Camber | 158 | 7.8 | 6 | camber | dirTwin | 1 | 252 |
| flagship | Jones Flagship | 158 | 8.5 | 8 | hybrid | directional | 3 | 249 |
| doa | CAPiTA DOA | 154 | 7.5 | 5 | hybrid | twin | 0 | 250 |
| box-scratcher | Lib Tech Box Scratcher | 151 | 7.0* | 3 | rocker | twin | 0 | 252, detuned |
| super-doa | CAPiTA Super DOA | 156 | 8.0 | 8 | camber | twin | 0 | 255 |
| warpig | Ride Warpig | 148 | 5.6 | 5 | hybrid | directional | 2 | 260 |
| instigator | Burton Instigator | 140 | 6.5 | 2 | flat | twin | 0 | 245 |

Later with their own cards: Kessler The Alpine 170 (hardboot, #472), Jones Solution 159 (split, #473), Burton Fish 3D 156 (swallowtail). Out: powsurf.

Values are design values until filled from the maker's page. Verified (boardom.co): Warpig 148 waist 260 mm, sidecut 5.1 to 6.2 m progressive, flex 5, directional; Box Scratcher 151 waist 252 mm, flex 3, rocker, twin, no published sidecut (*design value).

## 5. Checks
- `tools/boardcheck.mjs` (new, esbuild pattern of `carvecheck.mjs`): reference board is identity; rocker has lower catch and higher float; longer sidecut gives a longer radius.
- Default board: `carvecheck`, `fallcheck`, `powdercheck`, `switchcheck`, `brakecheck` identical to `main`.

## 6. Order
#467 core, #468 catalog and picker, #469 mesh, #470 bindings, #471 wax, #472 alpine, #474 skis, #473 splitboard.

| Card | What |
|---|---|
| FEAT-195 (#467) | Board stats drive the feel (`Boards.ts`, `boardFeel`, default unchanged) |
| FEAT-196 (#468) | Catalog with checked specs and a picker |
| FEAT-197 (#469) | Board mesh follows the board (length, width, shape, invented topsheets) |
| FEAT-198 (#470) | Stance setup: width, angles, setback |
| FEAT-199 (#471) | Wax and tune: glide from wax vs snow temperature, edge sharpness for ice |
| FEAT-200 (#472) | Alpine hardboot, own poses |
| FEAT-201 (#473) | Splitboard: split, skin uphill, transition |
| FEAT-202 (#474) | Ski types on the same system |

Researched ranges for #470 and #472:
- Stance angles (Jones stance guide), front / back: all-mountain +15 to +18 / 0; duck +15 to +21 / -3 to -12; freeride +18 to +24 / 0 to +9; carving +24 to +30 / +9 to +15. Width within 2 cm of the board's reference stance; powder setback 2 to 5 cm.
- Alpine (alpinecarving.com): angles about 45 to 60 deg, front 3 to 5 deg above rear.

## Sources
- [Ride Warpig 2025-2026 specs (boardom.co)](https://boardom.co/library/snowboards/ride/warpig/2025-2026)
- [Lib Tech Box Scratcher 2023-2024 specs (boardom.co)](https://boardom.co/library/snowboards/lib-tech/box-scratcher/2023-2024)
- [Jones stance guide](https://www.jonessnowboards.com/pages/a-guide-on-how-to-find-your-snowboard-riding-stance)
- [Burton: snowboard wax types](https://www.burton.com/blogs/the-burton-blog/snowboard-wax-types)
- [alpinecarving.com: binding setup](https://www.alpinecarving.com/binding_setup.html)
