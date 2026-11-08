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
| Arrows or WASD | steer, tuck (up), brake (down) |
| Space (hold, release) | jump |
| Shift | grab |
| E | ride a lift (at the bottom terminal); skip to the top while riding |
| Alt (hold) | look around |
| C | change camera (chase, close, far, first person, free) |
| M | map; click to drop in anywhere |
| T | go to the nearest time trial (when on in Settings) |
| N | next song |
| R | restart |
| Esc | pause and settings |

Keys can be remapped in Settings > Controls.

While you ride, the HUD shows the run you're on, top speed, vertical and distance. After a real
descent (60 m or more of vertical, ended by boarding a lift, stopping for 4 s or restarting) a run
card shows time, top speed, distance, vertical, longest air, biggest drop, max g, the named runs
ridden, your line on a little map and today's totals. Personal bests are kept per named run. Click
the card to dismiss it; it hides itself after 10 s.

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
