/** Resorts the game knows about. A resort is playable when packs/<slug>/meta.json exists. */
export const RESORTS: { slug: string; name: string }[] = [
  { slug: 'vail', name: 'Vail' },
  { slug: 'breckenridge', name: 'Breckenridge' },
  { slug: 'synth', name: 'Test mountain (synthetic)' },
];

/** Which resorts have a built pack on this server. */
export async function availableResorts(base: string): Promise<{ slug: string; name: string }[]> {
  const ok = await Promise.all(RESORTS.map(async (r) => {
    try { const res = await fetch(`${base}packs/${r.slug}/meta.json`, { method: 'GET', cache: 'no-store' }); return res.ok; } catch { return false; }
  }));
  return RESORTS.filter((_, i) => ok[i]);
}
