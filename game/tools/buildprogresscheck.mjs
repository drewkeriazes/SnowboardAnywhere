// Build progress check (FEAT-247): the build-pack states as a pure function over recorded gh JSON
// (tools/build_progress.mjs, tools/fixtures/build-progress.json: one case per state), the dev server's
// GET /api/resorts/builds (tools/resort_build_routes.mjs) over a fake verifier and a fake gh (the command arrays, the
// 10 s cache, the errors), the page's watcher (src/ui/BuildWatch.ts: who it asks for, when it polls and stops, its
// onChange and onPublished) and the picker's rows (src/ui/ResortPicker.ts shownRows). Both bundled with esbuild. No
// browser, no network, no real gh: nothing here can start a build. Exits 1 on a failure.
//   node tools/buildprogresscheck.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeVerifier } from './accounts/verifier.mjs';
import { buildProgress, runState } from './build_progress.mjs';
import { GAME } from './paths.mjs';
import { BUILDS_CACHE_MS, MAPPACKER_REPO, PR_FIELDS, RUN_FIELDS, resortBuildRoutes } from './resort_build_routes.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const KEYS = ['slug', 'runId', 'state', 'stage', 'why', 'prUrl', 'doneAt'];
const pick = (b) => Object.fromEntries(KEYS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buildprogresscheck-'));
const FIX = JSON.parse(fs.readFileSync(path.join(GAME, 'tools', 'fixtures', 'build-progress.json'), 'utf8'));

// ---------------------------------------------------------------- the states, over the fixtures
const seen = new Set();
for (const c of FIX.cases) {
  const prs = c.prs ?? [...FIX.prs, ...(c.extraPrs ?? [])];
  const got = buildProgress({ runs: c.runs, jobs: c.jobs, prs, now: Date.parse(c.now) });
  const same = JSON.stringify(got.map(pick)) === JSON.stringify(c.expect.map(pick));
  ok(same, `states: ${c.name}`);
  if (!same) console.error('  got ', JSON.stringify(got.map(pick)), '\n  want', JSON.stringify(c.expect.map(pick)));
  for (const b of got) {
    seen.add(b.state);
    if (b.state === 'failed') seen.add(`failed:${b.why === 'cancelled' && b.stage === 'queue' ? 'cancelled-queued' : b.why}`);
    const run = c.runs.find((r) => r.databaseId === b.runId);
    if (run && (b.url !== run.url || b.at !== run.createdAt)) { ok(false, `states: ${c.name}: ${b.slug} carries its run's url and start`); }
  }
}
for (const s of ['queued', 'probe', 'building', 'publishing', 'published', 'no-change', 'failed', 'failed:cancelled-queued', 'failed:pr-closed', 'failed:failure']) ok(seen.has(s), `the fixtures cover ${s}`);
ok(runState({ status: 'completed', conclusion: 'success' }, []).state === 'succeeded', 'runState: a run that succeeded waits on its publish PR');

// ---------------------------------------------------------------- the route, over a fake gh
const T = { 'tok-drew': { uid: 'u-drew', role: 'maintainer', player: 1 }, 'tok-p': { uid: 'u-p', role: 'player', player: null } };
const REC = FIX.cases[0];
const calls = [];
/** what the fake gh answers: by its first two arguments */
let gh = {};
const defaults = () => ({
  'run list': () => ({ code: 0, stdout: JSON.stringify(REC.runs), stderr: '' }),
  'run view': (args) => ({ code: 0, stdout: JSON.stringify({ jobs: REC.jobs[args[2]] ?? [] }), stderr: '' }),
  'pr list': () => ({ code: 0, stdout: JSON.stringify(FIX.prs), stderr: '' }),
  'workflow run': () => ({ code: 0, stdout: '', stderr: '' }),
});
const run = async (cmd, args, opts = {}) => {
  calls.push({ cmd, args: [...args], timeout: opts.timeout });
  const f = gh[`${args[0]} ${args[1]}`];
  return f ? f(args) : { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
};
let now = Date.parse(REC.now);
const routes = resortBuildRoutes({ verifier: fakeVerifier(T), run, env: { SBA_MAPPACKER: tmp }, now: () => now });
const server = http.createServer((req, res) => routes.middleware(req, res, () => { res.statusCode = 404; res.end('next'); }));
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const get = async (token, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/resorts/builds`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, json, headers: r.headers };
};
const post = (body, token = 'tok-drew') => fetch(`http://127.0.0.1:${port}/api/resorts/build`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const kinds = () => calls.map((c) => `${c.args[0]} ${c.args[1]}`);

try {
  gh = defaults();
  ok((await get()).status === 401 && (await get('tok-p')).status === 403 && (await get('tok-drew', { origin: 'https://evil.example' })).status === 403, 'builds: a guest 401, a player 403, a foreign Origin 403');
  ok(calls.length === 0, 'builds: nothing ran for a refused request');
  let r = await get('tok-drew');
  ok(r.status === 200 && JSON.stringify(r.json?.builds?.map(pick)) === JSON.stringify(REC.expect.map(pick)), 'builds: the maintainer gets the recorded runs\' states');
  ok(r.headers.get('cache-control') === 'no-store' && (r.headers.get('content-type') ?? '').includes('json'), 'builds: JSON, no-store');
  const list = calls.find((c) => c.args[1] === 'list' && c.args[0] === 'run');
  ok(list?.cmd === 'gh' && JSON.stringify(list.args) === JSON.stringify(['run', 'list', '--workflow', 'build-pack.yml', '-R', MAPPACKER_REPO, '--created', '>=2026-11-11', '-L', '50', '--json', RUN_FIELDS]), 'builds: gh run list for build-pack.yml in MapPacker, created in the last 2 days, as an argument array');
  const views = calls.filter((c) => c.args[0] === 'run' && c.args[1] === 'view').map((c) => c.args[2]).sort();
  ok(JSON.stringify(views) === JSON.stringify(['43377668210', '43380711559', '43381144237', '43383442356']) && calls.filter((c) => c.args[1] === 'view').every((c) => JSON.stringify(c.args.slice(3)) === JSON.stringify(['-R', MAPPACKER_REPO, '--json', 'jobs'])), 'builds: gh run view <id> --json jobs for the runs not finished and the failed one');
  const pl = calls.find((c) => c.args[0] === 'pr');
  ok(JSON.stringify(pl?.args) === JSON.stringify(['pr', 'list', '-R', MAPPACKER_REPO, '--label', 'publish', '--state', 'all', '-L', '50', '--json', PR_FIELDS]), 'builds: gh pr list --label publish --state all');
  ok(calls.every((c) => c.timeout > 0), 'builds: every gh call has a time limit');
  calls.length = 0;
  await Promise.all([get('tok-drew'), get('tok-drew'), get('tok-drew')]);
  ok(calls.length === 0, 'builds: three tabs inside 10 s cost no gh call');
  now += BUILDS_CACHE_MS;
  await get('tok-drew');
  ok(kinds().filter((k) => k === 'run view').length === 3 && kinds().includes('run list') && kinds().includes('pr list'), 'builds: after 10 s gh is asked again; the failed run\'s jobs are not asked twice (a finished run never changes)');
  calls.length = 0;
  now += BUILDS_CACHE_MS;
  {
    // slow gh: requests while it answers share the one answer
    let release; const gate = new Promise((res) => { release = res; });
    const slow = gh['run list'];
    gh['run list'] = async (a) => { await gate; return slow(a); };
    const p = Promise.all([get('tok-drew'), get('tok-drew')]);
    await new Promise((res) => setTimeout(res, 50));
    release();
    const [a, b] = await p;
    ok(a.status === 200 && b.status === 200 && kinds().filter((k) => k === 'run list').length === 1, 'builds: two requests while gh is answering share one set of gh calls');
    gh['run list'] = slow;
  }
  calls.length = 0;

  // a view failing keeps the run's last jobs
  now += BUILDS_CACHE_MS;
  gh['run view'] = () => ({ code: 1, stdout: '', stderr: 'HTTP 502' });
  r = await get('tok-drew');
  ok(r.status === 200 && r.json.builds.find((b) => b.runId === 43381144237)?.stage === 'build', 'builds: a gh run view that fails keeps the run\'s last jobs');
  gh = defaults(); calls.length = 0;

  // errors
  const fresh = async () => { now += BUILDS_CACHE_MS; calls.length = 0; return get('tok-drew'); };
  gh['run list'] = () => ({ code: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawn gh ENOENT' } });
  r = await fresh();
  ok(r.status === 503 && /gh/.test(r.json?.error), 'builds: no gh: 503');
  gh['run list'] = () => ({ code: 1, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run:  gh auth login\n' });
  r = await fresh();
  ok(r.status === 502 && /gh auth login/.test(r.json?.error), 'builds: gh failing: 502 with its last line');
  gh['run list'] = () => ({ code: 0, stdout: 'not json', stderr: '' });
  r = await fresh();
  ok(r.status === 502 && kinds().length === 1, 'builds: gh run list not answering JSON: 502, nothing more asked');
  gh = defaults();
  gh['pr list'] = () => ({ code: 1, stdout: '', stderr: 'HTTP 403: rate limit\n' });
  r = await fresh();
  ok(r.status === 502 && /rate limit/.test(r.json?.error), 'builds: gh pr list failing: 502');
  gh = defaults();
  r = await fresh();
  ok(r.status === 200, 'builds: works again once gh does');

  // Build it clears the cache; a build that ended can be started again inside the 10 minute gap
  calls.length = 0;
  const BW = { slug: 'brandywine', name: 'Brandywine Ski Resort', osm_id: 'way/391698033' };
  ok((await post(BW)).status === 202, 'build: 202');
  ok((await post(BW)).status === 409, 'build: again at once, the run still going: 409');
  const startedAt = now;
  const failedRun = { conclusion: 'failure', createdAt: new Date(startedAt + 5_000).toISOString(), databaseId: 9999, displayTitle: 'Build pack brandywine', status: 'completed', updatedAt: new Date(startedAt + 60_000).toISOString(), url: 'https://github.com/x/runs/9999' };
  gh['run list'] = () => ({ code: 0, stdout: JSON.stringify([failedRun, ...REC.runs]), stderr: '' });
  gh['run view'] = (args) => ({ code: 0, stdout: JSON.stringify({ jobs: args[2] === '9999' ? [{ name: 'queue', status: 'completed', conclusion: 'success', steps: [] }, { name: 'probe', status: 'completed', conclusion: 'failure', steps: [] }] : REC.jobs[args[2]] ?? [] }), stderr: '' });
  calls.length = 0;
  now += 90_000;
  r = await get('tok-drew');
  ok(kinds().includes('run list') && r.json.builds[0].slug === 'brandywine' && r.json.builds[0].state === 'failed' && r.json.builds[0].stage === 'probe', 'build: the builds cache was dropped by the start (gh asked at once), and shows its failure');
  ok((await post(BW)).status === 202, 'build: Build it again after that build failed, inside 10 minutes: 202');
  gh = defaults();
} finally {
  server.close();
}

// ---------------------------------------------------------------- the watcher and the rows (src/ui)
const out = path.join(tmp, 'ui.mjs');
fs.writeFileSync(path.join(tmp, 'entry.ts'), `export * from ${JSON.stringify(path.join(GAME, 'src', 'ui', 'BuildWatch.ts').replace(/\\/g, '/'))};\nexport { shownRows, noteBuild, resetBuilds } from ${JSON.stringify(path.join(GAME, 'src', 'ui', 'ResortPicker.ts').replace(/\\/g, '/'))};\n`);
await build({ entryPoints: [path.join(tmp, 'entry.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const U = await import(pathToFileURL(out).href);

/** a fake account: guest, player or maintainer, switchable */
function account(kind) {
  let s = kind === 'guest' ? { kind: 'guest' } : { kind: 'signed-in', player: { uid: 'u', playerNumber: 1, displayName: 'D', role: kind, providers: ['github.com'] } };
  const cbs = new Set();
  return {
    available: true, unavailableReason: '',
    state: () => s, onChange: (cb) => { cbs.add(cb); return () => cbs.delete(cb); }, ready: async () => s,
    idToken: async () => (s.kind === 'signed-in' ? 'tok' : null),
    set(k) { s = k === 'guest' ? { kind: 'guest' } : { kind: 'signed-in', player: { uid: 'u', playerNumber: 1, displayName: 'D', role: k, providers: [] } }; for (const cb of cbs) cb(s); },
  };
}
/** a fake page: the route's answers in order, the timers by hand */
function page(acct, answers, o = {}) {
  const asked = [];
  const timers = [];
  const errors = [];
  const fetchFn = async (url, init) => {
    asked.push({ url, auth: init?.headers?.Authorization });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': a.type ?? 'application/json' } });
  };
  const w = new U.BuildWatch({ account: acct, dev: o.dev ?? true, base: '/', fetch: fetchFn, now: () => o.now?.() ?? Date.parse('2026-11-13T07:20:00Z'), setTimer: (f, ms) => { const t = { f, ms }; timers.push(t); return t; }, clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } });
  const tick = async () => { const t = timers.shift(); if (!t) return null; t.f(); await settle(); return t.ms; };
  return { w, asked, timers, tick, errors };
}
const settle = () => new Promise((res) => setTimeout(res, 5));
const info = (slug, runId, state, extra = {}) => ({ slug, runId, url: `https://github.com/x/runs/${runId}`, state, at: '2026-11-13T07:10:00Z', ...extra });
const errs = [];
const origError = console.error;
console.error = (...a) => { if (!String(a[0]).startsWith('FAIL') && !String(a[0]).startsWith('  got')) errs.push(a.join(' ')); origError(...a); };

{
  const g = page(account('guest'), [{ body: { builds: [] } }]);
  g.w.start(); await settle();
  const p = page(account('player'), [{ body: { builds: [] } }]);
  p.w.start(); await settle();
  const h = page(account('maintainer'), [{ body: { builds: [] } }], { dev: false });
  h.w.start(); await settle();
  ok(g.asked.length === 0 && p.asked.length === 0 && h.asked.length === 0 && !g.w.active && !h.w.active, 'watcher: a guest, a player, and a maintainer on a build without the dev server ask nothing');
}
{
  const m = page(account('maintainer'), [{ body: { builds: [info('brandywine', 1, 'queued')] } }]);
  const changes = [];
  m.w.onChange((all, ch) => changes.push(ch.map((c) => `${c.build.slug}:${c.prev?.state ?? '-'}>${c.build.state}`).join(',')));
  m.w.start(); await settle();
  ok(m.asked.length === 1 && m.asked[0].url === '/api/resorts/builds' && m.asked[0].auth === 'Bearer tok', 'watcher: a maintainer on the dev server asks on load, with the Bearer token');
  ok(m.timers.length === 1 && m.timers[0].ms === 15_000, 'watcher: a build open: asks again in 15 s');
  ok(changes[0] === 'brandywine:->queued' && m.w.latest('brandywine')?.state === 'queued', 'watcher: onChange with the first answer (prev none)');
}
{
  const acct = account('maintainer');
  const answers = [
    { body: { builds: [info('brandywine', 1, 'queued')] } },
    { body: { builds: [info('brandywine', 1, 'building', { stage: 'fetch' })] } },
    { body: { builds: [info('brandywine', 1, 'building', { stage: 'fetch' })] } },
    { body: { builds: [info('brandywine', 1, 'publishing', { prUrl: 'https://github.com/x/pull/9' })] } },
    { body: { builds: [info('brandywine', 1, 'published', { prUrl: 'https://github.com/x/pull/9', doneAt: '2026-11-13T07:30:00Z' })] } },
  ];
  const m = page(acct, answers);
  const changes = []; const published = [];
  m.w.onChange((all, ch) => changes.push(ch.map((c) => `${c.prev?.state ?? '-'}>${c.build.state}${c.build.stage ? `:${c.build.stage}` : ''}`).join(',')));
  m.w.onPublished((b) => published.push(b.slug));
  m.w.start(); await settle();
  await m.tick(); await m.tick(); await m.tick();
  ok(published.length === 0, 'watcher: no Published before it is');
  await m.tick();
  ok(JSON.stringify(changes) === JSON.stringify(['->queued', 'queued>building:fetch', 'building>publishing', 'publishing>published']), 'watcher: onChange only when a state or stage changes, with the previous one');
  ok(JSON.stringify(published) === '["brandywine"]', 'watcher: onPublished once, when an open build turns Published');
  ok(m.timers.length === 0 && m.asked.length === 5, 'watcher: no build open: it stops asking');
  m.w.expect('snowy-peak'); await settle();
  ok(m.asked.length === 6 && m.timers.length === 1, 'watcher: expect(slug) asks at once and keeps asking until its run shows up');
}
{
  const m = page(account('maintainer'), [{ body: { builds: [info('vail', 2, 'published', { prUrl: 'p', doneAt: '2026-11-13T07:15:00Z' })] } }]);
  const published = [];
  m.w.onPublished((b) => published.push(b.slug));
  m.w.start(); await settle();
  ok(published.length === 0 && m.w.latest('vail')?.state === 'published' && m.timers.length === 0, 'watcher: a build already Published on load is listed (onChange) but not onPublished, and nothing polls');
}
{
  const html = page(account('maintainer'), [{ body: '<!doctype html><html></html>', type: 'text/html' }]);
  html.w.start(); await settle();
  const nf = page(account('maintainer'), [{ status: 404, body: 'Not found', type: 'text/plain' }]);
  nf.w.start(); await settle();
  await html.w.refresh(); await nf.w.refresh();
  ok(html.asked.length === 1 && nf.asked.length === 1 && !html.w.active && !nf.w.active && html.timers.length === 0, 'watcher: a server without the route (HTML or 404) turns it off for the page, no polling');
}
{
  const m = page(account('maintainer'), [{ status: 502, body: { error: 'gh: HTTP 502' } }, { body: { builds: [] } }]);
  m.w.start(); await settle();
  ok(m.w.lastError === 'gh: HTTP 502' && m.timers.length === 1 && m.timers[0].ms === 60_000, 'watcher: a route failure: lastError, and asks again in a minute');
  await m.tick();
  ok(m.w.lastError === '' && m.timers.length === 0, 'watcher: and settles once it works');
  const n = page(account('maintainer'), [new TypeError('Failed to fetch')]);
  n.w.start(); await settle();
  ok(n.timers.length === 1 && n.timers[0].ms === 60_000, 'watcher: offline: asks again in a minute');
}
{
  const acct = account('maintainer');
  const m = page(acct, [{ body: { builds: [info('brandywine', 1, 'building', { stage: 'fetch' })] } }]);
  let last = null;
  m.w.onChange((all) => { last = all; });
  m.w.start(); await settle();
  acct.set('guest'); await settle();
  ok(m.timers.length === 0 && last?.length === 0 && m.w.list().length === 0, 'watcher: signing out stops it and forgets the builds');
  acct.set('maintainer'); await settle();
  ok(m.asked.length === 2 && m.timers.length === 1, 'watcher: signing back in as the maintainer asks again');
  m.w.stop();
  ok(m.timers.length === 0, 'watcher: stop() clears its timer');
}
ok(errs.length === 0, `watcher: nothing logged an error (${errs.length})`);
console.error = origError;

// labels and links
const L = (state, extra) => U.buildLabel(info('x', 1, state, extra));
ok(L('queued') === 'Queued' && L('probe') === 'Checking data hosts' && L('building', { stage: 'fetch' }) === 'Building: fetch' && L('publishing') === 'Publishing' && L('published') === 'Published' && L('no-change') === 'No change', 'labels: Queued, Checking data hosts, Building: fetch, Publishing, Published, No change');
ok(L('failed', { stage: 'fetch', why: 'failure' }) === 'Failed at fetch' && L('failed', { stage: 'queue', why: 'cancelled' }) === 'Cancelled while queued' && L('failed', { why: 'pr-closed' }) === 'Failed: publish PR closed' && L('failed', { stage: 'probe', why: 'failure' }) === 'Failed checking data hosts', 'labels: Failed at a stage, cancelled while queued, the PR closed, the data hosts');
ok(U.buildLink(info('x', 1, 'building')).href === 'https://github.com/x/runs/1' && U.buildLink(info('x', 1, 'publishing', { prUrl: 'https://github.com/x/pull/3' })).href === 'https://github.com/x/pull/3', 'links: the run, then the publish PR once there is one');

// the picker's rows
{
  const base = [
    { slug: 'vail', name: 'Vail', note: 'here now', act: 'load', on: true },
    { slug: 'boston-mills', name: 'Boston Mills', note: 'Download (80 MB)', act: 'get', on: false },
  ];
  const m = (slug, name) => ({ openskidata_id: slug, osm_id: 'way/1', name, region: 'Ohio', country: 'US', runs: 9, lifts: 9, status: 'operating', slug, configured: false });
  const show = (q, found, progress) => U.shownRows(base, q, found, progress).map((x) => `${x.slug}:${x.act}:${x.note}${x.build ? `[${x.build.label}|${x.build.href}]` : ''}`);
  U.resetBuilds();
  let rows = show('', null, [info('vail', 5, 'building', { stage: 'report' })]);
  ok(rows[0] === 'vail:load:here now[Building: report|https://github.com/x/runs/5]', 'rows: a rebuilt resort keeps Ride and shows its build and link');
  rows = show('', null, [info('heavenly', 6, 'queued')]);
  ok(rows.at(-1) === 'heavenly:none:Queued[Queued|https://github.com/x/runs/6]' && U.shownRows(base, '', null, [info('heavenly', 6, 'queued')]).at(-1).name === 'Heavenly', 'rows: a build the page did not start (the tab was closed) shows again, named from its slug');
  ok(show('zzz', null, [info('heavenly', 6, 'queued')]).at(-1).startsWith('heavenly:'), 'rows: and stays whatever the query');
  rows = show('brandy', [m('brandywine', 'Brandywine')], [info('brandywine', 7, 'publishing', { prUrl: 'https://github.com/x/pull/9' })]);
  ok(rows.at(-1) === 'brandywine:none:Publishing[Publishing|https://github.com/x/pull/9]', 'rows: a search match being built shows its state and the publish PR');
  rows = show('brandy', [m('brandywine', 'Brandywine')], [info('brandywine', 7, 'failed', { stage: 'fetch', why: 'failure' })]);
  ok(rows.at(-1) === 'brandywine:build:Failed at fetch. Build it again[Failed at fetch|https://github.com/x/runs/7]', 'rows: a failed build of a match can be built again');
  ok(show('', null, [info('heavenly', 6, 'failed', { why: 'cancelled', stage: 'queue' })]).at(-1).startsWith('heavenly:none:'), 'rows: a failed build the page has no match for cannot be clicked (nothing to build from)');
  // a Build it newer than the server's latest run of the slug: Build started until its run shows up
  U.noteBuild(m('brandywine', 'Brandywine'), 'started', Date.parse('2026-11-13T07:30:00Z'));
  rows = show('', null, [info('brandywine', 7, 'failed', { stage: 'fetch', why: 'failure' })]);
  ok(rows.at(-1) === 'brandywine:none:Build started', 'rows: Build started wins over an older run of the slug');
  rows = show('', null, [info('brandywine', 8, 'queued', { at: '2026-11-13T07:29:30Z' }), info('brandywine', 7, 'failed', { stage: 'fetch', why: 'failure' })]);
  ok(rows.at(-1) === 'brandywine:none:Queued[Queued|https://github.com/x/runs/8]', 'rows: and gives way to its run once listed (the newest of the slug, inside the clock slack)');
  U.resetBuilds();
  ok(show('', null, [info('boston-mills', 9, 'no-change', { doneAt: 'x' })])[1] === 'boston-mills:get:Download (80 MB)[No change|https://github.com/x/runs/9]', 'rows: a Download row shows No change');
}

fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`${fails} buildprogresscheck failure(s)`); process.exit(1); }
console.log('buildprogresscheck: all ok');
