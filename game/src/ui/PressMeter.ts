/**
 * FEAT-140: the press balance meter, a short vertical arc with a needle drawn just above the
 * rider's head while a nose or tail press is held. Up is the heading's front end (W, the stick up),
 * down the back end (S). Colourblind safe: the sweet spot is green between two ticks, and the ends
 * carry shapes as well as red: a cross at the loaded end (you slam) and a flat bar at the other
 * (the board drops flat). It fades in and out with the press; after a press ends the needle stays
 * where it was lost while the meter fades.
 */
const NS = 'http://www.w3.org/2000/svg';
/** arc centre, radius, and the needle's swing at full balance (deg) */
const CX = 8, CY = 50, R = 38, SWING = 50;
const W = 60, H = 100;
const ZONES: [number, number, string][] = [[-1, -0.7, '#ef4444'], [-0.7, -0.3, '#f59e0b'], [-0.3, 0.3, '#22c55e'], [0.3, 0.7, '#f59e0b'], [0.7, 1, '#ef4444']];

const pt = (b: number, r: number): [number, number] => {
  const a = b * SWING * Math.PI / 180;
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
};
const arc = (b0: number, b1: number, r: number): string => {
  const [x0, y0] = pt(b0, r), [x1, y1] = pt(b1, r);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 0 0 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
};

export class PressMeter {
  readonly root: HTMLDivElement;
  private readonly needle: SVGGElement;
  /** the glyph at the top end and the one at the bottom (each holds a cross and a flat bar) */
  private readonly ends: { g: SVGGElement; cross: SVGGElement; flat: SVGGElement }[] = [];
  private shown = false;
  private dir = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;pointer-events:none;z-index:6;opacity:0;transition:opacity .2s;will-change:transform`;
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    svg.appendChild(el('path', { d: arc(-1, 1, R), stroke: 'rgba(0,0,0,.55)', 'stroke-width': 11, fill: 'none', 'stroke-linecap': 'round' }));
    for (const [a, b, c] of ZONES) svg.appendChild(el('path', { d: arc(a, b, R), stroke: c, 'stroke-width': 7, fill: 'none' }));
    // the sweet spot's edges
    for (const b of [-0.3, 0.3]) { const [x0, y0] = pt(b, R - 7), [x1, y1] = pt(b, R + 7); svg.appendChild(el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#fff', 'stroke-width': 2 })); }
    for (const side of [1, -1]) {
      const [x, y] = pt(side * 1.27, R);
      const g = el('g', { transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` });
      const cross = el('g', {});
      for (const d of ['M-5 -5L5 5M5 -5L-5 5']) { cross.appendChild(el('path', { d, stroke: 'rgba(0,0,0,.7)', 'stroke-width': 5, 'stroke-linecap': 'round' })); cross.appendChild(el('path', { d, stroke: '#ef4444', 'stroke-width': 2.6, 'stroke-linecap': 'round' })); }
      const flat = el('g', {});
      flat.appendChild(el('path', { d: 'M-6 0L6 0', stroke: 'rgba(0,0,0,.7)', 'stroke-width': 6, 'stroke-linecap': 'round' }));
      flat.appendChild(el('path', { d: 'M-6 0L6 0', stroke: '#e5e7eb', 'stroke-width': 3, 'stroke-linecap': 'round' }));
      g.append(cross, flat); svg.appendChild(g);
      this.ends.push({ g, cross, flat });
    }
    this.needle = el('g', {});
    const [nx0, ny0] = pt(0, R - 16), [nx1, ny1] = pt(0, R + 9);
    this.needle.appendChild(el('line', { x1: nx0, y1: ny0, x2: nx1, y2: ny1, stroke: 'rgba(0,0,0,.8)', 'stroke-width': 5, 'stroke-linecap': 'round' }));
    this.needle.appendChild(el('line', { x1: nx0, y1: ny0, x2: nx1, y2: ny1, stroke: '#fff', 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
    this.needle.appendChild(el('circle', { cx: nx1, cy: ny1, r: 3, fill: '#fff', stroke: 'rgba(0,0,0,.8)', 'stroke-width': 1.5 }));
    svg.appendChild(this.needle);
    this.root.appendChild(svg);
    document.body.appendChild(this.root);
  }

  /**
   * Show the meter while `pressing` with the needle at `balance` (-1 .. 1, + up) and the loaded
   * end `dir` (+1 top, -1 bottom), its bottom centre at screen point (x, y) in CSS pixels, or hide it.
   */
  update(pressing: boolean, balance: number, dir: number, x: number, y: number): void {
    if (pressing) {
      if (dir !== this.dir) {
        this.dir = dir;
        // the loaded end slams (a cross), the other end drops flat (a bar)
        this.ends[0].cross.style.display = dir > 0 ? '' : 'none'; this.ends[0].flat.style.display = dir > 0 ? 'none' : '';
        this.ends[1].cross.style.display = dir < 0 ? '' : 'none'; this.ends[1].flat.style.display = dir < 0 ? 'none' : '';
      }
      const b = Math.max(-1.1, Math.min(1.1, balance));
      this.needle.setAttribute('transform', `rotate(${(-b * SWING).toFixed(1)} ${CX} ${CY})`);
      // the end the needle is heading for grows as it gets close
      for (let i = 0; i < 2; i++) {
        const near = Math.max(0, (i === 0 ? b : -b) - 0.5) / 0.5;
        const e = this.ends[i], [gx, gy] = pt((i === 0 ? 1 : -1) * 1.27, R);
        e.g.setAttribute('transform', `translate(${gx.toFixed(1)} ${gy.toFixed(1)}) scale(${(0.8 + 0.5 * near).toFixed(2)})`);
        e.g.style.opacity = (0.55 + 0.45 * near).toFixed(2);
      }
    }
    if (pressing || this.shown) this.root.style.transform = `translate(${(x - CX - 0.8 * R).toFixed(0)}px, ${(y - H).toFixed(0)}px)`;
    if (pressing !== this.shown) { this.shown = pressing; this.root.style.opacity = pressing ? '1' : '0'; }
  }

  dispose(): void { this.root.remove(); }
}
