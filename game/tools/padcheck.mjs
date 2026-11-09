// Controller check (FEAT-137), no hardware needed:
//  1. the DualSense WebHID report helpers (bundled from src/sim/DualSense.ts with esbuild, run in Node):
//     CRC-32, the USB and Bluetooth output reports (lightbar, motors, trigger blocks at their offsets, the
//     Bluetooth CRC), the trigger effect encodings, and input parsing (buttons, D-pad hat, sticks, triggers,
//     touchpad);
//  2. the main menu on a fake DualSense (navigator.getGamepads stubbed): body.pad-on, the controller hint
//     with glyphs, the focus starting on Free ride, D-pad down moving it, Cross opening Settings, R1
//     switching the tab, Circle closing the panel back onto its button;
//  3. a headless session: the default buttons (R2 tuck past the trigger dead zone, Cross jump and release,
//     D-pad right one map press, Options pause), the stick dead zone, a rebound jump, a muted held button,
//     the corner hints in PlayStation glyphs (keys again after a key press), rumble effects on a landing and a crash,
//     and on a scripted rider: a press's hum and its warning beat on the heavy (slam) or light (flat) motor, bumps at
//     speed (none on a smooth slope, softer at a crawl and on groomed snow).
// node tools/padcheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };
const hex = (a) => Array.from(a, (v) => v.toString(16).padStart(2, '0')).join(' ');

// ---------------------------------------------------------------- 1. report helpers
console.log('---- DualSense reports');
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = await build({ entryPoints: [path.join(here, '../src/sim/DualSense.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'error' });
  const ds = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  check('crc32 check value', ds.crc32Of(new TextEncoder().encode('123456789')) === 0xcbf43926, ds.crc32Of(new TextEncoder().encode('123456789')).toString(16));
  const fb = ds.triggerFeedback(1, 8);
  // Nielk1: zones 1..9 active (0x3fe), force 7 in each 3-bit slot from zone 1
  let forces = 0; for (let i = 1; i < 10; i++) forces |= 7 << (3 * i);
  check('trigger feedback(1, 8)', fb[0] === 0x21 && fb[1] === 0xfe && fb[2] === 0x03 && (fb[3] | fb[4] << 8 | fb[5] << 16 | fb[6] << 24) >>> 0 === forces >>> 0, hex(fb));
  const wp = ds.triggerWeapon(2, 4, 3);
  check('trigger weapon(2, 4, 3)', hex(wp) === '25 14 00 02 00 00 00 00 00 00 00', hex(wp));
  check('trigger off', ds.triggerOff()[0] === 0x05 && ds.triggerFeedback(3, 0)[0] === 0x05);
  const o = { strong: 1, weak: 0.5, light: [10, 20, 30], left: fb, right: wp, vibrationV2: true };
  const usb = ds.outputReport(o, false);
  check('USB report id and size (47 after the id, as Windows reports it)', usb.id === 0x02 && usb.data.length === 47, `${usb.id} ${usb.data.length}`);
  check('USB flags', usb.data[0] === 0x0e && usb.data[1] === 0x04 && usb.data[38] === 0x04, hex(usb.data.subarray(0, 2)) + ' / ' + usb.data[38]);
  check('USB motors (right weak, left strong)', usb.data[2] === 128 && usb.data[3] === 255, `${usb.data[2]} ${usb.data[3]}`);
  check('USB triggers at 10 (R2) and 21 (L2)', usb.data[10] === 0x25 && usb.data[21] === 0x21);
  check('USB lightbar at 44..46', usb.data[44] === 10 && usb.data[45] === 20 && usb.data[46] === 30);
  const v1 = ds.outputReport({ ...o, vibrationV2: false }, false);
  check('old firmware rumble flag', v1.data[0] === 0x0f && v1.data[38] === 0, `${v1.data[0]} ${v1.data[38]}`);
  const setup = ds.outputReport({ ...o, light: null, setupLightbar: true }, false);
  check('lightbar setup report', setup.data[1] === 0 && (setup.data[38] & 0x02) && setup.data[41] === 0x02);
  const bt = ds.outputReport(o, true, 5);
  const crcIn = new Uint8Array(75); crcIn[0] = 0xa2; crcIn[1] = 0x31; crcIn.set(bt.data.subarray(0, 73), 2);
  const crc = ds.crc32Of(crcIn), got = (bt.data[73] | bt.data[74] << 8 | bt.data[75] << 16 | bt.data[76] << 24) >>> 0;
  check('BT report id, size, seq and tag', bt.id === 0x31 && bt.data.length === 77 && bt.data[0] === 0x50 && bt.data[1] === 0x10, `${bt.id} ${bt.data.length} ${bt.data[0]} ${bt.data[1]}`);
  check('BT common block at 2', bt.data[2] === 0x0e && bt.data[2 + 44] === 10 && bt.data[2 + 10] === 0x25);
  check('BT CRC', crc === got, `${crc.toString(16)} vs ${got.toString(16)}`);
  // input: USB layout (no id byte), Cross + Options + touchpad click, hat east, sticks, L2 half, a finger at (1000, 500)
  const raw = new Uint8Array(63);
  raw[0] = 255; raw[1] = 0; raw[2] = 128; raw[3] = 128; raw[4] = 128; raw[5] = 0;
  raw[7] = 0x20 | 2; raw[8] = 0x20; raw[9] = 0x02;
  raw[15] = 0x10; raw[16] = 0x00; // gyro x = 16 units, about 1 deg/s
  raw[32] = 0x01; raw[33] = 1000 & 0xff; raw[34] = ((1000 >> 8) & 0x0f) | ((500 & 0x0f) << 4); raw[35] = 500 >> 4;
  raw[52] = 0x07;
  const st = { buttons: Array.from({ length: 18 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0], gyro: [0, 0, 0], touch: { active: false, x: 0, y: 0 }, battery: 0 };
  const okUsb = ds.parseInput(new DataView(raw.buffer), 0, st);
  const pressed = st.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0).join(',');
  check('input buttons (Cross, L2, Options, D-pad right, touchpad)', okUsb && pressed === '0,6,9,15,17', pressed);
  check('input sticks and L2 value', st.axes[0] === 1 && st.axes[1] === -1 && Math.abs(st.axes[2]) < 0.01 && Math.abs(st.buttons[6].value - 128 / 255) < 1e-6, `${st.axes.map((a) => a.toFixed(2))} L2 ${st.buttons[6].value.toFixed(2)}`);
  check('input touch and gyro', st.touch.active && st.touch.x === 1000 && st.touch.y === 500 && Math.abs(st.gyro[0] - 1) < 0.05 && st.battery === 75, `${st.touch.x},${st.touch.y} gyro ${st.gyro[0].toFixed(2)} battery ${st.battery}`);
  const btIn = new Uint8Array(77); btIn.set(raw, 1);
  const st2 = { ...st, buttons: st.buttons.map(() => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0], gyro: [0, 0, 0], touch: { active: false, x: 0, y: 0 } };
  check('Bluetooth input one byte in', ds.parseInput(new DataView(btIn.buffer), 1, st2) && st2.buttons[0].pressed && st2.buttons[15].pressed);
}

// ---------------------------------------------------------------- the browser
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css' };
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
/** a fake DualSense on the standard mapping; the test sets window.__pad.buttons / axes, rumble effects are recorded */
const fakePad = () => {
  window.__pad = { on: true, id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', buttons: new Array(18).fill(0), axes: [0, 0, 0, 0], effects: [] };
  const act = { type: 'dual-rumble', playEffect: (t, o) => { window.__pad.effects.push({ t, ...o }); return Promise.resolve('complete'); }, reset: () => { window.__pad.effects.push({ t: 'reset' }); return Promise.resolve('complete'); } };
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: () => {
    const p = window.__pad;
    if (!p.on) return [null];
    return [{ id: p.id, index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: p.axes.slice(), buttons: p.buttons.map((v) => ({ pressed: v > 0.5, touched: v > 0, value: v })), vibrationActuator: act }];
  } });
};
const newPage = async (query) => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(fakePad);
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}${query}${process.env.SHOT_QUERY ?? ''}`);
  return { page, errors };
};
/** press a button for a few frames and let go */
const tap = async (page, b) => {
  await page.evaluate((b) => { window.__pad.buttons[b] = 1; }, b);
  await page.waitForTimeout(80);
  await page.evaluate((b) => { window.__pad.buttons[b] = 0; }, b);
  await page.waitForTimeout(80);
};

// ---------------------------------------------------------------- 2. the main menu
console.log('---- main menu');
{
  const { page, errors } = await newPage('');
  await page.waitForSelector('#menu .panel', { timeout: 60000 });
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({ on: document.body.classList.contains('pad-on'), ps: document.body.classList.contains('pad-ps'), hint: document.querySelector('#menu .pad-hint')?.innerHTML ?? '', focus: document.querySelector('.padfocus')?.textContent ?? '' }));
  check('body.pad-on and pad-ps', st.on && st.ps);
  check('menu hint in glyphs', st.hint.includes('<svg'), st.hint.slice(0, 60));
  check('focus starts on Free ride', st.focus === 'Free ride', st.focus);
  await tap(page, 13); // down
  const f2 = await page.evaluate(() => document.querySelector('.padfocus')?.textContent ?? '');
  check('D-pad down moves the focus', f2 === 'Drop in from the map', f2);
  // a DualSense on the Gamepad API (no rumble on Windows Chrome): the menu offers the WebHID extras; Cross on it asks for the mouse
  await tap(page, 13);
  const offer = await page.evaluate(() => ({ shown: getComputedStyle(document.querySelector('#menu .ds-connect')).display !== 'none', focus: document.querySelector('.padfocus')?.textContent ?? '' }));
  check('the menu offers the DualSense extras', offer.shown && offer.focus.startsWith('Turn on DualSense'), JSON.stringify(offer));
  await tap(page, 0);
  const note = await page.evaluate(() => document.querySelector('#menu .ds-status')?.textContent ?? '');
  check('Cross on it asks for a mouse click (the picker needs one)', note.includes('mouse click'), note);
  await tap(page, 13);
  await tap(page, 0); // Cross on Settings
  const open = await page.evaluate(() => !document.querySelector('#menu .settings').classList.contains('hidden'));
  check('Cross opens Settings', open);
  // the focus is still on the Settings button; move into the panel, then R1 switches the tab
  await tap(page, 13);
  const inPanel = await page.evaluate(() => !!document.querySelector('.padfocus')?.closest('.settings'));
  check('D-pad down enters the panel', inPanel);
  await tap(page, 5);
  const tabOn = await page.evaluate(() => document.querySelector('#menu .settings .tabs button.on')?.textContent ?? '');
  check('R1 switches the tab', tabOn === 'Graphics', tabOn);
  await tap(page, 1); // Circle
  const closed = await page.evaluate(() => ({ hidden: document.querySelector('#menu .settings').classList.contains('hidden'), focus: document.querySelector('.padfocus')?.textContent ?? '' }));
  check('Circle closes the panel onto its button', closed.hidden && closed.focus === 'Settings', JSON.stringify(closed));
  check('no console errors (menu)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

// ---------------------------------------------------------------- 3. a session
console.log('---- session');
{
  const { page, errors } = await newPage('&headless&lowgfx');
  await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
  page.setDefaultTimeout(240000);
  const r = await page.evaluate(() => {
    const c = window.__sim.controls, p = window.__pad, out = {};
    const frame = () => { c.endFrame(); return c.update(1 / 60); };
    const set = (b, v) => { p.buttons[b] = v; };
    frame();
    set(7, 0.2); out.rtLight = frame().tuck;
    set(7, 0.6); out.rtHeld = frame().tuck; set(7, 0);
    frame();
    set(0, 1); out.jumpHeld = frame().jumpHeld; set(0, 0); const rel = frame(); out.jumpReleased = rel.jumpReleased && !rel.jumpHeld; c.input.jumpReleased = false;
    set(15, 1); frame(); out.map1 = c.action('map'); out.map1again = c.action('map'); frame(); out.map2 = c.action('map'); set(15, 0); frame();
    set(9, 1); frame(); out.pause = c.once('Escape'); set(9, 0); frame();
    p.axes[0] = 0.1; out.steerDead = frame().steer; p.axes[0] = 1; out.steerFull = frame().steer; p.axes[0] = 0; frame();
    c.padKeys = { ...c.padKeys, jump: [1] }; set(1, 1); out.remapB = frame().jumpHeld; set(1, 0); set(0, 1); out.remapA = frame().jumpHeld; set(0, 0); frame();
    c.padKeys = { ...window.__sim.settings.padKeys };
    set(0, 1); frame(); c.padMute(); out.muted = frame().jumpHeld; set(0, 0); frame(); set(0, 1); out.unmuted = frame().jumpHeld; set(0, 0); frame(); c.input.jumpReleased = false;
    out.kind = c.padKind; out.active = c.padActive;
    return out;
  });
  check('R2 under the trigger dead zone does not tuck', r.rtLight === false);
  check('R2 past it tucks', r.rtHeld === true);
  check('Cross jumps and releases', r.jumpHeld && r.jumpReleased);
  check('D-pad right: one map press', r.map1 && !r.map1again && !r.map2, JSON.stringify([r.map1, r.map1again, r.map2]));
  check('Options pauses', r.pause);
  check('stick dead zone', r.steerDead === 0 && r.steerFull === 1, `${r.steerDead} ${r.steerFull}`);
  check('jump rebound to Circle', r.remapB && !r.remapA);
  check('a muted button waits for a release', !r.muted && r.unmuted);
  check('DualSense seen as a PlayStation pad', r.active && r.kind === 'ps', `${r.active} ${r.kind}`);
  // corner hints and rumble through real frames
  const fx = await page.evaluate(() => {
    const s = window.__sim, p = window.__pad;
    window.__step(2);
    const help = document.getElementById('help')?.innerHTML ?? '';
    p.effects.length = 0;
    s.rider.landingShock = 0.95;
    window.__step(1);
    const land = p.effects.filter((e) => e.t === 'dual-rumble').map((e) => e.strongMagnitude);
    p.effects.length = 0;
    s.rider.crashed = 1;
    window.__step(1);
    const crash = p.effects.filter((e) => e.t === 'dual-rumble').map((e) => e.strongMagnitude);
    s.settings.vibration = 0; s.padFx.strength = 0;
    p.effects.length = 0; s.rider.crashed = 0; window.__step(1); s.rider.crashed = 1; window.__step(1);
    const off = p.effects.filter((e) => e.t === 'dual-rumble' && e.strongMagnitude > 0.02).length;
    return { help, land, crash, off };
  });
  check('corner hints in PlayStation glyphs', fx.help.includes('<svg') && fx.help.includes('R2') && fx.help.includes('L stick') && !fx.help.includes('<kbd>'), fx.help.replace(/<svg.*?<\/svg>/g, '[svg]').slice(0, 160));
  check('a landing rumbles', fx.land.length > 0 && Math.max(...fx.land) > 0.5, JSON.stringify(fx.land));
  check('a crash rumbles hard', fx.crash.length > 0 && Math.max(...fx.crash) > 0.7, JSON.stringify(fx.crash));
  check('vibration 0 is off', fx.off === 0, String(fx.off));
  // press balance and bumps, on a scripted rider (deterministic)
  const pb = await page.evaluate(() => {
    const fx = window.__sim.padFx;
    const motors = [];
    const pad = { gp: { vibrationActuator: { playEffect: (_t, o) => { motors.push([o.strongMagnitude, o.weakMagnitude]); return Promise.resolve(); }, reset: () => Promise.resolve() } } };
    const rider = (o) => ({ landingShock: 0, crashed: 0, onGround: true, onFoot: false, speed: 12, vz: 0, chop: 0, pressing: false, pressBalance: 0, pressDir: 1, brakeAmt: 0, scrape: 0, surface: { rock: 0, scree: 0, moguls: 0, groomed: 0 }, ...o });
    const ride = (o, vz = () => 0) => {
      fx.stop(); fx.strength = 1; motors.length = 0;
      const r = rider(o);
      for (let i = 0; i < 90; i++) { r.vz = vz(i / 60); fx.update(1 / 60, pad, { rider: r, riding: true, monsterDist: Infinity, lens: 0 }); }
      const late = motors.slice(Math.floor(motors.length / 3));
      return { strong: Math.max(0, ...late.map((m) => m[0])), weak: Math.max(0, ...late.map((m) => m[1])) };
    };
    const out = {
      centre: ride({ pressing: true, pressBalance: 0 }),
      slam: ride({ pressing: true, pressBalance: 0.9 }),
      flat: ride({ pressing: true, pressBalance: -0.9 }),
      tailSlam: ride({ pressing: true, pressDir: -1, pressBalance: -0.9 }),
      smooth: ride({}, () => -3),
      bumps: ride({}, (t) => 2 * Math.sin(2 * Math.PI * 2 * t)),
      bumpsSlow: ride({ speed: 2 }, (t) => 2 * Math.sin(2 * Math.PI * 2 * t)),
      bumpsGroomed: ride({ surface: { rock: 0, scree: 0, moguls: 0, groomed: 1 } }, (t) => 2 * Math.sin(2 * Math.PI * 2 * t)),
    };
    fx.stop(); fx.strength = window.__sim.settings.vibration;
    return out;
  });
  const f2 = (m) => `strong ${m.strong.toFixed(2)} weak ${m.weak.toFixed(2)}`;
  check('a centred press only hums', pb.centre.strong < 0.05 && pb.centre.weak > 0.03 && pb.centre.weak < 0.2, f2(pb.centre));
  check('near the slam: the heavy motor beats', pb.slam.strong > 0.5 && pb.slam.weak < 0.2, f2(pb.slam));
  check('near dropping flat: the light motor beats', pb.flat.weak > 0.5 && pb.flat.strong < 0.1, f2(pb.flat));
  check('a tail press near its slam: the heavy motor', pb.tailSlam.strong > 0.5, f2(pb.tailSlam));
  check('a smooth slope at speed is still', pb.smooth.strong < 0.02 && pb.smooth.weak < 0.02, f2(pb.smooth));
  check('bumps at speed: a light background rumble, under a crash', pb.bumps.strong > 0.1 && pb.bumps.strong < 0.3, f2(pb.bumps));
  check('the same bumps at a crawl, softer', pb.bumpsSlow.strong < pb.bumps.strong * 0.4, `${f2(pb.bumpsSlow)} vs ${pb.bumps.strong.toFixed(2)}`);
  check('groomed snow, half', Math.abs(pb.bumpsGroomed.strong - pb.bumps.strong * 0.5) < 0.1, `${f2(pb.bumpsGroomed)} vs ${pb.bumps.strong.toFixed(2)}`);
  // the hints follow the hands: a key press brings the keys back, the controller its buttons
  await page.keyboard.press('KeyN');
  const kbHelp = await page.evaluate(() => { window.__step(16); return document.getElementById('help')?.innerHTML ?? ''; });
  await page.evaluate(() => { window.__pad.buttons[2] = 1; window.__step(1); window.__pad.buttons[2] = 0; window.__step(16); });
  const padHelp = await page.evaluate(() => document.getElementById('help')?.innerHTML ?? '');
  check('a key press switches the hints to keys', kbHelp.includes('<kbd>') && !kbHelp.includes('<svg'), kbHelp.slice(0, 80));
  check('the controller switches them back', padHelp.includes('<svg'), padHelp.slice(0, 80));
  check('no console errors (session)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} failed: ${fails.join(', ')}` : '\nall passed');
process.exit(fails.length ? 1 : 0);
