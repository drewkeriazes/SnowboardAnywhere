# FEAT-128 PR 1: shared menu frame. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Superseded in part (2026-11-09):** FEAT-137 (controller support) landed on `main` while this plan was built and was merged in. `ui/PadMap.ts`, MenuNav's own pad poll and `Controls.holdPadUntilRelease` were dropped in favour of `sim/Pad.ts`, `ui/PadGlyphs.ts`, `ui/PadNav.ts` (which hands its presses to `MenuNav.padIntent` on MenuNav screens) and `Controls.padMute`. The design doc's Navigation section has the current picture.

**Goal:** Give every menu one look (style tokens, bundled fonts, focus style) and one way to move around (keyboard, gamepad, mouse, touch), with button hints read from tables instead of typed by hand, without changing the menus' layout yet.

**Architecture:** A stylesheet of CSS variables replaces the hard-coded colours in `index.html`. A small focus manager (`ui/MenuNav.ts`) keeps a stack of open screens; only the top one takes input, from a capture-phase key listener and its own gamepad poll. Two tables, the pad map (`ui/PadMap.ts`) and the fixed menu keys (`ui/MenuKeys.ts`), feed both the input code and every hint line.

**Tech Stack:** TypeScript, Vite, DOM and CSS, Playwright browser checks (`game/tools/*.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-09-menus-design.md` (sections Look and feel, Navigation, Build plan item 1).

## Global Constraints

- Accent `#ffd166`; primary button solid accent with dark text; focus = accent bar on the left plus a soft accent wash; hit targets at least 44 px tall.
- Fonts: Barlow Condensed (600, 700, 800) for titles, menu items and category names (uppercase), Barlow (400, 500, 600) for body; bundled under `game/public/fonts/` with the OFL licence, never loaded from Google at runtime.
- Menu keys are a fixed table, not part of `DEFAULT_KEYS`: arrows move, Enter or Space select, Esc back, Tab / Shift+Tab move, Q / E categories, hold V peek, R reset section, B Snowboard / Skis.
- Pad: D-pad or left stick move (with repeat), A select, B back, LB / RB categories, Y peek, X reset or Snowboard / Skis, Start opens and closes pause.
- No key or button hint typed by hand anywhere in the menus or the riding help.
- `headless`, `cam=eye`, `__sim`, `__step` keep working; closed menus cost nothing per frame (no pad polling while no screen is open).
- UI scale: one root value `--ui-scale` (default 1) that every token size multiplies, so PR 2 can add the setting.
- Typecheck before each commit: `cd game && npx tsc --noEmit`. No em dashes in prose. Commit messages plain, reference FEAT-128.

## Review Focus

1. Rebinding a key in Settings > Controls while the menu is open: Esc must cancel the rebind, not close the menu or the pause. Test in Task 3 (`rebind Esc cancels only the slot`).
2. Pressing A on Resume with the pad: the rider must not jump when play resumes, because A is still held. Test in Task 3 (`pad A on Resume does not jump`).
3. Esc in the pause menu resumes exactly once (the nav and `main.ts`'s own Esc handling must not both toggle). Test in Task 3 (`Esc resumes once`).
4. Focus never lost: opening a screen focuses its primary item, hidden elements are skipped, and closing the settings panel returns focus to the Settings button. Test in Task 3 (`focus starts on primary`, `hidden rows skipped`).
5. Typing in a text field or select with the keyboard must not trigger menu shortcuts (Q / E / R / V / B). Test in Task 3 (`letters in a select do not switch tabs`).

---

### Task 1: Style tokens, bundled fonts, restyled menus

**Files:**
- Create: `game/src/ui/theme.css`, `game/public/fonts/` (six `.woff2` files and `OFL.txt`)
- Modify: `game/index.html` (move the menu, pause, settings, loading, prompt and Outrun card rules into `theme.css`; keep HUD-only rules), `game/src/main.ts` (one `import './ui/theme.css'`)

**Interfaces:**
- Produces: CSS variables on `:root`: `--ui-scale`, `--bg`, `--panel`, `--panel-strong`, `--line`, `--text`, `--dim`, `--accent`, `--accent-ink`, `--accent-wash`, `--danger`, `--ok`, `--r-sm` 6px, `--r-md` 10px, `--r-lg` 16px, `--sp-1..--sp-6` (4, 8, 12, 16, 24, 32 px), `--fs-xs/-sm/-md/-lg/-xl/-xxl` (11, 13, 15, 18, 24, 36 px), each size `calc(N * var(--ui-scale))`; `--font-display: 'Barlow Condensed'`, `--font-body: 'Barlow'`; `--row-h: calc(44px * var(--ui-scale))`. Classes used by later tasks: `.nav-focus` (the focus look), `.hintbar`, `.hintbar kbd`, `.btn-primary`.

- [ ] **Step 1:** Download Barlow Condensed 600/700/800 and Barlow 400/500/600 latin `woff2` from `https://cdn.jsdelivr.net/npm/@fontsource/barlow-condensed@5.1.0/files/` and `.../@fontsource/barlow@5.1.0/files/` into `game/public/fonts/`, plus the OFL text. Declare them with `@font-face` (`font-display: swap`) at the top of `theme.css`.
- [ ] **Step 2:** Write the tokens and move the menu rules out of `index.html` onto them (same layout, same sizes at scale 1). Buttons in `#menu`, `#pause`, `.settings` get `min-height: var(--row-h)`; titles and buttons use `--font-display` uppercase; `.primary` is solid `--accent` with `--accent-ink` text. `.nav-focus` and `:focus-visible` both draw the accent bar plus wash; keyboard key rows (`button.key`) keep their monospace.
- [ ] **Step 3:** `cd game && npx tsc --noEmit && npx vite build`. Expected: no errors; `dist/fonts/*.woff2` present.
- [ ] **Step 4:** Screenshot the main menu and the pause menu on the GPU (`node tools/menucheck.mjs --gpu --shots` once Task 4 exists; until then load `npx vite preview` and look). Expected: same layout as before, new fonts and accent.
- [ ] **Step 5:** Commit `FEAT-128: style tokens and bundled fonts for the menus`.

### Task 2: Pad map and menu key tables

**Files:**
- Create: `game/src/ui/PadMap.ts`, `game/src/ui/MenuKeys.ts`
- Modify: `game/src/sim/Controls.ts` (read button indices from `PadMap`), `game/src/main.ts:953` (riding pad help from the table), `game/src/ui/Settings.ts` (the Controls tab's gamepad hint from the table)

**Interfaces:**
- Produces (`PadMap.ts`):
  - `export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const; export type PadButton = keyof typeof PAD;` (moved out of Controls)
  - `export const PAD_RIDE: { what: string; pad: string; action?: string }[]`: rows in this order: left stick "Steer and lean"; A "Jump (hold, release)"; X "Squat / grab (+ steer: hard carve)"; RT / LT "Tuck / brake"; RB / LB "Nose / tail press"; B "Skate"; Y "Interact"; right stick "Look around"; R3 "Look behind"; D-pad up "Camera"; D-pad right "Map"; D-pad left "Piste lines"; D-pad down "Next track"; Select "Replay"; Start "Pause".
  - `export const PAD_BUTTON_FOR: Record<string, PadButton>` = `{ jump: 'A', grab: 'X', skate: 'B', tuck: 'RT', brake: 'LT', pressNose: 'RB', pressTail: 'LB', lift: 'Y', glance: 'R3', camera: 'UP', map: 'RIGHT', piste: 'LEFT', track: 'DOWN', replay: 'SELECT', pause: 'START' }`
  - `export function padLabel(b: PadButton): string` ('A', 'LB', 'D-pad up', 'Select', 'Start', ...)
  - `export function padRideHint(): string` (the one-line riding help, built from `PAD_RIDE`)
- Produces (`MenuKeys.ts`):
  - `export type NavIntent = 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'next' | 'prev' | 'prevCat' | 'nextCat' | 'peek' | 'reset' | 'discipline'`
  - `export const MENU_KEYS: Record<NavIntent, string[]>` = up `ArrowUp`, down `ArrowDown`, left `ArrowLeft`, right `ArrowRight`, select `Enter` `Space`, back `Escape`, next `Tab`, prev (Shift+Tab, handled in code), prevCat `KeyQ`, nextCat `KeyE`, peek `KeyV`, reset `KeyR`, discipline `KeyB`
  - `export const MENU_PAD: Partial<Record<NavIntent, PadButton>>` = select A, back B, prevCat LB, nextCat RB, peek Y, reset X, discipline X, up/down/left/right D-pad
  - `export function intentForKey(code: string, shift: boolean): NavIntent | null`

- [ ] **Step 1:** Create both modules with the values above.
- [ ] **Step 2:** In `Controls.update`, replace each literal pad index with `PAD[PAD_BUTTON_FOR.<action>]` and build `PAD_ACTIONS` from `PAD_BUTTON_FOR` (camera, map, piste, track, replay, lift, pause). Behaviour unchanged.
- [ ] **Step 3:** `main.ts`: the `controls.padActive` help line becomes `'Gamepad: ' + padRideHint()`. `Settings.ts`: the hand-typed "A gamepad works too: ..." sentence becomes a list rendered from `PAD_RIDE`.
- [ ] **Step 4:** `cd game && npx tsc --noEmit`. Expected: clean. Run `node tools/switchcheck.mjs` in the background (riding unaffected). Expected: all `ok`.
- [ ] **Step 5:** Commit `FEAT-128: one pad map and one menu key table, hints read from them`.

### Task 3: Focus manager on every menu

**Files:**
- Create: `game/src/ui/MenuNav.ts`, `game/src/ui/HintBar.ts`
- Modify: `game/src/ui/MainMenu.ts`, `game/src/ui/PauseMenu.ts`, `game/src/ui/Settings.ts` (tabs answer prevCat / nextCat; rebinding suspends the nav), `game/src/sim/Controls.ts` (A guard), `game/src/main.ts` (pause wiring)
- Test: `game/tools/menucheck.mjs` (created in Task 4; the cases named here go in it)

**Interfaces:**
- Consumes: `intentForKey`, `MENU_PAD`, `PAD`, `padLabel` (Task 2); `.nav-focus`, `.hintbar` (Task 1).
- Produces (`MenuNav.ts`):
  - `export type InputKind = 'keyboard' | 'pad' | 'mouse' | 'touch'`
  - `export interface ScreenOpts { primary?: () => HTMLElement | null; onBack?: () => void; onIntent?: (i: NavIntent, down: boolean) => boolean /* true = handled */; onInputKind?: (k: InputKind) => void }`
  - `export class Screen { constructor(root: HTMLElement, opts: ScreenOpts); focus(el: HTMLElement | null): void; focusPrimary(): void; get focused(): HTMLElement | null; refresh(): void }`
  - `export function openScreen(s: Screen): void` (push, focus primary, start the pad poll if not running), `export function closeScreen(s: Screen): void` (pop, restore focus to the element that was focused when it opened), `export function setNavSuspended(on: boolean): void`, `export function lastInputKind(): InputKind`
- Produces (`HintBar.ts`): `export function renderHints(el: HTMLElement, items: [NavIntent, string][], kind: InputKind): void` (chips from `MENU_KEYS` / `MENU_PAD`, keyboard names via `keyName`)
- Produces (`Controls.ts`): `holdPadUntilRelease(): void` (ignore pad A, B and X as riding inputs until each is released once)

Behaviour the code must have (not spelled out by the signatures):
- Focusables: `button, select, input, [data-nav]` inside the top screen's root, skipping ones with no layout box, `disabled`, or `[data-nav="skip"]`.
- Movement: up / down / left / right pick the nearest focusable whose centre lies in that direction (score = distance along the axis + 2 x distance across it); if none, stay. On a focused `select` or `input[type=range]`, left / right change the value (one option or one step) and fire `input`, and up / down move focus. `select` on a checkbox toggles it and fires `input`; on a button, clicks it.
- Keyboard: one `keydown` listener on `window` in the capture phase, only while a screen is open and the nav isn't suspended. It ignores events whose target is a text `input` (letters only; arrows, Tab, Enter and Esc still navigate) and `select` for letter keys. A handled key gets `preventDefault` and `stopPropagation`, so `Controls` never sees it (that is what keeps Esc from toggling pause twice).
- Pad: a `requestAnimationFrame` poll while at least one screen is open; edges only; D-pad and left stick (|axis| > 0.5) repeat after 400 ms, every 120 ms. Start is not a nav button (Controls already turns it into Esc for pause).
- Mouse and touch: `pointerover` on a focusable focuses it; the last input kind switches the hints (`onInputKind`).
- Wiring: `showMainMenu` opens a screen whose primary is the Free ride button and whose `onIntent('discipline')` toggles Snowboard / Skis. `PauseMenu.show()` opens a screen with primary Resume and `onBack` = the resume action; `hide()` closes it and calls `controls.holdPadUntilRelease()` through `main.ts`. The settings panel answers prevCat / nextCat by switching tabs; while a key slot is listening it calls `setNavSuspended(true)` and `false` when done.

- [ ] **Step 1:** Write the menucheck cases for this task (they run in Task 4's harness): `focus starts on primary` (main menu: `document.activeElement` is the Free ride button), `arrow down moves focus` (to the next visible button), `hidden rows skipped` (with the settings panel closed, ArrowDown from Settings never lands inside `.settings.hidden`), `Enter opens settings, Esc returns focus to Settings`, `Q / E switch settings tabs`, `letters in a select do not switch tabs` (focus the playlist select, press Q, the tab is unchanged), `rebind Esc cancels only the slot` (click a key slot, press Escape: slot shows its old key, settings still open), `pad D-pad moves focus` and `hints switch to pad labels` (fake pad, see Task 4), `Esc resumes once` (in a session: Esc opens pause, Esc closes it, pause hidden and `paused` false after two frames), `pad A on Resume does not jump` (fake pad holds A to select Resume; after 30 frames with A still held `__sim.rider.jumpCharge` is 0).
- [ ] **Step 2:** Run them. Expected: FAIL (no nav yet).
- [ ] **Step 3:** Implement `MenuNav.ts`, `HintBar.ts`, `Controls.holdPadUntilRelease`, and the wiring above.
- [ ] **Step 4:** `cd game && npx tsc --noEmit && npx vite build && node tools/menucheck.mjs`. Expected: every case `ok`.
- [ ] **Step 5:** Commit `FEAT-128: keyboard and gamepad navigation for the main menu, pause and settings`.

### Task 4: Hint bars instead of stale key lines, the check, docs

**Files:**
- Create: `game/tools/menucheck.mjs`
- Modify: `game/src/ui/MainMenu.ts` (remove the `.keys` line; add a hint bar and a Controls button), `game/src/ui/PauseMenu.ts` (hint bar), `game/src/ui/Settings.ts` (`renderPanel` gains `openTab(name: string): void` on its return value), `README.md`, `docs/developer-guide.md`, `docs/superpowers/specs/2026-11-09-menus-design.md` (committed here)

**Interfaces:**
- Consumes: `renderHints`, `openScreen`, `lastInputKind` (Task 3).
- Produces: `renderPanel(host, s, onChange): { openTab(name: 'audio' | 'graphics' | 'controls' | 'rider' | 'game'): void }`.

- [ ] **Step 1:** `menucheck.mjs`: the `switchcheck.mjs` harness (static server on `DIST` and `PACKS`, `launchBrowser`, `check()`, exit 1 on a failure), loading `index.html?pack=synth&lowgfx` without `headless` so the main menu shows. A fake gamepad through `page.addInitScript` replacing `navigator.getGamepads` with one standard-mapping pad whose `buttons[i].pressed` the test sets through `window.__pad`. Session cases click Free ride and wait for `window.__sim`. `--gpu` and `--shots` flags save screenshots of the main menu, settings and pause to `shots/menus/`. Add the Task 3 cases plus `no stale key line` (no element in `#menu` contains "Space jump" or "steer &middot;"; the hint bar has "Enter" with the keyboard, "A" with the pad) and `Controls opens the Controls tab`.
- [ ] **Step 2:** Run it. Expected: the two new cases FAIL.
- [ ] **Step 3:** Main menu: hint bar at the bottom (select, move, back, Snowboard / Skis), a Controls button after Settings that opens the panel on the Controls tab. Pause: hint bar (select, move, B resume). Both re-render on `onInputKind`.
- [ ] **Step 4:** `cd game && npx tsc --noEmit && npx vite build && node tools/menucheck.mjs`. Expected: all `ok`. Then `node tools/menucheck.mjs --gpu --shots` and look at the three screenshots.
- [ ] **Step 5:** Docs: `README.md` controls section gets "Menus: arrows or D-pad move, Enter / A select, Esc / B back, Q / E or LB / RB switch settings tabs". `docs/developer-guide.md`: `ui/theme.css` tokens, `ui/MenuNav.ts`, `ui/PadMap.ts`, `ui/MenuKeys.ts`, `ui/HintBar.ts`, and `tools/menucheck.mjs` under test tools.
- [ ] **Step 6:** Commit `FEAT-128: hint bars from the key tables, menucheck, docs and the design doc`.

### Finish

- [ ] Push `issue-274-menus` and open a PR titled `FEAT-128 (1 of 4): shared menu frame` that references #274 without closing it ("Part of #274"), with the screenshots, the menucheck output and what PRs 2 to 4 bring.
