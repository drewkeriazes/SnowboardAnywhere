# SnowboardAnywhere

A browser snowboarding game set on real mountains, rebuilt at 1:1 from public data: lidar terrain,
real trees, and the actual lifts, runs and buildings from OpenStreetMap. Ride Vail top to bottom,
take the chairs back up, race your own ghost.

Built with Three.js, TypeScript and Vite. Resorts so far: Vail and Breckenridge (pick one on the main menu).

## Play

```
cd game
npm install
npm run dev
```

Open http://localhost:5173/?pack=vail. Use `?pack=synth` for a synthetic test mountain if you have
no resort pack built yet (packs are generated locally, see below).

## Controls

| Key | Action |
| --- | --- |
| A / D (or arrows) | steer |
| W / S (or arrows) | tuck / brake (front flip / backflip in the air); walk on foot |
| Space (hold, release) | jump (hold W / S while charging for a nollie / ollie); climb on foot |
| Shift | squat on the snow, grab in the air, sprint on foot |
| Q / Z | nose / tail press (hold) |
| X | skate on the flat (hold) |
| E | ride a lift (at the bottom terminal); skip to the top while riding; strap in or out when stopped away from lifts |
| G (hold) | look behind, in every camera |
| Alt (hold) or right mouse button | look around |
| C | change camera (chase, close, far, first person, free) |
| M | map; click to drop in anywhere |
| P | piste lines |
| T | go to the nearest time trial (when on in Settings) |
| N | next song |
| R (hold) | restart |
| K / Backspace | replay viewer / rewind (hold) |
| F | boost (Outrun) |
| ` | free fly |
| Esc | pause and settings |

Every action has two slots in Settings > Controls (click a slot, press a key or the right mouse button; Delete clears it).
A gamepad with the standard mapping works too: left stick steers, up / down or the triggers tuck and brake,
A jumps, X squats and grabs, B skates, bumpers press, right stick looks around, R3 looks behind, Y interacts,
the d-pad cycles camera / map / piste lines / track, Select opens the replay and Start pauses.


## How a resort gets built

A Python pipeline downloads public data for a resort (USGS 1 m lidar, NAIP imagery, LANDFIRE
vegetation, OpenStreetMap) and turns it into a "pack" of height tiles, masks, trees and features.
The game streams that pack. Fetching runs on Windows with PowerShell; building runs anywhere:

```
python pipeline/build_pack.py vail <raw_dir> packs/vail
```

## More

- [docs/developer-guide.md](docs/developer-guide.md): full feature list, code layout, tools, pipeline scripts, URL parameters, milestones
- [docs/HANDOFF.md](docs/HANDOFF.md): current state and next steps
- [Project board](https://github.com/users/drewkeriazes/projects/2): open work, one issue per card ([how it works](docs/BOARD.md))
- [docs/README.md](docs/README.md): index of plans, research and data notes
- [game/public/music/README.md](game/public/music/README.md): playlists and music credits
