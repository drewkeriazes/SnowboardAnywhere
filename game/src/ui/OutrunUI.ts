import type { Outrun } from '../sim/Outrun';
import { BOOST_COST } from '../sim/Outrun';

/**
 * Outrun HUD (FEAT-097): the countdown and head start, then the distance line with a bar that
 * goes red inside 60 m, the score, close calls and the adrenaline meter; a frost-and-red vignette
 * that creeps in from the screen edges as it closes in; and the EATEN / ESCAPED card with stats
 * and Retry / Exit.
 */
export class OutrunUI {
  private readonly hud: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private lastHtml = '';
  onRetry: (() => void) | null = null;
  onExit: (() => void) | null = null;

  constructor() {
    this.hud = document.createElement('div'); this.hud.id = 'outrun';
    this.card = document.createElement('div'); this.card.id = 'outrun-card'; this.card.style.display = 'none';
    this.vignette = document.createElement('div'); this.vignette.id = 'outrun-vignette';
    const hud = document.getElementById('hud');
    document.body.insertBefore(this.vignette, hud);
    document.body.appendChild(this.hud);
    document.body.appendChild(this.card);
  }

  private set(html: string): void { if (html !== this.lastHtml) { this.lastHtml = html; this.hud.innerHTML = html; this.hud.classList.toggle('show', html !== ''); } }

  /** Per frame. */
  update(o: Outrun, metric: boolean, boostKey: string): void {
    if (!o.active || o.phase === 'caught' || o.phase === 'escaped') { this.set(''); this.vignette.style.opacity = '0'; return; }
    const dist = (m: number) => metric ? `${m.toFixed(0)} m` : `${(m * 3.28084).toFixed(0)} ft`;
    const fmt = (t: number) => { const m = Math.floor(t / 60), s = t - m * 60; return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}`; };
    let html = '';
    if (o.phase === 'countdown') {
      const n = Math.max(1, Math.ceil(3 - o.t));
      html = `<div class="name">Outrun &middot; ${o.cfg.difficulty}</div><div class="big">${n}</div><div class="dim">${o.cfg.escape === 'base' && o.base ? 'reach the base' : o.baseMissing ? 'no base on this pack: endless' : 'survive'}</div>`;
    } else if (o.phase === 'headstart') {
      const left = Math.max(0, o.headStart - o.t);
      html = `<div class="name">Head start</div><div class="big">${left < 5 ? `It wakes in ${Math.ceil(left)}...` : fmt(left)}</div><div class="dim">ride</div>`;
    } else {
      const d = o.dist;
      const near = Number.isFinite(d) ? Math.max(0, Math.min(1, 1 - d / 300)) : 0;
      const red = Number.isFinite(d) && d < 60;
      const bar = `<div class="bar"><div class="${red ? 'red' : ''}" style="width:${(near * 100).toFixed(0)}%"></div></div>`;
      const boost = o.boosting ? '<span class="boost">BOOST</span>' : o.adrenaline >= BOOST_COST ? `<span class="ready"><kbd>${boostKey}</kbd> boost</span>` : '';
      const adr = `<div class="adr"><div style="width:${(o.adrenaline * 100).toFixed(0)}%"></div></div>`;
      html = `<div class="name">${Number.isFinite(d) ? (d > 400 ? 'far behind' : dist(d)) : 'behind you'}${o.monsters.length > 1 ? ` &middot; ${o.monsters.length} of them` : ''}</div>${bar}` +
        `<div class="stats">${fmt(o.time)} &middot; ${Math.round(o.score)} pts${o.closeCalls ? ` &middot; ${o.closeCalls} close` : ''}${o.best ? ` &middot; <span class="dim">best ${o.best.score}</span>` : ''}</div>${adr}${boost}`;
      // frost and red from the edges as it closes in
      const v = Number.isFinite(d) ? Math.max(0, Math.min(1, (120 - d) / 110)) : 0;
      this.vignette.style.opacity = String(v * 0.85);
      this.vignette.classList.toggle('red', red);
    }
    this.set(html);
    if (o.phase !== 'chase') this.vignette.style.opacity = '0';
  }

  /** The end card. */
  showCard(o: Outrun, kind: 'eaten' | 'escaped'): void {
    const fmt = (t: number) => { const m = Math.floor(t / 60), s = t - m * 60; return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)} s`; };
    this.card.innerHTML = `<div class="panel">
      <div class="title ${kind}">${kind === 'eaten' ? 'EATEN' : 'ESCAPED'}</div>
      <div class="sub">${kind === 'eaten' ? 'Burp.' : 'It gave up at the treeline.'}</div>
      <div class="row"><span>Survived</span><b>${fmt(o.time)}</b></div>
      <div class="row"><span>Descended</span><b>${o.descended.toFixed(0)} m</b></div>
      <div class="row"><span>Close calls</span><b>${o.closeCalls}</b></div>
      <div class="row total"><span>Score</span><b>${Math.round(o.score)}</b></div>
      <div class="row"><span>Best (${o.cfg.difficulty}, ${o.cfg.escape})</span><b>${o.best ? o.best.score : '-'}${o.isBest ? ' <span class="new">new!</span>' : ''}</b></div>
      <button class="primary" data-a="retry">Retry</button>
      <button class="ghost" data-a="exit">Exit Outrun</button>
    </div>`;
    this.card.style.display = 'flex';
    this.card.querySelector('[data-a="retry"]')!.addEventListener('click', () => { this.hideCard(); this.onRetry?.(); });
    this.card.querySelector('[data-a="exit"]')!.addEventListener('click', () => { this.hideCard(); this.onExit?.(); });
  }
  hideCard(): void { this.card.style.display = 'none'; }
  get cardOpen(): boolean { return this.card.style.display !== 'none'; }

  destroy(): void { this.hud.remove(); this.card.remove(); this.vignette.remove(); }
}
