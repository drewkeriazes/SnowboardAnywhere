/**
 * FEAT-162: the game's states (loading, the main menu, riding, paused, the replay viewer, the map) as a
 * state machine. One state is active at a time; it decides which systems tick and it gets the input, so a
 * menu and the riding keys never both see a key.
 *
 * A state that changes the state inside its update hands the rest of that frame to the new state: the
 * update returns, and the new state's update runs next with the same dt (Esc closing the map, or K opening
 * the replay viewer, takes effect in the frame the key went down). The state active at the end of the
 * frame renders it. There is no interpolation alpha here: the rider blends its own 1/120 s physics steps
 * (sim/Rider.ts `applyRenderPose`).
 */
export interface State<N extends string = string> {
  readonly name: N;
  /** becoming the active state; `from` is the state left, null for the first one */
  enter(from: N | null): void;
  /** one frame: input, then the systems this state runs; `stepped` is true under window.__step */
  update(dt: number, stepped: boolean): void;
  /** draw the frame and close it (end the input frame, the frame rate, the HUD line) */
  render(): void;
  /** leaving, for `to` */
  exit(to: N): void;
}

/** the most states one frame can pass through (a guard against two states handing a frame back and forth) */
const MAX_HANDOVERS = 4;

export class StateMachine<N extends string> {
  private readonly states = new Map<N, State<N>>();
  private active: State<N> | null = null;
  /** set by go(): the active state's update changed the state, so the new one runs the rest of the frame */
  private changed = false;

  add(state: State<N>): this { this.states.set(state.name, state); return this; }

  /** the active state's name (null before the first go) */
  get current(): N | null { return this.active?.name ?? null; }

  is(name: N): boolean { return this.active?.name === name; }

  /** Leave the active state for `name` (nothing happens if it is already active). */
  go(name: N): void {
    const next = this.states.get(name);
    if (!next) throw new Error(`no state ${name}`);
    const from = this.active;
    if (from === next) return;
    from?.exit(name);
    this.active = next;
    this.changed = true;
    next.enter(from?.name ?? null);
  }

  /** One frame of the active state, handed on if it changes the state. */
  update(dt: number, stepped: boolean): void {
    for (let i = 0; i < MAX_HANDOVERS && this.active; i++) {
      this.changed = false;
      this.active.update(dt, stepped);
      if (!this.changed) return;
    }
  }

  render(): void { this.active?.render(); }
}
