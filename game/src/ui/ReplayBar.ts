import { PAD } from '../sim/Pad';
import type { KeyLabels } from './KeyLabels';

/** m:ss */
export const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export interface ReplayBarState {
  playing: boolean;
  speed: number;
  /** seconds into the recording, and its length */
  at: number;
  span: number;
  cam: string;
  hour: number;
  usingPad: boolean;
  /** FEAT-128 ?debug: the take marks, seconds into the recording (null: not set) */
  take: { in: number | null; out: number | null } | null;
}

/** FEAT-043: the replay viewer's bar (play state, speed, the scrub line, the keys). */
export class ReplayBar {
  readonly el = document.createElement('div');

  constructor(private readonly keys: KeyLabels) {
    this.el.id = 'replay';
    this.el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);width:min(720px,92vw);color:#fff;background:rgba(20,24,34,.8);border-radius:12px;padding:8px 14px;font:13px system-ui,sans-serif;display:none;pointer-events:none;z-index:6';
    document.body.appendChild(this.el);
  }

  hide(): void { this.el.style.display = 'none'; }

  /** `clean`: the photo view, bar hidden */
  draw(s: ReplayBarState, clean: boolean): void {
    const { pg } = this.keys;
    this.el.style.display = clean ? 'none' : 'block';
    this.el.innerHTML = `<div style="display:flex;justify-content:space-between"><b>REPLAY ${s.playing ? '&#9654;' : '&#10074;&#10074;'} ${s.speed}x</b><span>${fmtT(s.at)} / ${fmtT(s.span)}</span></div>` +
      `<div style="height:6px;background:rgba(255,255,255,.2);border-radius:3px;margin:6px 0"><div style="height:6px;width:${(s.at / s.span * 100).toFixed(1)}%;background:#facc15;border-radius:3px"></div></div>` +
      (s.usingPad
        ? `<div style="opacity:.75">${pg(PAD.A)} play &middot; ${pg(PAD.LEFT)}${pg(PAD.RIGHT)} scrub &middot; ${pg(PAD.LB)} ${pg(PAD.RB)} speed &middot; ${pg(PAD.Y)} camera (${s.cam}) &middot; ${pg(PAD.X)} hide &middot; ${pg(PAD.B)} close</div>`
        : `<div style="opacity:.75">Space play &middot; &larr; &rarr; scrub &middot; &uarr; &darr; speed &middot; C camera (${s.cam}) &middot; - = FOV &middot; , . time of day ${s.hour.toFixed(1)}h &middot; H hide &middot; P photo &middot; K / Esc close</div>`) +
      (s.take ? `<div style="opacity:.75">Main menu take: I in ${s.take.in === null ? '-' : fmtT(s.take.in)} &middot; O out ${s.take.out === null ? '-' : fmtT(s.take.out)} &middot; L save</div>` : '');
  }
}
