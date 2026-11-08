# SnowboardAnywhere

A browser snowboarding game set on real mountains, rebuilt at 1:1 from public data: lidar terrain,
real trees, and the actual lifts, runs and buildings from OpenStreetMap. Ride Vail top to bottom,
take the chairs back up, race your own ghost, or outrun the snow monster.

Built with Three.js, TypeScript and Vite. Resorts so far: Vail and Breckenridge (pick one on the main menu).
Modes: free ride, time trials (turn on in Settings > Game) and Outrun (Esc > Outrun).

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
| Arrows or WASD | steer, tuck (up), brake (down); in the air, steer spins and up / down flip |
| Space (hold, release) | jump; hold W or S with it for a nollie or ollie |
| Shift | grab; sprint on foot |
| Left Ctrl (hold) | squat |
| X (hold) | skate on the flat |
| V / Z (hold) | nose / tail press |
| B | unstrap and walk, or strap back in |
| E | ride a lift (at the base, inside the lift line where there is one); skip to the top while riding |
| Alt (hold) | look around |
| C | change camera (chase, close, far, cinematic, first person, helmet cam, free) |
| F | free fly |
| M | map; click to drop in anywhere |
| P | piste lines on or off |
| T | go to the nearest time trial (when on in Settings) |
| K | replay viewer |
| Backspace (hold) | rewind, let go to carry on from there |
| Q / G (hold) | Outrun: boost / look back |
| N | next song |
| R | restart |
| Esc | pause and settings |

Keys can be remapped in Settings > Controls. The replay viewer lists its own keys on screen.

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
