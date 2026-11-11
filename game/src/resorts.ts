/**
 * Resorts the game knows by name, in menu order. Since FEAT-175 the menu lists every pack in packs/index.json
 * under the name the index gives it, so a new resort needs no entry here; this list only orders the known ones
 * and names them where the index predates the names (or there is no index, and each one here is probed).
 */
export const RESORTS: { slug: string; name: string }[] = [
  { slug: 'vail', name: 'Vail' },
  { slug: 'breckenridge', name: 'Breckenridge' },
  { slug: 'bigsky', name: 'Big Sky' },
  { slug: 'synth', name: 'Test mountain (synthetic)' },
];

/** packs/index.json, as pipeline/packwriter.py index_packs and tools/get_pack.mjs write it */
interface PackIndex { packs: string[]; names?: Record<string, string> }

/** The built packs in menu order: the known resorts first, then the rest by name, the synthetic mountain last. */
export function resortsFromIndex(index: PackIndex): { slug: string; name: string }[] {
  const known = new Map(RESORTS.map((r, i) => [r.slug, i]));
  const rank = (slug: string) => (slug === 'synth' ? Infinity : known.get(slug) ?? RESORTS.length);
  return index.packs
    .map((slug) => ({ slug, name: index.names?.[slug] ?? RESORTS.find((r) => r.slug === slug)?.name ?? slug }))
    .sort((a, b) => rank(a.slug) - rank(b.slug) || a.name.localeCompare(b.name));
}

/** Which resorts have a built pack on this server. */
export async function availableResorts(base: string): Promise<{ slug: string; name: string }[]> {
  // packs/index.json (written by the pipeline) lists the built packs, so missing ones are not probed (BUG-036)
  try {
    const res = await fetch(`${base}packs/index.json`, { cache: 'no-store' });
    if (res.ok) return resortsFromIndex(await res.json() as PackIndex);
  } catch { /* older pack folders have no index: probe each resort below */ }
  const ok = await Promise.all(RESORTS.map(async (r) => {
    try { const res = await fetch(`${base}packs/${r.slug}/meta.json`, { method: 'GET', cache: 'no-store' }); return res.ok; } catch { return false; }
  }));
  return RESORTS.filter((_, i) => ok[i]);
}
