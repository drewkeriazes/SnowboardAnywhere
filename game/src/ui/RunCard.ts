import type { RunSummary } from '../sim/RunStats';
import { fmtSpeed, fmtHeight, fmtDistance } from './Units';

/**
 * FEAT-055: the after-run card, like a ski-tracker app: the run names, the stats, the line drawn
 * on a little map, personal bests and today's totals. Shows for 10 s (or until clicked).
 */
export class RunCard {
  private readonly el = document.createElement('div');
  private t = 0;

  constructor() {
    this.el.id = 'run-card'; // hud.css
    this.el.addEventListener('click', () => this.hide());
    document.body.appendChild(this.el);
  }

  show(s: RunSummary, metric: boolean): void {
    const spd = (v: number) => fmtSpeed(v, metric);
    const len = (m: number) => fmtDistance(m, metric);
    const ht = (m: number) => fmtHeight(m, metric);
    const tm = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    // run names come from OSM via the pack: escape them before they go into innerHTML
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const name = s.names.length ? s.names.map(esc).join(' &rarr; ') : 'Off-piste';
    const row = (k: string, v: string, pb = false) => `<div class="row"><span class="k">${k}</span><b>${v}${pb ? ' <span class="pb">PB</span>' : ''}</b></div>`;
    this.el.innerHTML = `<div class="name">${name}</div>
      <canvas width="228" height="120"></canvas>
      ${row('Time', tm(s.time), s.pbTime)}${row('Top speed', spd(s.topSpeed), s.pbSpeed)}${row('Distance', len(s.distance))}${row('Vertical', ht(s.vertical))}
      ${row('Longest air', `${s.maxAir.toFixed(1)} s`)}${row('Biggest drop', ht(Math.max(0, s.maxDrop)))}${row('Max g', s.maxG.toFixed(1))}
      <div class="today">Today: ${s.day.runs} run${s.day.runs === 1 ? '' : 's'} &middot; ${ht(s.day.vertical)} &middot; ${s.day.lifts} lift${s.day.lifts === 1 ? '' : 's'}</div>`;
    this.drawLine(this.el.querySelector('canvas')!, s.line);
    this.el.style.display = 'block';
    this.t = 10;
  }

  /** The line, fitted into the canvas with north up (pack x east, y north). */
  private drawLine(c: HTMLCanvasElement, line: [number, number][]): void {
    const g = c.getContext('2d');
    if (!g || line.length < 2) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of line) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = 10, k = Math.min((c.width - 2 * pad) / Math.max(1, x1 - x0), (c.height - 2 * pad) / Math.max(1, y1 - y0));
    const ox = (c.width - (x1 - x0) * k) / 2, oy = (c.height - (y1 - y0) * k) / 2;
    const P = (x: number, y: number): [number, number] => [ox + (x - x0) * k, c.height - (oy + (y - y0) * k)];
    g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#38bdf8';
    g.beginPath(); line.forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke();
    const [sx, sy] = P(line[0][0], line[0][1]), [ex, ey] = P(line[line.length - 1][0], line[line.length - 1][1]);
    g.fillStyle = '#22c55e'; g.beginPath(); g.arc(sx, sy, 4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ef4444'; g.beginPath(); g.arc(ex, ey, 4, 0, Math.PI * 2); g.fill();
  }

  update(dt: number): void { if (this.t > 0 && (this.t -= dt) <= 0) this.hide(); }
  hide(): void { this.t = 0; this.el.style.display = 'none'; }
  dispose(): void { this.el.remove(); }
}
