/** FEAT-110 / FEAT-139 trick names and the landing (split from sim/Rider.ts, FEAT-165) */
import type { Rider } from '../Rider';
import type { Input } from './types';
import { FLIP_CLEAN, FLIP_CRASH } from './tuning';

const COUNT = ['', '', 'Double ', 'Triple ', 'Quad '];
/** "Backflip", "Double front flip", "Rodeo 540" (a backflip with a spin), "Front flip 360" */
export function trickName(flip: number, spin: number, rotations: number): string {
  const n = COUNT[Math.min(rotations, 4)] ?? `${rotations}x `;
  const turns = Math.round(Math.abs(spin) / Math.PI) * 180;
  if (turns >= 360) return flip < 0 ? `${n}Rodeo ${turns}` : `${n}Front flip ${turns}`;
  return `${n}${flip > 0 ? 'front flip' : 'backflip'}`.replace(/^./, (c) => c.toUpperCase());
}
/**
 * FEAT-139: a spin with no flip ("Frontside 180", "Backside 360"), or '' under a half turn. `toe` is
 * the side the toe edge is on (+1 the heading's right): frontside turns the chest toward the
 * direction of travel first, which is counterclockwise (spin < 0) for a rider facing right.
 */
export function spinName(spin: number, toe: number): string {
  const turns = Math.round(Math.abs(spin) / Math.PI) * 180;
  return turns < 180 ? '' : `${spin * toe < 0 ? 'Frontside' : 'Backside'} ${turns}`;
}
/** FEAT-139: "Switch backside 180", "Switch backflip": a trick taken off riding switch */
export function switchName(name: string, sw: boolean): string {
  return sw && name ? `Switch ${name[0].toLowerCase()}${name.slice(1)}` : name;
}

/** Touch down from the air: the landing is judged clean, a wobble or a crash (FEAT-110), and a trick reported. */
export function land(r: Rider, ground: number, input: Input): void {
  const n = r.pack.groundNormal(r.x, r.y, undefined, r.z) as number[];
  r.z = ground;
  r.onGround = true;
  // impact normal to the surface
  const vn = r.vx * n[0] + r.vy * n[1] + r.vz * n[2];
  // remove normal component (inelastic), keep tangential
  r.vx -= vn * n[0]; r.vy -= vn * n[1]; r.vz -= vn * n[2];
  const impact = Math.max(0, -vn);
  // misaligned landing (board not along the velocity) or heavy impact costs speed; very heavy = crash
  const hx = Math.sin(r.heading), hy = Math.cos(r.heading);
  const spd = Math.hypot(r.vx, r.vy);
  const align = spd > 0.5 ? Math.abs((r.vx * hx + r.vy * hy) / spd) : 1;
  const spinOff = Math.abs(((r.spin % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI); // distance from facing forward/backward
  // FEAT-110: how far the flip is from a whole number of rotations (the board back under you)
  const flipOff = Math.abs(((r.flip % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  const flipped = Math.round(Math.abs(r.flip) / (Math.PI * 2));
  const sketchy = flipOff > FLIP_CLEAN && flipOff <= FLIP_CRASH;
  const clean = (align > 0.6 || spinOff < 0.6) && flipOff <= FLIP_CLEAN;
  const penalty = (clean ? 0.08 : sketchy ? 0.3 : 0.5) + impact * (clean ? 0.012 : 0.03);
  r.vx *= Math.max(0, 1 - penalty); r.vy *= Math.max(0, 1 - penalty);
  r.landingShock = Math.min(1, impact / 12);
  if (impact > 16 || (!clean && !sketchy && impact > 8 && !input.grab)) r.crashed = 1.3;
  if (flipOff > FLIP_CRASH) r.crashed = 1.3; // landed on the head or the back
  else if (sketchy) r.landingShock = Math.max(r.landingShock, 0.6); // a wobble
  // FEAT-139: a spin on its own is a trick too, and either is "Switch ..." taken off riding switch
  // (the stance cannot change in the air, so it is still the takeoff's here)
  if (r.crashed <= 0) {
    const name = flipped > 0 ? trickName(r.flip, r.spin, flipped) : clean && r.discipline === 'board' ? spinName(r.spin, r.toeSign) : '';
    if (name) r.onTrick?.(switchName(name, r.switch));
    r.landTrick = name ? switchName(name, r.switch) : ''; r.landStep = r.steps; // FEAT-140: landed into a press
  }
  // FEAT-139: landed with the board backwards (a 180, a 540): ride away switch, tail leading
  if (r.discipline === 'board' && spd > 0.5 && r.vx * hx + r.vy * hy < 0) r.turnRound();
  if (!clean) r.heading = Math.atan2(r.vx, r.vy); // the board snaps to the direction of travel (the nearer end leading)
  r.spin = 0; r.flip = 0; r.flipRate = 0; r.tuckDir = 0;
  r.airTime = 0;
}
