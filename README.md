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
| A / D (or arrows) | steer |
| W / S (or arrows) | tuck / brake (front flip / backflip in the air); walk on foot |
| Space (hold, release) | jump (hold W / S while charging for a nollie / ollie); climb on foot |
| Shift | squat on the snow, grab in the air, sprint on foot |
| Q / Z | nose / tail press (hold) |
| X | skate on the flat (hold) |
| E | ride a lift (at the base, inside the lift line where there is one); skip to the top while riding; strap in or out when stopped away from lifts |
| G (hold) | look behind, in every camera |
| Alt (hold) or right mouse button | look around |
| C | change camera (chase, close, far, cinematic, first person, helmet cam, free) |
| M | map; click to drop in anywhere |
| P | piste lines |
| T | go to the nearest time trial (when on in Settings) |
| N | next song |
| R (hold) | restart |
| K / Backspace (hold) | replay viewer / rewind, let go to carry on from there |
| F | boost (Outrun) |
| ` | free fly |
| Esc | pause and settings |

Every action has two slots in Settings > Controls (click a slot, press a key or the right mouse button; Delete clears it).
A gamepad with the standard mapping works too: left stick steers, up / down or the triggers tuck and brake,
A jumps, X squats and grabs, B skates, bumpers press, right stick looks around, R3 looks behind, Y interacts,
the d-pad cycles camera / map / piste lines / track, Select opens the replay and Start pauses.
The replay viewer lists its own keys on screen.

You can ride switch (the other foot forward, the tail leading). Land a 180, or slide back down the
hill tail first, and you carry on switch until you turn round again with another 180 or by stopping
and sliding off the other way. The HUD shows SWITCH while you do, and spins are named on landing
("Backside 180", "Switch frontside 360"). Pick your normal stance in Settings > Rider > Stance:
Regular (left foot forward) or Goofy (right foot forward).

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
