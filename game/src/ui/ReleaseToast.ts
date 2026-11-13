import { PACK_FORMAT } from '../pack/format';
import { buildLabel, buildLink, type BuildChange, type BuildInfo, type BuildWatch } from './BuildWatch';
import { PREVIEW_BADGE, slugName } from './ResortPicker';

/**
 * FEAT-248 (EPIC-17): when a maintainer's resort build is published, the pack downloads on its own and a toast says
 * it is ready, with Ride. Ride is the same-tab reload to `?pack=<slug>` that Change resort does (no swap mid-ride:
 * FEAT-280), so the rider starts at the resort's start and memory starts clean.
 *
 * The builds come from FEAT-247's watcher (ui/BuildWatch.ts: a signed-in maintainer on the dev server, nothing for
 * anyone else). The download is the picker's (FEAT-222): POST __packs/get {slug}, which reads the catalog afresh
 * (BUG-096) so it installs the release just published, then GET __packs/job?slug= until it is unpacked. A pack whose
 * formatVersion is not this game's PACK_FORMAT is not installed: the toast says it needs a newer game or a rebuild,
 * and has no Ride. A `preview` pack (did not pass the DATA-022 gate) downloads and rides the same, with a Preview badge.
 *
 * One toast per build: a No change or Failed build gets one too (no Ride; Failed links its run or publish PR). The
 * run ids announced are kept in localStorage, so a reload does not say the same build again. A build that finished
 * before the page loaded (the tab was closed) is announced when it finished within the last hour and was never
 * announced. A new release of the resort being ridden is not downloaded under the running game: its toast offers
 * Download and ride, which downloads it and then reloads into it.
 *
 * The toasts sit over the menu and the ride (theme.css #release-toasts), never pause, and never take the focus:
 * their buttons are not tab stops, and a click on them does not move the focus, so the keys and a controller keep
 * steering (PadNav and MenuNav do not walk into them either). They stay until closed or clicked.
 *
 * ReleaseToasts is the logic (tools/releasecheck.mjs runs it in Node over fake routes and timers); ToastStack is the
 * page's view of it.
 */

/** a build that finished before the page loaded is announced only if it finished this recently */
export const RECENT_MS = 60 * 60_000;
export const JOB_POLL_MS = 1000;
/** a release not in the catalog yet, or a catalog read that failed: ask again this much later, this many times */
export const CATALOG_RETRY_MS = 30_000;
export const CATALOG_RETRIES = 4;
export const ANNOUNCED_KEY = 'releaseToasts';
const ANNOUNCED_MAX = 50;

export type ToastKind = 'downloading' | 'ready' | 'update' | 'blocked' | 'failed' | 'no-change';
/** what one toast says. id: the build's run id, so a build has one toast that changes as it goes */
export interface ToastModel {
  id: string;
  kind: ToastKind;
  title: string;
  detail?: string;
  preview?: boolean;
  link?: { href: string; text: string };
  action?: { label: string; run: () => void };
}
export interface ToastView {
  /** show or update the toast with this id (a toast the player closed comes back only as another kind) */
  put(m: ToastModel): void;
  drop(id: string): void;
}

/** the URL Ride goes to: this page with `pack` set and the drop-in position (x, y, h) dropped, as MainMenu's picker does */
export function packHref(slug: string, href: string): string {
  const u = new URL(href);
  u.searchParams.set('pack', slug);
  for (const k of ['x', 'y', 'h']) u.searchParams.delete(k);
  return u.toString();
}

interface CatalogEntry { slug: string; name: string; status: string; pack: { formatVersion: number } }
interface Listing { formatVersion: number; catalog: { resorts?: CatalogEntry[]; test?: CatalogEntry[] } | null; local: Record<string, { name: string; formatVersion: number; status?: string }> }
interface Job { phase: 'download' | 'unzip' | 'done' | 'error'; received: number; total: number; error?: string }

export interface ReleaseOpts {
  builds: Pick<BuildWatch, 'onChange'>;
  view: ToastView;
  /** the pack the page has loaded ('' on the first-run screen) */
  current?: () => string;
  /** a same-tab navigation; default location.href = */
  navigate?: (href: string) => void;
  /** default location.href */
  href?: () => string;
  /** a pack was installed (the picker, if open, lists it again) */
  installed?: (slug: string) => void;
  fetch?: typeof fetch;
  /** default import.meta.env.BASE_URL */
  base?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** where the announced run ids are kept; default localStorage (null: this page only) */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

const DONE = new Set(['published', 'no-change', 'failed']);

export class ReleaseToasts {
  private readonly o: Required<Omit<ReleaseOpts, 'storage'>> & { storage: Pick<Storage, 'getItem' | 'setItem'> | null };
  /** runs this page has acted on (a download may still be going) */
  private readonly handled = new Set<number>();
  /** this page's copy, for a storage that throws */
  private announcedHere: number[] = [];

  constructor(o: ReleaseOpts) {
    let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
    if (o.storage !== undefined) storage = o.storage;
    else { try { storage = localStorage; } catch { storage = null; } }
    this.o = {
      builds: o.builds,
      view: o.view,
      current: o.current ?? (() => ''),
      navigate: o.navigate ?? ((h) => { location.href = h; }),
      href: o.href ?? (() => location.href),
      installed: o.installed ?? (() => {}),
      fetch: o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)),
      base: o.base ?? import.meta.env.BASE_URL,
      now: o.now ?? Date.now,
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      storage,
    };
  }

  /** listen to the watcher; returns the unsubscribe */
  start(): () => void { return this.o.builds.onChange((_all, changes) => this.changed(changes)); }

  /** the run ids already announced (on this PC, newest last) */
  announced(): number[] {
    try {
      const v = JSON.parse(this.o.storage?.getItem(ANNOUNCED_KEY) ?? '[]');
      if (Array.isArray(v)) return [...new Set([...v.filter(Number.isInteger), ...this.announcedHere])];
    } catch { /* unreadable: this page's copy */ }
    return this.announcedHere.slice();
  }

  private remember(runId: number): void {
    const next = [...this.announced().filter((x) => x !== runId), runId].slice(-ANNOUNCED_MAX);
    this.announcedHere = next;
    try { this.o.storage?.setItem(ANNOUNCED_KEY, JSON.stringify(next)); } catch { /* private window, blocked storage */ }
  }

  private changed(changes: BuildChange[]): void {
    for (const { build: b, prev } of changes) {
      if (!DONE.has(b.state) || this.handled.has(b.runId)) continue;
      // seen finished already (its why or PR changed): nothing new to say
      if (prev && prev.state === b.state) continue;
      // first sight of a finished build (it ended before this page loaded): only a recent one
      if (!prev && (!b.doneAt || this.o.now() - Date.parse(b.doneAt) > RECENT_MS)) continue;
      if (this.announced().includes(b.runId)) continue;
      this.handled.add(b.runId);
      const id = String(b.runId), name = slugName(b.slug), link = buildLink(b);
      if (b.state === 'failed') this.say(b, { id, kind: 'failed', title: `${name}: the build failed`, detail: buildLabel(b), link });
      else if (b.state === 'no-change') this.say(b, { id, kind: 'no-change', title: `${name}: no change`, detail: 'The build finished with nothing new to publish.', link });
      else if (b.slug === this.o.current()) {
        // the pack being ridden: not swapped under the running game
        this.say(b, { id, kind: 'update', title: `A new ${name} is published`, detail: 'Download it, then ride it (the page reloads).', link,
          action: { label: 'Download and ride', run: () => { void this.download(b, true); } } });
      } else void this.download(b, false);
    }
  }

  /** the toast that ends a build's story on this PC: it is not announced again */
  private say(b: BuildInfo, m: ToastModel): void {
    this.remember(b.runId);
    this.o.view.put(m);
  }

  private api(p: string): string { return `${this.o.base}__packs/${p}`; }

  private async listing(): Promise<Listing | null> {
    try {
      const r = await this.o.fetch(this.api('catalog'), { cache: 'no-store' });
      return r.ok && (r.headers.get('content-type') ?? '').includes('json') ? await r.json() as Listing : null;
    } catch { return null; }
  }

  /** start the download and follow it: '' when the pack is in, else why not */
  private async fetchPack(b: BuildInfo, progress: (detail: string) => void): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      let why = '';
      try {
        const r = await this.o.fetch(this.api('get'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: b.slug }) });
        if (!r.ok) why = ((await r.json().catch(() => ({}))) as Job).error ?? `HTTP ${r.status}`;
        else {
          for (;;) {
            await this.o.sleep(JOB_POLL_MS);
            const jr = await this.o.fetch(this.api(`job?slug=${encodeURIComponent(b.slug)}`), { cache: 'no-store' });
            const j = await jr.json().catch(() => ({})) as Job;
            if (!jr.ok) { why = j.error ?? `HTTP ${jr.status}`; break; } // 404: the server restarted and lost the job
            if (j.phase === 'error') { why = j.error ?? 'unknown error'; break; }
            if (j.phase === 'done') return '';
            progress(j.phase === 'unzip' ? 'Unpacking...' : j.total ? `Downloading ${Math.floor((j.received / j.total) * 100)}%` : 'Downloading...');
          }
        }
      } catch (e) { why = String((e as Error).message ?? e); }
      // the catalog does not list the release yet, or could not be read (offline, GitHub's limit): try again
      const retry = /not in the catalog|^catalog:|fetch failed|Failed to fetch/i.test(why);
      if (!retry || attempt >= CATALOG_RETRIES) return why;
      progress('Waiting for the catalog...');
      await this.o.sleep(CATALOG_RETRY_MS);
    }
  }

  private async download(b: BuildInfo, thenRide: boolean): Promise<void> {
    const id = String(b.runId), link = buildLink(b);
    let name = slugName(b.slug);
    const busy = (detail: string) => this.o.view.put({ id, kind: 'downloading', title: thenRide ? `Getting the new ${name}` : `${name} is published`, detail, link });
    busy('Downloading...');
    const why = await this.fetchPack(b, busy);
    const listing = await this.listing();
    const entries = [...(listing?.catalog?.resorts ?? []), ...(listing?.catalog?.test ?? [])].filter((e) => e.slug === b.slug && e.pack);
    const local = listing?.local?.[b.slug];
    name = local?.name ?? entries[0]?.name ?? name;
    // the format the pack is in: what was installed, else what the catalog publishes
    const f = !why && local ? local.formatVersion : entries.some((e) => e.pack.formatVersion === PACK_FORMAT) ? PACK_FORMAT : entries[0]?.pack.formatVersion;
    if (f !== undefined && f !== PACK_FORMAT) {
      const newer = f > PACK_FORMAT;
      this.say(b, { id, kind: 'blocked', title: `${name} was published`, link,
        detail: newer ? `It needs a newer game: the pack is format ${f}, this game reads ${PACK_FORMAT} (git pull).` : `It needs rebuild: the pack is format ${f}, this game reads ${PACK_FORMAT}.` });
      return;
    }
    if (why) { this.say(b, { id, kind: 'failed', title: `${name}: the download failed`, detail: why, link }); return; }
    this.o.installed(b.slug);
    const preview = local?.status === 'preview' || (!local?.status && entries.some((e) => e.status === 'preview'));
    const ride = () => this.o.navigate(packHref(b.slug, this.o.href()));
    if (thenRide) { this.remember(b.runId); ride(); return; }
    this.say(b, { id, kind: 'ready', title: `${name} is ready`, preview, action: { label: 'Ride', run: ride } });
  }
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** the page's toasts: a stack on the right, over the menu, the pause menu and the ride */
export class ToastStack implements ToastView {
  readonly el: HTMLElement;
  /** id -> the kind the player closed: the same kind does not come back (a download's progress), another does */
  private readonly closed = new Map<string, ToastKind>();

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.id = 'release-toasts'; // theme.css
    this.el.setAttribute('aria-live', 'polite');
    // a click here never moves the focus (the ride's keys and the menus' focus stay where they are)
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    parent.appendChild(this.el);
  }

  put(m: ToastModel): void {
    if (this.closed.get(m.id) === m.kind) return;
    this.closed.delete(m.id);
    let t = this.el.querySelector<HTMLElement>(`.rt[data-id="${CSS.escape(m.id)}"]`);
    if (!t) { t = document.createElement('div'); t.className = 'rt'; t.dataset.id = m.id; this.el.appendChild(t); }
    t.dataset.kind = m.kind;
    t.innerHTML = `<div class="rt-text"><div class="rt-title">${esc(m.title)}${m.preview ? PREVIEW_BADGE : ''}</div>`
      + `${m.detail ? `<div class="rt-detail">${esc(m.detail)}</div>` : ''}`
      + `${m.link ? `<a class="rt-link" href="${esc(m.link.href)}" target="_blank" rel="noopener noreferrer" tabindex="-1">${esc(m.link.text)}</a>` : ''}</div>`
      + `${m.action ? `<button class="rt-go" tabindex="-1">${esc(m.action.label)}</button>` : ''}`
      + '<button class="rt-x" tabindex="-1" aria-label="Close" title="Close">&times;</button>';
    const action = m.action;
    if (action) t.querySelector('.rt-go')!.addEventListener('click', () => { this.drop(m.id); action.run(); });
    t.querySelector('.rt-x')!.addEventListener('click', () => { this.closed.set(m.id, m.kind); this.drop(m.id); });
  }

  drop(id: string): void { this.el.querySelector(`.rt[data-id="${CSS.escape(id)}"]`)?.remove(); }
}
