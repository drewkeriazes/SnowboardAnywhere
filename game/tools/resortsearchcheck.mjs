// Resort search check (FEAT-246): the dev server's GET /api/resorts/search and POST /api/resorts/build
// (tools/resort_build_routes.mjs) over a fake verifier and a fake runner standing in for Python and gh, so no check
// ever starts a real build-pack run (a run from Drew's gh is a trusted publish that merges itself). Then the real
// runner (execFile, no shell) on node itself, the MapPacker path rule, and the picker's pure row logic
// (src/ui/ResortPicker.ts, bundled with esbuild). No browser, no network, no Firebase. Exits 1 on a failure.
//   node tools/resortsearchcheck.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeVerifier } from './accounts/verifier.mjs';
import { GAME } from './paths.mjs';
import { MAPPACKER_REPO, buildInputError, execRun, mainCheckout, mapPackerDir, queryError, resortBuildRoutes } from './resort_build_routes.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };

const T = {
  'tok-drew': { uid: 'u-drew', role: 'maintainer', player: 1 },
  'tok-p': { uid: 'u-p', role: 'player', player: null },
  'tok-odd': { uid: 'bad uid with spaces', role: 'maintainer', player: null },
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resortsearchcheck-'));
const mp = path.join(tmp, 'MapPacker');
fs.mkdirSync(path.join(mp, 'pipeline'), { recursive: true });
fs.writeFileSync(path.join(mp, 'pipeline', 'resort.py'), '# stand-in: the fake runner answers for it\n');

const SEARCH = { query: 'boston', matches: [{ openskidata_id: 'bm', osm_id: 'way/452323654', name: 'Boston Mills Ski Resort', region: 'Ohio', country: 'US', lat: 41.26, lon: -81.56, runs: 7, lifts: 7, status: 'operating', slug: 'boston-mills', configured: true, sold_with: null }], skipped: 1, closest: [] };
/** what the fake runner was asked, and what it answers next */
const calls = [];
let answer = () => ({ code: 0, stdout: JSON.stringify(SEARCH), stderr: '' });
const run = async (cmd, args, opts = {}) => { calls.push({ cmd, args: [...args], cwd: opts.cwd, timeout: opts.timeout }); return answer(cmd, args); };
let now = 1_000_000;
const env = { SBA_MAPPACKER: mp };
const routes = resortBuildRoutes({ verifier: fakeVerifier(T), run, env, now: () => now });
const server = http.createServer((req, res) => routes.middleware(req, res, () => { res.statusCode = 404; res.end('next'); }));
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function req(method, p, { token, body, headers = {} } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, json, text, headers: r.headers };
}
const ghArgs = (c) => c.args;
const BM = { slug: 'brandywine', name: 'Brandywine Ski Resort', osm_id: 'way/391698033' };

try {
  // ---------------------------------------------------------------- the gate: guest 401, player 403, Origin 403
  ok((await req('GET', '/api/resorts/search?q=boston')).status === 401, 'search as a guest: 401');
  ok((await req('POST', '/api/resorts/build', { body: BM })).status === 401, 'build as a guest: 401');
  ok((await req('POST', '/api/resorts/build', { body: BM, headers: { cookie: 'token=tok-drew; session=tok-drew' } })).status === 401, 'a cookie is not a credential: 401');
  ok((await req('GET', '/api/resorts/search?q=boston', { token: 'tok-p' })).status === 403, 'search as a player: 403');
  ok((await req('POST', '/api/resorts/build', { token: 'tok-p', body: BM })).status === 403, 'build as a player: 403');
  ok((await req('GET', '/api/resorts/search?q=boston', { token: 'tok-nope' })).status === 401, 'an unknown token: 401');
  ok((await req('POST', '/api/resorts/build', { token: 'tok-drew', body: BM, headers: { origin: 'https://evil.example' } })).status === 403, 'build with a foreign Origin and a maintainer token: 403');
  ok((await req('GET', '/api/resorts/search?q=boston', { token: 'tok-drew', headers: { origin: 'http://rebind.example:5173' } })).status === 403, 'search with a foreign Origin: 403');
  ok(calls.length === 0, 'nothing ran for a refused request');

  // ---------------------------------------------------------------- search
  let r = await req('GET', `/api/resorts/search?q=${encodeURIComponent('boston "mills"; rm -rf / && echo $HOME')}`, { token: 'tok-drew' });
  const c = calls.shift();
  ok(r.status === 200 && JSON.stringify(r.json) === JSON.stringify(SEARCH), 'the maintainer\'s search: 200, resort.py\'s JSON passed through');
  ok(c?.cmd === 'python' && c.cwd === mp && c.timeout > 0, 'search runs python in the MapPacker clone, with a time limit');
  ok(JSON.stringify(c?.args) === JSON.stringify([path.join('pipeline', 'resort.py'), 'search', '--json', '--', 'boston "mills"; rm -rf / && echo $HOME']), 'the query reaches Python as one argument, after --');
  ok(r.headers.get('cache-control') === 'no-store' && (r.headers.get('content-type') ?? '').includes('json'), 'the search reply is JSON, no-store');
  await req('GET', '/api/resorts/search?q=-rf', { token: 'tok-drew' });
  ok(calls.shift()?.args.at(-1) === '-rf', 'a query that looks like a flag is still the one argument after --');
  for (const q of ['', 'bo', '  b  ', 'x'.repeat(101), 'bos%00ton']) {
    const rr = await req('GET', `/api/resorts/search?q=${q}`, { token: 'tok-drew' });
    ok(rr.status === 400 && calls.length === 0, `search refuses ${JSON.stringify(q.slice(0, 12))} before any run: 400 (${rr.json?.error})`);
  }
  answer = () => ({ code: 1, stdout: '', stderr: 'Traceback...\nsearch: cannot read the OpenSkiData ski areas index: offline\n' });
  r = await req('GET', '/api/resorts/search?q=boston', { token: 'tok-drew' }); calls.length = 0;
  ok(r.status === 502 && r.json?.error === 'search: cannot read the OpenSkiData ski areas index: offline', 'resort.py failing: 502 with its last stderr line');
  answer = () => ({ code: 2, stdout: '', stderr: "usage: resort.py [-h] {resolve,plan,compare,add} ...\nresort.py: error: argument cmd: invalid choice: 'search' (choose from resolve, plan, compare, add)\n" });
  r = await req('GET', '/api/resorts/search?q=boston', { token: 'tok-drew' }); calls.length = 0;
  ok(r.status === 502 && r.json?.error === `The MapPacker clone at ${mp} has no resort search yet: pull its main.`, 'a clone with no search command (older than FEAT-279): 502 naming the clone and the pull (BUG-119)');
  answer = () => ({ code: 0, stdout: 'usage: resort.py [-h] {resolve,plan,compare,add} ...', stderr: '' });
  r = await req('GET', '/api/resorts/search?q=boston', { token: 'tok-drew' }); calls.length = 0;
  ok(r.status === 502 && /FEAT-279/.test(r.json?.error), 'an answer that is not the search JSON (a clone older than FEAT-279): 502');
  answer = () => ({ code: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawn python ENOENT' } });
  r = await req('GET', '/api/resorts/search?q=boston', { token: 'tok-drew' }); calls.length = 0;
  ok(r.status === 503 && /Python/.test(r.json?.error), 'no Python: 503 with a one-line reason');
  answer = () => ({ code: null, stdout: '', stderr: '', error: { message: 'killed', killed: true } });
  r = await req('GET', '/api/resorts/search?q=boston', { token: 'tok-drew' }); calls.length = 0;
  ok(r.status === 504, 'a search over the time limit: 504');
  {
    const noClone = resortBuildRoutes({ verifier: fakeVerifier(T), run, env: { SBA_MAPPACKER: path.join(tmp, 'nowhere') } });
    const s2 = http.createServer((q, s) => noClone.middleware(q, s, () => { s.statusCode = 404; s.end(); }));
    const p2 = await new Promise((resolve) => s2.listen(0, '127.0.0.1', () => resolve(s2.address().port)));
    const rr = await fetch(`http://127.0.0.1:${p2}/api/resorts/search?q=boston`, { headers: { authorization: 'Bearer tok-drew' } });
    const j = await rr.json();
    ok(rr.status === 503 && /SBA_MAPPACKER/.test(j.error) && !j.error.includes('nowhere') && calls.length === 0, 'no MapPacker clone: 503 naming SBA_MAPPACKER (not the path), nothing run');
    s2.close();
  }

  // ---------------------------------------------------------------- build
  answer = () => ({ code: 0, stdout: '', stderr: '' });
  r = await req('POST', '/api/resorts/build', { token: 'tok-drew', body: { ...BM, requested_by: 'someone-else', ref: 'evil' } });
  const g = calls.shift();
  ok(r.status === 202 && r.json?.slug === 'brandywine', 'Build it as the maintainer: 202 {slug}');
  ok(g?.cmd === 'gh' && JSON.stringify(ghArgs(g)) === JSON.stringify(['workflow', 'run', 'build-pack.yml', '-R', MAPPACKER_REPO, '-f', 'slug=brandywine', '-f', 'name=Brandywine Ski Resort', '-f', 'osm_id=way/391698033', '-f', 'requested_by=u-drew']), 'gh workflow run build-pack.yml with the inputs as one array (-f, raw strings)');
  ok(ghArgs(g).filter((a) => a.startsWith('requested_by=')).join() === 'requested_by=u-drew', 'requested_by is the verified uid, not the body\'s');
  ok(g?.timeout > 0, 'gh runs with a time limit');
  r = await req('POST', '/api/resorts/build', { token: 'tok-drew', body: BM });
  ok(r.status === 409 && calls.length === 0, 'a second Build it of the same slug at once: 409, no second run');
  now += 11 * 60_000;
  r = await req('POST', '/api/resorts/build', { token: 'tok-drew', body: BM }); calls.length = 0;
  ok(r.status === 202, 'the same slug again after the gap: 202');
  const bad = [
    [{ ...BM, slug: 'Brandywine' }, 'an upper-case slug'], [{ ...BM, slug: 'brandy--wine' }, 'a double hyphen'], [{ ...BM, slug: 'a'.repeat(61) }, 'a slug over 60'],
    [{ ...BM, slug: '../vail' }, 'a path'], [{ ...BM, osm_id: 'node/1' }, 'a node id'], [{ ...BM, osm_id: 'way/0' }, 'way/0'], [{ ...BM, osm_id: '1; gh repo delete' }, 'an osm id with a command'],
    [{ ...BM, osm_id: '' }, 'no osm id'], [{ ...BM, name: '--help' }, 'a name that starts with -'], [{ ...BM, name: 'a\nb' }, 'a name with a newline'],
    [{ ...BM, name: 'x'.repeat(101) }, 'a name over 100'], [{ ...BM, name: ' ' }, 'a blank name'], [{ ...BM, slug: 5 }, 'a number for the slug'], [{ slug: 'brandywine' }, 'no name or osm id'],
    [[BM], 'an array'], ['not json', 'a body that is not JSON'],
  ];
  for (const [body, what] of bad) {
    const rr = await req('POST', '/api/resorts/build', { token: 'tok-drew', body: typeof body === 'string' ? body : body, headers: typeof body === 'string' ? { 'content-type': 'application/json' } : {} });
    ok(rr.status === 400 && calls.length === 0, `build refuses ${what} before any run: 400`);
  }
  ok((await req('POST', '/api/resorts/build', { token: 'tok-drew', body: JSON.stringify({ ...BM, name: 'x'.repeat(5000) }) })).status === 413 && calls.length === 0, 'a body over 4 KB: 413, nothing run');
  r = await req('POST', '/api/resorts/build', { token: 'tok-odd', body: { ...BM, slug: 'odd' } });
  ok(r.status === 500 && calls.length === 0, 'an account id build-pack would refuse: 500, nothing run');
  answer = () => ({ code: 1, stdout: '', stderr: 'could not create workflow dispatch event: HTTP 422: Unexpected inputs provided\n' });
  r = await req('POST', '/api/resorts/build', { token: 'tok-drew', body: { ...BM, slug: 'snowy-peak' } }); calls.length = 0;
  ok(r.status === 502 && /HTTP 422/.test(r.json?.error), 'gh failing: 502 with its error');
  answer = () => ({ code: 0, stdout: '', stderr: '' });
  r = await req('POST', '/api/resorts/build', { token: 'tok-drew', body: { ...BM, slug: 'snowy-peak' } }); calls.length = 0;
  ok(r.status === 202, 'after a failed start the same slug can be tried again at once');
  answer = () => ({ code: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawn gh ENOENT' } });
  r = await req('POST', '/api/resorts/build', { token: 'tok-drew', body: { ...BM, slug: 'no-gh' } }); calls.length = 0;
  ok(r.status === 503 && /gh/.test(r.json?.error), 'no gh: 503');
  ok((await req('GET', '/api/resorts/build', { token: 'tok-drew' })).status === 405 && (await req('POST', '/api/resorts/search?q=boston', { token: 'tok-drew' })).status === 405, 'the wrong method: 405');
  ok((await req('GET', '/api/other')).text === 'next', 'any other URL goes on to next()');

  // ---------------------------------------------------------------- the pure checks and the real runner
  ok(buildInputError({ slug: ' brandywine ', name: ' Brandywine ', osm_id: ' 391698033 ' }) === null && buildInputError({ ...BM, osm_id: 'relation/22' }) === null, 'buildInputError: trimmed, a bare way number and a relation pass');
  ok(queryError('bos') === null && queryError('bo') !== null && queryError(null) !== null, 'queryError: 3 characters at least');
  {
    const e = await execRun(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a b; echo "c" && d | e']);
    ok(e.code === 0 && e.stdout === 'a b; echo "c" && d | e', 'execRun: an argument with shell characters arrives as is (no shell)');
    const n = await execRun(path.join(tmp, 'no-such-program'), []);
    ok(n.code === null && n.error?.code === 'ENOENT', 'execRun: a missing program is ENOENT, not a throw');
    const k = await execRun(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 200 });
    ok(k.error?.killed === true, 'execRun: the time limit kills the command');
  }
  {
    const main = path.join(tmp, 'git', 'SnowboardAnywhere');
    const wt = path.join(tmp, 'git', 'wt566');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt566'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt566')}\n`);
    ok(mainCheckout(wt) === main && mainCheckout(main) === main, 'mainCheckout: a worktree\'s main checkout, and the main checkout itself');
    ok(mapPackerDir({}, wt) === path.join(tmp, 'git', 'MapPacker-SnowboardAnywhere'), 'no SBA_MAPPACKER: MapPacker-SnowboardAnywhere next to the main checkout');
    ok(mapPackerDir({ SBA_MAPPACKER: mp }, wt) === mp && mapPackerDir({ SBA_MAPPACKER: '  ' }, wt) !== '  ', 'SBA_MAPPACKER wins; a blank one does not');
  }
  ok(typeof routes.route === 'function' && typeof routes.ctx.run === 'function' && routes.ctx.mapPacker() === mp, 'the factory hands out route() and ctx (run, mapPacker) for FEAT-247');

  // ---------------------------------------------------------------- the picker's rows (src/ui/ResortPicker.ts)
  const out = path.join(tmp, 'picker.mjs');
  await build({ entryPoints: [path.join(GAME, 'src', 'ui', 'ResortPicker.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
  const P = await import(pathToFileURL(out).href);
  const base = [
    { slug: 'vail', name: 'Vail', note: 'here now', act: 'load', on: true },
    { slug: 'boston-mills', name: 'Boston Mills', note: 'Download (80 MB)', act: 'get', on: false },
    { slug: 'solden', name: 'Sölden', note: '', act: 'load', on: false },
  ];
  const m = (slug, name) => ({ openskidata_id: slug, osm_id: 'way/1', name, region: 'Ohio', country: 'US', runs: 9, lifts: 9, status: 'operating', slug, configured: false });
  const show = (q, found) => P.shownRows(base, q, found).map((x) => `${x.slug}:${x.act}:${x.note}`).join(' | ');
  ok(show('', null) === 'vail:load:here now | boston-mills:get:Download (80 MB) | solden:load:', 'no query: every row, as before');
  ok(show('bost', null) === 'boston-mills:get:Download (80 MB)' && show('SOLDEN', null) === 'solden:load:' && show('mills boston', null) === 'boston-mills:get:Download (80 MB)', 'the filter: by name, any case, no accents, words in any order');
  ok(show('boston', [m('boston-mills', 'Boston Mills Ski Resort'), m('brandywine', 'Brandywine Ski Resort')]) === 'boston-mills:get:Download (80 MB) | brandywine:build:Build it', 'a match already in the catalog keeps its Download; a new one gets Build it');
  ok(P.shownRows(base, 'boston', [m('brandywine', 'Brandywine Ski Resort')]).at(-1).detail === 'Ohio, US, 9 runs, 9 lifts', 'a match shows its region and country, runs and lifts');
  ok(show('vail', [m('vail', 'Vail')]) === 'vail:load:here now', 'a match for a built pack is not offered to build');
  P.noteBuild(m('brandywine', 'Brandywine Ski Resort'), 'started');
  ok(show('zzz', null).endsWith('brandywine:none:Build started'), 'a started build stays in the list, Build started, and cannot be clicked again');
  P.noteBuild(m('brandywine', 'Brandywine Ski Resort'), 'failed');
  ok(show('', null).endsWith('brandywine:build:Build failed'), 'a failed start can be tried again');
  P.resetBuilds();
  ok(show('', null) === 'vail:load:here now | boston-mills:get:Download (80 MB) | solden:load:', 'resetBuilds clears the session\'s builds');
  ok(P.nameMatches('mont trem', 'Mont Tremblant') && !P.nameMatches('vail x', 'Vail'), 'nameMatches: every word, as a prefix or part');
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (fails) { console.error(`${fails} resortsearchcheck failure(s)`); process.exit(1); }
console.log('resortsearchcheck: all ok');
