/** Where Free ride starts (BUG-037): the pack's meta.start (or a landmark marked `start`, FEAT-132), unless the player dropped in from the map. */
export const spawnKey = (slug: string): string => `spawn:${slug}`;

/** True when the next ride starts somewhere other than meta.start (a saved map drop-in or ?x=&y= in the URL). */
export function hasCustomStart(slug: string): boolean {
  const p = new URLSearchParams(location.search);
  if (p.has('x') || p.has('y')) return true;
  try { return localStorage.getItem(spawnKey(slug)) !== null; } catch { return false; }
}

/** Forget the drop-in so the next ride starts at meta.start. */
export function resetStart(slug: string): void {
  try { localStorage.removeItem(spawnKey(slug)); } catch { /* private mode */ }
  const u = new URL(location.href);
  if (!['x', 'y', 'h'].some((k) => u.searchParams.has(k))) return; // leave the URL alone (re-serialising turns ?lowgfx into ?lowgfx=)
  for (const k of ['x', 'y', 'h']) u.searchParams.delete(k);
  history.replaceState(null, '', u.toString());
}
