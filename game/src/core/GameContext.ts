import type * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { GameAudio } from '../audio/Audio';
import type { Settings } from '../ui/Settings';
import type { Params } from './params';
import type { Events } from './Events';

/**
 * FEAT-160: the services one session shares, handed to whatever needs them instead of module globals.
 * Later steps of the card add the input actions and the clock.
 */
export interface GameContext {
  readonly params: Params;
  readonly canvas: HTMLCanvasElement;
  /** one renderer for the whole page; sessions build and tear down their scene */
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly pack: Pack;
  /** the saved settings, changed in place by the menus */
  readonly settings: Settings;
  readonly audio: GameAudio;
  /** FEAT-163: cross-system news (a trick, a gate, a new song), see core/Events.ts */
  readonly events: Events;
}
