import type { Events } from '../core/Events';
import type { Rider } from '../sim/Rider';
import type { TimeTrial } from '../sim/TimeTrial';
import type { RunStats } from '../sim/RunStats';
import type { GameAudio } from '../audio/Audio';
import type { RiderView } from '../world/RiderView';
import type { Eat } from '../world/Eat';
import type { Monsters } from '../world/Monster';

/** The systems whose news goes on the bus. */
export interface EventSources {
  rider: Rider; riderView: RiderView; trial: TimeTrial; runStats: RunStats; audio: GameAudio; eat: Eat; monsters: Monsters;
}

/**
 * FEAT-163: point each system's own hook at the bus. The sim classes keep their `on...` hooks (the node
 * checks drive Rider and TimeTrial without a bus and set them directly); this is the one place that knows
 * both sides. The Outrun events and landmarks are pulled in the frame (Session.ts). Returns the undo for
 * the hooks on objects that outlive the session (the audio).
 */
export function connectEventSources(events: Events, s: EventSources): () => void {
  const { rider, riderView, trial, runStats, audio, eat, monsters } = s;
  rider.onTrick = (name) => events.emit({ type: 'trick', name }); // FEAT-110: flips; FEAT-139: spins and switch tricks
  rider.onWashout = (side) => events.emit({ type: 'washout', side }); // FEAT-148
  rider.onPress = (how, dir, time, dist, switchStance, from) => events.emit({ type: 'pressEnd', how, dir, time, dist, switchStance, from }); // FEAT-140
  rider.onSkateStroke = () => events.emit({ type: 'footstep', surface: rider.surface, speed: rider.speed, sink: 0, snow: rider.snow }); // FEAT-085: a crunch per push
  // on foot (FEAT-067): every foot plant of the skeleton leaves a print and a footstep
  riderView.onPlant = (plant) => {
    events.emit({ type: 'footPlant', plant, sink: rider.sink });
    events.emit({ type: 'footstep', surface: rider.surface, speed: plant.speed, sink: rider.sink, snow: rider.snow });
  };
  trial.onEvent = (event) => events.emit({ type: 'trial', event, candidates: trial.candidates.length });
  runStats.onRunEnd = (summary) => events.emit({ type: 'runEnd', summary }); // FEAT-055
  audio.onTrack = (name) => events.emit({ type: 'song', name });
  eat.onSound = (sound) => events.emit({ type: 'eatSound', sound });
  monsters.onCrack = () => events.emit({ type: 'treeCrack' });
  return () => { audio.onTrack = null; };
}
