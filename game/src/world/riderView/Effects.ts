/** FEAT-152 set-down into the snow and its cover, and the spray (split from world/RiderView.ts, FEAT-165) */
import * as THREE from 'three';
import type { RiderView } from '../RiderView';
import type { Rider } from '../../sim/Rider';
import { buryGate, buryShape } from '../SnowCover';
import { BOARD_HALF, BURY_TAU, COVER_FULL, HOLD_FULL, HOLD_SHIFT } from './tuning';

/**
 * FEAT-152: in loose snow (2 in or more, all in by 4 in: SnowCover's buryGate) the rider is drawn set
 * down into it, tail low and nose up (SnowCover's buryShape): the tail sinks with the depth (0.8 of it
 * when slow, 0.45 by PLANE_SPEED, a few cm at high speed) and the nose floats near the surface; slow,
 * the nose dig (`noseSink`) takes the nose down too. The rider is lowered by `bury` (the board's middle)
 * along the snow normal and pitched by `buryPitch` about the board's middle. The whole rider moves, so
 * the legs stay on the bindings. Visual only: the physics, the tracks and the cameras keep the snow
 * surface. Also sets the snow cover over what is under the surface and the sag held ahead of the board.
 * `n` the drawn snow normal and `f` the rig's forward (three.js).
 */
export function setDown(v: RiderView, r: Rider, dt: number, seated: boolean, fl: number, n: THREE.Vector3, f: THREE.Vector3): void {
  // (the time-trial ghost's stand-in rider carries no snow: it is drawn on the surface)
  const set = r.onGround && !seated && r.crashed <= 0;
  const b = buryShape(set ? r.snow?.depth ?? 0 : 0, r.speed, r.noseSink ?? 0, BOARD_HALF, v.shape);
  const sink = b.sink, pitch = b.pitch;
  if (seated || r.crashed > 0) { v.bury = sink; v.buryPitch = pitch; } // the chair and the ragdoll start from the snow surface
  else { const e = 1 - Math.exp(-dt / BURY_TAU); v.bury += (sink - v.bury) * e; v.buryPitch += (pitch - v.buryPitch) * e; }
  v.footCover = 0;
  // the untouched snow under the rider: the cover's surface and where the spray leaves the snow
  v.surf.copy(v.group.position);
  if (!r.onGround && v.pack) { const g = v.pack.groundHeight(r.x, r.y); if (!Number.isNaN(g)) v.surf.y = g; }
  // nose-up about the rig's side axis: the travel end is the rig's nose, or its tail drawn turned round (fl)
  if (Math.abs(v.buryPitch) > 1e-5) v.group.quaternion.multiply(v.q2.setFromAxisAngle(v.xAxis, fl * v.buryPitch));
  if (v.bury > 1e-5) v.group.position.addScaledVector(n, -v.bury);
  const sc = v.snowCover;
  const tail = Math.max(0, v.bury + BOARD_HALF * Math.sin(Math.abs(v.buryPitch))); // the deeper end
  sc.uSnowCoverK.value = Math.min(1, tail / COVER_FULL);
  sc.uSnowOrigin.value.copy(v.surf);
  sc.uSnowN.value.set(r.normal[0], r.normal[2], -r.normal[1]).normalize();
  // the sag held ahead of the board along the travel direction (the travel end of the board when slow)
  const h = v.powderHold, sp = Math.hypot(r.vx, r.vy);
  h.k = Math.min(1, tail / HOLD_FULL);
  h.x = r.x; h.z = -r.y;
  if (sp > 0.5) { h.fx = r.vx / sp; h.fz = -r.vy / sp; }
  else { const l = Math.hypot(f.x, f.z) || 1; h.fx = fl * f.x / l; h.fz = fl * f.z / l; }
  // a press moves it to the end that is down: back over the buried tail of a tail press, on toward the nose of a nose press
  const shift = HOLD_SHIFT * Math.max(-1, Math.min(1, r.lean ?? 0));
  h.x += h.fx * shift; h.z += h.fz * shift;
}

/** FEAT-152 on foot: the boots sit down by the whole boot sink in deep powder and the snow covers them (the shins in deep snow) */
export function footSnow(v: RiderView, r: Rider, dt: number): number {
  const gate = r.onGround ? buryGate(r.snow?.depth ?? 0) : 0;
  v.footCover += (gate - v.footCover) * (1 - Math.exp(-dt / BURY_TAU));
  v.bury = 0; v.buryPitch = 0; v.powderHold.k = 0;
  const sc = v.snowCover;
  sc.uSnowCoverK.value = v.footCover;
  if (v.footCover > 0 && v.pack) {
    const g = v.pack.groundHeight(r.x, r.y);
    sc.uSnowOrigin.value.set(r.x, Number.isNaN(g) ? r.z : g, -r.y);
    const gn = v.pack.groundNormal(r.x, r.y) as number[];
    sc.uSnowN.value.set(gn[0], gn[2], -gn[1]).normalize();
  }
  v.surf.copy(v.group.position);
  return gate;
}

/**
 * Snow spray (FEAT-044, `Spray.ts`): wisps off the engaged edge and a sheet thrown ahead of the
 * board when braking on a groomer, hanging clouds in powder, a burst on landing. `emitting` false
 * only advances the clock (on foot, crashed, on a lift).
 */
export function updateSpray(v: RiderView, r: Rider, dt: number, f: THREE.Vector3, right: THREE.Vector3, emitting: boolean): void {
  v.spray.update(r, dt, v.surf, f, right, v.fl, emitting); // FEAT-152: from the snow surface, not the buried board
}
