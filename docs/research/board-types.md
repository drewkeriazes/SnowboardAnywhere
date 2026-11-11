# Board types with stats that change the ride (design, 2026-11-10)

Idea from Drew: pick a board type (and a real model) and it rides differently. KISS version: a board is a small table of stats that adjusts the feel constants we already have. No new physics.

## 1. What the code already has (main, 2026-11-10)
- `game/src/sim/rider/tuning.ts` has `FEEL: Record<'board'|'ski', Feel>` with `sidecut, pivot, pivotTuck, pivotFade, psiMax, psiPowder, roll, angulation, gripFlat, gripEdge, brake, aero, aeroTuck`. Board today: sidecut 7.8 m, psiMax 72 deg, gripEdge 0.9, pivot 1.9.
- `FEEL[r.discipline]` is read in only 3 places: `rider/EdgeModel.ts:191`, `:207`, `rider/Ride.ts:42`.
- Other knobs a board should touch: `OLLIE_POP`, `SQUAT_POP` (pop), `CATCH_DIG`, `CATCH_FLAT` (edge catch), `POWDER_DRAG`, `SINK_DRAG` (float), `CHOP_KICK`, `CHOP_YAW` (chatter), `SWITCH_GRIP` (riding switch).
- Settings already has a "feel preset" pattern (`SettingsRows.ts:78 applyFeelPreset`).

## 2. Board stats (what the player sees)
Seven stats. Real-world terms, so a rider recognises them.

| Stat | Values | Changes in game |
|---|---|---|
| Sidecut radius (m) | 5 to 12 (alpine 10 to 15) | `FEEL.sidecut` directly. Short = tight carves, long = big fast arcs |
| Flex | 1 soft to 10 stiff | Soft: faster pivot, easier presses, more chatter at speed, less pop. Stiff: more edge hold and pop, slower pivot |
| Profile | camber, hybrid, flat, rocker | Camber: + edge hold, + pop, + catch risk. Rocker: - catch, + float, - hold |
| Shape | twin, directional twin, directional | Directional: switch penalty (lower `SWITCH_GRIP`), better float |
| Setback / taper | 0 to 4 cm | More setback: nose floats, powder sink down |
| Waist width (mm) | 245 to 290 | Wider: + float, slower edge roll |
| Length (cm) | 120 to 175 | Longer: more stable (less chop), slower pivot |

Plus one flag per special board: `detuned` (jib, softer catch and grip near contact points), `hardboot` (alpine), `split` (backcountry), `noBindings` (powsurf).

## 3. Mapping stats to the existing constants
One function, `boardFeel(base: Feel, b: Board): { feel: Feel, mods: BoardMods }`. All factors are tunables; start here.

```
f = (flex - 5) / 5            // -0.8 soft .. +1 stiff
feel.sidecut   = b.sidecut
feel.pivot     = base.pivot * (1 - 0.25*f) * (1 - (b.length-155)/100)
feel.roll      = base.roll  * (1 + 0.15*f) * (1 - (b.waist-255)/200)
feel.gripEdge  = base.gripEdge * (1 + 0.15*f) * PROFILE[b.profile].grip * (b.detuned ? 0.85 : 1)
mods.pop       = (1 + 0.2*f) * PROFILE[b.profile].pop
mods.catch     = PROFILE[b.profile].catch * (b.detuned ? 0.6 : 1)
mods.float     = PROFILE[b.profile].float * (1 + (b.waist-255)/150) * (1 + b.setback/8)
mods.chatter   = (1 - 0.3*f) * (155 / b.length)
mods.switch    = SHAPE[b.shape]   // twin 1, dir-twin 0.9, directional 0.7

PROFILE = { camber: {grip:1.1, pop:1.15, catch:1.2, float:0.9},
            hybrid: {grip:1.0, pop:1.05, catch:0.9, float:1.0},
            flat:   {grip:0.95,pop:0.95, catch:0.8, float:1.05},
            rocker: {grip:0.85,pop:0.9,  catch:0.5, float:1.2} }
```
`mods.float` divides `POWDER_DRAG` and `SINK_DRAG`; `mods.catch` multiplies `CATCH_DIG`/`CATCH_FLAT`; `mods.pop` multiplies `OLLIE_POP`/`SQUAT_POP`; `mods.chatter` multiplies `CHOP_KICK`/`CHOP_YAW`; `mods.switch` multiplies `SWITCH_GRIP`.

Special flags
- `hardboot`: psiMax up to 80 deg, roll x1.3, `HARD_G` x1.2, pivot x0.6, presses and grabs off, pop x0.7.
- `split`: pop x0.9, gripEdge x0.95 (two halves, softer torsion). Skinning uphill is a separate later card.
- `noBindings` (powsurf): no jumps above a small hop, steering by weight only (pivot x0.5), brake x0.5, float x1.6. v2.

## 4. Board catalog (one real model per type)
Model names are real boards. The game stats are OUR design values per type, not a claim about the exact board; fill exact sidecut/waist per size from the maker's spec page when we finalise each one. Verified so far: Ride Warpig and Lib Tech Box Scratcher.

| Type | Example model | Len | Sidecut | Flex | Profile | Shape | Setback | Waist |
|---|---|---|---|---|---|---|---|---|
| All-mountain (default) | Burton Custom Camber | 158 | 7.8 | 6 | camber | dir-twin | 1 | 252 |
| Freeride | Jones Flagship | 158 | 8.5 | 8 | hybrid | directional | 3 | 249 |
| All-mountain freestyle | CAPiTA DOA | 154 | 7.5 | 5 | hybrid | twin | 0 | 250 |
| Jib / rail | Lib Tech Box Scratcher | 151 | 7.0 | 3 | rocker | twin | 0 | 252, `detuned` |
| Big jump / slopestyle | CAPiTA Super DOA | 156 | 8.0 | 8 | camber | twin | 0 | 255 |
| Splitboard | Jones Solution | 159 | 8.5 | 7 | hybrid | directional | 3 | 256, `split` |
| Volume shifted | Ride Warpig | 148 | 6.0 | 5 | hybrid | directional | 2 | 260 |
| Swallowtail / fish | Burton Fish 3D | 156 | 8.0 | 6 | hybrid | directional | 4 | 258 |
| Alpine / race | Kessler The Alpine | 170 | 12 | 10 | camber | directional | 2 | 200, `hardboot` |
| Kids / beginner | Burton Instigator (flat top) | 140 | 6.5 | 2 | flat | twin | 0 | 245 |
| Powsurf | Grassroots Powsurf | 140 | n/a | 4 | rocker | directional | 4 | 290, `noBindings` (v2) |

Verified specs (boardom.co): Ride Warpig 2025-26, 148 cm: waist 260 mm, sidecut 5.1 to 6.2 m (progressive), flex 5/10, directional. Lib Tech Box Scratcher 2023-24, 151 cm: waist 252 mm, flex 3/10, rocker, twin (sidecut not published).

## 5. Build steps (one card)
1. New `game/src/sim/rider/Boards.ts`: `Board` type, `BOARDS` catalog (section 4), `boardFeel()` (section 3).
2. `Rider`: hold `feel` and `mods`, recomputed when the board changes; replace the 3 `FEEL[r.discipline]` reads with `r.feel` (skis keep `FEEL.ski`).
3. Multiply the constants in section 3 by `r.mods` where they are used (Jumps, Press, EdgeModel catch, snow drag, chop).
4. `Settings.ts`: `board: string` (default `custom-camber`). `boardFeel` is computed relative to this board's own output (or the board gets neutral stats), so the default reproduces today's `FEEL.board` and all mods are exactly 1; nothing changes until a player picks another. A picker row with a 7-bar stat card.
5. Check: `carvecheck.mjs` on each board (sidecut sets turn radius), `fallcheck.mjs` (rocker catches less), one powder ride per type. Default board must give identical results to today.

Out of scope v1: powsurf, skinning on splitboards, per-size boards, custom board builder.

## Sources
- [Ride Warpig 2025-2026 specs (boardom.co)](https://boardom.co/library/snowboards/ride/warpig/2025-2026)
- [Lib Tech Box Scratcher 2023-2024 specs (boardom.co)](https://boardom.co/library/snowboards/lib-tech/box-scratcher/2023-2024)
- Repo `main`: `game/src/sim/rider/tuning.ts` (FEEL, constants), `rider/EdgeModel.ts`, `rider/Ride.ts`, `ui/SettingsRows.ts`

## 6. Cards (EPIC-12, #464, filed 2026-11-10)
- FEAT-195 (#467) board stats drive the feel (`Boards.ts`, `boardFeel`, default unchanged)
- FEAT-196 (#468) board catalog with checked specs and a picker
- FEAT-197 (#469) the board mesh follows the board (length, width, shape, invented topsheets)
- FEAT-198 (#470) stance setup: width, angles, setback. Real ranges (Jones stance guide): all-mountain front +15 to +18 / back 0; duck +15 to +21 / -3 to -12; freeride +18 to +24 / 0 to +9; carving +24 to +30 / +9 to +15. Width within 2 cm of the board's reference stance; powder setback 2 to 5 cm.
- FEAT-199 (#471) wax and tune: glide from wax vs snow temperature (month, hour, elevation lapse rate), edge sharpness for ice
- FEAT-200 (#472) alpine hardboot: angles about 45 to 60 deg, front 3 to 5 deg above rear (alpinecarving.com), own poses
- FEAT-201 (#473) splitboard: split, skin uphill, transition
- FEAT-202 (#474) ski types on the same system

Sources added: [Jones stance guide](https://www.jonessnowboards.com/pages/a-guide-on-how-to-find-your-snowboard-riding-stance), [alpinecarving.com binding setup](https://www.alpinecarving.com/binding_setup.html), [Burton wax types](https://www.burton.com/blogs/the-burton-blog/snowboard-wax-types).
