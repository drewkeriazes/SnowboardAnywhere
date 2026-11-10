import type { PressEnd, SurfaceInfo } from '../sim/Rider';
import type { SnowState } from '../sim/SnowConditions';
import type { TrialEvent } from '../sim/TimeTrial';
import type { OutrunEvent } from '../sim/Outrun';
import type { RunSummary } from '../sim/RunStats';
import type { Plant } from '../world/Gait';
import type { EatSound } from '../world/Eat';

/**
 * FEAT-163: every piece of cross-system news, in one union. The system that knows it emits; audio, the HUD,
 * the rumble and the world subscribe. Payloads are plain values read at the moment of the emit.
 */
export type GameEvent =
  /** a flip, spin or switch trick landed (FEAT-110, FEAT-139) */
  | { type: 'trick'; name: string }
  /** a hard carve the edge could not hold (FEAT-148): side > 0 onto the hip, < 0 onto the butt */
  | { type: 'washout'; side: number }
  /** a press held long enough to report ended (FEAT-140); `from` is the trick it was landed into from, or '' */
  | { type: 'pressEnd'; how: PressEnd; dir: number; time: number; dist: number; switchStance: boolean; from: string }
  /** a boot came down on foot (FEAT-067): the print */
  | { type: 'footPlant'; plant: Plant; sink: number }
  /** a boot came down or a skate push (FEAT-085): the sound */
  | { type: 'footstep'; surface: SurfaceInfo; speed: number; sink: number; snow: SnowState }
  /** time trials: armed, start, split (a gate), finish, cancel; `candidates` is how many courses are armed */
  | { type: 'trial'; event: TrialEvent; candidates: number }
  /** a run ended with a summary (FEAT-055) */
  | { type: 'runEnd'; summary: RunSummary }
  /** the rider passed a named landmark (FEAT-132) */
  | { type: 'landmark'; name: string }
  /** the music moved on to a new song */
  | { type: 'song'; name: string }
  /** an Outrun sim event (FEAT-097 to FEAT-101) */
  | { type: 'outrun'; event: OutrunEvent }
  /** a beat of the eat sequence (FEAT-104) */
  | { type: 'eatSound'; sound: EatSound }
  /** a monster snapped a tree */
  | { type: 'treeCrack' };

export type GameEventType = GameEvent['type'];
export type EventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;
export type Listener<T extends GameEventType> = (e: EventOf<T>) => void;

/**
 * FEAT-163: the event bus. `emit` calls the listeners at once, in the order they subscribed, so a listener
 * runs at the moment the news happens (the same frame and step as the direct calls it replaced). A listener
 * may emit or subscribe; that takes effect from the next emit. Lists are copied on change, not on emit,
 * so emitting allocates nothing.
 */
export class Events {
  private readonly listeners = new Map<GameEventType, readonly Listener<any>[]>();

  /** Subscribe; returns the matching `off`. */
  on<T extends GameEventType>(type: T, fn: Listener<T>): () => void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    return () => this.off(type, fn);
  }

  off<T extends GameEventType>(type: T, fn: Listener<T>): void {
    const ls = this.listeners.get(type);
    if (ls) this.listeners.set(type, ls.filter((l) => l !== fn));
  }

  emit(e: GameEvent): void {
    const ls = this.listeners.get(e.type);
    if (ls) for (const fn of ls) fn(e);
  }

  /** Session over: drop every listener. */
  clear(): void { this.listeners.clear(); }
}
