# FEAT-128 menus rework: design

Card: FEAT-128 (#274). Agreed with Drew on 2026-11-09 in a brainstorm with mockups. This doc is what the build follows; the card has the full settings inventory.

## Why

The menus were built quick and dirty: one 380 px glass column holds everything, settings open inline under the buttons and scroll, the categories mix weather with graphics, the pause menu hides Outrun in an expanding section, the key hints are stale, and nothing works without a mouse. Drew wants the front end to feel ergonomic and like a game: Halo's way of moving around (controller first, a strong focus highlight, LB / RB between categories, a description panel for the focused row) with Deadlock's look (dark, clean, one accent colour, big confident type over a live 3D scene). A secondary goal is to show off the real place: the backdrop is the resort we built from GIS and topo data, framed so you recognise it.

## Goals

- A full-screen main menu over a live, iconic shot of the resort, with ghosts riding a line in it.
- One settings overlay with categories, a detail panel, presets, search, peek and per-section reset, opened from the main and pause menus.
- A compact pause menu with run stats and quick toggles.
- The whole flow works with the keyboard alone, with a gamepad, with a mouse and on touch.
- Every current setting has a home, and bindings shown anywhere come from the keymap so they can't go stale.

## Non-goals

- The far-terrain look from high up (grey blobs over the bowls, no trees past 4.5 km). That's FEAT-153 (#345), researched in `docs/research/far-terrain.md`. The menu ships with the backdrop as the game renders it today and gets better when FEAT-153 lands.
- New gameplay settings from other Ready cards (jump mode, edge catches, fall line, controller dead zones, music source, goggle lens). Their rows go in when those cards land; this card leaves the slots.
- Colour-blind-safe piste colours and subtitles for audio cues. They're features in their own right; Accessibility gets the rows when they exist.
- Spotify. The private branch adds its own row; nothing for it on `main`.

## Anti-goals (what would make this a failure even if it works)

- A menu that only works with a mouse, or a focus that gets lost (nothing highlighted, or focus behind the overlay).
- Any key or button hint typed by hand. Hints are read from the keymap and the pad layout.
- Frame-rate cost while riding. The menus are DOM; when they're closed they cost nothing.
- Breaking the test tools: `headless`, `cam=eye` and the `__sim` / `__step` hooks keep working, and `cam=eye` still skips the menu.

## Look and feel (decided)

- **One set of style tokens** as CSS variables on `:root`: colours (background, panel, line, text, dim, the accent), radii, spacing, type scale, focus ring. The menus, the HUD prompts, the map and the Outrun card use them.
- **Accent:** the yellow `#ffd166` the HUD prompts already use. The primary button is solid accent with dark text.
- **Type:** a condensed display face for titles, menu items and category names (uppercase), a plain sans for body text. Drew saw Barlow Condensed and Barlow in the mockups. *Builder's call:* bundle the two fonts under `game/public/fonts/` (OFL), not from Google at runtime, so the hosted LAN build works offline.
- **Focus:** the focused item gets an accent bar on the left and a soft accent wash; focused rows in settings get an accent outline. Hit targets at least 44 px tall.
- **Panels:** dark translucent with a light border, over a darkening gradient on the backdrop, never a solid box over the whole screen.
- **Button hints** along the bottom of each screen (A Select, B Back, LB / RB, Y Peek, X Reset), shown as keyboard keys or pad buttons depending on the last input used.

## Main menu (layout B, decided)

- **Backdrop:** the live game, not a picture. For Vail, the camera sits on the ridge just behind the Legendary Back Bowls gateway, angled down, with the sign readable on the right and the bowls opening on the left (the mockup pose: eye x -727, y 524, heading 150, pitch -12, fov 50, about 9 m up). It drifts slowly (a few metres of dolly and a degree or two of pan over 20 to 30 s, then eases back). Each resort has its own hand-picked shot in a small table next to `LANDMARKS` (`world/Landmarks.ts`) or in the pack meta. *Builder's call:* a resort without a shot falls back to the default start looking downhill from 15 m up.
- **Title names the place in the shot**, not just the resort: "Back Bowls" huge, "Vail · Colorado" small above it, and a line of real facts under it.
- **Ghosts:** three or four riders drop the same line together, staggered a second or two apart, and loop. They replay **runs Drew records, shipped with the game** (not the player's own runs). Each ghost is a full rider (`RiderView`), not the translucent time-trial ghost, in a different outfit preset.
- **Primary action:** one big RIDE button (continue where you left off), with "or drop in from the map" as a link beside it and "continues at <place> · reset to resort start" under it (the BUG-037 start logic, unchanged).
- **Card row along the bottom:** the current resort card, a gap, then Free ride, Time trial, Outrun, then **Change resort**. Left and right walk the cards. Breckenridge is not a card of its own; Change resort opens the resort picker (every pack in `packs/index.json`), and picking one reloads into that resort's shot as today (`?pack=`).
- **Mode cards** select the mode RIDE starts. Time trial opens a course list (name, length, your best). Outrun opens its options (difficulty, escape, Gentle) in the same frame. Free ride needs nothing. *Builder's call, Time trial mode:* picking a course turns the gates on for the session, and RIDE (or Mode from pause) puts the rider just above that course's start gate, overriding the saved start for that ride. Switching back to Free ride turns the gates off again unless the Time trials setting is on. The setting stays as the default for Free ride.
- **Snowboard / Skis** toggles on a button (X on the pad), shown on the resort card.
- **Corner links:** Settings, Controls (opens Settings on the Controls category), Credits (opens Settings on Credits).
- The hosted-build line (FEAT-138) stays, small, in a corner.

### Architecture change this needs

Today the menu runs before the session, so there is no scene to show. The menu becomes a state **inside** the session: the session loads behind the menu (shown over the shot's still, see Loading order below), starts in an "attract" state (menu open, eye-style camera on the shot, ghosts running, rider hidden, physics paused, HUD hidden), and RIDE switches to riding with the camera snapping to the rider. Quit to main menu returns to attract without tearing the session down. Change resort reloads the page as today. `headless` and `cam=eye` skip attract as they skip the menu now.

- *Builder's call, quit and RIDE again:* Quit ends an Outrun or time trial in progress and closes this run's stats; RIDE then starts at the saved start (the last map drop-in or the resort start, BUG-037), as today, not where you quit.
- *Builder's call, sound:* browsers only allow audio after a click, tap or key press (a gamepad button doesn't count). The menu plays the selected playlist once audio is unlocked; until then a small "Click or press any key for sound" note shows in the hint bar. No "press any button" screen.
- **Loading order (Drew, decided): a still frame of the live shot first.** Each shot ships with a still rendered from the exact same pose (`game/public/attract/<slug>/<shot>.jpg`). The menu appears at once over that still, fully usable, with a slim loading bar in the corner while the session loads behind it. When the session is ready the still crossfades into the live view and the ghosts drop in, so the picture doesn't jump. Settings changed before the load finishes (Low quality, say) apply to the load. RIDE pressed early shows "Loading" on the button and goes as soon as the session is ready. This replaces today's separate loading screen on the way into the menu.
- *Builder's call, the stills:* a tool (alongside `tools/shoot_spots.mjs`) renders every shot in the shot table on Drew's GPU at 1920 x 1080 and writes the JPEGs; re-run it when a shot, the terrain or FEAT-153 changes. A shot with no still falls back to the dark gradient.
- *Builder's call, performance:* the attract scene renders at the saved quality and auto quality (FEAT-062) runs during attract as it does while riding, so a weak device steps down on its own before you press RIDE.
- *Builder's call, facts line:* the place line under the title is written per shot in the shot table (place name and the elevation from the sign, for example "Elev. 11,250 ft at the gateway"); resort numbers (summit height, runs, lifts) are counted from the pack, never typed from memory.

### Ghost recordings

- **Format:** a JSON file per ghost, a slice of the replay samples (`sim/Replay.ts`, 20 Hz, the `ReplaySample` fields) from a start time to an end time, plus the pack slug, the discipline (board or ski), the stance and an outfit name. *Builder's call:* ghosts ride what was recorded (a board take stays a board), whatever the player's Snowboard / Skis toggle says. They live in `game/public/attract/<slug>/` with a small `index.json`.
- **Recording tool:** with `?debug`, the replay viewer gets in and out marks (it has none today) and a key that saves the marked span as an attract file (a download, or into `game/public/attract/` through the dev server, the way `?spot=` shots save into `docs/compare/`). Drew rides the line a few times; each take is one ghost.
- **Playback:** step through the samples and drive a `RiderView` per ghost the way the replay viewer drives the rider pose. No physics.
- *Builder's call:* until Drew records them, a ghost-less backdrop is fine; the PR says what to record.

## Settings (layout B, decided)

- **Full screen**, over the blurred backdrop from the main menu, or over the live game (dimmed, not blurred, so changes show) from pause.
- **Top bar:** "Settings", the LB / RB hint, a search box, and a live fps readout (when opened over the game).
- **Left: categories.** Gameplay, Controls, Camera, Graphics, Conditions, Map and world, Audio, Rider, Accessibility, Credits. LB / RB or clicking switches.
- **Middle: rows** of label and control only, grouped under small section headings, with "Reset <category>" on the right of the first heading and Reset all at the bottom of the category list.
- **Right: detail panel** for the focused row: name, what it does, what it costs ("costs about 15% fps", measured, not guessed), what the presets do with it, and a preview picture where one helps (camera modes, weather, goggle frame). *Builder's call:* pictures are optional per row; start with camera and weather.
- **Controls:** toggles, segmented pickers (2 to 4 options), left / right pickers (more options), sliders. Left and right change the focused row's value; A toggles or opens.
- **Graphics presets** Low / Medium / High / Ultra at the top, the individual options under "Advanced". *Builder's call:* Ultra is High plus cascaded shadows and full resolution; changing any advanced option shows the preset as "Custom".
- **Gameplay Feel presets** Arcade / Balanced / Realistic at the top, setting the gameplay options together. Today that is only press balance; the presets grow as jump mode, edge catches and fall line land.
- **Peek:** hold Y (or a Peek button on touch and mouse) to hide the overlay and see the game; release to come back. Only over the game.
- **Search** filters rows across all categories by label and description, results grouped by category.
- **Controls category:** the FEAT-124 grouped rebinding view (two bindings per action, conflicts flagged), moved into the row style, plus the gamepad layout shown as a list read from the pad map in `sim/Controls.ts`.
- **Where every setting goes:** the table on the card (#274, "Update (Nov 9)"). Accessibility starts with UI scale (*builder's call:* it scales everything on screen that is DOM, the menus, HUD, prompts, map, Outrun card and touch controls, from one root value set up with the tokens in PR 1) and Reduce motion (one switch that turns camera shake, first person shake and speed lines down together, BUG-051). Credits moves out of Audio into its own category.

## Pause menu (layout B, decided)

- One left column over the live game, the right half left clear so you can see where you are.
- **Top:** "Paused · Vail" and the place you're at in big type (nearest named run or area), then this run's stats on one line (time, distance, vertical, top speed) from `sim/RunStats.ts`.
- **List:** Resume, Restart, Map, Mode (shows the current mode; opens Free ride / Time trial / Outrun with Outrun's start and stop), Replay (opens the replay viewer), Settings. Quit to main menu sits in the hint bar, so it isn't hit by accident.
- **Quick toggles** under the list: camera, weather, time of day, music station. Left and right cycle the focused one; the change applies at once.
- B or Esc resumes.

## Navigation (all screens)

- **Keyboard:** arrows move focus, Enter or Space selects, Esc goes back (resumes from pause), Tab and Shift+Tab also move, Q / E switch categories in settings (the LB / RB of the keyboard). *Builder's call:* the menu keys are a fixed table, not part of the rebindable riding keymap (`DEFAULT_KEYS`), so a rebind can never lock you out of the menus: Q / E categories, hold V peek, R reset section, B Snowboard / Skis on the main menu. The hint bar reads that table and the riding keymap; nothing is typed by hand.
- **Pad map:** FEAT-137 (merged during PR 1) made the controller buttons rebindable (`DEFAULT_PAD` in `sim/Pad.ts`) with per-controller glyphs (`ui/PadGlyphs.ts`) and its own menu loop (`ui/PadNav.ts`). The menus read those; on MenuNav screens PadNav hands its presses to MenuNav, so there is still one focus.
- **Gamepad:** D-pad or left stick moves focus (with repeat), A selects, B goes back, LB / RB switch categories, Y peeks, X resets the section or toggles Snowboard / Skis on the main menu, Start opens and closes pause.
- **Mouse and touch:** hover sets focus, click or tap selects; rows are 44 px or taller.
- One small focus manager module owns this for all three screens, so the behaviour is the same everywhere. Focus is always somewhere visible; opening a screen focuses its primary item; closing one returns focus to what opened it.

## Phone and portrait

- Main menu: the title and RIDE stay top-left; the card row becomes a horizontal scroller.
- Settings: categories become a scrolling strip across the top; the detail panel becomes one line of description under the focused row.
- Pause: the column takes the full width.
- *Builder's call* on breakpoints; check at 390 x 844 and 844 x 390.

## Build plan: four PRs, in order

Each PR is playable on its own and lands through its own PR to `main` that references FEAT-128; the last one says `Fixes #274`.

1. **Shared frame.** Style tokens, fonts, the focus manager (keyboard, gamepad, mouse, touch), button-hint bar reading from the keymap and pad map, and the screen container. Existing menus restyled onto the tokens with no layout change yet, and their stale key line replaced by hints from the keymap.
2. **Settings overlay.** Layout B, categories, rows, detail panel, Graphics and Feel presets, search, peek, per-section reset, Controls rebinding in the new style, Accessibility rows. Opened from the current main menu and pause menu.
3. **Pause menu.** Layout B with run stats, Mode, Replay, quick toggles; Outrun folded into Mode.
4. **Main menu.** Menu inside the session (attract state), the backdrop shot table, ghost playback and the recording tool, the card row, mode screens, Change resort picker, Credits and Controls links.

## Checks

- `cd game && npx tsc --noEmit` before every commit.
- A render-free browser check per PR (the `switchcheck.mjs` pattern): open each screen, walk it with synthetic keyboard and gamepad input, assert focus moves, values change and settings persist. One for keyboard-only start to riding.
- Screenshots of each screen on Drew's GPU (`--gpu`), at 1920 x 1080 and phone sizes, attached to each PR.
- Docs travel with each PR: `README.md` (controls, menu flow) and `docs/developer-guide.md` (code layout, the attract state, the recording tool and file format, URL parameters).

## Left to the builder

Everything marked *Builder's call* above, plus: module and file names, the exact drift path of the backdrop camera, the stagger and outfits of the ghosts, how the place name for the pause title is chosen, how fps costs are measured (the `perf-check` skill) and worded, and the animation timings (keep them short: under 200 ms for focus, about 300 ms for screen changes, none with Reduce motion on).
