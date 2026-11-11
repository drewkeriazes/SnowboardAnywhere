# Dual-stick body control (FEAT-220)

Investigated 2026-11-11 against `main` at 97926a3. Idea from Drew: with a controller's two sticks we can drive two parts of the rider at once, for more realistic body positions, and positions that put you on the snow if you get them wrong. Build on the hard press: pressing harder carves tighter but can skid.

KISS version: the left stick stays exactly as it is (steer and the edge, tuck / brake, press balance). The right stick becomes the **body**: X leans the upper body in or out of the turn, Y down compresses (the hard press, now analog), Y up is left for later. With the right stick centred the rider rides exactly as today. No new physics, only one lean value that today is computed and now can be offset, plus one balance meter.

## 1. What the code does today (checked)

| Piece | Where | Today |
|---|---|---|
| Left stick X steers, Y tucks / brakes / balances a press | `sim/Controls.ts` `update()` | analog steer, digital tuck / brake past half way |
| Right stick looks | `Controls.ts` `padLookX / padLookY` | free look while pushed |
| Hard carve | `EdgeModel.ts` `carve()` lines 16-19 | `input.squat` held + steer > `HARD_STEER`: `r.hardCarve` eases to 1 over `HARD_IN` (0.12 s). Pad has no squat button by default (`DEFAULT_PAD.squat = []`); X is the shared "get small" grab |
| Body lean | `EdgeModel.ts` `balance()` | `phi = min(phiMax, psi * (1 - angulation))`: the lean follows the edge, the player never sets it |
| The turn the lean holds | `balance()` | `aLat = min(v^2 turn / (Rsc cos psi), g nz tan(phi) turn + gIn)` |
| Skid and washout | `carve()` lines 45-72, `grip()` | asking more turn than the edge holds sets `carveShort` (skid); far short at speed fills `washout`, full = slam to the inside |
| Drawn lean | `world/riderView/BodyPose.ts` `incline()` | from the measured lateral g, so the picture follows the physics |
| Free buttons | `sim/Pad.ts` `DEFAULT_PAD` | R3 = glance, L3 = boost |

## 2. The design

### Input (one new setting: Controls > Body control: Auto / Trim / Full, default Auto)
- **Auto** (default): today, right stick looks. Nothing changes for anyone who does not turn it on.
- **Trim**: right stick X adds a lean offset to the automatic lean, up to `BODY_TRIM` = 35 deg at full stick, with a 1.5 power curve so small corrections are fine. Toward the steer = lean in, away = stand up.
- **Full**: right stick X sets the lean outright, full stick = `HARD_PHI` (69 deg). No automatic lean at all: at a crawl you must stay upright, at speed you must lay it over. Hard mode.
- **Right stick down** in Trim and Full: compress. Depth `d` (0..1 past a 0.15 dead zone) replaces the squat key's on / off: `r.squat` eases toward `d`, and while steering past `HARD_STEER` the hard carve eases toward `d` instead of 1. Keyboard Shift keeps working as `d = 1`.
- Free look with Trim or Full on: the right stick looks only while off the snow (air, lift, on foot, stopped under 1 m/s); the gyro and glance (R3) still work riding. FEAT-186 later claims the right stick in the air for grabs, which fits.

### Physics (EdgeModel only)
1. `r.bodyLean` (rad, + into the turn) = `phiAuto + trim` (Trim) or the stick angle (Full), capped at `PHI_MAX + (HARD_PHI - PHI_MAX) * H`.
2. `balance()` takes the lean as an argument instead of computing it. At speed the turn is lean-limited, so leaning in tightens the turn and standing up opens it (physically right: same edge, more lean, more turn force).
3. **Tip meter** `r.tip` (-1..1, + inside, like the press needle):
   - lean-in error `eIn = bodyLean - max(phiAutoBalanced, phiHold)` where `phiHold = atan(min(arc, gripMax) / (g nz))` is the most lean the edge and the snow can carry. Measured against the larger of the two so **Trim at zero never fills it**: the default ride is today's ride, ice included.
   - stand-up error `eOut = phiAutoBalanced - bodyLean`, counted only with the edge past 40 deg and speed over 3 m/s (a high edge with the body upright is what throws you over it).
   - past the tolerance (`TIP_IN` 10 deg, `TIP_OUT` 20 deg) the meter fills at `TIP_RATE` (1.5 /s) per `TIP_SPAN` (15 deg) over; under it, it drains at `TIP_DRAIN` (2 /s).
   - full: **low-side** (inside, `crashSide = sign(edge)`, same fall as the washout) or **high-side** (thrown over the outside edge, `crashSide = -sign(edge)`).
   - warning before the slam: past 0.4 the inside hand drags (`HAND_DRAG` 1.5 m/s^2 times the meter, spray from the hand), rumble scales with the meter (`PadFeedback`).
4. Feel preset Arcade multiplies `TIP_IN`, `TIP_OUT` by 1.5 and halves `TIP_RATE`.
5. Ghost and replay format unchanged (`bodyLean` is visible through `lateralG` and the pose); `BodyPose.incline()` blends toward `bodyLean` so a mismatched rider is seen tipping before the slam.

## 3. Tuning, worked out numerically

Harness: the `balance()` and hard carve formulas from `EdgeModel.ts` with today's `tuning.ts` constants, 15 deg groomer, mid-turn (gIn = 0), steady edge. Script in the PR notes; numbers below are its output.

### Today's baseline (auto lean)
| Speed | Edge 30 | Edge 45 | Edge 60 | Edge 72 |
|---|---|---|---|---|
| 5 m/s | R 6.8 m, 1.0 g | 5.5 m, 1.1 g | 3.9 m, 1.2 g | 2.4 m, 1.4 g |
| 8.3 m/s (30 km/h) | 14.6 m, 1.1 g | 8.8 m, 1.3 g | 5.5 m, 1.6 g | 3.6 m, 2.2 g |
| 16 m/s | 54 m | 33 m | 20.5 m | 13.6 m, 2.2 g |

Matches the rider-physics target (30 km/h carve on an 8 m board: R 5 to 7 m at about 1.5 g).

### Analog hard press (right stick down `d`), edge still rolling in at 45 deg toward 72
| Speed | d 0.25 | d 0.5 | d 0.75 | d 1 (today's key) |
|---|---|---|---|---|
| 10 m/s | R 9.1 m, safe | 6.7 m, skids, safe | 5.0 m, washout in 1.0 s | 4.1 m, 0.47 s |
| 14 m/s | 17.8 m, safe | 13.1 m, safe | 9.7 m, 0.33 s | 7.9 m, 0.16 s |
| 18 m/s | 29.5 m, safe | 21.6 m, safe | 16.1 m, 0.20 s | 13.1 m, 0.09 s |

Washout times are while the edge lags; it reaches the target in about 0.15 to 0.3 s, so a timed press bites and a late, deep one at speed washes out. The existing `WASH_SHARE` (0.35) already makes half depth the safe zone, so **no washout constants change**: depth alone gives "harder is tighter, too hard too late is a skid or a slam". This is the curve Drew asked for.

### Body trim (Trim mode)
| Case | Trim 0 | +0.3 (10.5 deg in) | +0.6 (21 deg in) | full in (35 deg) | half out | full out |
|---|---|---|---|---|---|---|
| Groomer, 2 m/s, edge 60 | R 3.9, safe | safe (20 s) | **slam 0.9 s** | **slam 0.4 s** | safe | safe (edge low share) |
| Groomer, 5 m/s, edge 60 | R 3.9 | safe | slam 0.9 s | slam 0.4 s | R 8.9, safe | **high-side 0.7 s** |
| Groomer, 10 m/s, edge 60 | R 8.0 | R 5.3, safe | R 5.0, safe | R 5.0, safe | R 14.9 | high-side 0.7 s |
| Groomer, 16 m/s, edge 60 | R 20.5 | R 13.6 | R 12.9 | R 12.9 | R 38 | high-side 0.7 s |
| Ice, 10 m/s, edge 60 | R 12.8, safe (today) | **slam 0.7 s** | slam 0.5 s | slam 0.5 s | safe | high-side 0.7 s |
| Ice, 16 m/s, edge 30 | R 54 | R 36 | R 33 | slam 0.8 s | safe | safe |

What this gives:
- Slow, leaning in drops you on your hip (you can't lean on a turn that has no force). Small trims are free.
- Fast on a groomer, leaning in is a skill: the same edge carves a third tighter, held by the corduroy.
- On ice the grip, not the lean, is the limit: lean past it and it washes out to the inside.
- A big edge with the body stood up throws you over the outside edge in under a second.
- Full mode is the same table with Trim 0 gone: the stick has to find the lean every turn.

### Constants (all new, `tuning.ts`)
`BODY_TRIM = 35 deg`, `BODY_CURVE = 1.5`, `TIP_IN = 10 deg`, `TIP_OUT = 20 deg`, `TIP_OUT_EDGE = 40 deg`, `TIP_OUT_SPEED = 3`, `TIP_SPAN = 15 deg`, `TIP_RATE = 1.5`, `TIP_DRAIN = 2`, `HAND_DRAG = 1.5`, `PRESS_DEAD = 0.15`. These are first values from the harness; tune on the pad on Drew's PC (a groomer at Vail and an icy aspect) and record the final ones on the card.

## 4. Build steps (one card, FEAT-220)
1. `Settings`: `bodyControl: 'auto' | 'trim' | 'full'` (Controls tab, shown with a pad). README controls table and developer guide.
2. `Input`: `body?: number` (-1..1, right X, sign so + is toward the steer side at use), `press?: number` (0..1, right Y down). `Controls.update()` fills them when the mode is on and stops `padLookX/Y` on the snow.
3. `Rider`: `bodyLean`, `tip`. `easeSquat` takes a depth. `carve()`: hard carve eases toward `press` depth; lean from step 1 of the physics; pass it to `balance()`; the tip meter and the two slams.
4. `PadFeedback`: rumble on `tip`. `BodyPose.incline()`: blend toward `bodyLean`. Hand drag spray.
5. `tools/bodycheck.mjs` (esbuild pattern of `carvecheck.mjs`): Auto is identical to `main` on `carvecheck` / `fallcheck`; Trim 0 identical too; the slam cases in the table happen within 30 % of the listed times; `d = 0.5` at 14 m/s never washes out.

## 5. Out of scope (later cards if v1 is fun)
- Right stick up as extend / unweight (quicker edge change, less grip).
- Fore-aft weight on an analog axis for presses and powder (FEAT-151 territory).
- Counter-rotation (shoulders against the board) for pivots and spins (FEAT-187 pre-wind).
- Per-limb IK targets from the sticks.
