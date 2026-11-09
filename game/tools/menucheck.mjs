// Menu check (FEAT-128): walks the main menu, the settings panel and the pause menu with the keyboard
// and a fake gamepad and checks focus moves, values change, hints come from the key tables, Esc cancels
// a rebind without closing anything, Esc resumes exactly once, and A on Resume doesn't jump.
// node tools/menucheck.mjs [pack] [--headed | --gpu | --cpu] [--shots]   (run after `npx vite build`; exit 1 on a failed check)
//   --shots saves the main menu, settings and pause to shots/menus/
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

const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// one fake standard-mapping gamepad; the test presses buttons through window.__pad
await page.addInitScript(() => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  window.__pad = { buttons, axes: [0, 0, 0, 0] };
  navigator.getGamepads = () => [{ id: 'menucheck pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), buttons, axes: window.__pad.axes, vibrationActuator: null }];
  localStorage.clear();
});
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&lowgfx${process.env.SHOT_QUERY ?? ''}`);
await page.waitForSelector('#menu .panel', { timeout: 60000 });
await page.waitForTimeout(300);

const active = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.dataset.a ?? a.dataset.t ?? a.dataset.k ?? a.dataset.d ?? a.tagName) : null; });
const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(60); };
const pad = async (i, holdMs = 90) => { await page.evaluate((i) => { window.__pad.buttons[i].pressed = true; window.__pad.buttons[i].value = 1; }, i); await page.waitForTimeout(holdMs); await page.evaluate((i) => { window.__pad.buttons[i].pressed = false; window.__pad.buttons[i].value = 0; }, i); await page.waitForTimeout(80); };
const hints = () => page.evaluate(() => [...document.querySelectorAll('.hintbar')].filter((e) => e.offsetParent).map((e) => [...e.querySelectorAll('span')].map((x) => `[${x.querySelector('kbd')?.textContent}] ${x.lastChild?.textContent}`).join(' ')).join(' | '));

// ---- main menu
check('focus starts on primary', (await active()) === 'ride', `focused ${await active()}`);
await key('ArrowDown');
const afterDown = await active();
check('arrow down moves focus', afterDown !== 'ride' && afterDown !== null && afterDown !== 'BODY', `focused ${afterDown}`);
// with the settings panel closed, walking down never lands inside it
let inHidden = false;
for (let i = 0; i < 8; i++) { await key('ArrowDown'); if (await page.evaluate(() => !!document.activeElement?.closest('.settings.hidden'))) inHidden = true; }
check('hidden rows skipped', !inHidden);
check('keyboard hints', /Enter/.test(await hints()), await hints());
check('no stale key line', await page.evaluate(() => !/Space jump|steer ·/.test(document.querySelector('#menu')?.textContent ?? '')));
if (shots) await page.screenshot({ path: path.join(outDir, 'main.png') });

// settings: Enter on Settings opens it, Q / E switch tabs, Esc closes and returns focus
await page.evaluate(() => document.querySelector('#menu button[data-a="settings"]')?.focus());
await page.evaluate(() => { const b = document.querySelector('#menu button[data-a="settings"]'); b?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); });
await key('Enter');
check('Enter opens settings', await page.evaluate(() => !document.querySelector('#menu .settings:not(.outrun)')?.classList.contains('hidden')));
const tab0 = await page.evaluate(() => document.querySelector('#menu .tabs button.on')?.dataset.t);
await key('KeyE');
const tab1 = await page.evaluate(() => document.querySelector('#menu .tabs button.on')?.dataset.t);
check('Q / E switch settings tabs', tab0 === 'audio' && tab1 === 'graphics', `${tab0} -> ${tab1}`);
await key('KeyQ');
// letters typed on a select are the select's own (type-ahead), not tab switches
await page.evaluate(() => document.querySelector('#menu .settings select[data-k="musicSource"]')?.focus());
await key('KeyE');
check('letters in a select do not switch tabs', (await page.evaluate(() => document.querySelector('#menu .tabs button.on')?.dataset.t)) === 'audio');
// Controls tab: Esc while a key slot listens cancels the slot only
await page.click('#menu .tabs button[data-t="controls"]');
const slot = page.locator('#menu button.key').first();
const before = await slot.textContent();
await slot.click();
await key('Escape');
check('rebind Esc cancels only the slot', (await slot.textContent()) === before && await page.evaluate(() => !document.querySelector('#menu .settings:not(.outrun)')?.classList.contains('hidden')), `slot "${await slot.textContent()}"`);
if (shots) await page.screenshot({ path: path.join(outDir, 'settings.png') });
await key('Escape');
check('Esc closes settings, focus back on Settings', await page.evaluate(() => document.querySelector('#menu .settings:not(.outrun)')?.classList.contains('hidden')) && (await active()) === 'settings', `focused ${await active()}`);

// gamepad: D-pad moves focus, hints switch to pad labels
await page.evaluate(() => document.querySelector('#menu button[data-a="ride"]')?.focus());
await pad(13); // D-pad down
check('pad D-pad moves focus', (await active()) !== 'ride', `focused ${await active()}`);
check('hints switch to pad labels', /\[A\] Select/.test(await hints()) && !/Enter/.test(await hints()), await hints());
await key('ArrowUp');

// ---- into a session: Free ride
await page.evaluate(() => document.querySelector('#menu button[data-a="ride"]')?.click());
await page.waitForFunction(() => window.__sim, null, { timeout: 120000 });
await page.waitForTimeout(1500);
await key('Escape');
const pauseOpen = await page.evaluate(() => getComputedStyle(document.querySelector('#pause')).display !== 'none');
check('Esc opens pause on Resume', pauseOpen && (await active()) === 'resume', `open ${pauseOpen}, focused ${await active()}`);
if (shots) await page.screenshot({ path: path.join(outDir, 'pause.png') });
await key('Escape');
await page.waitForTimeout(300);
check('Esc resumes once', await page.evaluate(() => getComputedStyle(document.querySelector('#pause')).display === 'none'));

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

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' / '));
await browser.close();
server.close();
console.log(fails.length ? `${fails.length} failed` : 'all ok');
process.exit(fails.length ? 1 : 0);
