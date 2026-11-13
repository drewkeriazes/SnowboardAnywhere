// FEAT-246 (EPIC-17): the resort picker's Find a resort and Build it, dev server only (vite.config.ts accountRoutes,
// configureServer; never `npm run host`, never the launcher). Both routes are for a signed-in maintainer: each is
// wrapped in requireAccount(verifier, handler, { role: 'maintainer' }) (tools/accounts/gate.mjs: a foreign Origin
// 403, no Bearer token 401, a player 403). Only the Bearer token counts: no cookie or other ambient credential is
// ever read, which is what keeps a DNS-rebinding page out (FEAT-273 review).
//   GET  /api/resorts/search?q=<name>   runs `python pipeline/resort.py search --json -- <q>` in the MapPacker clone
//                                       (FEAT-279) and passes its JSON through; 503 with a one-line reason when the
//                                       clone or Python is missing
//   POST /api/resorts/build {slug, name, osm_id}
//                                       checks each against the shapes build-pack accepts (MapPacker
//                                       tools/ci/build_pack_ci.py), then runs `gh workflow run build-pack.yml -R
//                                       <MapPacker> -f slug= -f name= -f osm_id= -f requested_by=<the verified uid>`;
//                                       202 {slug}, 400 before any run on a bad input, 502 with gh's error; 409
//                                       when this server started that slug in the last 10 minutes, unless the
//                                       builds route has since seen that build end (FEAT-247: Build it again)
// Every command goes through `run(cmd, args, opts)`, execFile with an argument array (never a shell string) and a
// time limit; the checks (tools/resortsearchcheck.mjs) pass a fake one, so no check ever starts a real build. A run
// from Drew's gh is a trusted publish that merges itself.
//
//   GET  /api/resorts/builds            (FEAT-247) the build-pack runs worth showing, as {builds: BuildInfo[]}
//                                       (tools/build_progress.mjs: the states and the windows), from `gh run list`,
//                                       `gh run view <id> --json jobs` for the runs not finished and `gh pr list
//                                       --label publish`; cached 10 s, so several tabs polling cost no more gh calls
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { requireAccount } from './accounts/gate.mjs';
import { REPO } from './paths.mjs';
import { DONE_WINDOW_MS, OPEN_WINDOW_MS, buildProgress, runSlug } from './build_progress.mjs';

export const MAPPACKER_REPO = 'drewkeriazes/MapPacker-SnowboardAnywhere';
export const BUILD_WORKFLOW = 'build-pack.yml';

// the shapes MapPacker's tools/ci/build_pack_ci.py check_inputs accepts (FEAT-245); the workflow checks again
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const OSM_RE = /^((way|relation)\/)?[1-9][0-9]{0,15}$/;
export const REQUESTED_BY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
export const MAX_SLUG = 60;
export const MAX_NAME = 100;
export const MIN_QUERY = 3;
export const MAX_QUERY = 100;
// the first search downloads OpenSkiData's ski areas index (about 21 MB) when the cache has none
export const SEARCH_TIMEOUT_MS = 90_000;
export const GH_TIMEOUT_MS = 60_000;
// a second Build it for the same slug this soon is refused (409): a double click must not queue two builds
export const REBUILD_GAP_MS = 10 * 60_000;
// FEAT-247: one answer of the builds route serves every request for this long
export const BUILDS_CACHE_MS = 10_000;
/** the fields the builds route asks gh for */
export const RUN_FIELDS = 'databaseId,displayTitle,status,conclusion,createdAt,updatedAt,url';
export const PR_FIELDS = 'number,url,state,headRefName,createdAt,mergedAt,closedAt';

/** @typedef {{ code: number | null; stdout: string; stderr: string; error?: { code?: string; message: string; killed?: boolean } }} RunResult
 *  code is the exit code (null when it never ran or was killed); error is set when it could not start (ENOENT: not
 *  installed) or hit the time limit (killed) */
/** @typedef {(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> }) => Promise<RunResult>} Runner */

/** The real runner: execFile, never a shell, with a time limit; resolves (never rejects) with what happened.
 *  @type {Runner} */
export function execRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 60_000, env: opts.env ?? process.env, windowsHide: true, maxBuffer: 16 << 20, encoding: 'utf8', shell: false },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const e = /** @type {NodeJS.ErrnoException & { killed?: boolean }} */ (err);
        resolve({ code: typeof e.code === 'number' ? e.code : null, stdout: stdout ?? '', stderr: stderr ?? '', error: { code: typeof e.code === 'string' ? e.code : undefined, message: e.message, killed: !!e.killed } });
      });
  });
}

/** The game's main checkout: the folder that holds the shared .git (a worktree's `.git` is a file naming
 *  <main>/.git/worktrees/<name>), else `repo` itself.
 *  @param {string} [repo] @returns {string} */
export function mainCheckout(repo = REPO) {
  try {
    const dotgit = path.join(repo, '.git');
    if (fs.statSync(dotgit).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
      const w = m && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(path.resolve(repo, m[1]));
      if (w) return w[1];
    }
  } catch { /* no .git: not a checkout */ }
  return repo;
}

/** The MapPacker clone: SBA_MAPPACKER (game/.env.local or the environment), else MapPacker-SnowboardAnywhere next to
 *  the game's main checkout.
 *  @param {Record<string, string | undefined>} [env] @param {string} [repo] @returns {string} */
export function mapPackerDir(env = process.env, repo = REPO) {
  const p = env.SBA_MAPPACKER;
  return p && p.trim() !== '' ? path.resolve(p.trim()) : path.join(path.dirname(mainCheckout(repo)), 'MapPacker-SnowboardAnywhere');
}

/** null when a Build it body is one build-pack accepts, else why not (a 400). Only strings, trimmed as the workflow
 *  trims them. @param {unknown} b @returns {string | null} */
export function buildInputError(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'the body is not a JSON object';
  const { slug, name, osm_id: osm } = /** @type {Record<string, unknown>} */ (b);
  if (typeof slug !== 'string' || typeof name !== 'string' || typeof osm !== 'string') return 'slug, name and osm_id are strings';
  const s = slug.trim(), n = name.trim(), o = osm.trim();
  if (!SLUG_RE.test(s) || s.length > MAX_SLUG) return `slug is not lower-case letters, digits and single hyphens (at most ${MAX_SLUG})`;
  if (!n || n.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(n) || n.startsWith('-')) return `name is empty, longer than ${MAX_NAME} characters, has control characters or starts with -`;
  if (!OSM_RE.test(o)) return 'osm_id is not an OSM id (123, way/123 or relation/123)';
  return null;
}

/** null when a search query can go to Python, else why not. @param {string | null} q @returns {string | null} */
export function queryError(q) {
  const t = (q ?? '').trim();
  if (t.length < MIN_QUERY) return `type at least ${MIN_QUERY} characters`;
  if (t.length > MAX_QUERY) return `at most ${MAX_QUERY} characters`;
  if (/[\u0000-\u001f\u007f]/.test(t)) return 'the query has control characters';
  return null;
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
export function reply(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** the last non-empty line of a command's error output, short enough for a reply */
const lastLine = (/** @type {string} */ t) => (t.trim().split(/\r?\n/).filter((l) => l.trim()).pop() ?? '').trim().slice(0, 300);

/** the body as text, or null when it is over `limit` bytes (the rest is read and dropped, so the reply still goes)
 *  @param {import('node:http').IncomingMessage} req @param {number} limit @returns {Promise<string | null>} */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The resort routes, as one Connect-style middleware.
 * @param {{ verifier: import('./accounts/verifier.mjs').TokenVerifier; run?: Runner; env?: Record<string, string | undefined>; repo?: string; now?: () => number }} o
 *   verifier: devVerifier() on the dev server, fakeVerifier in the checks; run: execRun, or a fake in the checks;
 *   env: read at each request (SBA_MAPPACKER, SBA_PYTHON), so game/.env.local loaded after this is made still counts
 * @returns {{ middleware: (req: any, res: any, next: (err?: unknown) => void) => void; route: (method: string, pathname: string, handler: (req: any, res: any, account: import('./accounts/verifier.mjs').VerifiedAccount, url: URL) => unknown) => void; ctx: { run: Runner; env: Record<string, string | undefined>; mapPacker: () => string; python: () => string; gh: (args: string[], opts?: { timeout?: number }) => Promise<RunResult>; reply: typeof reply; now: () => number; builds: () => Promise<{ status: number; body: unknown }>; forgetBuilds: () => void } }}
 */
export function resortBuildRoutes(o) {
  const run = o.run ?? execRun;
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const ctx = {
    run, env, reply, now,
    mapPacker: () => mapPackerDir(env, o.repo),
    python: () => (env.SBA_PYTHON && env.SBA_PYTHON.trim()) || 'python',
    /** gh against the MapPacker repo's Actions; the caller adds -R where the command takes it */
    gh: (/** @type {string[]} */ args, opts = {}) => run('gh', args, { timeout: opts.timeout ?? GH_TIMEOUT_MS, env }),
    /** FEAT-247: the builds route's answer, shared for BUILDS_CACHE_MS */
    builds: () => sharedBuilds(),
    /** a build was just started: the next builds request asks gh again */
    forgetBuilds: () => { cached = null; },
  };
  /** @type {{ t: number; p: Promise<{ status: number; body: unknown }> } | null} the builds answer every request shares */
  let cached = null;
  /** @type {import('./build_progress.mjs').BuildInfo[]} the builds in the last answer that worked */
  let lastBuilds = [];
  /** the build of `slug` this server started at `t` has ended (failed, or published nothing): it can be tried again
   *  inside REBUILD_GAP_MS. The run's start is GitHub's clock, so a 2 minute slack. */
  const endedSince = (/** @type {string} */ slug, /** @type {number} */ t) => lastBuilds.some((b) => b.slug === slug && Date.parse(b.at) >= t - 120_000 && (b.state === 'failed' || b.state === 'no-change' || b.state === 'published'));
  /** @type {Map<string, ReturnType<typeof requireAccount>>} "<METHOD> <path>" -> gated handler */
  const table = new Map();
  const paths = new Set();
  const route = (/** @type {string} */ method, /** @type {string} */ pathname, /** @type {any} */ handler) => {
    paths.add(pathname);
    table.set(`${method} ${pathname}`, requireAccount(o.verifier, (req, res, account) => handler(req, res, account, new URL(req.url ?? '/', 'http://x')), { role: 'maintainer' }));
  };

  route('GET', '/api/resorts/search', async (req, res, account, url) => {
    const q = url.searchParams.get('q');
    const bad = queryError(q);
    if (bad) return reply(res, 400, { error: bad });
    const dir = ctx.mapPacker();
    if (!fs.existsSync(path.join(dir, 'pipeline', 'resort.py'))) {
      console.warn(`[resorts] no MapPacker clone at ${dir} (set SBA_MAPPACKER in game/.env.local)`);
      return reply(res, 503, { error: 'resort search needs the MapPacker clone: set SBA_MAPPACKER in game/.env.local' });
    }
    // the query is one argument, after --, so it is never read as a flag
    const r = await run(ctx.python(), [path.join('pipeline', 'resort.py'), 'search', '--json', '--', q.trim()], { cwd: dir, timeout: SEARCH_TIMEOUT_MS, env });
    if (r.error?.code === 'ENOENT') return reply(res, 503, { error: `resort search needs Python: ${ctx.python()} was not found (set SBA_PYTHON)` });
    if (r.error?.killed) return reply(res, 504, { error: `resort search took more than ${SEARCH_TIMEOUT_MS / 1000} s` });
    // BUG-119: a clone from before FEAT-279 has no search command, and argparse says so in its own words
    if (r.code !== 0 && /invalid choice: 'search'/.test(r.stderr)) return reply(res, 502, { error: `The MapPacker clone at ${dir} has no resort search yet: pull its main.` });
    if (r.code !== 0) return reply(res, 502, { error: lastLine(r.stderr) || `resort.py search exited ${r.code}` });
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.matches)) return reply(res, 502, { error: 'resort.py search did not answer JSON (is the MapPacker clone older than FEAT-279?)' });
    return reply(res, 200, r.stdout.trim());
  });

  /** slug -> when its build was started from this server */
  const started = new Map();
  route('POST', '/api/resorts/build', async (req, res, account) => {
    const text = await readBody(req, 4096);
    if (text === null) return reply(res, 413, { error: 'the body is over 4 KB' });
    let body;
    try { body = JSON.parse(text); } catch { return reply(res, 400, { error: 'the body is not JSON' }); }
    const bad = buildInputError(body);
    if (bad) return reply(res, 400, { error: bad });
    // requested_by is always the verified account, never the body
    if (!REQUESTED_BY_RE.test(account.uid)) return reply(res, 500, { error: 'this account id is not one build-pack accepts' });
    const slug = body.slug.trim(), name = body.name.trim(), osm = body.osm_id.trim();
    const t = started.get(slug);
    if (t !== undefined && now() - t < REBUILD_GAP_MS && !endedSince(slug, t)) return reply(res, 409, { error: `a build of ${slug} was started ${Math.round((now() - t) / 1000)} s ago` });
    started.set(slug, now());
    const r = await ctx.gh(['workflow', 'run', BUILD_WORKFLOW, '-R', MAPPACKER_REPO, '-f', `slug=${slug}`, '-f', `name=${name}`, '-f', `osm_id=${osm}`, '-f', `requested_by=${account.uid}`]);
    if (r.code === 0) {
      console.log(`[resorts] build-pack started for ${slug} (${osm}), requested by ${account.uid}`);
      ctx.forgetBuilds();
      return reply(res, 202, { slug });
    }
    started.delete(slug);
    if (r.error?.code === 'ENOENT') return reply(res, 503, { error: 'Build it needs the GitHub CLI (gh) on this PC, signed in' });
    return reply(res, 502, { error: lastLine(r.stderr) || r.error?.message || `gh exited ${r.code}` });
  });

  // ---------------------------------------------------------------- FEAT-247: the builds and how they are going
  /** @type {Map<number, { jobs: unknown[]; final: boolean }>} run id -> its jobs: the last good answer for a run
   *  still going, and once for a finished one (final: they never change again) */
  const jobsSeen = new Map();
  const loadBuilds = async () => {
    const t = now();
    const since = new Date(t - OPEN_WINDOW_MS).toISOString().slice(0, 10);
    const fail = (/** @type {RunResult} */ r, /** @type {string} */ what) => r.error?.code === 'ENOENT'
      ? { status: 503, body: { error: 'build progress needs the GitHub CLI (gh) on this PC, signed in' } }
      : { status: 502, body: { error: lastLine(r.stderr) || r.error?.message || `${what} exited ${r.code}` } };
    const rl = await ctx.gh(['run', 'list', '--workflow', BUILD_WORKFLOW, '-R', MAPPACKER_REPO, '--created', `>=${since}`, '-L', '50', '--json', RUN_FIELDS]);
    if (rl.code !== 0) return fail(rl, 'gh run list');
    let runs;
    try { runs = JSON.parse(rl.stdout); } catch { runs = null; }
    if (!Array.isArray(runs)) return { status: 502, body: { error: 'gh run list did not answer a JSON list' } };
    // the jobs of every run not finished, and once each of a finished run that did not succeed (where it stopped)
    const want = runs.filter((r) => runSlug(r) && Number.isInteger(r.databaseId) && t - Date.parse(r.createdAt) <= OPEN_WINDOW_MS
      && (r.status !== 'completed' || (r.conclusion !== 'success' && !jobsSeen.get(r.databaseId)?.final && t - Date.parse(r.updatedAt ?? r.createdAt) <= DONE_WINDOW_MS)));
    // a view that fails keeps the run's last good jobs (or none: a running run then reads queued)
    const view = async (/** @type {any} */ r) => {
      const v = await ctx.gh(['run', 'view', String(r.databaseId), '-R', MAPPACKER_REPO, '--json', 'jobs']);
      let j = null;
      try { j = v.code === 0 ? JSON.parse(v.stdout).jobs : null; } catch { j = null; }
      if (Array.isArray(j)) jobsSeen.set(r.databaseId, { jobs: j, final: r.status === 'completed' });
    };
    // the PRs after the runs, so a run that finished between the two calls already has its PR
    const [, pl] = await Promise.all([
      Promise.all(want.map(view)),
      ctx.gh(['pr', 'list', '-R', MAPPACKER_REPO, '--label', 'publish', '--state', 'all', '-L', '50', '--json', PR_FIELDS]),
    ]);
    if (pl.code !== 0) return fail(pl, 'gh pr list');
    let prs;
    try { prs = JSON.parse(pl.stdout); } catch { prs = null; }
    if (!Array.isArray(prs)) return { status: 502, body: { error: 'gh pr list did not answer a JSON list' } };
    // forget the jobs of runs gh no longer lists
    const listed = new Set(runs.map((r) => r.databaseId));
    for (const id of jobsSeen.keys()) if (!listed.has(id)) jobsSeen.delete(id);
    lastBuilds = buildProgress({ runs, jobs: Object.fromEntries([...jobsSeen].map(([id, v]) => [id, v.jobs])), prs, now: t });
    return { status: 200, body: { builds: lastBuilds, checkedAt: new Date(t).toISOString() } };
  };
  /** the shared answer, at most BUILDS_CACHE_MS old; a request while gh is still answering waits for the same one */
  const sharedBuilds = () => {
    if (!cached || now() - cached.t >= BUILDS_CACHE_MS) {
      const p = loadBuilds().catch((e) => ({ status: 500, body: { error: String(e?.message ?? e) } }));
      cached = { t: now(), p };
      // the time counts from the answer, so a slow gh does not make the next request ask again at once
      p.then(() => { if (cached?.p === p) cached.t = now(); });
    }
    return cached.p;
  };
  route('GET', '/api/resorts/builds', async (req, res) => {
    const r = await ctx.builds();
    return reply(res, r.status, r.body);
  });

  const middleware = (/** @type {any} */ req, /** @type {any} */ res, /** @type {(err?: unknown) => void} */ next) => {
    const pathname = (req.url ?? '').split('?')[0];
    const h = table.get(`${req.method} ${pathname}`);
    if (h) return h(req, res, next);
    if (paths.has(pathname)) return reply(res, 405, { error: `${req.method} is not allowed here` });
    next();
  };
  return { middleware, route, ctx };
}
