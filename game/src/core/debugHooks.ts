/**
 * FEAT-160: window.__sim, the debug view the test tools in game/tools/ read and drive, built in one place.
 * `fixed` are objects and functions (the same instance for the whole session); `live` are values read
 * fresh on every access (they were copied into a new __sim every frame before).
 * Keep the field names: the tools depend on them.
 */
export function installSimDebug(fixed: Record<string, unknown>, live: Record<string, () => unknown>): void {
  const sim: Record<string, unknown> = { ...fixed };
  for (const [k, get] of Object.entries(live)) Object.defineProperty(sim, k, { get, enumerable: true });
  (window as any).__sim = sim;
}
