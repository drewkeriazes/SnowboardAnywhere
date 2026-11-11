# Dual-stick body control (FEAT-220)

Investigated 2026-11-11 against `main` at 97926a3. Idea from Drew: with a controller's two sticks we can drive two parts of the rider at once, for more realistic body positions, and positions that put you on the snow if you get them wrong. Build on the hard press: pressing harder carves tighter but can skid.

KISS version: the left stick stays exactly as it is (steer and the edge, tuck / brake, press balance). The right stick becomes the **body**: X leans the upper body in or out of the turn, Y down compresses (the hard press, now analog), Y up is left for later. With the right stick centred the rider rides exactly as today. No new physics, only one lean value that today is computed and now can be offset, plus one balance meter.

## 1. What the code does today (checked)

| Piece | Where | Today |
|---|---|---|
| Left stick X steers, Y tucks / brakes / balances a press | `sim/Controls.ts` `update()` | analog steer, digital tuck / brake past half way |
| Right stick looks | `Controls.ts` `padLookX / padLookY` | free look while pushed |
| Hard carve | `sim/rider/EdgeModel.ts` `carve()` lines 16-18 | `input.squat` held + steer > `HARD_STEER` (`sim/rider/tuning.ts` line 173): `r.hardCarve` eases to 1 over `HARD_IN` (0.12 s, tuning.ts line 150). Pad has no squat button by default (`DEFAULT_PAD.squat = []`); X is the shared "get small" grab |
| Body lean | `sim/rider/EdgeModel.ts` `balance()` line 219 | `phi = min(phiMax, psi * (1 - angulation))`: the lean follows the edge, the player never sets it |
| The turn the lean holds | `sim/rider/EdgeModel.ts` `balance()` | `aLat = min(v^2 turn / (Rsc cos psi), g nz tan(phi) turn + gIn)` |
| Skid and washout | `sim/rider/EdgeModel.ts` `carve()` lines 45-72, `grip()` | asking more turn than the edge holds sets `carveShort` (skid); far short at speed fills `washout`, full = slam to the inside |
| Drawn lean | `world/riderView/BodyPose.ts` `incline()` | from the measured lateral g, so the picture follows the physics |
| Free buttons | `sim/Pad.ts` `DEFAULT_PAD` | R3 = glance, L3 = boost |

## 2. The design

### Input (one new setting: Controls > Body control: Auto / Trim / Full, default Auto)
- **Auto** (default): today, right stick looks. Nothing changes for anyone who does not turn it on.
- **Trim**: right stick X adds a lean offset to the automatic lean, up to `BODY_TRIM` = 35 deg at full stick, with a 1.5 power curve so small corrections are fine. Toward the steer = lean in, away = stand up.
- **Full**: right stick X sets the lean outright, full stick = `HARD_PHI` (69 deg, `sim/rider/tuning.ts` line 150). No automatic lean at all: at a crawl you must stay upright, at speed you must lay it over. Hard mode.
- **Right stick down** in Trim and Full: compress. Depth `d` (0..1 past a 0.15 dead zone) replaces the squat key's on / off: `r.squat` eases toward `d`, and while steering past `HARD_STEER` the hard carve eases toward `d` instead of 1. Keyboard Shift keeps working as `d = 1`.
- Free look with Trim or Full on: the right stick looks only while off the snow (air, lift, on foot, stopped under 1 m/s); the gyro and glance (R3) still work riding. FEAT-186 later claims the right stick in the air for grabs, which fits.

### Physics (`sim/rider/EdgeModel.ts` only)
1. `r.bodyLean` (rad, + into the turn) = `phiAuto + trim` (Trim, `phiAuto = min(phiMax, psi * (1 - angulation))` as today) or the stick angle (Full), capped at `PHI_MAX + (HARD_PHI - PHI_MAX) * H`.
2. `balance()` takes the lean as an argument instead of computing it. At speed the turn is lean-limited, so leaning in tightens the turn and standing up opens it (physically right: same edge, more lean, more turn force).
3. **Tip meter** `r.tip` (-1..1, + inside, like the press needle):
   - lean-in error `eIn = bodyLean - max(phiAuto, phiHold)` where `phiHold = atan(min(arc, gripMax) / (g nz))` is the most lean the edge and the snow can carry (`gripMax` is `grip()`'s full-edge `maxLat`). Measured against the larger of the two so **Trim at zero never fills it**: the default ride is today's ride, ice included.
   - stand-up error `eOut = phiAuto - bodyLean`, counted only with the edge past 40 deg and speed over 3 m/s (a high edge with the body upright is what throws you over it).
   - past the tolerance (`TIP_IN` 10 deg, `TIP_OUT` 20 deg) the meter fills at `TIP_RATE` (1.5 /s) per `TIP_SPAN` (15 deg) over; under it, it drains at `TIP_DRAIN` (2 /s).
   - full: **low-side** (inside, `crashSide = sign(edge)`, same fall as the washout) or **high-side** (thrown over the outside edge, `crashSide = -sign(edge)`).
   - warning before the slam: past 0.4 the inside hand drags (`HAND_DRAG` 1.5 m/s^2 times the meter, spray from the hand), rumble scales with the meter (`PadFeedback`).
4. Feel preset Arcade multiplies `TIP_IN`, `TIP_OUT` by 1.5 and halves `TIP_RATE`.
5. Ghost and replay format unchanged (`bodyLean` is visible through `lateralG` and the pose); `BodyPose.incline()` blends toward `bodyLean` so a mismatched rider is seen tipping before the slam.

## 3. Tuning, worked out numerically

Every table here is printed by `game/tools/bodytune.mjs` (`cd game && node tools/bodytune.mjs`), which bundles the real sim code with esbuild like `hardcarvecheck.mjs`. Rerun it when `sim/rider/tuning.ts` or `EdgeModel.ts` changes. What it runs:
- Baseline: the real `balance()` with today's constants.
- Analog press: the real `Rider` on a flat groomer, full steer, with the hard carve and the squat held at depth `d` each step (today's key drives both to 1, so `d = 1` is today's ride: it reproduces `hardcarvecheck`'s washout from flat at 20 m/s, 0.20 s).
- Body trim: the proposed lean and tip meter from section 2 (not in the game yet, so the harness carries its own copy) on the real `balance()` arc, the real snow grip and `grip()`'s full-edge hold.

### Today's baseline (auto lean)
15 deg groomer, mid-turn (gIn = 0), steady edge. g is the load the rider feels.

| Speed | Edge 30 | Edge 45 | Edge 60 | Edge 72 |
|---|---|---|---|---|
| 5 m/s | R 6.8 m, 1.1 g | 5.5 m, 1.1 g | 3.9 m, 1.2 g | 2.4 m, 1.5 g |
| 8.3 m/s (30 km/h) | 14.6 m, 1.1 g | 8.8 m, 1.3 g | 5.5 m, 1.6 g | 3.6 m, 2.2 g |
| 16 m/s | 54 m, 1.1 g | 33 m, 1.3 g | 21 m, 1.6 g | 13.6 m, 2.2 g |

Matches the rider-physics target (30 km/h carve on an 8 m board: R 5 to 7 m at about 1.5 g).

### Analog hard press (right stick down `d`)
R is over a 90 deg turn; skid is the peak past 0.3.

Committed (the edge already at 45 deg when the press goes in):

| Speed | no press | d 0.25 | d 0.5 | d 0.75 | d 1 (today's key) |
|---|---|---|---|---|---|
| 10 m/s | R 4.6 m | 4.2 m | 3.8 m | 3.7 m | 3.6 m |
| 14 m/s | 8.1 m | 7.4 m | 6.8 m | 6.7 m | 6.7 m |
| 18 m/s | 12.3 m, skid 0.35 | 11.4 m, skid 0.31 | 10.5 m | 10.5 m | 10.6 m |
| 22 m/s | 17.0 m, skid 0.45 | 15.9 m, skid 0.39 | 14.8 m | 15.0 m | 15.2 m |

From flat (press and steer together):

| Speed | no press | d 0.25 | d 0.5 | d 0.75 | d 1 (today's key) |
|---|---|---|---|---|---|
| 10 m/s | R 5.1 m | 4.6 m | 4.1 m | 3.8 m | 3.7 m, skid 0.37 |
| 14 m/s | 8.7 m | 8.0 m | 7.2 m, skid 0.32 | 6.9 m, skid 0.54 | 6.5 m, skid 0.66 |
| 18 m/s | 13.1 m, skid 0.34 | 12.1 m, skid 0.30 | 11.0 m, skid 0.35 | 10.5 m, skid 0.59 | 10.0 m, skid 0.73 |
| 20 m/s | 15.4 m, skid 0.39 | 14.3 m, skid 0.34 | 13.0 m, skid 0.35 | 12.6 m, skid 0.59 | **washout 0.20 s** |
| 22 m/s | 17.9 m, skid 0.44 | 16.7 m, skid 0.38 | 15.3 m, skid 0.35 | 14.9 m, skid 0.59 | **washout 0.17 s** |

What this gives with today's constants: depth is a smooth "harder is tighter" (at 10 m/s from flat, 5.1 m to 3.7 m), most of it in the first half of the stick; committed, every depth holds to 22 m/s; from flat, a deeper press skids more, and only a full press from flat at 20 m/s and up washes out, the same as the key today. So **no washout constants change** for v1, and the safe zone is wider than "half depth": the slam needs full depth, late, fast. Whether a deep late press should slam at lower speed is a feel question for the pad (lowering `WASH_V0` does it, but also changes the keyboard key, which is `d = 1`).

### Body trim (Trim mode)
Steady edge, mid-turn (gIn = 0), no hard carve. Columns are the trim lean, with the stick that gives it on the 1.5 curve. The groomer holds 2.03 g at full edge, today's spring ice at 7 am 1.32 g.

| Case | Trim 0 | +10.5 deg (stick 0.45) | +21 deg (stick 0.71) | +35 deg (full in) | -17.5 deg (stick 0.63 out) | -35 deg (full out) |
|---|---|---|---|---|---|---|
| Groomer, 2 m/s, edge 30 | R 6.8 | low-side 20 s | **low-side 0.9 s** | **low-side 0.4 s** | R 6.8 | upright, no turn |
| Groomer, 5 m/s, edge 45 | R 5.5 | low-side 20 s | **low-side 0.9 s** | **low-side 0.5 s** | R 6.5 | **high-side 0.7 s** |
| Groomer, 10 m/s, edge 60 | R 8.0 | R 5.3 | R 5.0 | R 5.0 | R 14.9 | **high-side 0.7 s** |
| Groomer, 16 m/s, edge 60 | R 21 | R 13.6 | R 12.9 | R 12.9 | R 38 | **high-side 0.7 s** |
| Ice, 10 m/s, edge 60 | R 8.0 | R 7.7 | **low-side 2.4 s** | **low-side 2.4 s** | R 14.9 | **high-side 0.7 s** |
| Ice, 16 m/s, edge 30 | R 54 | R 36 | R 25 | R 19.8 | R 173 | upright, no turn |

The slow rows use edges the game lets you hold there (`edgeCap()` keeps a crawl near 30 deg). A 20 s fill is in practice free: any turn ends first.

What this gives:
- Slow, leaning in drops you on your hip (you can't lean on a turn that has no force). Small trims are free.
- Fast on a groomer, leaning in is a skill: the same edge carves a third tighter, held by the corduroy up to its 2 g.
- On ice the grip, not the lean, is the limit: a small trim still holds, a big one washes out to the inside. The lean cap (`PHI_MAX`, 68 deg) stops the body at 15 deg past an edge-60 auto lean, which is why full in is no quicker than +21 there; if that reads as too forgiving, raise `TIP_RATE` or measure `eIn` against the asked lean before the cap.
- A big edge with the body stood up throws you over the outside edge in under a second.
- Full mode is the same table with Trim 0 gone: the stick has to find the lean every turn.

### Constants (all new, `tuning.ts`)
`BODY_TRIM = 35 deg`, `BODY_CURVE = 1.5`, `TIP_IN = 10 deg`, `TIP_OUT = 20 deg`, `TIP_OUT_EDGE = 40 deg`, `TIP_OUT_SPEED = 3`, `TIP_SPAN = 15 deg`, `TIP_RATE = 1.5`, `TIP_DRAIN = 2`, `HAND_DRAG = 1.5`, `PRESS_DEAD = 0.15`. These are first guesses (the trim table above is what they give); tune on the pad on Drew's PC (a groomer at Vail and an icy aspect) and record the final ones on the card.

## 4. Build steps (one card, FEAT-220)
1. `Settings`: `bodyControl: 'auto' | 'trim' | 'full'` (Controls tab, shown with a pad). README controls table and developer guide.
2. `Input`: `body?: number` (-1..1, right X, sign so + is toward the steer side at use), `press?: number` (0..1, right Y down). `Controls.update()` fills them when the mode is on and stops `padLookX/Y` on the snow.
3. `Rider`: `bodyLean`, `tip`. `easeSquat` takes a depth. `carve()`: hard carve eases toward `press` depth; lean from step 1 of the physics; pass it to `balance()`; the tip meter and the two slams.
4. `PadFeedback`: rumble on `tip`. `BodyPose.incline()`: blend toward `bodyLean`. Hand drag spray.
5. `tools/bodycheck.mjs` (esbuild pattern of `carvecheck.mjs`): Auto is identical to `main` on `carvecheck` / `fallcheck`; Trim 0 identical too; the slam cases in the trim table happen within 30 % of the listed times; from flat, `d = 0.75` at 22 m/s never washes out and `d = 1` at 20 m/s does (as the key today). Then switch `tools/bodytune.mjs` from its copy of the tip meter and the lean to the real code, so its tables keep tracking the game.

## 5. Out of scope (later cards if v1 is fun)
- Right stick up as extend / unweight (quicker edge change, less grip).
- Fore-aft weight on an analog axis for presses and powder (FEAT-151 territory).
- Counter-rotation (shoulders against the board) for pivots and spins (FEAT-187 pre-wind).
- Per-limb IK targets from the sticks.
