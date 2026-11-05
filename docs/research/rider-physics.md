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

## 3. Validation targets
- Groomed blue at 12 to 15 deg (Born Free, Lost Boy, Swingsville): cruising speed 35 to 50 km/h with turns; terminal ~100 km/h without turning.
- A carved turn at 30 km/h on an 8 m board: R ~ 5 to 7 m, about 1.5 g.
- Black mogul runs at 25 to 30 deg (Highline, Prima): carving impossible above ~20 km/h; the controller must skid.

## Sources
- [Komissarov, Balanced carving turns in alpine skiing (arXiv 1812.02539)](https://ar5iv.labs.arxiv.org/html/1812.02539)
- [Simulation of Snowboarding (SCITEPRESS 2018)](https://scitepress.org/PublishedPapers/2018/68964/pdf/index.html)
