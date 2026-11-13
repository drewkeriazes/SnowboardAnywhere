# Research: Takeoff physics, launching off lips and side hits (FEAT-277)

How a rider gets air off a lip, a side hit or a kicker without pressing jump, and what to tune so it feels right in Realistic mode while Arcade (BUG-055) can scale it up. This is ordinary projectile physics plus a short spring at the lip. No commercial game's internals are used or needed here: the mechanic is published terrain-park-jump physics, and the references are listed at the end.

Labels: **physics** is the closed-form result, **model** is the simplification this game makes, **tuning** is a knob to set by feel.

## 1. The core: a lip rotates your velocity, gravity does the rest

Riding up a ramp face does not add energy. It redirects the velocity you already carry. Leave a lip at speed `v` where the ramp face at the lip meets the horizontal at angle `θ` (the **takeoff angle**), and your velocity at the lip splits into:

- along-ground: `v · cos(θ)`
- upward: `v_z = v · sin(θ)` (**physics**)

Once the lip ends there is nothing under you, so you are a projectile. On flat ground past the lip:

- peak height: `h = v_z² / 2g`
- air time: `t = 2 · v_z / g`

That is the whole no-pop launch. The air is "free" only in the sense that the terrain did the steering: you paid for it in the speed you carried in.

### Numbers to tune against

| Speed | Takeoff angle | v_z | Peak height | Air time |
|---|---|---|---|---|
| 10 m/s (22 mph) | 15° | 2.6 m/s | 0.34 m | 0.53 s |
| 15 m/s (34 mph) | 20° | 5.1 m/s | 1.3 m | 1.05 s |
| 20 m/s (45 mph) | 25° | 8.5 m/s | 3.7 m | 1.72 s |
| 15 m/s | 10° | 2.6 m/s | 0.34 m | 0.53 s |

(**derived** from `v_z = v·sinθ`, `g = 9.81`.) Two readings: a shallow side hit at trail speed is a short, playful 0.3 to 0.6 s air, and the takeoff angle matters as much as the speed. A 25° lip at 20 m/s is already a real jump.

## 2. Why the game throws the air away today

`sim/rider/Jumps.ts` `followGround` decides each step whether the rider has left the surface:

```
const vzSurf = -(r.vx * n2[0] + r.vy * n2[1]) / Math.max(0.2, n2[2]); // vertical speed to stay on the slope PAST the lip
const ballistic = r.vz - G * dt;                                      // vertical speed if we just fall
const lift = 1.5 - 1.3 * Math.min(1, r.surface.moguls / 0.4);         // margin: 1.5 m/s open snow, ~0.2 on moguls
if (ballistic > vzSurf + lift && spd > 6) {
  r.onGround = false; r.airTime = 0; ...
  r.vz = vzSurf;   // <-- the bug: resets to the downhill surface, deleting the ramp's upward speed
}
```

Two problems:

1. **The reset (the main bug).** On takeoff `r.vz = vzSurf`, the vertical speed needed to hug the slope *below* the lip, which is downward on a drop. The upward speed you built on the ramp face is overwritten the instant you leave. So a lip drops you off instead of sending you. (**model** error.)
2. **The margin swallows small lips.** `lift` is 1.5 m/s on open snow so 1 m of DEM noise does not launch you. A real side hit kicks less than that, so it never triggers. Moguls work only because FEAT-059 shrinks the margin on bump fields.

## 3. The fix (what FEAT-277 builds)

1. **Keep the ramp's speed.** On takeoff set `r.vz = ballistic` (the upward speed carried off the face), not `vzSurf`. This alone restores section 1's physics.
2. **Smaller margin on sharp lips.** Lower `lift` where the surface normal turns sharply over a short distance (a true lip or side hit), keep 1.5 m/s on open snow. Reuse the FEAT-059 curvature idea, keyed on slope change rather than the mogul mask. (**tuning**: how sharp counts as a lip.)
3. **Pre-load adds, it does not create.** If the jump is held (`jumpCharge > 0`) or the tail is loaded (`|lean| > 0.5`) as you leave, add a small extra `v_z`, about `0.8 · jumpCharge` m/s in Realistic. No auto pop otherwise. This is the "bending the board in the early stages of an ollie" feel.

## 4. The transition is the feel knob

Section 1 treats the lip as a clean angle. Real ramps curve: a **transition** (the arc from the flat into the ramp face) redirects momentum over a short distance instead of instantly. The curvature sets the G-load and how "poppy" the hit feels:

- Mellow transition (long arc): momentum turns gradually, smooth, little buck. (**model**: the surface-follow already does this when the normal turns slowly.)
- Abrupt transition (tight arc): the surface demands more centripetal acceleration than gravity plus the legs can supply, so you launch early and get bucked, extra air you did not ask for. This is exactly the `ballistic > vzSurf + lift` condition firing.

So the launch detector and the feel are the same mechanism: you leave the ground when the surface curves away faster than you can be held to it. Tuning the margin and the curvature threshold (step 2) is tuning how twitchy side hits are. (**tuning**.)

## 5. The rider's own pop, for scale

From BUG-055, a real ollie adds roughly 0.3 to 0.6 m (a strong one about 1 m), a takeoff of about 2.5 to 4.6 m/s of `v_z`. That is the ceiling of what a rider makes on flat snow. Everything above it in the table in section 1 is terrain. So in Realistic mode the pop is a garnish on the terrain's air, and big air has to come from a real lip or kicker (FEAT-113), which is the intended feel. Arcade mode is free to scale both.

## 6. References (published, no game internals)

- McNeil, Hubbard & Swedberg, *Designing, building, measuring and testing a constant equivalent fall height terrain park jump* (Sports Engineering, 2012; preprint [arXiv:1611.04448](https://arxiv.org/abs/1611.04448)). Takeoff angle, approach speed, landing surface shaped so the equivalent fall height stays constant. This is the ground truth for takeoff angle vs air.
- Hubbard, *Equivalent fall height* as the measure of jump severity, [Springer](https://link.springer.com/article/10.1007/s12283-017-0253-y).
- Scientific American, [*Olympic Big Air Snowboarders Use Physics to Their Advantage*](https://www.scientificamerican.com/article/olympic-big-air-snowboarders-use-physics-to-their-advantage/), a plain-language take on the same takeoff geometry.

Takeoff angle and approach speed fully determine the trajectory; the rider adds a small, bounded pop. Nothing here needs any shipped game's code, which is why it can live in the open repo.
