import { PACK_FORMAT } from '../pack/format';

/**
 * FEAT-222: the "Change resort" panel's list. Built packs first (as before), then what the resorts repo's
 * catalog adds: a published resort that is not on disk shows "Download (size)", a pack from an older format
 * "needs rebuild". The catalog and the download go through the dev or host server (vite.config.ts /__packs/*,
 * tools/get_pack.mjs); on a server without them (or offline) the list is just the built packs.
 */
interface CatalogEntry { slug: string; name: string; status: string; pack: { version: number; formatVersion: number; bytes: number } }
interface LocalPack { name: string; formatVersion: number; version?: number }
interface CatalogReply { formatVersion: number; catalog: { resorts?: CatalogEntry[] } | null; local: Record<string, LocalPack> }
interface Job { phase: 'download' | 'unzip' | 'done' | 'error'; received: number; total: number; error?: string }

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const mb = (b: number) => `${Math.max(1, Math.round(b / 1e6))} MB`;
const api = (p: string) => `${import.meta.env.BASE_URL}__packs/${p}`;

type Row = { slug: string; name: string; note: string; act: 'load' | 'get' | 'none'; on: boolean };

function rowHtml(r: Row): string {
  return `<button class="course${r.on ? ' on' : ''}" data-pack="${r.slug}" data-act="${r.act}"${r.act === 'none' ? ' disabled' : ''}><span class="cn">${esc(r.name)}</span><span class="cl">${esc(r.note)}</span></button>`;
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

/** Fill the panel, then add the catalog's resorts when the server answers. `go(slug)` loads a built resort. */
export function fillResortPicker(host: HTMLElement, current: string, built: { slug: string; name: string }[], go: (slug: string) => void, close: () => void): void {
  const list = () => host.querySelector<HTMLElement>('.courses')!;
  let reply: CatalogReply | null = null;
  const token = String(Date.now() + Math.random());
  host.dataset.picker = token;
  const draw = () => {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('button[data-pack]')?.dataset.pack;
    list().innerHTML = rows(current, built, reply).map(rowHtml).join('');
    list().querySelectorAll<HTMLButtonElement>('button[data-pack]').forEach((b) => b.addEventListener('click', () => {
      const slug = b.dataset.pack!;
      if (b.dataset.act === 'get') { download(b, slug); return; }
      if (slug === current) close(); else go(slug);
    }));
    if (focused) list().querySelector<HTMLElement>(`button[data-pack="${focused}"]`)?.focus();
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
  draw();
  fetch(api('catalog'), { cache: 'no-store' })
    .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() as Promise<CatalogReply> : null))
    .then((j) => { if (j && host.dataset.picker === token && !host.hidden && list()) { reply = j; draw(); } })
    .catch(() => { /* no download endpoint here (a static host) or offline: built packs only */ });
}
