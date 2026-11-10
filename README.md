# SnowboardAnywhere

A browser snowboarding game set on real mountains, rebuilt at 1:1 from public data: lidar terrain,
real trees, and the actual lifts, runs and buildings from OpenStreetMap. Ride Vail top to bottom,
take the chairs back up, race your own ghost, or outrun the snow monster.

Built with Three.js, TypeScript and Vite. Resorts so far: Vail and Breckenridge (pick one on the main menu).
Modes: free ride, time trials (turn on in Settings > Gameplay) and Outrun (Esc > Outrun).

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
| Shift | squat on the snow (hold while steering: hard carve), grab in the air, sprint on foot |
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
The replay viewer lists its own keys on screen.

Menus work with the keyboard, a gamepad, the mouse or touch: arrows or the D-pad move, Enter / Space or Cross / A select, Esc or Circle / B go back
(Esc or Circle / B resumes from pause), B on the keyboard or Square / X on the pad switches Snowboard / Skis on the main menu.
The hint bar at the bottom of each menu shows the keys or buttons for whichever you used last.
The main menu's Controls button opens your current bindings.

Settings opens full screen: categories on the left (Gameplay, Controls, Camera, Graphics, Conditions, Map and world, Audio,
Rider, Accessibility, Credits), the settings in the middle, and what the focused one does on the right.

| Settings key (pad) | Action |
| --- | --- |
| Q / E (L1 / R1) | previous / next category |
| left / right | change the focused setting |
| Enter / Space (Cross / A) | toggle it, or step to the next choice |
| R (Square / X), twice | reset the category (Reset all is under the categories) |
| V (Triangle / Y), hold | peek at the game (from the pause menu) |
| Esc (Circle / B) | clear the search, then close |

Type in the search box to find a setting in any category. Graphics has presets (Low, Medium, High, and Ultra:
High plus cascaded shadows at full resolution) over its advanced options, Gameplay has Feel presets (Arcade,
Realistic). Accessibility has UI scale and Reduce motion (camera shake, first person shake and speed
lines off together). Opened from the pause menu, changes show at once behind the screen, with the frame rate in the corner.

### Controllers

A PS5 DualSense, an Xbox pad or any controller the browser maps the standard way plays the whole game,
menus included. The hints, prompts and settings show the buttons of the controller in use (PlayStation
shapes on a DualSense or DualShock); press a key and they switch back to the keyboard.

| DualSense (Xbox) | Action |
| --- | --- |
| left stick | steer; up / down tuck and brake, and balance a press |
| R2 / L2 (RT / LT) | tuck / brake (analog, past the trigger dead zone) |
| ✕ (A) hold, release | jump (with the stick up / down: nollie / ollie) |
| □ (X) | squat (with steer: hard carve), grab in the air, sprint on foot |
| ○ (B) | skate on the flat |
| △ (Y) | interact: ride a lift, skip, strap in or out |
| R1 / L1 (RB / LB) | nose / tail press |
| right stick, R3 | look around, look behind |
| L3 | boost (Outrun) |
| D-pad up / left / down | camera / piste lines / next song |
| D-pad right or touchpad click | map: left stick moves the crosshair, R2 / L2 zoom, ✕ drops in, ○ closes |
| Create (Select) | replay viewer |
| Options (Start) or PS | pause |

In menus the D-pad or left stick moves, ✕ picks, ○ goes back (resumes from the pause menu), L1 / R1 switch
the settings categories, and left / right change a setting. Settings > Controls > Controller has
vibration on / off and its strength, the stick and trigger dead zones, the look speed, invert look Y, and two
slots per action to rebind the buttons (click a slot or press ✕ on it, then press the button).

Rumble: crashes, landings (harder the harder you land), time trial checkpoints, and the Outrun
monster's footsteps as it closes in; under that, a light background rumble while riding over bumps,
chop and rock at speed off the groomers (none on groomed snow, softer at a crawl). Holding a nose or tail press hums, then beats faster and harder as the
balance needle nears either end: a heavy rumble when it is about to catch the loaded end (ease off), a
light buzz when the board is about to drop flat (lean in more).

**DualSense extras** (Chrome or Edge, USB or Bluetooth): Settings > Controls > DualSense extras > Connect,
clicked with the mouse, opens the browser's device picker; pick the controller. After that it reconnects
by itself. Chrome on Windows gives a DualSense no rumble on its own, so its rumble comes through the
extras: the main and pause menus show a "Turn on DualSense rumble and lightbar" button while one is
plugged in without them (Settings > Controls > Test vibration says which way rumble goes). It adds the lightbar (the goggle lens colour, pulsing red as the Outrun monster closes in,
flashing green on a time trial best), adaptive triggers (L2 pushes back harder the more the edge digs in
a brake, R2 clicks near the top; off by default), gyro look (tilt the controller to look around; off by
default, with a speed slider) and touchpad swipes to change the camera.

If a controller is not seen, press a button with the game in front (browsers hide controllers until
then), and over the home network use `npm run host -- --https` (see above). `?debug=pad` shows what each
connected controller reports.

Holding a nose or tail press is a balancing act. A small meter shows above the rider with a needle
that drifts toward the nose or the tail, faster the longer you hold, the faster you go and the
bumpier the snow. Keep it in the green with W / S (or the left stick up / down, which is analog).
Off the loaded end (the cross) the board catches and you fall over that end, or stall when slow; off
the other end (the bar) the board drops flat. There is no time limit: a long press only needs quicker,
finer corrections. Let go any time to end it cleanly. Hold the press key through a trick to land
straight into the press ("Backside 360 to nose press"). A toast gives the press time and distance,
with your best for the resort. Settings > Gameplay > Press balance: Easy, Normal, Hard or Off (the Feel presets set it too).

Hold Shift while you steer for a hard carve: the rider drops low, drives the edge in to 80 degrees
and lays over toward the snow with the inside hand dragging, for the tightest turn the board allows
(about 3 to 4 m at 22 mph on a groomer, against about 5 m steering normally). Commit first: roll onto the
edge, then press. Pressed from flat at speed, or on ice, the edge lags behind the turn you are asking
for, so the tail skids out wide and scrubs speed, and badly overdone (pressed from straight at about 45 mph
on a groomer or in tracked-out chop, less on ice) it washes out and you go down on your hip (toeside) or your
butt (heelside). Only in deep powder does the board plane instead, a deep surfy turn. Every hard carve slows you, a skidded one more. Steering without Shift is unchanged.

You can ride switch (the other foot forward, the tail leading). Land a 180, or slide back down the
hill tail first, and you carry on switch until you turn round again with another 180 or by stopping
and sliding off the other way. The HUD shows SWITCH while you do, and spins are named on landing
("Backside 180", "Switch frontside 360"). Pick your normal stance in Settings > Gameplay > Stance:
Regular (left foot forward) or Goofy (right foot forward).

The snow changes how the board rides (FEAT-053). Groomers are fast and grippy. Off the groomers,
north-facing bowls, high ground, the trees and anything under a storm hold powder: the board slows
and floats, turns come round wider, and the nose sinks and digs in when you are slow. In powder the
board sits down in the snow, tail low and nose up, the deeper the snow and the slower you go the
deeper, and the nose floats up out of it as you pick up speed.
A tail press (Z) lifts the nose out and keeps your speed, and is easier to hold; a nose press (Q)
buries the nose, slows you and pulls you over it. Open off-piste
gets tracked out into chop as the day goes on and rattles the board. High exposed ridges are
wind-scoured ice, and spring mornings leave the groomers icy: the edge holds less and skids sooner.
Low sunny faces turn to slush in the afternoon, heavy and slow. Settings > Conditions (Snow conditions:
Fresh, Mid-season or Spring; New snow; Weather; Time of day) all change it. The HUD names
the snow under you (Groomed, Powder, Chop, Ice, Slush, Rock); on foot it also shows how deep the
boots sink.

The snow near you moves. Carving in powder cuts a deep, board-wide trench (a groomer keeps its
shallow groove), the snow around your tracks and footprints sags, and a hockey stop piles a ridge of
pushed snow. Hard turns throw spray: light wisps on a groomer, clouds that hang and drift in powder, a
burst when you land. Settings > Graphics > Snow dents turns the sag off (the Low preset turns it off
too).

In first person you look through goggle lenses (Settings > Camera > Goggle lens). In flat light
(a storm, overcast, deep shade) the snow's bumps, rollers and dips are hard to see; a warm lens (Rose,
Orange, Yellow) cuts the blue and brings their shape back, Yellow most of all in a storm. The mirrored
lenses (Green, Blue, Purple) darken the view for sunny days, Clear is for night, and Auto picks one for
the weather and the time of day. Lens strength scales the effect. Your rider wears the same lens, the
outfit presets each come with one, and the helmet cam stays untinted.

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
