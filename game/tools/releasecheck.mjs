// Release toast check (FEAT-248): when a maintainer's build turns Published, the page downloads the pack on its own
// (POST /__packs/get, then /__packs/job) and a toast offers Ride, a same-tab ?pack=<slug> navigation
// (src/ui/ReleaseToast.ts). Part 1 runs the logic in Node over a fake build watcher (and once over the real one,
// src/ui/BuildWatch.ts), fake pack routes, fake sleeps and a fake localStorage: one download and one toast per
// build, Ride's URL, the same run again doing nothing (in the page and after a reload), a format mismatch with no
// Ride, Preview, No change and Failed toasts, a build that ended before the page loaded, a new release of the resort
// being ridden, a catalog that lags. Part 2 puts the toasts in a browser page (setContent, no server, no WebGL) over
// a stand-in main menu: on top, clickable, no tab stops, and a click that leaves the focus where it was.
// No network, no gh, no real download: nothing here can start a build. Exits 1 on a failure.
//   node tools/releasecheck.mjs [pack] [--gpu | --headed | --cpu] [--no-page]   (the pack is ignored: CI passes synth)
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GAME } from './paths.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'releasecheck-'));
const src = (f) => JSON.stringify(path.join(GAME, 'src', 'ui', f).replace(/\\/g, '/'));
fs.writeFileSync(path.join(tmp, 'entry.ts'), `export * from ${src('ReleaseToast.ts')};\nexport { BuildWatch } from ${src('BuildWatch.ts')};\nexport { PACK_FORMAT } from ${JSON.stringify(path.join(GAME, 'src', 'pack', 'format.ts').replace(/\\/g, '/'))};\n`);
const out = path.join(tmp, 'bundle.mjs');
await build({ entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const U = await import(pathToFileURL(out).href);
const F = U.PACK_FORMAT;

const NOW = Date.parse('2026-11-13T08:00:00Z');
const HREF = 'http://localhost:5173/?pack=vail&x=10&y=20&h=1.5&account=maintainer';
const settle = () => new Promise((res) => setTimeout(res, 5));
const info = (slug, runId, state, extra = {}) => ({ slug, runId, url: `https://github.com/x/runs/${runId}`, state, at: '2026-11-13T07:10:00Z', ...extra });
const done = (slug, runId, state, minsAgo = 1, extra = {}) => info(slug, runId, state, { doneAt: new Date(NOW - minsAgo * 60_000).toISOString(), ...extra });

/** a localStorage stand-in (throws: a blocked one) */
function store(throws = false) {
  const m = new Map();
  return { m, getItem: (k) => { if (throws) throw new Error('blocked'); return m.get(k) ?? null; }, setItem: (k, v) => { if (throws) throw new Error('blocked'); m.set(k, String(v)); } };
}

/**
 * The pack routes. `jobs`: the job answers in order for each POST (the last one repeats); `local` / `catalog`: what
 * GET /__packs/catalog lists once the download is over.
 */
function routes({ jobs = [[{ phase: 'download', received: 50, total: 100 }, { phase: 'unzip', received: 100, total: 100 }, { phase: 'done', received: 100, total: 100 }]], post = [], local = {}, catalog = { resorts: [] } } = {}) {
  const asked = [];
  let posts = 0, job = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = async (url, init = {}) => {
    asked.push(`${init.method ?? 'GET'} ${url}`);
    if (url === '/__packs/get' && init.method === 'POST') {
      const p = post[posts] ?? { status: 202 };
      job = (jobs[Math.min(posts, jobs.length - 1)] ?? []).slice();
      posts++;
      return json(p.body ?? { phase: 'download', received: 0, total: 0 }, p.status);
    }
    if (url.startsWith('/__packs/job?slug=')) return json(job.length > 1 ? job.shift() : job[0]);
    if (url === '/__packs/catalog') return json({ formatVersion: F, catalog, local });
    return new Response('not found', { status: 404 });
  };
  return { fetchFn, asked, posts: () => posts };
}

/** a page: the toasts over a fake watcher (emit sends one onChange) */
function page(r, o = {}) {
  const puts = [], navs = [], sleeps = [], installed = [];
  const cbs = new Set();
  const builds = { onChange: (cb) => { cbs.add(cb); return () => cbs.delete(cb); } };
  const view = { shown: new Map(), put: (m) => { puts.push(m); view.shown.set(m.id, m); }, drop: (id) => view.shown.delete(id) };
  const t = new U.ReleaseToasts({
    builds, view, fetch: r.fetchFn, base: '/', now: () => NOW, href: () => HREF, navigate: (h) => navs.push(h),
    current: () => o.current ?? 'vail', storage: o.storage === undefined ? store() : o.storage, installed: (s) => installed.push(s),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const off = t.start();
  const emit = async (changes) => { for (const cb of [...cbs]) cb([], changes); await settle(); };
  const final = () => puts.filter((m) => m.kind !== 'downloading');
  return { t, view, puts, navs, sleeps, installed, emit, off, final };
}

// ---------------------------------------------------------------- Published: one download, one toast, Ride
{
  const r = routes({ local: { 'boston-mills': { name: 'Boston Mills', formatVersion: F, status: 'playable' } }, catalog: { resorts: [{ slug: 'boston-mills', name: 'Boston Mills', status: 'playable', pack: { formatVersion: F } }] } });
  const s = store();
  const p = page(r, { storage: s });
  await p.emit([{ build: done('boston-mills', 7, 'published', 0, { prUrl: 'https://github.com/x/pull/9' }), prev: info('boston-mills', 7, 'publishing') }]);
  ok(r.posts() === 1 && r.asked.filter((a) => a.startsWith('GET /__packs/job?slug=boston-mills')).length === 3, `published: one POST /__packs/get and the job followed to done (${r.asked.join(', ')})`);
  const dl = p.puts.filter((m) => m.kind === 'downloading');
  ok(dl.length >= 3 && dl.some((m) => m.detail === 'Downloading 50%') && dl.some((m) => m.detail === 'Unpacking...'), `published: the toast says how the download goes (${dl.map((m) => m.detail).join(' / ')})`);
  const f = p.final();
  ok(f.length === 1 && f[0].kind === 'ready' && f[0].title === 'Boston Mills is ready' && f[0].action?.label === 'Ride' && !f[0].preview && f[0].id === '7', `published: one ready toast with Ride (${JSON.stringify(f.map((m) => [m.kind, m.title]))})`);
  ok(p.installed.join() === 'boston-mills', 'published: the picker hears the pack is in');
  f[0].action.run();
  ok(p.navs.length === 1 && p.navs[0] === 'http://localhost:5173/?pack=boston-mills&account=maintainer', `Ride: the same tab to ?pack=boston-mills, x / y / h dropped (${p.navs[0]})`);
  ok(JSON.parse(s.m.get(U.ANNOUNCED_KEY)).includes(7), 'published: the run id is kept in localStorage');
  // the same run Published again (the watcher saw it change again), and after a reload
  await p.emit([{ build: done('boston-mills', 7, 'published', 0), prev: info('boston-mills', 7, 'publishing') }]);
  await p.emit([{ build: done('boston-mills', 7, 'published', 0, { prUrl: 'other' }), prev: done('boston-mills', 7, 'published', 0) }]);
  ok(r.posts() === 1 && p.final().length === 1, 'same run Published again: nothing');
  const again = page(r, { storage: s });
  await again.emit([{ build: done('boston-mills', 7, 'published', 2) }]);
  ok(r.posts() === 1 && again.puts.length === 0, 'after a reload: the announced run is not announced again');
  p.off(); again.off();
}

// ---------------------------------------------------------------- Preview
{
  const r = routes({ local: { brandywine: { name: 'Brandywine', formatVersion: F, status: 'preview' } } });
  const p = page(r);
  await p.emit([{ build: done('brandywine', 8, 'published'), prev: info('brandywine', 8, 'publishing') }]);
  const f = p.final();
  ok(f.length === 1 && f[0].kind === 'ready' && f[0].preview === true && f[0].action?.label === 'Ride', 'preview: downloads and rides the same, with the Preview flag');
}

// ---------------------------------------------------------------- format mismatch: no Ride
for (const [fv, want] of [[F + 1, /needs a newer game/], [F - 1, /needs rebuild/]]) {
  const problem = fv > F ? `the published snowy pack is format ${fv}, newer than this game's ${F}: update the game (git pull)` : `the published snowy pack is format ${fv}, this game reads ${F}: it needs a rebuild and a new release`;
  const r = routes({ jobs: [[{ phase: 'error', received: 0, total: 0, error: problem }]], catalog: { resorts: [{ slug: 'snowy', name: 'Snowy', status: 'playable', pack: { formatVersion: fv } }] } });
  const p = page(r);
  await p.emit([{ build: done('snowy', 9, 'published'), prev: info('snowy', 9, 'publishing') }]);
  const f = p.final();
  ok(f.length === 1 && f[0].kind === 'blocked' && !f[0].action && want.test(f[0].detail) && p.navs.length === 0 && r.posts() === 1, `format ${fv} (game reads ${F}): "${f[0]?.detail}", no Ride`);
}
{
  // getPack says nothing (a pack in the format somehow): the installed pack's own format still decides
  const r = routes({ local: { odd: { name: 'Odd', formatVersion: F + 1 } } });
  const p = page(r);
  await p.emit([{ build: done('odd', 10, 'published'), prev: info('odd', 10, 'publishing') }]);
  ok(p.final()[0]?.kind === 'blocked' && !p.final()[0]?.action, 'an installed pack in another format: no Ride');
}

// ---------------------------------------------------------------- No change, Failed: a toast, no download, no Ride
{
  const r = routes();
  const p = page(r);
  await p.emit([
    { build: done('vail', 11, 'no-change'), prev: info('vail', 11, 'building', { stage: 'report' }) },
    { build: done('aspen', 12, 'failed', 1, { stage: 'fetch', why: 'failure' }), prev: info('aspen', 12, 'building', { stage: 'fetch' }) },
    { build: done('taos', 13, 'failed', 1, { why: 'pr-closed', prUrl: 'https://github.com/x/pull/4' }), prev: info('taos', 13, 'publishing') },
  ]);
  const [nc, fa, pr] = p.final();
  ok(r.posts() === 0, 'no change and failed: nothing downloads');
  ok(nc?.kind === 'no-change' && nc.title === 'Vail: no change' && !nc.action && nc.link?.href.endsWith('/runs/11'), 'no change: a toast with the run, no Ride');
  ok(fa?.kind === 'failed' && fa.detail === 'Failed at fetch' && !fa.action && fa.link?.href === 'https://github.com/x/runs/12' && fa.link.text === 'The run on GitHub', `failed: a toast with the stage and the run link (${fa?.detail})`);
  ok(pr?.kind === 'failed' && pr.link?.href === 'https://github.com/x/pull/4', 'failed with a closed publish PR: links the PR');
  // an open build, or one still going, says nothing
  await p.emit([{ build: info('copper', 14, 'building', { stage: 'build' }), prev: info('copper', 14, 'queued') }]);
  ok(p.puts.length === 3, 'an open build: no toast');
}

// ---------------------------------------------------------------- a build that ended before the page loaded
{
  const r = routes({ local: { a: { name: 'A', formatVersion: F }, b: { name: 'B', formatVersion: F } } });
  const p = page(r);
  await p.emit([{ build: done('a', 20, 'published', 30) }, { build: done('b', 21, 'published', 90) }, { build: info('c', 22, 'published') }, { build: done('d', 23, 'failed', 10, { stage: 'build', why: 'failure' }) }]);
  const f = p.final();
  ok(r.posts() === 1 && f.length === 2 && f.some((m) => m.id === '20' && m.kind === 'ready') && f.some((m) => m.id === '23' && m.kind === 'failed'), `first sight: announced only when it ended within the hour (30 min: yes, 90 min: no, no doneAt: no) (${f.map((m) => m.id).join()})`);
}

// ---------------------------------------------------------------- a new release of the resort being ridden
{
  const r = routes({ local: { vail: { name: 'Vail', formatVersion: F } } });
  const p = page(r, { current: 'vail' });
  await p.emit([{ build: done('vail', 30, 'published'), prev: info('vail', 30, 'publishing') }]);
  const u = p.final();
  ok(r.posts() === 0 && u.length === 1 && u[0].kind === 'update' && u[0].action?.label === 'Download and ride', 'the resort being ridden: not downloaded under the running game; Download and ride');
  u[0].action.run(); await settle();
  ok(r.posts() === 1 && p.navs[0] === 'http://localhost:5173/?pack=vail&account=maintainer' && p.final().length === 1, `Download and ride: downloads, then reloads into it (${p.navs[0]})`);
}

// ---------------------------------------------------------------- the catalog lags; a download that fails
{
  const r = routes({ jobs: [[{ phase: 'error', received: 0, total: 0, error: 'lag is not in the catalog (published: vail)' }], [{ phase: 'done', received: 1, total: 1 }]], local: { lag: { name: 'Lag', formatVersion: F } } });
  const p = page(r);
  await p.emit([{ build: done('lag', 40, 'published'), prev: info('lag', 40, 'publishing') }]);
  ok(r.posts() === 2 && p.sleeps.includes(U.CATALOG_RETRY_MS) && p.final()[0]?.kind === 'ready' && p.puts.some((m) => m.detail === 'Waiting for the catalog...'), 'not in the catalog yet: asks again 30 s later, then ready');
  const r2 = routes({ jobs: [[{ phase: 'error', received: 0, total: 0, error: 'packs/bad is a pack built on this PC, not one from the catalog: --force replaces it (it is deleted)' }]], catalog: { resorts: [{ slug: 'bad', name: 'Bad', status: 'playable', pack: { formatVersion: F } }] } });
  const q = page(r2);
  await q.emit([{ build: done('bad', 41, 'published'), prev: info('bad', 41, 'publishing') }]);
  const f = q.final();
  ok(r2.posts() === 1 && f[0]?.kind === 'failed' && /built on this PC/.test(f[0].detail) && !f[0].action, `a download that fails: says why, no Ride (${f[0]?.title})`);
  const r3 = routes({ post: Array(9).fill({ status: 400, body: { error: 'catalog: HTTP 403 from https://api.github.com/x' } }) });
  const w = page(r3);
  await w.emit([{ build: done('gone', 42, 'published'), prev: info('gone', 42, 'publishing') }]);
  ok(r3.posts() === U.CATALOG_RETRIES + 1 && w.final()[0]?.kind === 'failed', `a catalog that can't be read: ${U.CATALOG_RETRIES} more tries, then failed`);
}

// ---------------------------------------------------------------- blocked storage: still one toast per build in the page
{
  const r = routes({ local: { s: { name: 'S', formatVersion: F } } });
  const p = page(r, { storage: store(true) });
  await p.emit([{ build: done('s', 50, 'published'), prev: info('s', 50, 'publishing') }]);
  await p.emit([{ build: done('s', 50, 'published'), prev: info('s', 50, 'publishing') }]);
  ok(r.posts() === 1 && p.final().length === 1, 'localStorage that throws: still one download and one toast');
}

// ---------------------------------------------------------------- through the real watcher
{
  let s = { kind: 'signed-in', player: { uid: 'u', playerNumber: 1, displayName: 'D', role: 'maintainer', providers: ['github.com'] } };
  const acct = { available: true, unavailableReason: '', state: () => s, onChange: () => () => {}, ready: async () => s, idToken: async () => 'tok' };
  const answers = [[info('boston-mills', 60, 'publishing')], [done('boston-mills', 60, 'published', 0)]];
  const timers = [];
  const r = routes({ local: { 'boston-mills': { name: 'Boston Mills', formatVersion: F } } });
  const fetchFn = async (url, init) => {
    if (url === '/api/resorts/builds') return new Response(JSON.stringify({ builds: answers.length > 1 ? answers.shift() : answers[0] }), { headers: { 'content-type': 'application/json' } });
    return r.fetchFn(url, init);
  };
  const w = new U.BuildWatch({ account: acct, dev: true, base: '/', fetch: fetchFn, now: () => NOW, setTimer: (f, ms) => { const t = { f, ms }; timers.push(t); return t; }, clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } });
  const puts = [], navs = [];
  const t = new U.ReleaseToasts({ builds: w, view: { put: (m) => puts.push(m), drop() {} }, fetch: fetchFn, base: '/', now: () => NOW, href: () => HREF, navigate: (h) => navs.push(h), storage: null, sleep: async () => {} });
  t.start(); w.start(); await settle();
  ok(r.posts() === 0 && puts.length === 0, 'watcher: Publishing, nothing yet');
  timers.shift().f(); await settle(); await settle();
  const f = puts.filter((m) => m.kind !== 'downloading');
  ok(r.posts() === 1 && f.length === 1 && f[0].kind === 'ready' && f[0].title === 'Boston Mills is ready', 'watcher: Publishing then Published: one download, one ready toast');
  w.stop();
}

console.log(`\npackHref keeps the rest of the URL: ${U.packHref('synth', 'http://h/?pack=vail&cam=eye&x=1#t')}`);
ok(U.packHref('synth', 'http://h/?pack=vail&cam=eye&x=1#t') === 'http://h/?pack=synth&cam=eye#t', 'packHref: pack set, x / y / h dropped, the rest kept');

// ---------------------------------------------------------------- part 2: the toasts in a page
if (!process.argv.includes('--no-page')) {
  const { launchBrowser } = await import('./browser.mjs');
  const iife = path.join(tmp, 'page.js');
  fs.writeFileSync(path.join(tmp, 'page.ts'), `export { ToastStack } from ${src('ReleaseToast.ts')};\n`);
  await build({ entryPoints: [path.join(tmp, 'page.ts')], bundle: true, format: 'iife', globalName: 'RT', platform: 'browser', outfile: iife, logLevel: 'error', define: { 'import.meta.env': '{"BASE_URL":"/"}' } });
  const css = fs.readFileSync(path.join(GAME, 'src', 'ui', 'theme.css'), 'utf8').replace(/@font-face[^}]*}/g, '');
  const browser = await launchBrowser();
  const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.setContent(`<!doctype html><html><head><style>${css}</style></head><body style="margin:0;background:#0b1020">
    <div id="menu" style="display:grid"><button class="primary ride" data-a="ride" style="width:100vw;height:100vh">Ride</button></div></body></html>`);
  await pg.addScriptTag({ content: fs.readFileSync(iife, 'utf8') });
  await pg.evaluate(() => {
    window.ran = [];
    window.stack = new window.RT.ToastStack();
    document.querySelector('#menu button').focus();
    window.stack.put({ id: '7', kind: 'ready', title: 'Boston Mills is ready', preview: true, action: { label: 'Ride', run: () => window.ran.push('ride') } });
  });
  const at = await pg.evaluate(() => {
    const go = document.querySelector('#release-toasts .rt-go');
    const r = go.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: top === go, tab: [...document.querySelectorAll('#release-toasts button, #release-toasts a')].every((b) => b.tabIndex === -1), badge: !!document.querySelector('#release-toasts .rt-title .badge-preview'), x: r.left + r.width / 2, y: r.top + r.height / 2, focus: document.activeElement?.dataset.a };
  });
  ok(at.top, 'page: the toast is over the main menu (the Ride button is what a click there hits)');
  ok(at.tab, 'page: the toast buttons are not tab stops');
  ok(at.badge, 'page: the Preview badge on the ready toast');
  await pg.mouse.click(at.x, at.y);
  const after = await pg.evaluate(() => ({ ran: window.ran.join(), focus: document.activeElement?.dataset.a ?? document.activeElement?.tagName, left: document.querySelectorAll('#release-toasts .rt').length }));
  ok(after.ran === 'ride' && after.left === 0, 'page: clicking Ride runs it, and the toast goes');
  ok(after.focus === 'ride', `page: the click left the focus where it was (${after.focus})`);
  // Space after the click presses what had the focus, not the toast (the ride's keys keep steering)
  await pg.evaluate(() => {
    window.stack.put({ id: '8', kind: 'downloading', title: 'Brandywine is published', detail: 'Downloading 10%' });
    document.querySelector('#menu button').addEventListener('click', () => window.ran.push('menu'));
  });
  const x = await pg.evaluate(() => { const b = document.querySelector('#release-toasts .rt-x').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await pg.mouse.click(x.x, x.y);
  const closed = await pg.evaluate(() => {
    const gone = !document.querySelector('#release-toasts .rt');
    window.stack.put({ id: '8', kind: 'downloading', title: 'Brandywine is published', detail: 'Downloading 40%' });
    const stays = !document.querySelector('#release-toasts .rt');
    window.stack.put({ id: '8', kind: 'ready', title: 'Brandywine is ready', action: { label: 'Ride', run: () => {} } });
    return { gone, stays, back: document.querySelector('#release-toasts .rt')?.dataset.kind };
  });
  ok(closed.gone && closed.stays && closed.back === 'ready', 'page: closed while downloading, it stays closed until it is ready');
  await pg.keyboard.press('Space');
  ok(await pg.evaluate(() => window.ran.join()) === 'ride,menu', 'page: Space after a toast click goes to what had the focus');
  ok(errors.length === 0, `page: no errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await browser.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
