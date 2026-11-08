# Research: rider physics for a carving snowboard on a heightfield (M2)

Researched 2026-11-05. Section 1 is the ideal-carving model from Komissarov, "Balanced carving turns in alpine skiing" (arXiv 1812.02539): a point-mass skier on an inclined plane, which is exactly our rider on the local tangent plane of the heightfield. Section 2 is our adaptation to a snowboard and a game loop (design, not from the paper).

## 1. Carving model (from the paper)

Conventions: slope angle alpha (local, from the heightfield normal); beta = angle between velocity and the across-slope axis (beta = 90 deg is straight down the fall line); Psi = board edge angle to the snow; Phi = inclination of effective gravity (gravity + centrifugal) from the surface normal. Balanced carving requires Phi = Psi.

Turn radius from sidecut and edge angle:
```
R = R_sc * cos(Psi)
```
Balance and g-force:
```
tan(Phi) = v^2 / (g * R * cos(alpha)) - tan(alpha) * cos(beta)
g_force  = cos(alpha) / cos(Phi)
```
Ideal Carving Equation (the R at which a pure carve is balanced at speed v):
```
sqrt((R_sc / R)^2 - 1) = v^2 / (g * R * cos(alpha)) - tan(alpha) * cos(beta)
```
Equations of motion with snow friction mu and air drag kappa = Cd * A * rho / 2:
```
dv/dt    = g*sin(alpha)*sin(beta) - mu*g*cos(alpha)/cos(Phi) - (kappa/m)*v^2
dbeta/dt = v / R
dx/dt    = -/+ v*cos(beta)      (minus right turn, plus left turn)
dy/dt    = v*sin(beta)
```
Solving the ICE for xi = 1/R (dimensionless: R in units of R_sc, v in units of V_sc = sqrt(g*R_sc*cos(alpha))), with b = -cos(beta)*tan(alpha):
```
(v^4 - 1)*xi^2 + 2*b*v^2*xi + (1 + b^2) = 0
xi = [-b*v^2 +/- sqrt(1 + b^2 - v^4)] / (v^4 - 1)
```
Accept only real roots with xi >= 1 and v^2*xi + b >= 0, and re-check against the unsquared equation (squaring adds a spurious root). No valid root means a balanced carve is impossible at that state: the rider must skid.

Limits
- Pure carving needs v < V_sc = sqrt(g * R_sc * cos(alpha)); above it the required edge angle exceeds what geometry allows.
- Full half-circle carves need sqrt(g*R_sc*sin(alpha)) < v < sqrt(g*R_sc*cos(alpha)), so pure carving only works on moderate slopes (roughly 8 to 20 deg for ski sidecuts). Steeper means skidding.
- Fall-line terminal speed with friction: v_s^2 = (m*g/kappa) * sin(alpha) * (1 - mu*cot(alpha)).
- Geometric limit Psi <= ~80 deg; athlete limit ~3 g (Phi ~ 70 deg); snow fracture on a groomed track around Phi ~ 81 deg, far lower in soft snow.

Parameters used in the paper
| Quantity | Value |
|---|---|
| Snow friction mu | 0.04 (hard groomed) |
| Cd, A, rho | 0.5, 0.4 m^2, 1.2 kg/m^3 -> kappa ~ 0.12 kg/m |
| Mass | 70 to 80 kg |
| Sidecut radius | 13 m (slalom ski), 50 m (downhill ski) |
| Typical speeds | slalom ~40 km/h; terminal on 15 deg ~148 km/h without turning |

## 2. Adapting to a snowboard and a game (our design)

Board numbers (typical production values; tunables)
- All-mountain snowboard sidecut radius R_sc = 7 to 9 m (freestyle 6 to 7, freeride/carve 9 to 12). Use 8 m default. This is much tighter than skis, so V_sc at alpha = 15 deg is sqrt(9.81 * 8 * 0.966) ~ 8.7 m/s (31 km/h): above that, pure carving is impossible and the model naturally forces skidding, which is realistic for a snowboard at speed.
- Edge angle is the player input. Map steer input s in [-1, 1] to target Psi = s * Psi_max with Psi_max ~ 65 deg, slewed at ~200 deg/s so an edge change takes ~0.3 s.

Hybrid carve/skid controller (fixed 120 Hz)
1. Sample the heightfield: height h, normal N (bilinear from the 1 m Float32 grid; 4-tap central difference at 1 m for N). alpha = acos(N.y); fall line = normalized projection of -Y onto the plane.
2. Compute beta from the velocity direction relative to the across-slope axis.
3. From target Psi get R_target = R_sc * cos(Psi). Check the ICE: if a balanced R exists within ~15 % of R_target, carve: lateral grip is "infinite", dbeta/dt = v/R, no lateral speed loss, mu = mu_carve (0.03 to 0.05).
4. Otherwise skid: lateral force capped at F_lat_max = mu_skid * N_force with mu_skid ~ 0.3 to 0.6 scaled by sin(Psi); excess lateral velocity bleeds off as speed loss and spray. Skid drag mu rises to 0.1 to 0.2 under hard braking (Down key).
5. Integrate v and position on the plane, then re-project onto the heightfield (snap y = h(x, z) when grounded; if the vertical gap exceeds ~0.3 m or vertical velocity exceeds the slope's, go airborne with ballistic motion).
6. Landing: impact angle theta between velocity and the slope plane. Speed retained = v * cos(theta) along the slope; if theta > 35 deg or vertical speed > 8 m/s, bail.

Surface modifiers (from the mask tiles)
| Surface | mu_carve | mu_skid cap | extra drag | notes |
|---|---|---|---|---|
| groomed corduroy | 0.04 | 0.5 | none | reference |
| chopped / tracked | 0.06 | 0.4 | random lateral noise 0.2 m/s^2 | moguls come from the 1 m DEM itself |
| powder (depth d) | 0.05 | 0.3 | k * d * v^2, k ~ 0.02 per m depth | "float": steering authority down 30 % |
| ice / wind scour | 0.02 | 0.15 | none | skids easily; edge chatter |
| spring slush | 0.08 | 0.45 | none | |

Inputs (match Bonvo so players can switch): Left/Right steer, Up tuck (Cd*A x 0.6, steering authority x 0.7), Down brake, hold-release Space jump (vertical impulse ~2.5 to 3.5 m/s scaled by hold time), Shift grab, camera toggle.

Camera (chase): follow point 6 m behind and 2.5 m above the rider along the velocity direction, critically damped spring (omega ~ 6 rad/s), FOV 65 deg at rest rising to 80 deg at 25 m/s, minus 3 deg in a tuck.

## As built (FEAT-127, `game/src/sim/Rider.ts`)

The game keeps the carve geometry and the balance but departs from strict ideal carving at speed:
- Steer sets a target edge `Psi = steer * Psi_cap`; the edge rolls at 400 deg/s (skis 460), 1.5x that while it crosses to the other side (unweighting), easing in over the last few degrees, so edge to edge takes about 0.3 s (BUG-053; was 220 deg/s and 0.6 s, which read as a hang between turns at speed). `Psi_cap` is 72 deg on firm snow (skis 68), 45 deg in powder (the board planes), 85 % of that in a tuck (was 70 %), +5 deg in a squat, less on a press, and at a crawl only 25 deg plus the lean the sidecut's arc needs (slow, a high edge would tip you into the hill).
- The body inclines `Phi = Psi * (1 - angulation)` (angulation 0.12, capped at 68 deg); the knees and hips make up the rest.
- Turn: `a_lat = min(v^2 / (R_sc cos Psi), g cos(alpha) tan(Phi) + g_in)`, where `g_in` is the slope's pull toward the turn centre (the paper's `tan(alpha) cos(beta)` term). Slow, the sidecut's arc sets the radius; fast, the arc opens out to the radius the lean can balance (a partly bent board), instead of the paper's forced skid above `V_sc`. With keyboard steer being all or nothing, forcing a skid on every fast turn was unplayable. The heading turns at `a_lat / v`, plus a pivot that fades out by 9 m/s (8 for skis) so slow steering still works, plus from about that speed up a steer yaw of 0.25 rad/s x steer (BUG-053, a feel term, not physics) so the board keeps coming round through the flat crossover instead of waiting for the new edge to bite. `g_in` counts in full when it helps the turn (down into the fall line) and at half when it fights it (climbing out across the hill), so the end of a turn is not its weakest part.
- Targets at 25 m/s on a groomer (`tools/carvecheck.mjs`): full carve standing 1.0 rad/s, radius 24 m; tucked 0.76 rad/s, radius 33 m; edge to edge 0.28 s with the heading rate under 0.2 rad/s for 0.07 s at the crossover (was 0.75 / 0.35 rad/s, 32 / 72 m, 0.65 s and a 0.37 s hang before BUG-053). The slow pivot at 3 m/s is unchanged at 1.7 rad/s.
- Grip: `g * surface * (0.55 + 0.9 * min(1, Psi / 40 deg))` for the board (skis 0.65 + 0.75), `surface` 1.4 on corduroy, 1.0 off piste, 0.5 less on rock and scree, x1.08 in a squat, less on a press. Past it the heading pulls ahead of the velocity; past 4 deg of slip the arc lets go of the heading (gone by 34 deg), so a wash-out settles into a skid at about 10 to 15 deg of slip rather than spinning out.
- Result on a 22 deg groomer (board): 8 m/s full edge R ~ 6 m at 1.6 g (the validation target below), 15 m/s R ~ 15 to 17 m, 22 m/s R ~ 30 m, all at 72 deg edge with no skid; on rock the same turn washes out; a squat on corduroy just exceeds the hold.

## As built: the brake (FEAT-065, FEAT-133, `game/src/sim/Rider.ts`)

Komissarov's snow-cutting model of the side-slip and the hockey stop: holding brake swings the board to the angle of attack `gamma` off the travel direction (84 deg) over 0.25 s while the edge angle `Psi` ramps from 15 deg to a cut that rises with the slope (45 deg on gentle pitches, slope + 12 up to 68). The snow resists the board's slide across its own edge with up to `N tan(Psi)`, and since FEAT-133 that push is applied at right angles to the board rather than against the velocity: the part against the travel direction brakes, `a = g cos(alpha) tan(Psi) sin(gamma)` (the FEAT-065 figure, so a plain stop is unchanged, 1.4 s and 8 m from 10 m/s on 15 deg), and the part across it turns the rider toward the edge, so a partial swing is a skidded turn. The dug-in edge also drags along its own length at up to 35 % of the cut, so the slide settles rather than running on along the board. While the board is swung the carve grip under the heading fades out and the heading follows the travel direction, so the brake's push is not fought by the carve and the board rides off on its new line when the brake lets go.

Steer works the brake while it is held (eased over 0.2 s): toward the brake side squares the board to 90 deg and tips the edge 12 deg past the plain cut (stop from 10 m/s on 15 deg in 1.0 s and 5.8 m instead of 1.4 s and 7.9 m); away from it opens the swing to 40 deg and lets the edge off to 25 deg, a skidded turn that turns 20 deg in the first 1.5 s and about 60 deg by the time it stops, 4 s and 21 m later, drifting down the fall line. On a 35 deg pitch the soft edge cannot hold the slope's pull across the board (`g sin(alpha)` = 5.6 m/s^2 against `g cos(alpha) tan(25 deg)` = 3.7) and the rider side-slips at 3.7 m/s after 3 s; the dug-in edge (47 deg) holds and stops in half a second. `tools/brakecheck.mjs` checks all of these.

## As built: the fall line (FEAT-134, `game/src/sim/Rider.ts`)

Before FEAT-134 the flat base held 0.55 g sideways (0.77 g on corduroy), more than the pull across a 50 deg pitch, so a rider with no input traversed any slope on rails. Now, scaled by the Fall line setting (Realistic 1, Assisted 0.5, Off 0 = the old behaviour):
- Grip: `g * surface * (0.12 + 1.33 * min(1, Psi / 40 deg))` for the board, so a flat base holds a waxed base's friction and a full edge holds the same 1.45 g as before. Across a 30 deg groomer the flat board side-slips at `g sin 30 - 0.12 * 1.4 g` = 3.2 m/s^2; 20 deg of uphill edge holds it.
- Weathervane: the heading turns toward the fall line at `4 * sin(slope) * sin(angle to the fall line) * (1 - Psi / 12 deg)^2 / (1 + v / 20)` rad/s. A feel term standing in for the rider's weight on the front foot, not from the paper: on a blue (17 deg) a flat board swings from across to within 30 deg of the fall line in about 1.3 s at 8 m/s, on a black (30 deg) in 0.9 s, and any real edge stops it.
- Standing: nearly stopped across the hill, the rider only holds still with 10 deg of uphill edge (5 deg on Assisted; steer into the hill) or the brake; at a crawl the steer into the hill is not a pivot, so holding it does not spin the board, while steer downhill still turns the board to run.
- Edge catch (realistic only): side-slipping (the velocity more than 30 deg off the board, over 2 m/s of it sideways, over 3 m/s) onto the downhill edge past 15 deg for 0.05 s is a crash. A skidded carve transition slips 10 to 15 deg and never trips it; six seconds of linked full carves from 20 m/s lose the same speed as with the fall line off (slowest 12.0 m/s either way).
- Not done from the card: an edge that only holds a push toward its own side (it turned every carve transition into a skid, since the new edge is always briefly on the wrong side of the lagging velocity), and the minimap fall-line arrow.

## 3. Validation targets
- Groomed blue at 12 to 15 deg (Born Free, Lost Boy, Swingsville): cruising speed 35 to 50 km/h with turns; terminal ~100 km/h without turning.
- A carved turn at 30 km/h on an 8 m board: R ~ 5 to 7 m, about 1.5 g.
- Black mogul runs at 25 to 30 deg (Highline, Prima): carving impossible above ~20 km/h; the controller must skid.

## Sources
- [Komissarov, Balanced carving turns in alpine skiing (arXiv 1812.02539)](https://ar5iv.labs.arxiv.org/html/1812.02539)
- [Simulation of Snowboarding (SCITEPRESS 2018)](https://scitepress.org/PublishedPapers/2018/68964/pdf/index.html)
