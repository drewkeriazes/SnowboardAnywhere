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

### Play on another computer

Host the game on the PC that has the packs and play it from any computer on the same home network:

```
cd game
npm run host
```

It builds the game, serves it on port 5173 and prints the address to open on the other computer,
e.g. `http://192.168.1.42:5173/?pack=vail`. The packs stream from the PC, and the main menu shows
"Hosted from <PC name>" with the address so it is easy to read off. Ctrl+C stops it.

- **Controllers:** some browsers (Firefox, and Chrome as it phases in the rule) only let a page see a
  gamepad over https. If a controller on the other computer is not seen, run `npm run host -- --https`
  instead and open the `https://` address. The certificate is self-signed, so the browser warns once:
  click Advanced > Proceed. It is renewed every 30 days, and then it warns once more.
- **Windows Firewall:** the first time, allow Node.js on **Private networks**. If you missed the prompt:
  Windows Security > Firewall & network protection > Allow an app through firewall > Node.js, Private.
- The PC's wifi or ethernet must be set to a **Private** network, not Public.
- Guest networks often block devices from seeing each other: use the main network.
- The game renders on the other computer's GPU, so a weak laptop runs slower than the PC.
- The address can change after a router reboot: check what `npm run host` prints.
- Settings, best times and saved spots are kept per browser, so the other computer starts with defaults.
- `npm run host -- --port 8080` picks another port.

## Controls

| Key | Action |
| --- | --- |
| A / D (or arrows) | steer |
| W / S (or arrows) | tuck / brake (front flip / backflip in the air); walk on foot |
| Space (hold, release) | jump (hold W / S while charging for a nollie / ollie); climb on foot |
| Shift | squat on the snow, grab in the air, sprint on foot |
| Q / Z | nose / tail press (hold); W / S balance it |
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

Holding a nose or tail press is a balancing act. A small meter shows above the rider with a needle
that drifts toward the nose or the tail, faster the longer you hold, the faster you go and the
bumpier the snow. Keep it in the green with W / S (or the left stick up / down, which is analog).
Off the loaded end (the cross) the board catches and you fall over that end, or stall when slow; off
the other end (the bar) the board drops flat. There is no time limit: a long press only needs quicker,
finer corrections. Let go any time to end it cleanly. Hold the press key through a trick to land
straight into the press ("Backside 360 to nose press"). A toast gives the press time and distance,
with your best for the resort. Settings > Game > Press balance: Easy, Normal, Hard or Off.

You can ride switch (the other foot forward, the tail leading). Land a 180, or slide back down the
hill tail first, and you carry on switch until you turn round again with another 180 or by stopping
and sliding off the other way. The HUD shows SWITCH while you do, and spins are named on landing
("Backside 180", "Switch frontside 360"). Pick your normal stance in Settings > Rider > Stance:
Regular (left foot forward) or Goofy (right foot forward).

The snow changes how the board rides (FEAT-053). Groomers are fast and grippy. Off the groomers,
north-facing bowls, high ground, the trees and anything under a storm hold powder: the board slows
and floats, turns come round wider, and the nose sinks and digs in when you are slow. Open off-piste
gets tracked out into chop as the day goes on and rattles the board. High exposed ridges are
wind-scoured ice, and spring mornings leave the groomers icy: the edge holds less and skids sooner.
Low sunny faces turn to slush in the afternoon, heavy and slow. Settings > Graphics (Snow conditions:
Fresh corduroy, Mid-season or Spring; New snow; Weather) and Settings > Game (Time of day) all change it. The HUD names
the snow under you (Groomed, Powder, Chop, Ice, Slush, Rock); on foot it also shows how deep the
boots sink.

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
