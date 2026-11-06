# Back Bowls, top of Campbell's (Sun Down Bowl)

Real: Street View, Jan 2019 (link in spot.json; not stored here). Game: `game-east-standing.png` (at the spot), `game-east-riding.png` (a few metres east, slightly lower).

## Findings
- **Moguls (Drew):** the real bowl is covered in mogul fields: the bowl floor and the steep slopes on the right (Milt's Face / The Slot side) show a dense, regular bump texture. The game bowl is smooth. Reference for FEAT-059 (#92). Ungroomed, steep, high-traffic Back Bowls runs are exactly where the card's score should put bumps.
- **Tree density matches here.** The real slopes have sparse lone conifers and small groups scattered across the steep faces, and the game is similar. So BUG-023 (too few trees) is a glade and treeline problem (Blue Sky, China Bowl), not a global one.
- **Trees still read black and cone-shaped** against the bright snow; the real ones are dark green with snow and narrow ragged tops. -> FEAT-070
- **The bowl shape looks shallower in the game** at this framing. Re-shoot at eye height (1.7 m) with the matching pitch and FOV once DATA-008's `cam=eye` exists before judging terrain.
- **Snow:** real foreground is tracked-out and chalky with sharp small shadows; ours is smooth. -> FEAT-047 / FEAT-069
- **Far ridges (right):** real distant forest is dark green with white clearings; ours is close but greyer. -> FEAT-041 / FEAT-052
