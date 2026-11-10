// Menu check (FEAT-128): walks the main menu, the settings screen and the pause menu with the keyboard
// and a fake gamepad and checks focus moves, values change and persist, presets, search, reset, peek,
// hints come from the key tables, Esc cancels a rebind without closing anything, Esc resumes exactly
// once, and A on Resume doesn't jump.
// node tools/menucheck.mjs [pack] [--headed | --gpu | --cpu] [--shots]   (run after `npx vite build`; exit 1 on a failed check)
//   --shots saves the main menu, settings (over the menu, over the game, phone sizes) and pause to shots/menus/
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const shots = args.includes('--shots');
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = await launchBrowser();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };
const outDir = path.join('shots', 'menus');
if (shots) fs.mkdirSync(outDir, { recursive: true });
const url = `http://localhost:${server.address().port}/index.html?pack=${pack}&lowgfx${process.env.SHOT_QUERY ?? ''}`;

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// one fake standard-mapping gamepad; the test presses buttons through window.__pad
await page.addInitScript(() => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  window.__pad = { buttons, axes: [0, 0, 0, 0] };
  navigator.getGamepads = () => [{ id: 'menucheck pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), buttons, axes: window.__pad.axes, vibrationActuator: null }];
  if (!sessionStorage.getItem('menucheck')) { localStorage.clear(); sessionStorage.setItem('menucheck', '1'); }
});
await page.goto(url);
await page.waitForSelector('#menu .panel', { timeout: 60000 });
await page.waitForTimeout(300);

/** the focused item: a settings row by its id, else the button's data-a / data-cat, else the tag */
const active = () => page.evaluate(() => { const a = document.activeElement; if (!a) return null; const r = a.closest('[data-row]'); return a.dataset.row ?? (r && a.matches('.key') ? `slot:${r.dataset.row}` : null) ?? a.dataset.a ?? a.dataset.cat ?? a.dataset.k ?? a.dataset.d ?? (a.matches('.search') ? 'search' : a.tagName); });
const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(60); };
const pad = async (i, holdMs = 90) => { await page.evaluate((i) => { window.__pad.buttons[i].pressed = true; window.__pad.buttons[i].value = 1; }, i); await page.waitForTimeout(holdMs); await page.evaluate((i) => { window.__pad.buttons[i].pressed = false; window.__pad.buttons[i].value = 0; }, i); await page.waitForTimeout(80); };
const hints = () => page.evaluate(() => [...document.querySelectorAll('.hintbar')].filter((e) => e.offsetParent).map((e) => [...e.querySelectorAll(':scope > span')].map((x) => `[${x.querySelector('kbd')?.textContent}] ${x.lastChild?.textContent}`).join(' ')).join(' | '));
const setOpen = () => page.evaluate(() => { const el = document.querySelector('#settings'); return !!el && getComputedStyle(el).display !== 'none'; });
const cat = () => page.evaluate(() => document.querySelector('#settings .cats button.on')?.dataset.cat ?? null);
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('settings') ?? '{}'));
/** focus a settings row by id (as the arrows would) */
const focusRow = (id) => page.evaluate((id) => { const el = document.querySelector(`#settings [data-row="${id}"][data-nav]`); el?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, movementX: 2, movementY: 2 })); el?.focus(); return !!el; }, id);
const openCat = (c) => page.evaluate((c) => document.querySelector(`#settings .cats button[data-cat="${c}"]`)?.click(), c);

// ---- main menu
check('focus starts on primary', (await active()) === 'ride', `focused ${await active()}`);
await key('ArrowDown');
const afterDown = await active();
check('arrow down moves focus', afterDown !== 'ride' && afterDown !== null && afterDown !== 'BODY', `focused ${afterDown}`);
check('keyboard hints', /Enter/.test(await hints()), await hints());
check('no stale key line', await page.evaluate(() => !/Space jump|steer ·/.test(document.querySelector('#menu')?.textContent ?? '')));
if (shots) await page.screenshot({ path: path.join(outDir, 'main.png') });

// ---- settings over the menu: opens on the first Gameplay row, the detail panel follows the focus
await page.evaluate(() => document.querySelector('#menu button[data-a="settings"]')?.focus());
await key('Enter');
check('Enter opens settings on the first row', await setOpen() && (await cat()) === 'gameplay' && (await active()) === 'feel', `open ${await setOpen()}, cat ${await cat()}, focused ${await active()}`);
check('over the menu: blurred, no peek', await page.evaluate(() => document.querySelector('#settings').classList.contains('over-menu') && getComputedStyle(document.querySelector('#settings .peek')).display === 'none'));
await key('ArrowDown');
check('detail panel follows the focus', await page.evaluate(() => /press balance/i.test(document.querySelector('#settings .detail h3')?.textContent ?? '')), await page.evaluate(() => document.querySelector('#settings .detail h3')?.textContent));
check('detail shows what the presets do', await page.evaluate(() => /Arcade: easy/.test(document.querySelector('#settings .detail .presets')?.textContent ?? '')));
// the settings hint bar: keys from the tables, peek only over the game
const sh = await hints();
check('settings hints from the key tables', /\[Q E\] Category/.test(sh) && /\[R\] Reset gameplay/.test(sh) && /\[Esc\] Back/.test(sh) && !/peek/i.test(sh), sh);
// Q / E switch category
await key('KeyE');
const c1 = await cat();
await key('KeyQ');
check('Q / E switch category', c1 === 'controls' && (await cat()) === 'gameplay', `${c1} -> ${await cat()}`);
// left / right change the focused row; the value is saved
await focusRow('invertSteer');
await key('ArrowRight');
check('right turns a toggle on and saves it', (await saved()).invertSteer === true, JSON.stringify((await saved()).invertSteer));
await key('Enter');
check('Enter flips a toggle', (await saved()).invertSteer === false);
await openCat('camera');
await focusRow('fov');
const fov0 = (await saved()).fov ?? 68;
await key('ArrowRight'); await key('ArrowRight');
check('right steps a slider', (await saved()).fov === fov0 + 2, `${fov0} -> ${(await saved()).fov}`);
await focusRow('camera');
await key('ArrowRight');
check('right steps a picker', (await saved()).camera === 'close', (await saved()).camera);
// Graphics presets: Low moves the advanced options; changing one of them shows Custom
await openCat('graphics');
await focusRow('gfx');
await page.evaluate(() => document.querySelector('#settings [data-row="gfx"] .seg button[data-v="high"]')?.click());
await page.evaluate(() => document.querySelector('#settings [data-row="gfx"] .seg button[data-v="low"]')?.click());
const low = await saved();
check('Graphics preset Low sets the advanced options', low.quality === 'low' && low.shadows === false && low.treeDensity === 0.3, JSON.stringify([low.quality, low.shadows, low.treeDensity]));
await focusRow('shadows');
await key('Enter');
check('changing an advanced option shows Custom', await page.evaluate(() => document.querySelector('#settings [data-row="gfx"]').classList.contains('custom') && !document.querySelector('#settings [data-row="gfx"] .seg button.on')));
await page.evaluate(() => document.querySelector('#settings [data-row="gfx"] .seg button[data-v="ultra"]')?.click());
const ultra = await saved();
check('Ultra is High plus cascaded shadows', ultra.quality === 'high' && ultra.csmExperimental === true && ultra.shadows === true);
await page.evaluate(() => document.querySelector('#settings [data-row="gfx"] .seg button[data-v="high"]')?.click());
// Feel preset
await openCat('gameplay');
await page.evaluate(() => document.querySelector('#settings [data-row="feel"] .seg button[data-v="realistic"]')?.click());
check('Feel Realistic sets press balance Hard', (await saved()).pressBalance === 'hard');
await page.evaluate(() => document.querySelector('#settings [data-row="feel"] .seg button[data-v="balanced"]')?.click());
// per-category reset: one press arms, a second resets
await openCat('camera');
await focusRow('fov');
await key('KeyR');
check('one R only arms the reset', (await saved()).fov === fov0 + 2 && await page.evaluate(() => document.querySelector('#settings [data-reset-cat="camera"]').classList.contains('armed')));
await key('KeyR');
check('a second R resets the category', (await saved()).fov === 68 && (await saved()).camera === 'chase', `fov ${(await saved()).fov} camera ${(await saved()).camera}`);
// search: filters across categories, letters stay in the box, Esc clears then closes
await page.focus('#settings .search');
await page.keyboard.type('speed', { delay: 20 });
const found = await page.evaluate(() => [...document.querySelectorAll('#settings .srow[data-nav]')].filter((r) => r.offsetParent).map((r) => r.dataset.row));
check('search finds rows in any category', found.includes('speedFov') && found.includes('lookSens') && found.includes('gyroSens') && !found.includes('fov') && !found.includes('shadows'), found.join(','));
check('letters typed in search do not switch category', (await page.evaluate(() => document.querySelector('#settings .search').value)) === 'speed');
await key('Escape');
check('Esc clears the search first', await setOpen() && (await page.evaluate(() => document.querySelector('#settings .search').value)) === '');
// Accessibility: UI scale and Reduce motion
await openCat('access');
await focusRow('uiScale');
await key('ArrowRight'); await key('ArrowRight');
check('UI scale sets the token', (await page.evaluate(() => document.documentElement.style.getPropertyValue('--ui-scale'))) === '1.1');
await key('ArrowLeft'); await key('ArrowLeft');
await focusRow('reduceMotion');
await key('Enter');
await openCat('camera');
check('Reduce motion marks the shake rows overridden', await page.evaluate(() => document.querySelector('#settings [data-row="camShake"]').classList.contains('overridden') && document.documentElement.classList.contains('reduce-motion')));
await openCat('access'); await focusRow('reduceMotion'); await key('Enter');
// Controls: Esc while a key slot listens cancels the slot only
await openCat('controls');
const slot = page.locator('#settings [data-mount="keys"] button.key').first();
const before = await slot.textContent();
await slot.click();
await key('Escape');
check('rebind Esc cancels only the slot', (await slot.textContent()) === before && await setOpen(), `slot "${await slot.textContent()}"`);
check('controller menu hint from the tables', await page.evaluate(() => { const el = document.querySelector('#settings [data-padnav-hint]'); return !!el && el.querySelectorAll('.pg').length >= 5; }));
const pslot = page.locator('#settings [data-mount="padkeys"] button.key').first();
const pBefore = await pslot.innerHTML();
await pslot.click();
await key('Escape');
check('pad rebind Esc cancels only the slot', (await pslot.innerHTML()) === pBefore && await setOpen());
// a second slot clicked while one listens takes over: it shows it listens and keeps the focus
await page.locator('#settings [data-mount="keys"] button.key[data-action="jump"][data-slot="0"]').click();
await page.locator('#settings [data-mount="keys"] button.key[data-action="camera"][data-slot="1"]').click();
const second = await page.evaluate(() => { const b = document.querySelector('#settings [data-mount="keys"] button.key[data-action="camera"][data-slot="1"]'); return { text: b.textContent, focused: document.activeElement === b, jump: document.querySelector('#settings [data-mount="keys"] button.key[data-action="jump"][data-slot="0"]').textContent }; });
await key('Escape');
check('a second slot takes over the listening', second.text === '...' && second.focused && second.jump !== '...', JSON.stringify(second));
// descriptions name the keys from the keymap, not typed by hand
check('row descriptions read the keymap', await page.evaluate(() => /\bC cycles/.test(document.querySelector('#settings [data-row="camera"] .sdesc').textContent)));
// the action rows act inside the screen (Reset keys does not start a ride)
await page.evaluate(() => document.querySelector('#settings [data-row="keys-reset"]')?.click());
await page.waitForTimeout(150);
check('settings actions stay in the screen', await setOpen() && await page.evaluate(() => !!document.querySelector('#menu')));
// with the controller, focus walks past the keyboard key slots and the colour pickers
await page.evaluate(() => document.querySelector('#settings .cats button[data-cat="controls"]')?.focus());
let onKeySlot = false;
const walk = [];
for (let i = 0; i < 18; i++) { await pad(13, 50); const w = await page.evaluate(() => { const a = document.activeElement; return (a?.matches('[data-mount="keys"] button.key') ? 'SLOT ' : '') + (a?.dataset.row ?? a?.dataset.paction ?? a?.className); }); walk.push(w); if (w.startsWith('SLOT')) onKeySlot = true; }
check('pad focus skips keyboard key slots', !onKeySlot, walk.join(' > '));
check('hints switch to pad labels', await page.evaluate(() => document.querySelectorAll('#settings .hintbar kbd.pad svg').length >= 3), await hints());
// R1 / L1 switch category on the pad
await pad(5);
check('R1 switches category', (await cat()) === 'camera', await cat());
if (shots) await page.screenshot({ path: path.join(outDir, 'settings-menu.png') });
await key('Escape');
check('Esc closes settings, focus back on Settings', !(await setOpen()) && (await active()) === 'settings', `focused ${await active()}`);
// the Controls button opens the Controls category
await page.evaluate(() => document.querySelector('#menu button[data-a="controls"]')?.click());
check('Controls opens the Controls category', await setOpen() && (await cat()) === 'controls');
if (shots) {
  for (const [w, h] of [[390, 844], [844, 390]]) { await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(200); await page.screenshot({ path: path.join(outDir, `settings-${w}x${h}.png`) }); }
  await page.setViewportSize({ width: 1280, height: 800 });
}
await key('Escape');

// ---- into a session: Free ride
await page.evaluate(() => document.querySelector('#menu button[data-a="ride"]')?.click());
await page.waitForFunction(() => window.__sim, null, { timeout: 120000 });
await page.waitForTimeout(1500);
await key('Escape');
const pauseOpen = await page.evaluate(() => getComputedStyle(document.querySelector('#pause')).display !== 'none');
check('Esc opens pause on Resume', pauseOpen && (await active()) === 'resume', `open ${pauseOpen}, focused ${await active()}`);
await key('Escape');
await page.waitForTimeout(300);
check('Esc resumes once', await page.evaluate(() => getComputedStyle(document.querySelector('#pause')).display === 'none'));

// a stick already held down (braking) when pause opens doesn't walk the focus off Resume
await page.evaluate(() => { window.__pad.axes[1] = 1; });
await key('Escape');
await page.waitForTimeout(1000);
const heldFocus = await active();
await page.evaluate(() => { window.__pad.axes[1] = 0; });
await page.waitForTimeout(150);
check('held stick keeps focus on Resume', heldFocus === 'resume', `focused ${heldFocus}`);
// ---- the pause menu (layout B): the place and this run's stats, quick toggles, Mode, Quit pressed twice
const head = await page.evaluate(() => ({ place: document.querySelector('#pause .place').textContent, stats: document.querySelector('#pause .stats').textContent, eyebrow: document.querySelector('#pause .eyebrow').textContent }));
check('pause names the place and shows stats', head.place.length > 0 && head.stats.length > 0 && /Paused/.test(head.eyebrow), JSON.stringify(head));
const qfocus = (id) => page.evaluate((id) => { const el = document.querySelector(`#pause .qrow[data-q="${id}"]`); el?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, movementX: 2, movementY: 2 })); el?.focus(); }, id);
const cam0 = await page.evaluate(() => window.__sim.cam.mode);
await qfocus('camera'); await key('ArrowRight');
const camQ = await page.evaluate(() => ({ mode: window.__sim.cam.mode, saved: window.__sim.settings.camera, shown: document.querySelector('#pause .qrow[data-q="camera"] .pv').textContent }));
check('quick toggle changes the camera at once', camQ.mode !== cam0 && camQ.mode === camQ.saved && camQ.shown.length > 0, `${cam0} -> ${JSON.stringify(camQ)}`);
await key('ArrowLeft');
await qfocus('clouds'); await key('ArrowRight');
check('quick toggle changes the weather', (await saved()).clouds === 'broken', (await saved()).clouds);
await key('ArrowLeft');
// Mode: its own screen, Q / E across Free ride / Time trial / Outrun, Esc back onto Mode
await page.evaluate(() => document.querySelector('#pause button[data-a="mode"]')?.focus());
await key('Enter');
const modeOpen = await page.evaluate(() => !document.querySelector('#pause .modep').hidden && document.querySelector('#pause .main').hidden);
await key('KeyE');
const tab = await page.evaluate(() => document.querySelector('#pause .modep .tabs button.on')?.dataset.m);
check('Mode opens its screen, E switches mode', modeOpen && tab === 'trial', `open ${modeOpen}, tab ${tab}`);
await key('Escape');
check('Esc closes Mode onto its button, pause stays', (await active()) === 'mode' && await page.evaluate(() => getComputedStyle(document.querySelector('#pause')).display !== 'none'), `focused ${await active()}`);
// pick a time trial course: the gates come on for the session and the rider starts above the gate
const course = await page.evaluate(() => document.querySelector('#pause .courses button[data-course]')?.dataset.course ?? null);
if (course) {
  await page.evaluate(() => { document.querySelector('#pause button[data-a="mode"]').click(); document.querySelector('#pause .modep .tabs button[data-m="trial"]').click(); document.querySelector('#pause .courses button[data-course]').click(); });
  await page.waitForTimeout(300);
  const tt = await page.evaluate(() => ({ paused: getComputedStyle(document.querySelector('#pause')).display !== 'none', on: window.__sim.trialWorld.enabled, setting: window.__sim.settings.timeTrials }));
  check('a course from Mode turns the gates on for the session', !tt.paused && tt.on && tt.setting === false, JSON.stringify(tt));
  await key('Escape');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#pause')).display !== 'none', null, { timeout: 10000 }).catch(() => {});
  const label = await page.evaluate(() => document.querySelector('#pause [data-v="mode"]').textContent);
  check('Mode shows the course', label.length > 0 && label !== 'Free ride', label);
  await page.evaluate(() => { document.querySelector('#pause button[data-a="mode"]').click(); document.querySelector('#pause .modep .tabs button[data-m="free"]').click(); document.querySelector('#pause [data-go="freeride"]').click(); });
  await page.waitForTimeout(200);
  check('Free ride turns them off again', await page.evaluate(() => !window.__sim.trialWorld.enabled));
  await key('Escape');
} else check('the pack has a time trial course', false);
// Quit sits in the hint bar and needs a second press
await page.evaluate(() => document.querySelector('#pause .foot .quit').click());
check('one Quit press only arms it', await page.evaluate(() => getComputedStyle(document.querySelector('#pause')).display !== 'none' && document.querySelector('#pause .foot .quit').classList.contains('armed')));
if (shots) {
  await page.screenshot({ path: path.join(outDir, 'pause.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, 'pause-390x844.png') });
  await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(200);
}
// pause > Settings: over the live game, with the fps readout; changes apply at once
await page.evaluate(() => document.querySelector('#pause button[data-a="settings"]')?.click());
await page.waitForTimeout(700);
check('settings over the game, with fps', await setOpen() && await page.evaluate(() => document.querySelector('#settings').classList.contains('over-game') && /fps/.test(document.querySelector('#settings .fps').textContent)));
// the readout is the live frame rate of the paused game, not the last one before the pause
await page.waitForTimeout(1200);
const rates = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res({ raf: n * 1000 / (performance.now() - t0), shown: parseFloat(document.querySelector('#settings .fps').textContent) }); }; requestAnimationFrame(f); }));
check('fps readout is live while paused', Math.abs(rates.shown - rates.raf) < Math.max(6, rates.raf * 0.25), `shown ${rates.shown}, frames ${rates.raf.toFixed(0)}/s`);
await openCat('camera'); await focusRow('fov'); await key('ArrowRight');
check('a change applies to the running game', await page.evaluate(() => window.__sim.cam.baseFov === window.__sim.settings.fov && window.__sim.settings.fov === 69));
await key('ArrowLeft');
// Reset all keeps the options the pause menu edits live: Outrun set from pause after a Reset all is what runs
await page.evaluate(() => { const b = document.querySelector('#settings [data-reset-all]'); b.click(); b.click(); });
await page.waitForTimeout(100);
await key('Escape');
await page.evaluate(() => { document.querySelector('#pause button[data-a="mode"]').click(); document.querySelector('#pause .modep .tabs button[data-m="outrun"]').click(); });
await page.evaluate(() => document.querySelector('#pause .qrow[data-q="outrun.difficulty"] button.arr[data-d="1"]').click());
check('after Reset all the pause Outrun options still apply', await page.evaluate(() => window.__sim.settings.outrun.difficulty === 'skifree' && document.querySelector('#pause .qrow[data-q="outrun.difficulty"] .pv').textContent === 'SkiFree'));
await page.evaluate(() => document.querySelector('#pause .qrow[data-q="outrun.difficulty"] button.arr[data-d="-1"]').click());
await key('Escape');
await page.evaluate(() => document.querySelector('#pause button[data-a="settings"]')?.click());
await page.waitForTimeout(200);
// typing in search never reaches the game behind (M is the map)
await page.focus('#settings .search');
await page.keyboard.type('m', { delay: 20 });
check('typing in search does not open the map', await page.evaluate(() => !window.__sim.map.fullOpen));
await key('Escape');
// Peek: hold V (or Y) hides the screen, release brings it back (V typed in the search box is a letter, so from a row)
await focusRow('fov');
await page.keyboard.down('KeyV'); await page.waitForTimeout(150);
const peekOn = await page.evaluate(() => document.body.classList.contains('peeking'));
await page.keyboard.up('KeyV'); await page.waitForTimeout(150);
check('hold V peeks, release returns', peekOn && await page.evaluate(() => !document.body.classList.contains('peeking')));
await page.evaluate(() => { window.__pad.buttons[3].pressed = true; window.__pad.buttons[3].value = 1; }); await page.waitForTimeout(200);
const padPeek = await page.evaluate(() => document.body.classList.contains('peeking'));
await page.evaluate(() => { window.__pad.buttons[3].pressed = false; window.__pad.buttons[3].value = 0; }); await page.waitForTimeout(200);
check('hold Y peeks, release returns', padPeek && await page.evaluate(() => !document.body.classList.contains('peeking')));
if (shots) await page.screenshot({ path: path.join(outDir, 'settings-game.png') });
// Esc on a listening key slot cancels the slot, settings stays open
await openCat('controls');
const kslot = page.locator('#settings [data-mount="keys"] button.key').first();
const kBefore = await kslot.textContent();
await kslot.click();
await key('Escape');
await page.waitForTimeout(150);
check('pause rebind Esc cancels only the slot', (await kslot.textContent()) === kBefore && await setOpen());
// a slot still listening when the pause closes (Start) stops listening and the screen closes: the next key while riding is not bound
const keysBefore = await page.evaluate(() => JSON.stringify(window.__sim.settings.keys));
await kslot.click();
await pad(9); // Start
await page.waitForTimeout(200);
await key('KeyJ');
const keysAfter = await page.evaluate(() => JSON.stringify(window.__sim.settings.keys));
const closedAll = !(await setOpen()) && await page.evaluate(() => getComputedStyle(document.querySelector('#pause')).display === 'none' && !document.body.classList.contains('settings-open'));
await key('Escape');
const f0 = await active();
await key('ArrowDown');
check('closing pause closes settings and cancels a listening slot', keysAfter === keysBefore && closedAll && f0 === 'resume' && (await active()) !== 'resume', `keys same ${keysAfter === keysBefore}, closed ${closedAll}, focus ${f0} -> ${await active()}`);
await key('Escape');
await page.waitForTimeout(300);

// A on Resume with the pad, A still held: no jump charge, no jump on release
await key('Escape');
await page.evaluate(() => { window.__pad.buttons[0].pressed = true; window.__pad.buttons[0].value = 1; });
await page.waitForTimeout(600);
const charge = await page.evaluate(() => window.__sim.rider.jumpCharge);
const closed = await page.evaluate(() => getComputedStyle(document.querySelector('#pause')).display === 'none');
await page.evaluate(() => { window.__pad.buttons[0].pressed = false; window.__pad.buttons[0].value = 0; });
let air = false;
for (let i = 0; i < 10; i++) { await page.waitForTimeout(60); if (await page.evaluate(() => !window.__sim.rider.onGround)) air = true; }
check('pad A on Resume does not jump', closed && charge === 0 && !air, `closed ${closed}, charge ${charge}, airborne ${air}`);

await key('Escape');
await page.waitForTimeout(200);
await page.evaluate(() => { document.querySelector('#pause .foot .quit').click(); document.querySelector('#pause .foot .quit').click(); });
await page.waitForSelector('#menu .panel', { timeout: 30000 }).catch(() => {});
check('Quit pressed twice goes to the main menu', await page.evaluate(() => !!document.querySelector('#menu .panel')));
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' / '));
await browser.close();
server.close();
console.log(fails.length ? `${fails.length} failed` : 'all ok');
process.exit(fails.length ? 1 : 0);
