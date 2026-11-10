import { PAD } from '../sim/Pad';
import { stickGlyph } from '../ui/PadGlyphs';
import type { Settings } from '../ui/Settings';
import type { Controls } from '../sim/Controls';
import type { ResortMap } from '../ui/ResortMap';
import type { KeyLabels } from '../ui/KeyLabels';
import type { TouchControls } from '../ui/TouchControls';
import type { GameAudio } from '../audio/Audio';
import type { FramePlan, RideFrame } from './RideFrame';
import { backPressed, type GameState, type GameStates } from './GameState';

export interface MapParts {
  controls: Controls; touch: TouchControls | null; map: ResortMap; settings: Settings; keyLabels: KeyLabels; audio: GameAudio; frame: RideFrame;
  /** the map has closed (Outrun picked with "or drop in from the map" starts now) */
  onClosed(): void;
}

/**
 * FEAT-162: the full resort map (M) over the world. The state follows the map (ResortMap.onOpenChange), so a
 * drop-in click, Esc, M or Circle all end it. The rider holds still under it, though a lift carries on; the
 * map has the keys (its own mouse, touch and + / - keys, the stick on a controller), the riding keys do nothing.
 */
export class MapState implements GameState {
  readonly name = 'map';
  private readonly plan: FramePlan = { drive: 'hold', touch: false, fullMap: true, interact: false, replay: null };

  constructor(private readonly p: MapParts, private readonly states: GameStates) {}

  enter(): void { /* opened by whoever called map.open() */ }

  exit(): void {
    this.p.controls.padMute(); // FEAT-137: the button that closed it (or the Cross that dropped in) is not a riding press
    this.p.onClosed();
  }

  update(dt: number, stepped: boolean): void {
    const { controls, touch, map, settings, keyLabels, audio, frame } = this.p;
    if (backPressed(controls, touch) || controls.action('map') || touch?.once('map')) { map.close(); return; }
    // FEAT-137: the full map on a controller: the stick pans under a crosshair, R2 / L2 zoom, Cross drops in, Circle closes
    if (controls.pad) {
      const p = controls.pad, dz = (v: number) => (Math.abs(v) > settings.padDead ? v : 0);
      const zoom = (p.buttons[PAD.RT]?.value ?? 0) - (p.buttons[PAD.LT]?.value ?? 0);
      const sx = dz(p.axes[0] ?? 0), sy = dz(p.axes[1] ?? 0), z = Math.abs(zoom) > 0.1 ? zoom : 0;
      if (controls.padOnce(PAD.B)) { map.close(); return; }
      const pg = keyLabels.pg;
      const help = `${stickGlyph('L')} move &middot; ${pg(PAD.RT)} ${pg(PAD.LT)} zoom (${map.zoom.toFixed(1)}x) &middot; ${pg(PAD.A)} drop in &middot; ${pg(PAD.B)} close`;
      if (map.padDrive(dt, sx, sy, z, controls.padOnce(PAD.A), help)) map.drawFull();
      if (!this.states.is('map')) return; // Cross dropped in: the pick closed the map and riding has the frame
    }
    if (controls.action('track')) audio.nextTrack();
    frame.update(dt, stepped, this.plan);
  }

  render(): void { this.p.frame.draw(); }
}
