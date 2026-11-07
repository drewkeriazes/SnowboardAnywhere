# Research: Outrun mode (a SkiFree-style monster chase)

Researched 2026-11-06 for FEAT-096 (#163). Planning only; the build cards are FEAT-097 to FEAT-101 (section 8).

A not-so-serious arcade mode: switch it on, get a head start, then a snow monster comes over the ridge and chases you down the real mountain. If it catches you, it eats you. You can hear it getting closer before you see it, and the music bends as it closes in. The card (#163) has the full design pitch; this doc checks that pitch against the code as of 3e0494c and turns it into cards.

## 1. What SkiFree did (reference, from the sources at the bottom)

- The yeti appears once you pass the 2,000 m mark and is far faster than the skier.
- The only reliable escape is the F speed boost; hitting an obstacle while running still gets you caught.
- A second one spawns if you stay ahead of the first. It eats you and the run ends. There is no ending: outrunning it is the win, and it is famous because it is unfair and funny.

Takeaway: the threat must be overwhelming but readable. You know it is coming, you have one or two tools to stay ahead, and being caught is a payoff, not a frustration.

## 2. Corrections to the card after reading the code

| Card said | Code says | Decision |
|---|---|---|
| Boost on `B` ("F is free fly") | `B` is already bound: `board` (strap in / out, and skip to the top on a lift), see `game/src/sim/Controls.ts:12`. `F` is fly, `T` trial, `M` map, `C` camera, `R` restart, `P` piste, `N` track, `E` lift, `Alt` look. | Boost goes on `Q` by default, as a new rebindable action `boost` in `DEFAULT_KEYS` (`game/src/ui/Settings.ts:62`) so the Settings key panel picks it up for free. |
| "Lift fast-forward (W) is allowed" | `W` is an alias for tuck on the snow (`Controls.ts:67`) and the 5x hold on a lift (`main.ts:520`); `E` on a lift skips to the top (`LiftRide.ts:62`). | Keep `W` (5x) legal; block the `E` skip while Outrun runs. |
| "Jukebox: a new `chase` style" | `JukeStyle` is `'ska' | 'house' | 'metal' | 'hiphop'` (`game/src/audio/Jukebox.ts:12`); styles are picked per playlist, with their own BPM, scale, progression and per-beat generator. | `chase` is a fifth style, but it is not a playlist: Outrun drives it directly as a drum-only layer on top of (or instead of) whatever is playing. Needs a small `Jukebox` entry point that plays a style without a track name. |
| "Record the rider's position every 0.25 s" | The time trial already records a 10 Hz ghost track: `GhostSample { t, x, y, z, h, lg, e, f }` (`game/src/sim/TimeTrial.ts:12`). | Reuse the sample shape at 4 Hz for the breadcrumb ring buffer (about 2 min of trail at 480 samples). Do not share the recorder itself; the trial one starts and stops with the course. |
| "Raycast on the heightfield for line of sight" | There is no raycast helper. Height comes from `pack.height(x, y, res)` (`game/src/terrain/Terrain.ts:207`) and the fine set's `sample(x, y)` (`game/src/pack/HeightSet.ts:120`). | Line of sight is a 2 m march along the monster-to-rider segment, comparing the interpolated line height to `pack.height` plus 1 m. At 60 m that is 30 samples a frame, nothing. |
| "Parent split clones to a monster hand bone" | `RiderView` wraps one `RiderRig` built from `BONES` (`game/src/world/RiderRig.ts:15`), Mixamo names without the `mixamorig` prefix. `TrialWorld` already makes a second translucent `RiderView` for the ghost (`game/src/world/TrialWorld.ts:39`), so a second rider copy is proven. | Two extra `RiderView` instances with the outfit copied, posed per frame from the live rider's pose at the catch, then bone scaling as the card describes. |
| "Big footprint holes from the bootprint system" | `Bootprints` is one `InstancedMesh` with a fixed sole shape (0.32 x 0.13 m) and a 4,000 ring buffer (`game/src/world/Bootprints.ts`). Depth is per instance, size is not. | Phase 5. Add a per-instance scale or a second `Bootprints` instance built with bigger sole constants; the second instance is the smaller change. |
| "Map teleport off" | The full map's click is `map.onPick` (`game/src/ui/ResortMap.ts:29`, wired at `main.ts:257`). | Set `onPick = null` while Outrun runs, restore on exit. |
| Pause | `Escape` toggles `paused` and the frame returns before physics (`main.ts:400`). | The chase updates in the same place as the physics step, so pause freezes it for free. |

Everything else in the card holds: `musicGain` is one `GainNode` that every music source feeds (`game/src/audio/Audio.ts:86`), so a `BiquadFilterNode` can sit between it and `master`; the one-shots are synthesised with `burst()` (`Audio.ts:226`) and `tone()`, so gallop, roar and breathing need no sample files; `setDuck()` (`Audio.ts:213`) is the existing ducking hook; `Gait.ts` gives a phase clock and stride logic to borrow for the gallop; storm weather sets `env.setStorm` fog (`main.ts:200`); `Collider` hashes tree trunks and rocks (`game/src/sim/Collider.ts:37`) if the monster ever needs to know what it is bounding through.

## 3. Mode flow

1. **On:** a Pause menu button "Outrun" (and a Main menu entry later). Off by default; not a Settings checkbox, because it is a run, not a preference. While on: time trials cancelled (`trial.cancel`), map teleport off, lift `E` skip off.
2. **Start:** from where you are. 3-2-1, then the head start: 10 s (Chill), 7 s (Normal), 5 s (SkiFree). HUD: "It wakes in 5...".
3. **Spawn:** roar from uphill. The monster appears on the breadcrumb trail 150 to 250 m back along the path (so it always spawns where the rider was, never inside a cliff). If the trail is shorter than that (you started from a standstill), spawn at the trail's oldest point plus 150 m straight uphill along the local gradient, snapped to `pack.height`.
4. **Chase:** survive. Score = seconds survived + metres descended / 10 + 50 per close call (it got within 10 m and then fell back past 25 m).
5. **Escape conditions** (one per run, chosen with the difficulty):
   - *Endless:* no exit; a second monster spawns at 3 min.
   - *Reach the base:* any building cluster at the bottom of the pack (`features.json` buildings, the cluster with the lowest median height). It gives up at the cluster edge and roars from the treeline.
6. **Caught:** the eat sequence (section 6), then an "EATEN" card: time, distance, close calls, best, Retry / Exit.

## 4. How the monster moves

- **Breadcrumbs.** A 4 Hz ring buffer of rider samples (section 2). The monster walks the trail by arc length, so it goes only where the rider went: no pathfinding, no terrain or tree stuck cases, works on every pack. Height is re-sampled from `pack.height` each frame so it stays on the snow when the trail was recorded in the air.
- **Shortcut.** With line of sight (section 2) inside 60 m it leaves the trail and heads straight at the rider. That is when it visibly lunges.
- **Rubber band speed**, each frame:
  `speed = clamp(riderAvg5s * k + ramp(t), min, max)`
  `k` starts at 0.95 and grows 0.01 per 10 s; over 300 m add a catch-up bonus of up to +4 m/s; under 25 m subtract 2 m/s so a boost or a good line can shake it. Per difficulty: Chill `k0` 0.85, max 18 m/s; Normal 0.95, max 24; SkiFree 1.1, ramp doubled, max 30 (the only escape is the boost).
- **Mistakes feed it.** `rider.crashed > 0`, `onFoot`, speed under 2 m/s, or heading uphill all keep the rider average low, and the monster speed never drops below `min` (6 m/s), so a stop hands it the gap. No special code.
- **Cheese protection.** If the distance has not changed by more than 5 m in 8 s, it takes the direct line regardless of line of sight (frustration timer).
- **Lifts.** MVP: when the rider boards a lift, the monster runs to the bottom terminal and then teleports to the top terminal at the moment the rider unloads, minus the head start for that difficulty. Tower hopping is Phase 5.
- **Trees.** It ignores collisions (it follows the trail, which already avoids trunks). Phase 5 adds a sway and snow puff on near trees from the `Vegetation` cell data plus a crack sound.

## 5. Knowing it is coming

**Spatial sound.** A `PannerNode` (`panningModel: 'HRTF'`, `distanceModel: 'inverse'`, `refDistance` 20, `rolloffFactor` 1.5) with the listener set from the chase camera each frame; the whole monster bus goes through it:
- gallop thuds: `burst('lowpass', 90, 0.12, g)` at the gait rate, with the filter frequency rising from 90 Hz at 400 m to 400 Hz at 30 m;
- roars at spawn, on regaining line of sight, and on a close call (angry); a sawtooth sweep through a bandpass, like the existing one-shots;
- breathing and growl under 40 m, panting snorts under 15 m (filtered noise bursts at 1.5 Hz);
- heartbeat (not spatial, on the master bus) whose rate goes from 60 bpm at 300 m to 150 at 20 m; this layer alone makes the mode playable with music off.

**Music stages** by distance, through a new `BiquadFilterNode` between `musicGain` and `master` plus `setDuck`:

| Distance | Music |
|---|---|
| > 300 m | unchanged |
| 150 to 300 | duck 3 dB, heartbeat in, a low drone starts |
| 60 to 150 | low-pass sweeps to 800 Hz, `chase` drums start |
| < 60 | music gain to 0: drums, gallop, breathing only |
| escape > 150 | swell back over 2 s |
| caught | playbackRate ramp to 0 over 0.4 s (file source) or `jukebox.stop()`, then a silly sting |

**Visuals.** HUD distance line ("120 m", bar goes red under 60), a monster dot on the minimap and full map (`ResortMap` already draws per-frame markers for the pulsing lift bottom, `ResortMap.ts:293`, so a second marker is the same pattern), frost vignette on the goggle layer, camera shake per footfall under 30 m. Look back: `Alt` free look already exists; add a `glance` action that snaps the chase camera 180 degrees while held.

## 6. The eat sequence (cartoon, no blood)

1. Grab: time scale 0.3 for 0.5 s, camera cut to high in front of the monster (about 5 m out and 6 m up, pushing in slowly), looking down over the rider into its face (FEAT-104; the first build used a side angle).
2. Lift: the rider held up by the torso, legs and board dangling.
3. Rip: a "pop", snow and confetti puff. Top half right hand, legs and board left hand.
4. Jaw: scale the jaw bone tall, snake-style.
5. Two bites, gulp each. Optional: spit the board out, it lands upright.
6. Burp, snow cloud, belly pat, fade to the EATEN card.
7. A **Gentle** setting swallows the rider whole in one bite.

The split with the current rig: at the catch, create two `RiderView`s with the live outfit and pose. Clone A scales `LeftUpLeg` and `RightUpLeg` to 0 and hides the board; clone B scales `Spine` to 0. Parent each to a monster hand. A puff at the seam hides the join. No mesh cutting, no new shader.

## 7. The monster model

- **Option A, fastest:** a CC0 animated monster pack. Quaternius' Ultimate Monsters is tagged yeti on Sketchfab, but the page text says CC0 while the licence field says CC BY; the itch.io page is the authoritative licence. Check before use, and add the line to `docs/research/licensing-and-attribution.md` and the `meta.json` attribution block. The eat keyframes are still ours, animated procedurally on top.
- **Option B, ours:** a `RiderRig`-style procedural rig with the same bone set plus `Jaw`, about 3.5 m tall, chunky limbs, white shaggy fur (a few layered alpha cards), blue face, big teeth; gallop from `Gait.ts` with four feet. Two to three sessions, but it matches the game and has no licence question.
- A yeti is folklore; do not copy the SkiFree sprite or name. Working name: "the Abominable".

Recommendation: MVP with a capsule, then B. The eat sequence needs hand and jaw bones we control; retrofitting those onto a glTF rig costs most of what B costs anyway.


Built as option B (FEAT-099), then redesigned in FEAT-104 at Drew's ask: a grey, gangly, upright yeti that runs on two legs with both arms thrown up and flailing, a pot belly, a small head with a heavy brow and close-set eyes, a shaggy crest and a gaping dark maw. The aim is the nostalgic beat of the classic charging yeti; the model is ours, not a copy of the SkiFree sprite.
## 8. Build cards

| Card | What | Effort |
|---|---|---|
| FEAT-097 (#165) | Outrun MVP: Pause menu toggle, difficulties, head start, breadcrumbs, capsule monster with the rubber band and shortcut, catch ends the run, HUD distance, synth gallop and roar, EATEN card | 1 to 2 sessions |
| FEAT-098 (#166) | Outrun sound and music: HRTF panner, breathing, heartbeat, music filter stages, `chase` jukebox drums, caught sting | 1 session |
| FEAT-099 (#167) | Outrun monster: procedural rig with jaw, fur, gallop; or the CC0 glTF if its licence checks out | 2 to 3 sessions |
| FEAT-100 (#168) | Outrun eat sequence: slow-mo, camera cut, split clones, jaw, two bites, spit board, burp, Gentle setting | 2 sessions |
| FEAT-101 (#169) | Outrun polish: adrenaline boost on `Q`, glance-back, tree snapping, tower hopping, second monster, big footprints, best times | 2 sessions |

Order: 097, 098, 100, 099, 101. Sound before the model, because the design goal is to play by ear; the eat sequence can be built against the capsule and re-targeted when the rig lands.

## 9. Risks

- **Fairness:** rubber banding feels cheap unless everything is telegraphed. The distance meter, the sound and the close-call payoff are not optional.
- **Tone:** slapstick, not horror. Snow puffs, confetti, a burp, cartoon sounds. Gentle is the backstop.
- **Performance:** one extra skinned mesh and a dozen audio nodes, nothing next to the trees. Check with the perf-check skill after 099 anyway.
- **Base detection:** "lowest building cluster" is a guess until tried on Vail (Lionshead and Vail Village are both at the bottom) and Breck.

## 10. Done when

- You can switch Outrun on, get a head start, and the monster spawns behind you and chases you down any run on any pack.
- With the screen hidden, you can tell how close it is by sound and music alone.
- Getting caught plays the grab, rip, two-bite eat sequence, then the stats card.
- On Normal a good rider can reach the base. On SkiFree it only works with the boost.

Sources: PC Gamer, "Remembering SkiFree" (pcgamer.com/remembering-skifree-and-the-yeti-that-still-haunts-our-dreams); Giant Bomb, SkiFree (giantbomb.com/wiki/Games/SkiFree); Quaternius Ultimate Monsters on Sketchfab (sketchfab.com/3d-models/ultimate-monsters-pack-fd72e114d119488da71fe3a16f216c4f) and itch.io (quaternius.itch.io/lowpoly-animated-monsters). Code references are to commit 3e0494c.
