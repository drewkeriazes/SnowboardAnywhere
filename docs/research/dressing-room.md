# Dressing room: outfits that look different and ride a little different (design, 2026-11-10)

Idea from Drew: a dressing room where you pick the rider's style. The steez matters. Outfits can nudge stats or skills. KISS version: same pattern as board types ([board-types.md](board-types.md)): a small catalog of pieces, each with a few stat numbers, folded into `mods` the rider already reads. Mostly cosmetic, small trade-offs, no new physics.

## 1. Rules that keep it simple and fair
- Default outfit = today's rider, zero mods. Nothing changes until a player dresses up.
- Every stat effect is small (each piece within +/-5 %, total clamped to +/-15 %) and every style has a trade-off. Looks first, stats second.
- No real brand names or logos on clothing. Invented labels only.
- One "Gear" screen for board + outfit together, not two menus.

## 2. Slots (5)
| Slot | Options (v1) |
|---|---|
| Head | helmet, beanie, hood up, bare (bandana) |
| Goggles | lens: clear, yellow (low light), dark mirror (bluebird), rose |
| Top | shell jacket, puffy, oversized hoodie, tall tee over jacket, race suit (top half), flannel |
| Bottom | shell pants, baggy cargo, slim pants, bibs, jeans |
| Hands | gloves, mitts, pogies-style big mitts |

Plus a colour picker per piece (two colours: main and accent). Colour is free style, no stats.

## 3. Stats (4) and what they change
| Stat | Comes mostly from | Changes in game |
|---|---|---|
| Aero | top + bottom fit | Multiplies `FEEL.aero` / `aeroTuck`. Baggy = more drag, race suit = less. +/-8 % drag is about -/+4 % terminal speed (v ~ 1/sqrt(drag)) |
| Style | fit, head, colour clash | Trick score multiplier once trick scoring lands (FEAT-186 to 192). Until then shown only on the replay/photo card |
| Grip | hands | Grab hold: gloves hold grabs a bit longer and steadier, big mitts a bit less |
| Warmth | top, bottom, hands, head | Only matters with Live weather (feature 3.1). Below -10 C with low warmth, edge roll slews slower ("stiff and cold"). v2 |

Goggle lens is the fun one and has no stat at all: it tints the screen. Yellow lens in a storm or flat light raises contrast a little (real thing riders do); dark mirror cuts glare on bluebird days; wrong lens for the light looks slightly worse. One post-process colour grade per lens.

## 4. Styles (preset kits)
Pick a kit in one click, then swap pieces.

| Kit | Pieces | Net effect |
|---|---|---|
| Classic (default) | helmet, shell jacket, shell pants, gloves | 0 on everything |
| Park rat | beanie, tall tee over hoodie, baggy cargo, gloves | Style +15 %, Aero -8 % |
| Racer | helmet, race suit, gloves | Aero +8 %, Style -15 % |
| Backcountry | helmet, shell, bibs, mitts, small pack | Warmth high, Grip -3 %, Aero -3 % |
| 80s retro | headband, neon one-piece | Style +10 %, Aero +3 %, Warmth low |
| Jeans day | beanie, flannel, jeans, gloves | Style +15 %, Warmth very low (and pants get dark and wet in powder: a material darken, pure looks) |
| Puffy cruiser | beanie, puffy, baggy pants, mitts | Warmth high, Aero -5 %, Grip -3 % |

## 5. Build steps (one card, after board types)
1. `game/src/sim/rider/Outfits.ts`: `Slot`, `Piece {id, slot, name, look, stats: {aero, style, grip, warmth}}`, `PIECES`, `KITS`, `outfitMods(pieces)` that sums and clamps.
2. Combine with board mods: `r.mods.aero`, `r.mods.style`, `r.mods.grip`, `r.mods.warmth` next to the board's `pop`, `catch`, `float`.
3. Multiply where used: aero in the drag term, grip in the grab code, style in trick scoring when it exists.
4. `Settings.ts`: `outfit: Record<Slot, {piece, main, accent}>`, saved in localStorage like other settings.
5. Gear screen: rider on a turntable in front of a lodge, slot tabs, colour swatches, the same stat-bar card as the board picker, "Kits" row on top.
6. Lens: one colour grade per lens in the existing post-process (or a CSS filter on the canvas if there is no post-process pass yet).
7. Checks: default outfit gives identical `carvecheck` / `fallcheck` results; racer vs park rat terminal speed differs by about 8 % on a straight run.

## 6. The real work: the rider model
Check first how `RiderView` builds the rider (procedural parts or a skinned GLB). That decides the art cost:
- Procedural parts: each slot maps to a part, swap geometry and material. Cheap.
- Skinned GLB: each piece is a separate skinned mesh on the same skeleton, hide the body under it. Baggy vs slim can share a mesh with a "fit" morph target.
- Cheapest v1 either way: colour swaps on today's mesh + head variants (helmet/beanie/hood) + one baggy and one slim fit. That alone covers every kit in section 4 except the one-piece.

## 7. Later (not v1)
- Unlocks from the logbook (ride every Back Bowl run: unlock the retro one-piece). v1 has everything unlocked: it's a sandbox.
- Ghosts and LAN multiplayer peers wear their own outfits (send the outfit once on join).
- Warmth tied to Live weather.
- Set bonus for a full kit.

## 8. What already exists (checked on main, 2026-11-10)
- `ui/Settings.ts`: `Outfit { jacket, pants, helmet, board, gloves }` colours, six `OUTFIT_PRESETS`, each with its own lens (`OUTFIT_LENS`, FEAT-130).
- `world/Lens.ts`: eight lenses plus Auto by weather and sun, a shader pass in first person, `tools/lenscheck.mjs`. Section 3's lens idea is mostly built.
- `world/RiderRig.ts`: skinned tube body (Mixamo bone names), one helmet, one board shape; `RiderView.setOutfit` sets colours. Ghosts take a preset by name (`AttractGhosts`).
So v1 is pieces and fit on the rig, then stats; colours and lenses are done.

## 9. Cards (EPIC-14, #466, filed 2026-11-10)
- FEAT-209 (#481) head and hand pieces
- FEAT-210 (#482) fit: baggy, slim, tall tee, one-piece
- FEAT-211 (#483) outfit stats and kits. Aero range backed by wind-tunnel work on alpine suits: drag up about 4 % per 2 cm of extra suit size ([Frontiers 2025](https://www.frontiersin.org/articles/10.3389/fspor.2025.1693699/full)).
- FEAT-212 (#484) Gear screen (board, outfit, stance, wax, lens)
- FEAT-213 (#485) snow sticks to the rider
- FEAT-214 (#486) cold and warmth v2, goggle fog
- FEAT-215 (#487) gear record in ghosts, replays, multiplayer
