import { isMaintainer, type AccountService } from '../account/Account';

/**
 * FEAT-247 (EPIC-17): the resort builds a maintainer started, and how each is going, from the dev server's
 * GET api/resorts/builds (tools/resort_build_routes.mjs; the states come from tools/build_progress.mjs, over MapPacker's
 * build-pack runs and its publish PRs). Builds keep going on GitHub when the tab closes, so Game.start makes one
 * watcher: it asks on load and then every 15 s while a build is open, with the resort picker open or not, and the
 * picker (ui/ResortPicker.ts) draws from it. FEAT-248 (ui/ReleaseToast.ts) follows its onChange to download a published build.
 *
 * It does nothing, and asks nothing, for a guest or a player, or on a build without the dev server (`npm run host`,
 * the launcher: the route exists only under `npm run dev`, so `dev` is import.meta.env.DEV). A server that answers
 * the route with anything but its JSON (no route) turns it off quietly for the page.
 */
export type BuildState = 'queued' | 'probe' | 'building' | 'publishing' | 'published' | 'no-change' | 'failed';
export type BuildStage = 'queue' | 'probe' | 'resolve' | 'fetch' | 'build' | 'report' | 'publish';
/** one build-pack run (the route's shape). at: when the run started; doneAt: when it ended, a finished state only;
 *  why: a failed run's conclusion (failure, cancelled, timed_out ...) or 'pr-closed' (the publish PR closed unmerged) */
export interface BuildInfo { slug: string; runId: number; url: string; state: BuildState; stage?: BuildStage; why?: string; prUrl?: string; at: string; doneAt?: string }
/** a build seen for the first time this page (prev undefined) or whose state, stage, why or PR changed */
export interface BuildChange { build: BuildInfo; prev?: BuildInfo }

export const BUILD_POLL_MS = 15_000;
/** after a failed request (gh down, offline) the watcher asks again this much later */
export const BUILD_RETRY_MS = 60_000;
/** a Build it just started keeps the watcher asking this long for its run to show up */
export const BUILD_EXPECT_MS = 3 * 60_000;

const OPEN: ReadonlySet<BuildState> = new Set(['queued', 'probe', 'building', 'publishing']);
/** still going: queued, checking data hosts, building or publishing */
export const isOpenBuild = (b: BuildInfo): boolean => OPEN.has(b.state);

/** what the picker says about a build: "Queued", "Building: fetch", "Failed at fetch" ... */
export function buildLabel(b: BuildInfo): string {
  switch (b.state) {
    case 'queued': return 'Queued';
    case 'probe': return 'Checking data hosts';
    case 'building': return `Building: ${b.stage ?? 'resolve'}`;
    case 'publishing': return 'Publishing';
    case 'published': return 'Published';
    case 'no-change': return 'No change';
    case 'failed':
      if (b.why === 'pr-closed') return 'Failed: publish PR closed';
      if (b.why === 'cancelled') return b.stage === 'queue' ? 'Cancelled while queued' : 'Cancelled';
      if (b.stage === 'queue') return 'Failed while queued';
      if (b.stage === 'probe') return 'Failed checking data hosts';
      return b.stage ? `Failed at ${b.stage}` : 'Failed';
  }
}

/** the page a build links to: its publish PR once there is one, else its run */
export function buildLink(b: BuildInfo): { href: string; text: string } {
  return b.prUrl ? { href: b.prUrl, text: 'The publish PR on GitHub' } : { href: b.url, text: 'The run on GitHub' };
}

const same = (a: BuildInfo, b: BuildInfo) => a.state === b.state && a.stage === b.stage && a.why === b.why && a.prUrl === b.prUrl;

export interface BuildWatchOpts {
  account: AccountService;
  /** true where the builds route can exist (the dev server); default import.meta.env.DEV */
  dev?: boolean;
  /** default the page's fetch */
  fetch?: typeof fetch;
  /** default import.meta.env.BASE_URL */
  base?: string;
  every?: number;
  retry?: number;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * The page's build watcher.
 *   start()            begins (idempotent): waits for the account, then asks if it is a maintainer
 *   list() / latest()  what the last answer said (newest first; the newest run of a slug)
 *   onChange(cb)       every answer that changed something: all builds, and what changed
 *   onPublished(cb)    a build seen open on this page that is now Published (once per run)
 *   expect(slug)       Build it just started: ask now, and keep asking until its run shows up
 *   refresh()          ask now (the picker opening)
 */
export class BuildWatch {
  private readonly o: Required<Omit<BuildWatchOpts, 'account' | 'dev' | 'fetch' | 'base'>> & { account: AccountService; dev: boolean; fetch: typeof fetch; base: string };
  private builds: BuildInfo[] = [];
  private byRun = new Map<number, BuildInfo>();
  private changeCbs = new Set<(all: BuildInfo[], changes: BuildChange[]) => void>();
  private publishedCbs = new Set<(b: BuildInfo) => void>();
  /** slug -> when this page started its build (until its run shows up) */
  private expected = new Map<string, number>();
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private gone = false;
  private offAccount: (() => void) | null = null;
  /** bumped on stop and on an account change, so an answer for the old account is dropped */
  private epoch = 0;
  /** the last request's failure, '' when it worked */
  lastError = '';

  constructor(o: BuildWatchOpts) {
    this.o = {
      account: o.account,
      dev: o.dev ?? !!import.meta.env.DEV,
      fetch: o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
      base: o.base ?? import.meta.env.BASE_URL,
      every: o.every ?? BUILD_POLL_MS,
      retry: o.retry ?? BUILD_RETRY_MS,
      now: o.now ?? Date.now,
      setTimer: o.setTimer ?? ((f, ms) => setTimeout(f, ms)),
      clearTimer: o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
    };
  }

  /** a signed-in maintainer on a server that has the route (as far as the page knows) */
  get active(): boolean { return this.started && this.o.dev && !this.gone && isMaintainer(this.o.account.state()); }

  start(): this {
    if (this.started) return this;
    this.started = true;
    if (!this.o.dev) return this;
    this.offAccount = this.o.account.onChange(() => this.accountChanged());
    void this.o.account.ready().then(() => { if (this.started) this.accountChanged(); });
    return this;
  }

  stop(): void {
    this.started = false;
    this.epoch++;
    this.offAccount?.(); this.offAccount = null;
    this.unschedule();
  }

  list(): BuildInfo[] { return this.builds.slice(); }
  /** the newest run of `slug`, if the route listed one */
  latest(slug: string): BuildInfo | undefined { return this.builds.find((b) => b.slug === slug); }

  onChange(cb: (all: BuildInfo[], changes: BuildChange[]) => void): () => void { this.changeCbs.add(cb); return () => { this.changeCbs.delete(cb); }; }
  onPublished(cb: (b: BuildInfo) => void): () => void { this.publishedCbs.add(cb); return () => { this.publishedCbs.delete(cb); }; }

  expect(slug: string): void {
    this.expected.set(slug, this.o.now());
    // a request already out may have left before the build started: ask again once it is in
    void (this.inFlight ?? Promise.resolve()).then(() => this.refresh());
  }

  /** ask now (unless a request is out already); resolves when the answer is in */
  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.unschedule();
    const p = this.ask().finally(() => { if (this.inFlight === p) this.inFlight = null; });
    this.inFlight = p;
    return p;
  }

  private accountChanged(): void {
    this.epoch++;
    this.unschedule();
    this.inFlight = null;
    if (!this.active) {
      // signed out, or not a maintainer: forget what the last account saw
      this.expected.clear();
      if (this.builds.length) this.apply([]);
      return;
    }
    void this.refresh();
  }

  private unschedule(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.unschedule();
    if (!this.active) return;
    this.timer = this.o.setTimer(() => { this.timer = null; void this.refresh(); }, ms);
  }

  private async ask(): Promise<void> {
    const epoch = this.epoch;
    let token: string | null = null;
    try { token = await this.o.account.idToken(); } catch { token = null; }
    if (epoch !== this.epoch || !this.active) return;
    if (!token) return;
    let status = 0;
    let json: { builds?: unknown; error?: string } | null = null;
    try {
      const r = await this.o.fetch(`${this.o.base}api/resorts/builds`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      status = r.status;
      json = (r.headers.get('content-type') ?? '').includes('json') ? await r.json().catch(() => null) : null;
    } catch (e) {
      if (epoch !== this.epoch) return;
      this.lastError = String((e as Error).message ?? e);
      this.schedule(this.o.retry);
      return;
    }
    if (epoch !== this.epoch || !this.active) return;
    if (!json || status === 404 || status === 405) {
      // no builds route on this server (not JSON, or not found): off for the page, quietly
      this.gone = true;
      this.lastError = '';
      return;
    }
    if (status === 401 || status === 403) {
      // the server does not take this session as a maintainer's: wait for the account to change
      this.lastError = json.error ?? `HTTP ${status}`;
      return;
    }
    if (status !== 200 || !Array.isArray(json.builds)) {
      this.lastError = json.error ?? `HTTP ${status}`;
      this.schedule(this.o.retry);
      return;
    }
    this.lastError = '';
    this.apply(json.builds.filter(isBuildInfo));
    // keep asking while a build is open, or a Build it from this page has not shown up yet
    const t = this.o.now();
    for (const [slug, at] of this.expected) {
      const b = this.builds.find((x) => x.slug === slug && Date.parse(x.at) >= at - BUILD_CLOCK_SLACK_MS);
      if (b || t - at > BUILD_EXPECT_MS) this.expected.delete(slug);
    }
    if (this.builds.some(isOpenBuild) || this.expected.size) this.schedule(this.o.every);
  }

  private apply(next: BuildInfo[]): void {
    const changes: BuildChange[] = [];
    const byRun = new Map<number, BuildInfo>();
    for (const b of next) {
      byRun.set(b.runId, b);
      const prev = this.byRun.get(b.runId);
      if (!prev || !same(prev, b)) changes.push(prev ? { build: b, prev } : { build: b });
    }
    const dropped = [...this.byRun.keys()].some((id) => !byRun.has(id));
    this.builds = next.slice();
    this.byRun = byRun;
    if (!changes.length && !dropped) return;
    const all = this.list();
    for (const cb of [...this.changeCbs]) { try { cb(all, changes); } catch (e) { console.error(e); } }
    for (const c of changes) {
      if (c.build.state !== 'published' || !c.prev || c.prev.state === 'published') continue;
      for (const cb of [...this.publishedCbs]) { try { cb(c.build); } catch (e) { console.error(e); } }
    }
  }
}

/** how far GitHub's clock (a run's `at`) may be behind this PC's when matching a Build it to its run */
export const BUILD_CLOCK_SLACK_MS = 2 * 60_000;

const STATES = new Set<string>(['queued', 'probe', 'building', 'publishing', 'published', 'no-change', 'failed']);
function isBuildInfo(x: unknown): x is BuildInfo {
  const b = x as BuildInfo;
  return !!b && typeof b === 'object' && typeof b.slug === 'string' && Number.isInteger(b.runId) && typeof b.url === 'string' && STATES.has(b.state) && typeof b.at === 'string';
}
