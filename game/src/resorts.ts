/** packs/index.json, as MapPacker-SnowboardAnywhere/pipeline/packwriter.py index_packs and tools/get_pack.mjs write it */
interface PackIndex { packs: string[]; names?: Record<string, string> }

/**
 * The built packs in menu order: by name, the synthetic mountain last. FEAT-243: the game keeps no list of
 * resorts; each one's name comes from packs/index.json (its pack's meta.json `name`), else its slug.
 */
export function resortsFromIndex(index: PackIndex): { slug: string; name: string }[] {
  return index.packs
    .map((slug) => ({ slug, name: index.names?.[slug] ?? slug }))
    .sort((a, b) => Number(a.slug === 'synth') - Number(b.slug === 'synth') || a.name.localeCompare(b.name));
}

/** Which resorts have a built pack on this server: packs/index.json (BUG-036: missing ones are not probed); none without it */
export async function availableResorts(base: string): Promise<{ slug: string; name: string }[]> {
  try {
    const res = await fetch(`${base}packs/index.json`, { cache: 'no-store' });
    if (res.ok) return resortsFromIndex(await res.json() as PackIndex);
  } catch { /* no index: no built packs */ }
  return [];
}
