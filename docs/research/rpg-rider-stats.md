# Research: RPG-style rider stats (FEAT-194)

Researched 2026-11-10 for FEAT-194 (#462). Bottom of the backlog; Drew is not sure about this one. Planning only.

The idea: like any RPG, the rider has stats (holding an edge, balance, air, and so on) and doing things advances them.

## 1. How other games do it

| Game | System | What we take from it |
|---|---|---|
| Tony Hawk's Pro Skater 1+2 | 10 stats (air, hangtime, ollie, speed, spin, switch, flip speed, rail/lip/manual balance). You collect stat-point tokens in levels and spend them in the pause menu. Stats change the physics. | The stat list maps almost 1:1 onto snowboarding. But tokens need levels and goals we do not have yet (FEAT-056). |
| Elder Scrolls (Morrowind, Oblivion, Skyrim) | "Learn by doing": swinging a sword raises the sword skill, jumping raises acrobatics. | Feels natural, but players gamed it: jumping everywhere to level acrobatics, hitting an enemy that never fights back. Counting actions invites grinding. |
| Riders Republic, Steep | Career XP and gear unlocks; no per-skill physics stats. | Even the big modern open-mountain games keep the physics the same for everyone. |

## 2. The tension with this project

SnowboardAnywhere is a real-life simulation first. If stats change the physics, a level 1 rider on Riva Ridge is slower and grips less than the real mountain says. That undercuts the point of 1 m lidar and the carving model in `rider-physics.md`.

So the simple answer: **stats describe how well you ride; they do not change how the board rides.** If we ever want RPG physics, it lives in Arcade feel only.

## 3. Four ways to build it

| # | Approach | Effort | Pros | Cons |
|---|---|---|---|---|
| A | **Skill report card**: score each stat from the quality of your riding | S | No physics change, cannot be grinded by spamming, shows real improvement | Not a "level up" power fantasy |
| B | **Learn by doing XP**: actions add XP per stat, levels nudge physics (Arcade only) | M | Classic RPG feel | Grinding (the Skyrim jump spam), balancing, conflicts with Realistic |
| C | **Stat points from goals** (THPS): finish challenges, spend points | M | Gives challenges a reward | Needs FEAT-056 challenges first |
| D | **Your real stats**: seed from ShredFinder GoPro runs (real top speed, real airtime) | M | Unique to this project | Needs the ShredFinder ghost work first |

**Recommendation:** A as v1. B as an optional v2 in Arcade feel. C and D only if A turns out fun.

## 4. v1 design: the skill report card

Eight stats, 0 to 100. Each is a rolling score over your last ~20 qualifying attempts (so it goes up as you get better and can drift down if you get sloppy). Quality, not count.

| Stat | What earns it | Measured from |
|---|---|---|
| **Edge** | Carved turns instead of skidded ones; higher edge angle held through the turn | `sim/rider/EdgeModel.ts`: per turn, share of time in carve vs skid, peak edge angle |
| **Speed** | Fast, controlled runs without falling | `sim/RunStats.ts`: average speed per run, zero falls |
| **Air** | Airtime with a clean landing | `sim/rider/Jumps.ts`: `airTime` on landings that did not bail; jumps under ~0.4 s do not count |
| **Spin** | Rotation landed clean | `sim/rider/Tricks.ts` / `Jumps.ts`: degrees spun on clean landings |
| **Balance** | Presses held, landings stuck | `sim/rider/Press.ts`: press time ended `'clean'`; landing angle |
| **Powder** | Speed held in deep snow | `sim/SnowConditions.ts` powder share times speed held |
| **Bumps** | Mogul runs without falls | `terrain/Moguls.ts` mask under the rider, distance per fall |
| **Switch** | Riding switch, carving switch | switch time and switch carves (EdgeModel) |

Anti-grind rules (keep it simple):
- Only attempts above a minimum count (a turn > 2 s, a jump > 0.4 s airtime, a run > 300 m).
- Score is an average of quality, so repeating an easy thing holds the stat at an easy number.

UI
- Day summary (FEAT-055) gets a "Rider" block with the eight bars and what moved today.
- A toast when a stat goes up a whole point step ("Edge 42 -> 45").
- Saved under `riderStats` in local storage with try/catch, like `ui/Settings.ts`.

Build steps
1. New `sim/RiderStats.ts` (~120 lines): listens on the event bus (`core/Events.ts`) for turn end, landing, press end, run end; keeps a ring buffer per stat; exposes `get()`.
2. Emit the missing events where the data already lives (turn end from EdgeModel, landing quality from Jumps, press end from Press).
3. A "Rider" panel in the day summary and pause menu.
4. README line.

## 5. v2 option: stats scale the physics (Arcade feel only)

If v1 is fun and Drew wants the RPG payoff, map each stat to a multiplier from 0.85 (stat 0) to 1.15 (stat 100), applied only when Feel is Arcade (`ui/SettingsRows.ts` `FeelPreset`).

| Stat | Tunable it scales | Where |
|---|---|---|
| Edge | `gripEdge`, `psiMax`, `roll` | `sim/rider/tuning.ts` discipline table |
| Air | jump pop (`2.5 + 4.5 * charge`) | `sim/rider/Jumps.ts` `jump()` |
| Spin | air spin rate (`3.5` rad/s) | `sim/rider/Jumps.ts` `airStep()` |
| Balance | landing bail angle, press balance window | Jumps / Press |
| Speed | tuck drag | `tuning.ts` |
| Powder | `POWDER_DRAG`, `SINK_DRAG` | `tuning.ts` |

Keep it at +/-15 %: enough to feel, not enough to break the carve model. Realistic feel always uses 1.0.

## 6. Open questions for Drew
- Is a report card (A) enough, or is the point the physics getting better (B)?
- One rider profile, or one per family member (the LAN multiplayer idea makes names useful)?

## Sources
- [How to increase your stats in Tony Hawk's Pro Skater 1 + 2 (Gamer Journalist)](https://gamerjournalist.com/how-to-increase-your-stats-in-tony-hawks-pro-skater-1-2)
- [Killer Feature: The Elder Scrolls' learning by doing (Film Stories)](https://filmstories.co.uk/?p=45821)
- [Riders Republic review (eXputer)](https://exputer.com/reviews/riders-republic-review-a-thrill-ride/)
- Code: `game/src/sim/rider/tuning.ts`, `Jumps.ts`, `EdgeModel.ts`, `Press.ts`, `sim/RunStats.ts`, `ui/SettingsRows.ts` at 30a335a
