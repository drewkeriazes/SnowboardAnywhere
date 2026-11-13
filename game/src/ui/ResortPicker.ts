import { PACK_FORMAT } from '../pack/format';
import { isMaintainer, type AccountService } from '../account/Account';
import { BUILD_CLOCK_SLACK_MS, buildLabel, buildLink, isOpenBuild, type BuildInfo, type BuildWatch } from './BuildWatch';

/**
 * FEAT-222: the "Change resort" panel's list. Built packs first (as before), then what the resorts repo's
 * catalog adds: a published resort that is not on disk shows "Download (size)", a pack from an older format
 * "needs rebuild". The catalog and the download go through the dev or host server (vite.config.ts /__packs/*,
 * tools/get_pack.mjs); on a server without them (or offline) the list is just the built packs.
 *
 * FEAT-246: a "Find a resort" field over the list filters those rows by name, for everyone, on every server. For a
 * signed-in maintainer, a query of 3 or more characters also asks the dev server (GET api/resorts/search, MapPacker's
 * `resort.py search --json`, tools/resort_build_routes.mjs) after a 300 ms pause, and adds the ski areas neither the
 * built packs nor the catalog have (by slug), each with Build it (POST api/resorts/build, which starts MapPacker's
 * build-pack workflow). A guest, a player, or a server without the routes (`npm run host`, the launcher) sees the
 * filtered list only, with no Build it and no error.
 *
 * FEAT-247: how each build is going (ui/BuildWatch.ts, the dev server's GET api/resorts/builds) shows on the resort's
 * row, the Build it row or the Ride / Download row of a rebuilt resort, with a link to its run or publish PR: Queued,
 * Checking data hosts, Building: <stage>, Publishing, Published, No change or Failed. The watcher asks every 15 s while
 * a build is open; the panel redraws from it while it is open. A build started before the page loaded (the tab was
 * closed) shows again, named from its slug.
 */
interface CatalogEntry { slug: string; name: string; status: string; pack: { version: number; formatVersion: number; bytes: number } }
interface LocalPack { name: string; formatVersion: number; version?: number }
interface CatalogReply { formatVersion: number; catalog: { resorts?: CatalogEntry[] } | null; local: Record<string, LocalPack> }
interface Job { phase: 'download' | 'unzip' | 'done' | 'error'; received: number; total: number; error?: string }
/** one match of `resort.py search --json` (MapPacker FEAT-279) */
export interface SearchMatch { openskidata_id: string; osm_id: string; name: string; region: string | null; country: string | null; runs: number; lifts: number; status: string | null; slug: string; configured: boolean; sold_with?: string | null }
interface SearchReply { query: string; matches: SearchMatch[]; skipped?: number; closest?: string[] }

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const mb = (b: number) => `${Math.max(1, Math.round(b / 1e6))} MB`;
const api = (p: string) => `${import.meta.env.BASE_URL}__packs/${p}`;
const resortsApi = (p: string) => `${import.meta.env.BASE_URL}api/resorts/${p}`;
export const SEARCH_MIN = 3;
export const SEARCH_PAUSE_MS = 300;

/** a build's line on its row: what it is doing, and the run or publish PR it links to */
export interface RowBuild { label: string; href: string; link: string; kind: 'open' | 'done' | 'failed' }
export type Row = { slug: string; name: string; note: string; act: 'load' | 'get' | 'none' | 'build'; on: boolean; detail?: string; build?: RowBuild };

/** lower case, no accents: "Sölden" finds "solden" */
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** every word of the query is in the name (or the slug) */
export function nameMatches(query: string, name: string, slug = ''): boolean {
  const hay = `${fold(name)} ${slug}`;
  return fold(query).split(/[^a-z0-9]+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * Build it started this session, by slug (at: when, on this PC's clock): the row keeps saying so when the panel
 * reopens, until the watcher lists the build's run (FEAT-247), and a second click does nothing (the dev server
 * refuses a repeat too).
 */
const builds = new Map<string, { match: SearchMatch; state: 'starting' | 'started' | 'failed'; why?: string; at: number }>();

function rowHtml(r: Row): string {
  const head = `<button class="course${r.on ? ' on' : ''}" data-pack="${esc(r.slug)}" data-act="${r.act}"${r.act === 'none' ? ' disabled' : ''}${r.build ? ` data-build="${r.build.kind}"` : ''}><span class="cn">${esc(r.name)}</span>`;
  // FEAT-247: the run or publish PR, on its own line under the row (a link can't go inside a button)
  const link = r.build ? `<a class="build-link" data-nav href="${esc(r.build.href)}" target="_blank" rel="noopener noreferrer">${esc(r.build.link)}</a>` : '';
  // a search match or a build: its place and size (when known), then Build it or how the build is going
  if (r.detail !== undefined) return `${head}<span class="cl">${esc(r.detail)}</span><span class="cb">${esc(r.note)}</span></button>${link}`;
  // a built or catalog resort: Ride / Download as before, and how its rebuild is going
  return `${head}<span class="cl">${esc(r.note)}</span>${r.build ? `<span class="cb">${esc(r.build.label)}</span>` : ''}</button>${link}`;
}

function rows(current: string, built: { slug: string; name: string }[], reply: CatalogReply | null): Row[] {
  const local = reply?.local ?? {};
  const cat = reply?.catalog?.resorts ?? [];
  const out: Row[] = [];
  const localNote = (slug: string): Pick<Row, 'note' | 'act'> => {
    const l = local[slug], c = cat.find((e) => e.slug === slug && e.pack.formatVersion === PACK_FORMAT);
    if (slug === current) return { note: 'here now', act: 'load' };
    // BUG-106: `version` means the pack came from the catalog (it carries .catalog.json), so get_pack replaces it
    // on its own, also when it is an older format. A pack built on this PC or copied in with --from has no version:
    // get_pack replaces it only with --force, so an old one says "needs rebuild".
    if (l?.version && c && (l.formatVersion < PACK_FORMAT || c.pack.version > l.version)) return { note: `Update (${mb(c.pack.bytes)})`, act: 'get' };
    if (l && l.formatVersion < PACK_FORMAT) return { note: 'needs rebuild', act: 'load' };
    return { note: '', act: 'load' };
  };
  for (const r of built) out.push({ ...r, ...localNote(r.slug), on: r.slug === current });
  // a resort downloaded from the catalog that the game's own list (resorts.ts) doesn't know yet
  for (const c of cat) if (local[c.slug] && !built.some((b) => b.slug === c.slug)) out.push({ slug: c.slug, name: c.name, ...localNote(c.slug), on: c.slug === current });
  for (const c of cat) {
    if (local[c.slug]) continue;
    const f = c.pack.formatVersion;
    const note = f < PACK_FORMAT ? 'needs rebuild' : f > PACK_FORMAT ? 'needs a newer game' : `Download (${mb(c.pack.bytes)}${c.status === 'preview' ? ', preview' : ''})`;
    out.push({ slug: c.slug, name: c.name, note, act: f === PACK_FORMAT ? 'get' : 'none', on: false });
  }
  return out;
}

/** "Ohio, US, 9 runs, 9 lifts" */
function matchDetail(m: SearchMatch): string {
  return [[m.region, m.country].filter(Boolean).join(', '), `${m.runs} runs, ${m.lifts} lifts`].filter(Boolean).join(', ');
}

/** a build's line on its row (FEAT-247) */
export function rowBuild(b: BuildInfo): RowBuild {
  const l = buildLink(b);
  return { label: buildLabel(b), href: l.href, link: l.text, kind: isOpenBuild(b) ? 'open' : b.state === 'failed' ? 'failed' : 'done' };
}

/** "boston-mills" -> "Boston Mills", for a build whose resort the page knows only by its slug */
const slugName = (slug: string) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** the server's build of `slug` when it is this resort's latest: not older than a Build it this page started */
function liveBuild(slug: string, srv: BuildInfo | undefined): BuildInfo | undefined {
  const b = builds.get(slug);
  if (!srv || !b) return srv;
  // a Build it newer than the server's latest run: its run has not shown up yet, or its start failed
  return b.state !== 'starting' && Date.parse(srv.at) >= b.at - BUILD_CLOCK_SLACK_MS ? srv : undefined;
}

/** a resort to build: a search match, a Build it this session, or a build the watcher lists (srv) */
function buildRow(slug: string, m: SearchMatch | undefined, srv: BuildInfo | undefined): Row {
  const b = builds.get(slug);
  const name = m?.name ?? slugName(slug);
  const detail = m ? matchDetail(m) : '';
  const live = liveBuild(slug, srv);
  if (live) {
    const build = rowBuild(live);
    // a failed build can be tried again when the page has the match to build from
    const again = live.state === 'failed' && !!m;
    return { slug, name, detail, note: again ? `${build.label}. Build it again` : build.label, act: again ? 'build' : 'none', on: false, build };
  }
  const note = !b ? 'Build it' : b.state === 'starting' ? 'Starting...' : b.state === 'started' ? 'Build started' : 'Build failed';
  return { slug, name, detail, note, act: (!b || b.state === 'failed') && m ? 'build' : 'none', on: false };
}

/** the newest build of each slug */
function newestBuilds(progress: BuildInfo[]): Map<string, BuildInfo> {
  const out = new Map<string, BuildInfo>();
  for (const b of progress) {
    const o = out.get(b.slug);
    if (!o || Date.parse(b.at) > Date.parse(o.at)) out.set(b.slug, b);
  }
  return out;
}

/**
 * The rows the list shows: the built and catalog rows whose name matches `query` (all of them for an empty query),
 * then the search matches whose slug none of those rows have (each with Build it), then any Build it started this
 * session and any build the watcher lists (`progress`, FEAT-247) that is not listed already, whatever the query.
 * A row whose resort has a build says how it is going. Pure apart from the session's builds:
 * tools/resortsearchcheck.mjs and tools/buildprogresscheck.mjs run it.
 */
export function shownRows(base: Row[], query: string, found: SearchMatch[] | null, progress: BuildInfo[] = []): Row[] {
  const q = query.trim();
  const srv = newestBuilds(progress);
  const withBuild = (r: Row): Row => { const b = liveBuild(r.slug, srv.get(r.slug)); return b ? { ...r, build: rowBuild(b) } : r; };
  const out = (q ? base.filter((r) => nameMatches(q, r.name, r.slug)) : base.slice()).map(withBuild);
  const have = new Set(base.map((r) => r.slug));
  for (const m of found ?? []) {
    if (have.has(m.slug)) continue;
    have.add(m.slug);
    out.push(buildRow(m.slug, m, srv.get(m.slug)));
  }
  for (const b of builds.values()) if (!have.has(b.match.slug)) { have.add(b.match.slug); out.push(buildRow(b.match.slug, b.match, srv.get(b.match.slug))); }
  for (const b of srv.values()) if (!have.has(b.slug)) { have.add(b.slug); out.push(buildRow(b.slug, undefined, b)); }
  return out;
}

/** for the checks: forget the session's builds */
export function resetBuilds(): void { builds.clear(); }
/** for the checks: mark a build as this session's (at: when it started, default now) */
export function noteBuild(m: SearchMatch, state: 'starting' | 'started' | 'failed', at = Date.now()): void { builds.set(m.slug, { match: m, state, at }); }

export interface PickerOpts {
  /** runs once the catalog has been drawn or has failed (no download routes, offline), so a caller can say what
   *  the list means (BUG-105's first-run screen) */
  settled?: () => void;
  /** FEAT-246: the player's account; a signed-in maintainer gets the search and Build it */
  account?: AccountService;
  /** FEAT-247: the page's build watcher; the rows show how each build is going */
  builds?: BuildWatch;
}

/**
 * Fill the panel, then add the catalog's resorts when the server answers. `go(slug)` loads a built resort.
 * The host holds a `.courses` element; the Find a resort field goes just above it.
 */
export function fillResortPicker(host: HTMLElement, current: string, built: { slug: string; name: string }[], go: (slug: string) => void, close: () => void, opts: PickerOpts = {}): void {
  const list = () => host.querySelector<HTMLElement>('.courses')!;
  const { account, settled, builds: watch } = opts;
  let reply: CatalogReply | null = null;
  const token = String(Date.now() + Math.random());
  host.dataset.picker = token;
  const live = () => host.dataset.picker === token && !host.hidden && host.isConnected;

  // the Find a resort field and its one-line note, over the list
  host.querySelector('.find-row')?.remove();
  const findRow = document.createElement('div');
  findRow.className = 'find-row';
  findRow.innerHTML = '<input type="search" class="find" placeholder="Find a resort" aria-label="Find a resort" autocomplete="off" spellcheck="false" maxlength="100"><p class="find-note dim" hidden></p>';
  list().before(findRow);
  const input = findRow.querySelector<HTMLInputElement>('input.find')!;
  const findNote = findRow.querySelector<HTMLElement>('.find-note')!;
  const say = (t: string) => { findNote.textContent = t; findNote.hidden = !t; };

  let found: SearchMatch[] | null = null;
  let foundFor = '';
  const draw = () => {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('button[data-pack]')?.dataset.pack;
    const q = input.value.trim();
    list().innerHTML = shownRows(rows(current, built, reply), q, foundFor === q ? found : null, watch?.list() ?? []).map(rowHtml).join('');
    list().querySelectorAll<HTMLButtonElement>('button[data-pack]').forEach((b) => b.addEventListener('click', () => {
      const slug = b.dataset.pack!;
      if (b.dataset.act === 'build') { void build(slug); return; }
      if (b.dataset.act === 'get') { download(b, slug); return; }
      if (slug === current) close(); else go(slug);
    }));
    for (const [slug, b] of builds) if (b.why) list().querySelector(`button[data-pack="${CSS.escape(slug)}"]`)?.setAttribute('title', b.why);
    if (focused) list().querySelector<HTMLElement>(`button[data-pack="${CSS.escape(focused)}"]`)?.focus();
  };

  // ---------------------------------------------------------------- search (a signed-in maintainer on the dev server)
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | null = null;
  let seq = 0;
  const canSearch = () => !!account && isMaintainer(account.state());
  const stop = () => { clearTimeout(timer); seq++; inFlight?.abort(); inFlight = null; };
  const search = async (q: string) => {
    stop();
    const mine = seq;
    const ctl = new AbortController();
    inFlight = ctl;
    const auth = await account!.idToken();
    if (mine !== seq || !live()) return;
    if (!auth || !canSearch()) { say(''); return; }
    say('Searching OpenSkiData...');
    try {
      const r = await fetch(`${resortsApi('search')}?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${auth}` }, cache: 'no-store', signal: ctl.signal });
      const json = (r.headers.get('content-type') ?? '').includes('json') ? await r.json().catch(() => null) as (SearchReply & { error?: string }) | null : null;
      if (mine !== seq || !live()) return;
      if (!r.ok || !json || !Array.isArray(json.matches)) {
        // no search route here (npm run host, the launcher: not JSON, or a 404), or the session was refused: the
        // filtered list only. The route's own failure (no MapPacker clone, no Python) says why in one line.
        say(json?.error && r.status >= 500 ? `Search is unavailable: ${json.error}` : '');
        return;
      }
      found = json.matches; foundFor = q;
      const listed = new Set(rows(current, built, reply).map((x) => x.slug));
      say(found.length === 0 ? `No ski area by that name.${json.closest?.length ? ` Closest: ${json.closest.join(', ')}` : ''}`
        : found.every((m) => listed.has(m.slug)) ? 'Every match is in the list already.' : '');
      draw();
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && mine === seq) say('');
    }
  };
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q !== foundFor) { found = null; foundFor = ''; }
    draw();
    stop();
    if (!canSearch() || q.length < SEARCH_MIN) { say(''); return; }
    timer = setTimeout(() => { if (live()) void search(q); }, SEARCH_PAUSE_MS);
  });
  // signed out (or in) while the panel is open: the search results follow the account
  const unsub = account?.onChange(() => {
    if (!live()) { unsub?.(); return; }
    if (!canSearch()) { stop(); found = null; foundFor = ''; say(''); draw(); }
    else if (input.value.trim().length >= SEARCH_MIN) void search(input.value.trim());
  });

  const build = async (slug: string) => {
    const m = (found ?? []).find((x) => x.slug === slug) ?? builds.get(slug)?.match;
    // only a row whose act is build calls this: Build it, Build failed, or a failed run to try again
    if (!m || !account || builds.get(slug)?.state === 'starting') return;
    const at = Date.now();
    builds.set(slug, { match: m, state: 'starting', at });
    draw();
    const done = (state: 'started' | 'failed', why?: string) => { builds.set(slug, { match: m, state, why, at }); if (live()) draw(); };
    try {
      const auth = await account.idToken();
      if (!auth || !isMaintainer(account.state())) { done('failed', 'Sign in as a maintainer first.'); return; }
      const r = await fetch(resortsApi('build'), { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ slug: m.slug, name: m.name, osm_id: m.osm_id }), cache: 'no-store' });
      const j = await r.json().catch(() => ({})) as { error?: string };
      // 409: this server started that build a moment ago
      if (r.status === 202 || r.status === 409) { done('started'); watch?.expect(slug); }
      else done('failed', j.error ?? `HTTP ${r.status}`);
    } catch (e) { done('failed', String((e as Error).message ?? e)); }
  };

  const download = async (b: HTMLButtonElement, slug: string) => {
    if (b.dataset.busy) return;
    b.dataset.busy = '1';
    const note = b.querySelector<HTMLElement>('.cl')!;
    const fail = (why: string) => { note.textContent = 'Download failed'; b.title = why; delete b.dataset.busy; };
    note.textContent = 'Starting...';
    try {
      const r = await fetch(api('get'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug }) });
      if (!r.ok) { fail(((await r.json().catch(() => ({}))) as Job).error ?? `HTTP ${r.status}`); return; }
      for (;;) {
        await new Promise((res) => setTimeout(res, 500));
        // the panel closed or reopened: stop watching (the server keeps downloading; reopening shows it again)
        if (host.dataset.picker !== token || host.hidden) return;
        const jr = await fetch(api(`job?slug=${slug}`), { cache: 'no-store' });
        const j = await jr.json().catch(() => ({})) as Job;
        if (!jr.ok) { fail(j.error ?? `HTTP ${jr.status}`); return; } // 404: the server restarted and lost the job
        if (j.phase === 'error') { fail(j.error ?? 'unknown error'); return; }
        if (j.phase === 'done') { note.textContent = 'Ready'; go(slug); return; }
        note.textContent = j.phase === 'unzip' ? 'Unpacking...' : j.total ? `Downloading ${Math.floor((j.received / j.total) * 100)}%` : 'Downloading...';
      }
    } catch (e) { fail(String((e as Error).message ?? e)); }
  };
  const loadCatalog = () => fetch(api('catalog'), { cache: 'no-store' })
    .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() as Promise<CatalogReply> : null))
    .then((j) => { if (j && live() && list()) { reply = j; draw(); } })
    .catch(() => { /* no download endpoint here (a static host) or offline: built packs only */ });

  // FEAT-247: redraw as the builds move on while the panel is open. A build just published is in the catalog (or
  // soon: its CDN can lag), so ask for the catalog again.
  if (watch) {
    const off = watch.onChange((_all, changes) => {
      if (!live()) { off(); return; }
      draw();
      if (changes.some((c) => c.build.state === 'published' && c.prev && c.prev.state !== 'published')) void loadCatalog();
    });
    void watch.refresh();
  }
  draw();
  void loadCatalog().then(() => settled?.());
}
