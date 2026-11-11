# Trick system, animation and visual roadmap: lessons from The Snowboard Game, Steep and peers

Research report (claude.ai deep research, 2026-11-05) on how The Snowboard Game, Steep, Riders Republic, SSX, Shredders, Skate, Infinite Air and Grand Mountain Adventure handle rider physics, trick input, scoring, animation and rendering, turned into a design the game can build on. This is the "Source" the cards below cite.

## Cards made from this report

First pass (2026-11-05): FEAT-043 to FEAT-064 (#75 to #97). Second pass (2026-11-10), after checking the board and the code:

| Card | Epic | Report sections |
|---|---|---|
| FEAT-186 #452 Grab tricks | EPIC-05 | 4.5 grabs, 3 Infinite Air |
| FEAT-187 #453 Spin wind-up and momentum | EPIC-05 | 4.3 pop at the lip, 4.4 air rotation |
| FEAT-188 #454 Landing absorb and feedback | EPIC-05 | 4.8 landing evaluation |
| FEAT-189 #455 Trick score, lines and a trick book | EPIC-05 | 4.9 scoring, 3 SSX and Shredders |
| FEAT-190 #456 120 Hz input log and re-sim | EPIC-11 | 4.2 input sampling, 6 determinism and replay format |
| FEAT-191 #457 Session features | EPIC-06 | 1 sessions, 7 M11 and M14 |
| FEAT-192 #458 Judged park runs | EPIC-09 | 7 M13 |
| Comments on FEAT-114 #197, FEAT-061 #94, FEAT-049 #81 | | 4.7 rails, 6 testing, 6 assist profile |

Not taken: the G-meter (4.8; the landing already uses slope-relative impact and the report's own sources call Steep's version "RNG"), volumetric fog and tessellation (5; out of reach in WebGL2), and anything already on the board or shipped (replays, ragdoll, rider IK, fixed step, fog and sky, snow conditions, flips, ollie, presses, photo mode).

Numbers in sections 4 and 6 (thresholds, byte sizes, effort tiers) are design proposals to tune, not measurements from these games. Steep rendering details are inferred from screenshots; no developer talk on them was found.

## TL;DR

The best model is a hybrid. Use The Snowboard Game's physics-first, stick-driven control (wind-up, flick, release-to-pop, board steered by the right stick) on top of the existing Komissarov carving model. Add Steep's forgiving layers (path recording, drop-anywhere, ghost challenges). Then add an SSX-style combo and multiplier ledger for scoring. One correction to the brief: The Snowboard Game is made by Let it roll AB (Sweden), not "Grassgames", and it has no lineage to "Snowboarding The Fourth Phase", a Red Bull mobile title from a different studio.

- **What to copy, from where:** The Snowboard Game's input model: hold a trigger to load, wind up on the left stick, flick and release at the lip, the right stick moving the board. Steep's ragdoll trigger and path-replay systems. SSX's banked-combo-plus-multiplier scoring. All of these fit on the 120 Hz point-mass carver once it has an angular-momentum air model and a landing evaluator.
- **Visuals are feasible in the browser with fallbacks:** wrap-lit PBR snow, sparkle, height fog, analytic sky and a rider-local render-to-texture snow-trail heightfield all fit WebGL2 at 60 fps. True volumetrics, tessellated deformation and full-body active ragdoll do not; section 5 gives a cheaper substitute for each.
- **Roadmap:** after M6, seven phases (M7 to M13): replay and ghost first (it doubles as the test harness), then air tricks, rider animation, landing and scoring, butters and rails, visual polish, then challenges and photo mode. Only parks and rails need hand-authored content; everything else derives from the DEM, masks and OSM.

## Key findings

| Topic | The Snowboard Game | Steep / Riders Republic | Transfer to SnowboardAnywhere |
|---|---|---|---|
| Developer, engine | Let it roll AB (Sweden), Unity per SteamDB and ModDB | Ubisoft Annecy, AnvilNext 2.0 (Ghost Recon Wildlands tech) | Three.js r172 is fine; neither game's feel depends on engine-specific features |
| Terrain | "Five fictional handcrafted mountains" | Real data available at about 50 cm but deliberately not used; big shapes authored, details procedural | Real lidar is the differentiator; add authored parks on top |
| Physics feel | Simulation, steep learning curve, edge and weight via sticks | Balance of realism and arcade; G-force meter | Keep Komissarov carving; add assist sliders |
| Trick input | Trigger load, left-stick wind-up, flick, release; right stick moves the board | Trigger release pops; sticks spin and flip; triggers grab | Dual-stick "Physical" scheme plus a Simplified preset |
| Bails | Ragdoll (improved in a 2018 patch) | "Ragdoll trigger" when G-force is exceeded | Threshold-driven ragdoll from the landing impulse |
| Replays | Replay timeline mode (2021) | Auto-recorded path, shareable replays, trails as challenges | Fixed-Hz state log from day one |

## 1. The Snowboard Game (Let it roll AB)

### Identity and status (verified)

- **Developer, release, price.** Developer and publisher Let it roll AB, released 24 Apr 2018. Steam shows "Very Positive (310)", 82% of 310 reviews positive, $14.99.
- **Pitch.** "A realistic skill based snowboard game with natural physics set in multiple immersive mountain locations and snow parks." "The focus of development has been to create natural and immersive physics while still being fun with tight and responsive controls."
- **Who made it.** Marcus Forsmoo, per letitrollproductions.com: "I'm Marcus Forsmoo, a passionate gamer and developer, the person behind Let It Roll AB". A ranking site describes the company as "comprised of just one guy" (secondary, consistent).
- **Engine.** SteamDB lists "Technologies: Unity Engine"; ModDB also lists Unity. Supporting inference: the controls-reset instructions point to `HKEY_CURRENT_USER\Software\Let it roll AB\The Snowboard Game`, where Unity stores PlayerPrefs. Minimum spec is a GTX 550 class GPU with DirectX 11, so a modest Unity pipeline (inference).
- **Name correction.** No source links the game to "Grassgames" (that studio makes card games). "Snowboarding The Fourth Phase" is a separate 2015/2016 Red Bull Media House mobile game; MobyGames credits Session Games Inc., a Red Bull video credits Roadhouse Interactive; neither is Let it roll AB.
- **Lineage to Shredders.** Let It Roll teamed up with I-Illusions to form FoamPunch, the studio behind Shredders (2022, Unity). Shredders is the big-budget successor of The Snowboard Game's control philosophy.

### Physics approach

From the developer's posts and patch notes:

- **Board steering.** In flips "The right stick is moving the board"; butters use "LT and right stick to control board". The right stick drives board orientation and pressure, not the camera: body and board are separate controlled bodies (inference).
- **Speed through stance.** A player: "hold the left stick forward as you carve to maintain speed", and moving it "to the back half you start scrubbing speed". Left stick = fore-aft weight plus lean; rear-weighted skidding scrubs speed. Close to the carve/skid controller with a pressure term.
- **Tunable thresholds.** May 2018: "Side-cut / land physics threshold turned up", "Rewritten input processor". An explicit sidecut-based carve threshold (like the Ideal Carving Equation switch) plus a land-contact threshold.
- **Assists are optional layers.** 23 Dec 2021: "(Optionally) Easier landings, no roll", "(Optionally) Less landing assist, no rail magnetism". 21 Dec 2021: "Hardcore mode doesn't have the rail magnetism" and "has adjustable restore jump corrections". Lesson: a physics sim ships with invisible helpers (landing auto-align, rail magnetism, takeoff corrections) and exposes their strength as a difficulty option.
- **Momentum rebalancing.** "Rebalanced takeoff momentums", "rebalanced takeoff spin speeds to match pre takoffs [sic]". Pre-takeoff wind-up sets the initial angular velocity; it is not an in-air animation trigger.

### Control scheme (reported)

| Action | Gamepad | Keyboard |
|---|---|---|
| Steer, lean, weight fore-aft | Left stick | Arrow keys |
| Board orientation, presses, flick for flips | Right stick | Rebindable in the launcher |
| Load ollie (crouch), release to pop | Hold RT, release at takeoff | Down arrow in place of RT |
| Butter, press | LT + right stick | Rebindable |
| Spin pre-wind | Left stick held to the side before takeoff | Arrow held |
| Flip pre-wind | Left stick back, then flick forward (or both sticks) | Arrows |
| Grabs | Right-stick sequences in the air | Method = left then up; Japan = up then right |

- **Flips.** Valid inputs: "Flicking forward on the right stick from center", "Wind up with left stick backwards, then flick forward", "Remember to keep holding left stick forward to keep flipping". The flip direction is held in the air to sustain rotation torque.
- **Pre-wind feedback.** The tutorial shows a "yellow bar filling up"; "the input feedback will freeze when you are in the air".
- **Input per frame.** The developer: "If you have a very low fps and you manage to somehow flick back and forth faster than you run the game it will not register the change". Input is sampled per render frame, a weakness to avoid. Skate producer Scott Blackwood (Gamasutra): "we need to read it at 120 to get all that information on how fast you were and how accurate you were. Then we built that into the physics."
- **Keyboard grabs** are short directional sequences ("press left arrow, release left arrow, press up arrow (and hold for the grab)").
- **Flip difficulty.** Players called flips "100% impossible" after one build; the developer "made them a bit more forgiving". Tune the flip input window carefully.

### Trick system (verified pieces plus inference)

- **Spins and flips** come from takeoff angular momentum (pre-wind plus flick), not canned animations. A player reports "big 1440s with two tweaked grabs". Rodeos exist: "Double Rodeo 7 mission can now be completed with any Double flip".
- **Grabs** are named (Method, Japan) and can be tweaked.
- **Butters and presses** are ground tricks on LT plus the right stick; nose and tail presses on rails on the experimental branch.
- **Rails.** "Takeoff and spin off rails" (Jun 2018), "Rail improvements" and optional rail magnetism (2021). A Jun 2021 experimental build broke flips on and off rails; players called it "quite the downgrade". Rail entry and exit must stay physics-continuous.
- **Scoring.** 14 Jun 2021: "Line bonus multiplier limits changed", "Combining butters, rails and jumps gives a trick multiplier". Line-based, with a cross-category variety multiplier.
- **Trick naming** is classified after the fact from measured rotation. "Trick naming is still a bit off sometimes" after a player complained about rodeo and cork classes. Lesson: classify from the measured axis and rotation, and keep a naming test suite.
- **Tours** "keep track of your highscores"; story missions request specific tricks.

### Animation, bails, terrain, multiplayer, modding

- **Animation.** Ragdoll exists ("Ragdoll improvements", Jun 2018). The body appears to be posed procedurally from board state and stick input (inference).
- **Terrain.** "Five fictional handcrafted mountains in three different mountain areas." Sessions: "create a session spawn point and place jumps to get further variation on each level". User-created levels: experimental Dec 2019, default Feb 2021, image previews Dec 2021.
- **Multiplayer.** An "Online hangout" (May 2018); user challenges cleared after 30 days. Servers shut down 30 Sep 2022; the "Offline version" removed online multiplayer and challenge creation. Lesson: do not build features whose existence depends on a backend you might stop running.
- **Replays.** Dec 2021: "Start replay in non smooth camera (Can bind a controller button to activate it while in timeline mode)". No full video editor.
- **Feel.** Metacritic user: "fantastic game, awesome physics of the rider, however the learning curve of the game is steep!". Steam: "actually somewhat realistic".

## 2. Steep (2016) and Riders Republic (2021)

### Engine and world building

- **Engine.** AnvilNext 2.0 (Wikipedia). Game director Arnaud Ragot (GamesBeat): "We're using the Ghost Recon Wildlands engine. It helps as far as capturing the details of the terrain."
- **Terrain method.** Ragot: "We make sure the big shapes of the terrain, like Mont Blanc, feel like we want them to, and then we define rules to generate the mountain procedurally."
- **Real data deliberately not used as-is.** Creative director Igor Manceau: the team "could have gone for GPS data", "precise to about 50cm", but "didn't quite go that way because on the real mountain not everything is something that you can ride". About "256 km squared". Tyrol "really close to real life, whereas the Aiguille is kind of the opposite". Erosion modelled by rock type. Correction to the brief: Steep is real-data inspired then composited; Mont Blanc and the Matterhorn share a zone though they cannot see each other.
- **Alaska and DLC.** Ubisoft News (23 Feb 2017): the free Alaska update, "21 new challenges, two new invitationals, a new Mountain Story", level cap 25 to 30. Japan and Korea came with Road to the Olympics.
- **Parks.** Manceau (Onboard): "I believe 15 freestyle snowparks in the game to play in, without counting the four Ultra Natural zones and big air spots", and "we haven't introduced rails yet". Rails were promised after launch (Game Informer, 16 Jan 2017).
- **Riders Republic** (AnvilNext 2.0) mashes Bryce Canyon, Yosemite, Sequoia, Zion, Canyonlands, Mammoth and Grand Teton into one map; up to 64 players in Mass Races (about 20 on last-gen), "60 FPS with over 50 live players onscreen" on Series X|S (Xbox Wire, 12 Jun 2021); a 6v6 Trick Battle mode where captured districts grant a score multiplier.

### Systems worth copying

- **G-force and wipeouts.** Whitelines: "If you get too many G's, you get what we call a 'ragdoll trigger', like a free physics on the body of the rider". The ragdoll "takes into account the weight of each body part". The meter recovers when you slow down; players learned to "slow down and regain your meter before the next jump". Others called it "RNG" on big drops: make thresholds legible. Crashes show "the amount of g-Force the player's character endured".
- **Trick input.** Keyboard: A/D spin, Space jump, L-Alt/Space grabs. Gamepad: hold the jump trigger, release before the lip, push a stick to trick, triggers to grab; release everything "before you are 50% of the way through the current rotation". Game Informer: "aimed at accessibility".
- **Camera and navigation.** First and third person, a GoPro-style camera, and "Mountain view" with drop zones as fast travel.
- **Replays and challenges.** "When players move around on the map, their path will be recorded automatically and can be viewed through entering the mountain mode." Replays can be shared; "players can set and share their trail as a challenge".
- **Riders Republic changes.** Control presets: "Trickster" (full manual) vs simplified, plus auto-landing; manual players "will earn more XP" (Gaming Age). Xsens inertial mocap captured on snow. Lead animator Julien Beilles: "a physical layer on top of an animation that runs in real-time" (an active-ragdoll blend over mocap).
- **Influences.** Trials and Skate 3.
- **No public Steep GDC or SIGGRAPH talk found** on snow rendering, streaming or deformation. The closest documented reference is the GDC 2014 Batman: Arkham Origins deformable-snow talk (section 5).

## 3. Other trick-system references (patterns that transfer)

- **SSX (Tricky, 3, 2012).** Tricks fill a boost meter; a full meter enables Uber tricks. SSX 2012: "they build up a combo bonus which goes through a multiplier once cashed in, but will be lost if the player bails". SSX 3: a per-trick bonus that grows "the later in a combo you perform a trick". Transfer: a pending-combo bank that cashes on a clean ride-away and is wiped on a bail.
- **Shredders (FoamPunch, 2022, Unity).** Left stick steers, right stick controls the board, right trigger jumps, left trigger is for landings, arm buttons plus the right stick do grabs. Rewind for bad landings, replays, photo mode, surfaces that ride differently. Criticised for no trick list and inconsistent trick registration ("I didn't do anything resembling a trick and it thought I had"). Transfer: rewind as a practice tool; always ship a trick list and an input visualizer.
- **Skate (EA Black Box).** Flick-it maps foot gestures to right-stick motions, read at 120 Hz. skate. (2025) presets "Classic", "Experienced", "Streamlined"; "Flick-It Sensitivity can be adjusted from 0 to 100 (default 50)". Transfer: sample input at the physics rate; offer presets.
- **Mark McMorris Infinite Air (HB Studios, Unity).** Left stick carves, quick flips and spins; right stick does "pre-loaded flip torques, shifters, tweaks, and the grab location"; triggers grab. Transfer: the right stick as a continuous grab-location selector.
- **Grand Mountain Adventure (Toppluva).** Built "completely from scratch including a custom game engine, map editor, physics engine"; open-world resorts with touch controls; GMA2 ships a map editor. Transfer: a small team can ship carving-real physics with touch controls.

## 4. Synthesized trick-system architecture (plan, not code)

### 4.1 Layering

1. **Sim core (existing).** Point mass on the local tangent plane at 120 Hz, Komissarov carve/skid.
2. **Rider state layer.** Board orientation, body yaw offset (wind-up), angular velocity, compression (0 to 1), edge angle, fore/aft pressure, grab state.
3. **Trick recognizer.** A pure function over a ring buffer of rider states; emits trick events, never feeds back into physics.
4. **Scoring ledger.** Consumes trick events; owns combos and multipliers.
5. **Presentation.** Animation, camera, VFX and audio, reading interpolated state.

### 4.2 Input mapping

| Intent | Gamepad ("Physical") | Keyboard | Touch |
|---|---|---|---|
| Lean, edge (heel-toe) | LS X | A/D | Left thumb drag X |
| Fore/aft weight | LS Y | W/S | Left thumb drag Y |
| Compression, ollie load | Hold RT, release pops | Hold Space | Hold right zone, lift pops |
| Spin wind-up | LS X held while loaded | A/D while Space held | Drag while held |
| Flip torque | RS Y flick at release | Up/Down after release | Swipe up/down on release |
| Press, butter | LT + RS | Shift + W/S | Two-finger tilt |
| Grab (location) | LB/RB plus RS direction; hold to keep | J/K plus arrows | Tap-hold a grab ring |
| Tweak | RS while grabbing | Arrows while grabbing | Drag while holding |
| Tuck, brake | Existing | Existing | Existing |

- Sample all input at 120 Hz inside the fixed step; store the raw axes in the replay log.
- A "Simplified" preset: auto-release pop at the lip, auto-level landing, spins on the left stick only (Riders Republic). Score assisted runs lower.

### 4.3 Takeoff detection and pop

- **Contact model.** Grounded while the board base is within epsilon of the heightfield and the normal force is positive; when the trajectory curves away faster than the terrain, you are at a lip: AIR.
- **Lip detection without authored kickers.** Compare terrain curvature along the velocity from the heightmap's second derivative (sample ahead at 0.5, 1 and 2 m). A large negative curvature change marks a natural kicker or rollover: cornices, road cuts, cat-track lips.
- **Ollie.** On release while grounded: impulse along the normal scaled by compression, plus a tail-pop pitch impulse. Release within a window before the lip (0 to 120 ms) for a lip bonus; after the lip is a ride-off with no pop.
- **Data.** Height and normal at the nose and tail contact points from the 1 m tile; surface type from the splat masks (powder reduces pop, ice increases slide); the groomed mask.

### 4.4 Air rotation model

- **State.** Angular momentum L (world), a diagonal body inertia I (yaw, pitch, roll), board-vs-body yaw offset.
- **Pre-wind.** While grounded and loaded, the stick accumulates wind-up up to about 90 degrees (the body counter-rotates visually). At pop, L_yaw = k_spin * windup + the carry-over yaw rate from the carve. This is why carving into a jump matters.
- **Flip.** Flick velocity at release sets L_pitch; holding the stick in the air adds a small sustain torque, capped so L cannot be created from nothing.
- **Off-axis (cork, rodeo).** Combine yaw and pitch/roll; the recognizer classifies by the integrated rotation axis, not the input.
- **Stopping.** Grabbing changes inertia; opening up (neutral sticks) applies a damping torque toward the nearest 180 multiple, its strength the "landing assist" slider.
- **Integration.** Integrate the orientation quaternion with omega = I^-1 L at 120 Hz; gravity acts on the point mass only.

### 4.5 Grabs

States: NONE, REACHING (150 to 250 ms), HELD, RELEASING, NONE.

- A grab counts once REACHING completes and scores only if HELD lasts 0.25 s or more.
- Grab score = base(grab) x f(hold time, saturating at 1.5 s) x (1 + tweak x 0.5).
- Tweak = stick deflection while HELD, driving an IK offset and a style score.
- Releasing within 150 ms of contact is a "late release" sketch penalty.

### 4.6 Presses and butters (ground)

- In a press the contact shifts to the nose or tail: a single-point pivot, edge grip drops, yaw becomes free.
- A **butter** is a press plus yaw rotation above 90 degrees; a **press** is a hold over 0.5 s with yaw under 30.
- **Masks.** Groomed scores full; powder sinks (less score, more decel); ice over-rotates.
- **Butter-to-pop:** popping during a butter inherits its yaw rate ("butter 180").

### 4.7 Rails and jibs

- **Sources.** Hand-placed park features (polylines with a profile: rail, box, ledge), plus curated OSM candidates (fences, guard rails, walls); OSM accuracy is metres, so curate before enabling.
- **Snap.** Within r_snap (0.4 m; 0.15 m hardcore) of the polyline with velocity within 35 degrees of its tangent: GRIND. Rail magnetism is the r_snap slider.
- **GRIND.** Position constrained to the polyline, speed integrated with rail friction, balance a 1D inverted pendulum (theta' = k sin theta + input + noise), past the limit you fall off. Board yaw to the rail gives boardslide, 50-50, or a nose/tail press with the press input.
- **Exit.** Pop or run off the end into AIR, preserving angular momentum so spins on and off rails work.

### 4.8 Landing evaluation

| Feature | Clean | Sketchy | Bail |
|---|---|---|---|
| Board normal vs terrain normal | under 15 degrees | 15 to 35 | over 35 |
| Yaw remainder to the nearest 180 (switch allowed) | under 20 | 20 to 45 | over 45 |
| Board axis vs velocity in the tangent plane | under 20 | 20 to 50 | over 50 (edge catch) |
| Normal impact speed (slope-relative, m/s) | under 6 | 6 to 10 | over 12 |
| Grab still held at contact | no | released under 150 ms before | held |

- Impact uses the slope-relative normal velocity (as the game already does): a steep landing is soft, flat is hard.
- Steep's G-meter: each landing subtracts f(impulse), regenerates with time and low speed; show it, since hidden bails felt like "RNG". (Not taken for this game; see the top of the doc.)
- Clean adds a landing bonus and cashes the combo; sketchy keeps the combo with a multiplier penalty and a stumble; bail wipes the combo and triggers the ragdoll.

### 4.9 Scoring and combos

- **Base points** = rotation (per 180) + flips (per 360) + grabs + air time + distance.
- **Trick score** = base x style (tweak, clean landing, grab held while rotating) x novelty (repeats in one combo pay 1.0, 0.75, 0.5, 0.25).
- **Combo.** Tricks chained within 2.5 s of plain riding stay pending; +1 multiplier per category switch (air, rail, butter), +0.5 per same-category trick; cash on a clean 1.5 s ride-away; wipe on bail.
- **Data-derived bonuses** (the advantage over handcrafted games): tree run (canopy clearance under 10 m), cliff drop (DEM drop over X m within 3 m), near miss (tree instance under 1 m at speed), powder line (depth mask), couloir (slope plus side-wall test).

### 4.10 Ragdoll bails

- A lightweight Verlet ragdoll (about 12 particles, distance constraints, heightfield and tree-trunk capsule collision), seeded from the rider's velocity and angular velocity at the bail frame; no physics-engine dependency. Rapier (WASM) only if rigid-body interactions are ever needed.
- Blend back to a get-up or respawn once slow; cap the slide time (Steep players complained ragdolls "slide down mountains way too long").

### 4.11 State machine summary

```
GROUNDED_CARVE <-> GROUNDED_SKID         (existing ICE switch)
GROUNDED_* -> LOADED (jump held)         needs: compression, windup
GROUNDED_* -> PRESS/BUTTER               needs: groomed/powder/ice masks
LOADED -> AIR (release or lip)           needs: curvature lookahead, normal
GROUNDED/AIR -> GRIND (snap)             needs: feature polylines, r_snap
GRIND -> AIR (pop/end) | BAIL (balance)
AIR -> AIR_GRAB -> AIR                   needs: inertia change
AIR -> LANDING_EVAL -> CLEAN|SKETCHY|BAIL needs: normal, slope, impulse
BAIL -> RAGDOLL -> RECOVER|RESPAWN       needs: heightfield + tree capsules
```

## 5. Graphics style target and browser feasibility

- **Steep** (observed; technique inferred): scale and atmosphere. Very long draw distance with aerial perspective, physically based sun and sky with strong time of day, wind-blown snow and cloud layers, rock materials from erosion rules, GoPro and cinematic cameras.
- **The Snowboard Game** is modest (Unity, DX11, GTX 550 minimum); its realism comes from motion, not rendering.
- **Implication.** 1 m lidar plus the 100 km horizon ring already gives Steep's main ingredient (scale). Spend on atmosphere and motion, not micro-detail.

| Technique | Feasible in r172 WebGL2 at 60 fps? | Plan or fallback |
|---|---|---|
| PBR snow, wrap lighting, SSS approximation | Yes | onBeforeCompile on MeshStandardMaterial: wrap diffuse, blue-tinted transmission, view-dependent glints |
| Sparkle | Yes | Hash-based screen-space glints keyed on world position and half-vector, fading with distance |
| Snow trails (deformation) | Yes, rider-local | Ping-pong R16F/RG16F target (512 squared over 64 m) scrolling with the rider; stamp the board each step; the near CDLOD LOD reads it in the vertex shader; far trails as decal ribbons |
| Persistent trails across the resort | Partially | Trail polylines in replay data drawn as ribbon decals, not a global heightfield |
| Spray and powder particles | Yes | GPU particles via ping-pong float textures (no compute shaders in WebGL2; transform feedback is an option); emission from edge angle x speed x depth mask |
| Height fog plus aerial perspective | Yes | Analytic height fog in the terrain and sky shader; later a precomputed scattering LUT (Bruneton) |
| True volumetric clouds or fog | Marginal | Quarter-res raymarch on desktop only; fallback layered billboard clouds and a horizon cubemap |
| Dynamic time of day | Yes | Sun direction drives sky, CSM and fog colour; update the far cascade every N frames |
| Weather (snowfall, flat light, wind) | Yes | Camera-local particle volume; flat light = fog plus reduced sun plus lower normal contrast |
| Motion blur, speed | Cheap version | Radial blur, speed lines, FOV ramp (70 to 85 degrees with speed), shake from terrain roughness; a velocity buffer is optional |
| Tessellated deformation (Batman) | No | No tessellation in WebGL2; use the CDLOD near-ring vertex density |
| Ray tracing, full GI | No | Baked sky-visibility AO from DEM horizon angles in the pipeline |

**Trails reference.** The Batman: Arkham Origins GDC 2014 talk renders snow-affecting actors "from below" into a heightmap, accumulates it, blends flat vs flattened snow with relief mapping, and updates only "2 surfaces/frame". The same budget idea applies to a scrolling rider-local target.

**Rider animation.** A skeletal glTF rider with a small clip set (stance, crouch, carve heel and toe, tuck, pop, about 8 grabs, stumble, get-up) layered with procedural control: board-locked feet via two-bone analytic IK (or CCDIKSolver), hip height from compression, spine twist from the wind-up, lean from the edge angle, arms from a grab IK target; AnimationMixer weights driven by physics state (the Riders Republic "physical layer" idea); ragdoll on bail only.

## 6. Engine architecture lessons

- **Fixed step plus interpolation.** Keep the 120 Hz accumulator loop with render interpolation (Gaffer on Games, "Fix Your Timestep"); sample input inside each step; bound catch-up to 4 to 6 steps.
- **Determinism for replays.** Physics in a module free of Math.random and Date; a seeded PRNG; avoid order-dependent float reductions. Cross-browser float determinism is not guaranteed, so do not rely on input-only replays across machines.
- **Replay and ghost format (hybrid).** A 120 Hz input log (axes quantized to int8) for local re-sim and debugging; 20 Hz state keyframes (position, smallest-three quaternion, speed, state enum, trick events) for ghosts and sharing. A 3-minute run is about 3,600 frames x 24 bytes, about 90 KB before compression (estimate). Steep's "path recorded automatically" and "share their trail as a challenge" map onto state keyframes plus a route polyline.
- **Streaming.** Prefetch tiles along the velocity (speed x 3 s); keep physics on the 1 m tiles independent of render LOD; load park-feature JSON per tile; stream ghost data with the tile it starts in.
- **Assist layer as data.** Landing assist, rail magnetism, pop window and spin auto-complete in one "difficulty profile", recorded with replays and leaderboards.
- **Testing.** Replays double as regression tests: feed recorded inputs through headless physics and assert trick events and landing classes; Playwright screenshot-diffs the visual layers. This is what prevents the trick-registration bugs reviewers hit in Shredders.

## 7. Long-term roadmap (after M0 to M6)

Effort tiers: S under a week, M 1 to 3 weeks, L 1 to 2 months, XL 2 months or more, for a solo part-time developer (estimate).

| Milestone | Features | Depends on | Effort | Content |
|---|---|---|---|---|
| M7 Replay and ghost core | 120 Hz input log, 20 Hz state keyframes, local ghost, headless replay harness, rewind to last ground | M2 | M | Data-derived |
| M8 Air and pop | Compression and ollie, lip detection from curvature, pre-wind, angular-momentum air, flips, input visualizer, Simplified preset | M2, M7 | L | Data-derived |
| M9 Rider animation v1 | glTF rider, two-bone leg IK, physics-driven blend tree, grab reach IK, Verlet ragdoll | M8 | L | One rig, about 15 clips |
| M10 Landing and scoring | Landing evaluator, trick recognizer and naming, combo ledger, trick list UI, data-derived bonuses | M8, M9, M3 | L | Data-derived |
| M11 Ground tricks and rails | Presses and butters, butter-to-pop, rail and box grind with balance, park feature JSON, in-game placement tool (sessions) | M10 | L | Hand-authored parks; curated OSM |
| M12 Visual polish | Rider-local trails, GPU spray, weather and flat light, time of day, scattering sky, speed FX, camera modes | M5, M9 | XL | Data-derived plus shaders |
| M13 Modes and social | Line challenges from replays, async ghost leaderboards (static JSON), photo mode, trick missions, park slopestyle runs | M7, M10, M11 | L | Mixed |
| M14 Creation tools | Park editor export and import, user features per resort, optional Rapier active-ragdoll experiment | M11 | XL | User-authored |

Sequencing: M7 before tricks (every later feature needs reproducible inputs to tune and test, and The Snowboard Game's history shows how often flips, rails and naming regressed); scoring after animation (players judge "clean" by what they see); keep ghosts and challenges file-based so they survive without a backend.

## Recommendations

1. Adopt The Snowboard Game's "Physical" control scheme as the gamepad default, with a Simplified preset; score assisted runs lower and record the assist profile in replays.
2. Build the replay and input log first and make it the regression harness.
3. Use data-derived trick bonuses (cliff drops from the DEM, tree runs from the canopy model, powder from the depth mask) as the signature feature; no competitor reviewed can do this on real terrain.
4. Limit hand-authored content to a few parks per resort plus an in-game placement tool.
5. Do not chase volumetrics or tessellation; height fog, a scattering LUT, a rider-local trail target and GPU spray give most of the Steep look in the browser (judgement).

## Caveats

- No developer devlog, GDC or SIGGRAPH talk was found for Steep's snow rendering, streaming or trick design; those details are inferred.
- The Snowboard Game's internals are undocumented; control mappings come from developer and player forum posts and may differ between branches. The 2018 patch-note text was read from page metadata.
- The Unity attribution for The Snowboard Game comes from SteamDB and ModDB, not a developer statement.
- Studio credit for Snowboarding The Fourth Phase conflicts between Session Games (MobyGames) and Roadhouse Interactive (a Red Bull video).
- SSX multiplier details (x1 to x20) come from a GameFAQs player post, not EA documentation.
- Byte sizes, effort tiers, thresholds and constants in sections 4 and 6 are design proposals, not measurements.

## Sources

- The Snowboard Game: [Steam store](https://store.steampowered.com/app/803830/The_Snowboard_Game/), [SteamDB](https://steamdb.info/app/803830/), [ModDB](https://www.moddb.com/games/the-snowboard-game), [Steam news (all)](https://steamcommunity.com/app/803830/allnews), patch notes [Dec 2021](https://store.steampowered.com/news/app/803830/view/4649359990221635953) and [Dec 2021 (2)](https://store.steampowered.com/news/app/803830/view/4649359990221635833), Steam discussions [1](https://steamcommunity.com/app/803830/discussions/0/1741100099549024181/), [2](https://steamcommunity.com/app/803830/discussions/0/3202620911886132121/), [3](https://steamcommunity.com/app/803830/discussions/0/1737715419893315567/), [4](https://steamcommunity.com/app/803830/discussions/0/1752399065083023021/), [5](https://steamcommunity.com/app/803830/discussions/0/4402812641369217597/), [6](https://steamcommunity.com/app/803830/discussions/0/1745594817442204806/), [7](https://steamcommunity.com/app/803830/discussions/0/1694920442961935528/), [8](https://steamcommunity.com/app/803830/discussions/0/1642044369653513290/), [9](https://steamcommunity.com/app/803830/discussions/0/3203652426708333683/), [Metacritic](https://www.metacritic.com/game/the-snowboard-game/), [Let It Roll Productions](https://letitrollproductions.com/), [Let It Roll AB on Instagram](https://www.instagram.com/letitrollab/), [FandomSpot best snowboarding games](https://www.fandomspot.com/best-snowboarding-games/), [GrassGames](https://www.grassgames.com/), [Snowboarding The Fourth Phase on MobyGames](https://www.mobygames.com/game/120282/snowboarding-the-fourth-phase/), [Red Bull video](https://www.youtube.com/watch?v=ASAgnEsPq-s).
- Steep and Riders Republic: [Steep (Wikipedia)](https://en.wikipedia.org/wiki/Steep_(video_game)), [GamesBeat: how Ubisoft built a mountain](https://gamesbeat.com/how-ubisoft-built-a-mountain-and-then-created-a-video-game-around-it/), Whitelines [science slams](https://whitelines.com/snowboard-culture/videos/ubisoft-steep-science-slams.html) and [terrain](https://whitelines.com/snowboard-culture/videos/ubisoft-steep-terrain-earns-name.html), [Steep keyboard controls (Fandom)](https://steep.fandom.com/wiki/Keyboard_Controls), Steep Steam discussions [1](https://steamcommunity.com/app/460920/discussions/0/2592234299579172921/), [2](https://steamcommunity.com/app/460920/discussions/0/154642901286917576/), [3](https://steamcommunity.com/app/460920/discussions/0/154643085270191846), [4](https://steamcommunity.com/app/460920/discussions/0/154644598509288769/), [5](https://steamcommunity.com/app/460920/discussions/0/1621724915812694023), [Riders Republic review (Gaming Age)](https://gaming-age.com/2021/11/riders-republic-review-for-ps5-xbox-series-x-pc/), [Xsens case study](https://www.xsens.com/resources/cases/ubisoft-hits-the-slopes-for-the-riders-republic-with-xsens-mvn-suits), [Red Bull Levels: Riders Republic](https://www.redbull.com/int-en/levels-riders-republic-episode).
- Other games: [Shredders (Wikipedia)](https://en.wikipedia.org/wiki/Shredders_(video_game)), Shredders reviews [Sonny Dickson](https://sonnydickson.com/2023/09/09/review-shredders-a-fantastic-arcade-snowboarding-adventure/), [Kotaku](https://kotaku.com/shredders-review-xbox-series-snowboarding-foam-punch-ea-1848674340), [Maxi-Geek](https://www.maxi-geek.com/con/shredders-review); [SSX](https://en.wikipedia.org/wiki/SSX), [SSX Tricky](https://en.wikipedia.org/wiki/SSX_Tricky), [SSX 2012](https://en.wikipedia.org/wiki/SSX_(2012_video_game)), [GameSpot SSX 3 combos](https://www.gamespot.com/articles/ssx3-big-air-big-scores-big-combos/1100-6074832/), [GameFAQs SSX multipliers](https://gamefaqs.gamespot.com/boards/615810-ssx/65565531); [Skate flick-it controls](https://deltiasgaming.com/skate-flick-it-controls-explained/), [Skate 3 Steam discussion](https://steamcommunity.com/app/244930/discussions/0/365163686076264869); [Mark McMorris Infinite Air (Wikipedia)](https://en.wikipedia.org/wiki/Mark_McMorris_Infinite_Air); [Grand Mountain Adventure (Android Police)](https://www.androidpolice.com/2020/01/22/grand-mountain-adventure-snowboarding-android/), [Grand Mountain Adventure 2 (Steam)](https://store.steampowered.com/app/3605330/Grand_Mountain_Adventure_2/).
- Engine and rendering: [GDC 2014 deformable snow in Batman: Arkham Origins](https://www.slideshare.net/colinbb/gdc2014-deformable-snow-rendering-in-batman-arkham-origins), [Gaffer on Games: Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/).
