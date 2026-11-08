import * as THREE from 'three';

/**
 * Rider pose tables and outfit materials. The body itself is the skeletal rig in RiderRig.ts;
 * these joint angles drive its upper body and pelvis (FK), and the legs only when seated. On the
 * snow the legs are solved by IK to the bindings, so the hip and knee angles here are ignored.
 * Stance: the board points -Z, a regular-stance rider stands sideways with the chest facing +X.
 */
export interface Pose {
  hipsY: number; // pelvis height above the board (m); IK lowers or raises it if the feet cannot reach
  hipsRot: [number, number, number]; // euler xyz
  torso: [number, number, number];
  head: [number, number, number];
  lShoulder: [number, number, number]; rShoulder: [number, number, number];
  lElbow: number; rElbow: number;
  lHip: [number, number, number]; rHip: [number, number, number];
  lKnee: number; rKnee: number;
}

export interface RiderMaterials {
  jacket: THREE.MeshStandardMaterial; pants: THREE.MeshStandardMaterial; helmet: THREE.MeshStandardMaterial;
  gloves: THREE.MeshStandardMaterial; boots: THREE.MeshStandardMaterial; board: THREE.MeshStandardMaterial; skin: THREE.MeshStandardMaterial; goggles: THREE.MeshStandardMaterial;
}

export function defaultMaterials(): RiderMaterials {
  const m = (color: number, roughness = 0.8, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  return { jacket: m(0xef4444), pants: m(0x1f2937, 0.9), helmet: m(0x111111, 0.5), gloves: m(0x111111), boots: m(0x22262e, 0.7), board: m(0x1d4ed8, 0.35, 0.2), skin: m(0xd9b08c), goggles: m(0xff8a00, 0.2, 0.4) };
}

const d2r = Math.PI / 180;
const E = (x: number, y: number, z: number): [number, number, number] => [x * d2r, y * d2r, z * d2r];

/** Named poses. Angles in degrees via E(). Stance is sideways: hips yaw 90 so the chest faces +X. */
export const POSES: Record<string, Pose> = {
  neutral: { hipsY: 0.92, hipsRot: E(4, -90, 0), torso: E(8, 45, 0), head: E(-6, 40, 0), lShoulder: E(10, 0, -55), rShoulder: E(10, 0, 55), lElbow: 25, rElbow: 25, lHip: E(18, 0, -11), rHip: E(18, 0, 11), lKnee: 35, rKnee: 35 },
  tuck: { hipsY: 0.68, hipsRot: E(12, -90, 0), torso: E(45, 40, 0), head: E(-35, 45, 0), lShoulder: E(60, 0, -20), rShoulder: E(60, 0, 20), lElbow: 90, rElbow: 90, lHip: E(60, 0, -11), rHip: E(60, 0, 11), lKnee: 95, rKnee: 95 },
  carveToe: { hipsY: 0.84, hipsRot: E(6, -90, 0), torso: E(-14, 50, 0), head: E(-4, 50, 0), lShoulder: E(-10, 0, -85), rShoulder: E(-10, 0, 40), lElbow: 20, rElbow: 60, lHip: E(35, 0, -11), rHip: E(35, 0, 11), lKnee: 60, rKnee: 60 },
  carveHeel: { hipsY: 0.79, hipsRot: E(-6, -90, 0), torso: E(16, 35, 0), head: E(-4, 35, 0), lShoulder: E(20, 0, -45), rShoulder: E(20, 0, 85), lElbow: 50, rElbow: 20, lHip: E(50, 0, -11), rHip: E(50, 0, 11), lKnee: 75, rKnee: 75 },
  // FEAT-126 hard carve at full lean (about 60 deg): hips low (the leg IK bends the knees to 100 to 120 deg),
  // the chest angulated back up the slope from the legs so it leans about 75 % of the body, head near level;
  // toeside the arms reach low and forward toward the snow, heelside they are held out in front
  carveToeDeep: { hipsY: 0.56, hipsRot: E(10, -90, 0), torso: E(-24, 50, 0), head: E(-22, 50, 0), lShoulder: E(50, 0, -30), rShoulder: E(35, 0, 30), lElbow: 15, rElbow: 40, lHip: E(80, 0, -11), rHip: E(80, 0, 11), lKnee: 115, rKnee: 115 },
  carveHeelDeep: { hipsY: 0.54, hipsRot: E(0, -90, 0), torso: E(26, 35, 0), head: E(14, 35, 0), lShoulder: E(50, 0, -25), rShoulder: E(35, 0, 20), lElbow: 25, rElbow: 35, lHip: E(85, 0, -11), rHip: E(85, 0, 11), lKnee: 115, rKnee: 115 },
  crouch: { hipsY: 0.55, hipsRot: E(8, -90, 0), torso: E(30, 45, 0), head: E(-25, 45, 0), lShoulder: E(-30, 0, -60), rShoulder: E(-30, 0, 60), lElbow: 40, rElbow: 40, lHip: E(75, 0, -11), rHip: E(75, 0, 11), lKnee: 110, rKnee: 110 },
  // FEAT-111 deep squat (Left Ctrl): hips low over the board, back straight and leaned ~20 deg, arms out in front, head up; the leg IK bends the knees as far as it can
  squat: { hipsY: 0.3, hipsRot: E(22, -90, 0), torso: E(18, 45, 0), head: E(-30, 45, 0), lShoulder: E(70, 0, -25), rShoulder: E(70, 0, 25), lElbow: 20, rElbow: 20, lHip: E(115, 0, -11), rHip: E(115, 0, 11), lKnee: 140, rKnee: 140 },
  // FEAT-125 tail press / ollie load and nose press / nollie. Added on top of the current pose as a
  // difference from neutral (so they stack on a squat or a charge), except the arms, which take over.
  // hipsRot z rolls the pelvis and everything above it along the board: - toward the tail, + the nose.
  // Arms up and wide for balance: the arm over the unloaded end reaches out past shoulder height
  // toward it, the other goes out and back over the loaded end.
  pressTail: { hipsY: 0.92, hipsRot: E(2, -90, -20), torso: E(-2, 50, 0), head: E(-12, 45, 0), lShoulder: E(15, 0, -112), rShoulder: E(-25, 0, 128), lElbow: 15, rElbow: 25, lHip: E(18, 0, -11), rHip: E(18, 0, 11), lKnee: 35, rKnee: 35 },
  pressNose: { hipsY: 0.92, hipsRot: E(6, -90, 20), torso: E(12, 40, 0), head: E(-14, 40, 0), lShoulder: E(-25, 0, -128), rShoulder: E(15, 0, 112), lElbow: 25, rElbow: 15, lHip: E(18, 0, -11), rHip: E(18, 0, 11), lKnee: 35, rKnee: 35 },
  air: { hipsY: 0.78, hipsRot: E(0, -90, 0), torso: E(10, 40, 0), head: E(-15, 40, 0), lShoulder: E(-40, 0, -110), rShoulder: E(-40, 0, 110), lElbow: 20, rElbow: 20, lHip: E(50, 0, -11), rHip: E(50, 0, 11), lKnee: 85, rKnee: 85 },
  grab: { hipsY: 0.6, hipsRot: E(10, -90, 0), torso: E(40, 40, 10), head: E(-30, 40, 0), lShoulder: E(30, 0, -40), rShoulder: E(80, 0, 30), lElbow: 30, rElbow: 10, lHip: E(85, 0, -11), rHip: E(85, 0, 11), lKnee: 125, rKnee: 125 },
  land: { hipsY: 0.5, hipsRot: E(8, -90, 0), torso: E(35, 45, 0), head: E(-25, 45, 0), lShoulder: E(20, 0, -50), rShoulder: E(20, 0, 50), lElbow: 60, rElbow: 60, lHip: E(85, 0, -11), rHip: E(85, 0, 11), lKnee: 125, rKnee: 125 },
  crash: { hipsY: 0.3, hipsRot: E(-70, -40, 60), torso: E(30, 20, 20), head: E(20, 0, 0), lShoulder: E(-80, 0, -120), rShoulder: E(40, 0, 140), lElbow: 90, rElbow: 30, lHip: E(30, 0, -11), rHip: E(-20, 0, 11), lKnee: 60, rKnee: 20 },
  seated: { hipsY: 0.42, hipsRot: E(0, 0, 0), torso: E(5, 20, 0), head: E(0, 0, 0), lShoulder: E(-20, 0, -15), rShoulder: E(-20, 0, 15), lElbow: 70, rElbow: 70, lHip: E(85, 0, -11), rHip: E(85, 0, 11), lKnee: 60, rKnee: 60 },
};

/** On foot (FEAT-067), both disciplines: facing forward. Legs are IK to the gait's feet, so the hip
 *  and knee angles here are unused; the arms are overridden by hand IK where they hold the gear. */
export const WALK_POSES: Record<'walk' | 'sprint' | 'crawl', Pose> = {
  walk: { hipsY: 0.97, hipsRot: E(3, 0, 0), torso: E(4, 0, 0), head: E(-4, 0, 0), lShoulder: E(0, 0, -6), rShoulder: E(0, 0, 6), lElbow: 15, rElbow: 15, lHip: E(0, 0, 0), rHip: E(0, 0, 0), lKnee: 0, rKnee: 0 },
  sprint: { hipsY: 0.93, hipsRot: E(10, 0, 0), torso: E(10, 0, 0), head: E(-14, 0, 0), lShoulder: E(0, 0, -10), rShoulder: E(0, 0, 10), lElbow: 80, rElbow: 80, lHip: E(0, 0, 0), rHip: E(0, 0, 0), lKnee: 0, rKnee: 0 },
  // scrambling up a steep pitch (FEAT-068): low, bent well forward, head up; the free hand is IK to the snow
  crawl: { hipsY: 0.68, hipsRot: E(30, 0, 0), torso: E(40, 0, 0), head: E(-45, 0, 0), lShoulder: E(60, 0, -10), rShoulder: E(30, 0, 10), lElbow: 30, rElbow: 30, lHip: E(0, 0, 0), rHip: E(0, 0, 0), lKnee: 0, rKnee: 0 },
};

export function lerpPose(out: Pose, a: Pose, b: Pose, t: number): Pose {
  const l3 = (p: [number, number, number], q: [number, number, number]): [number, number, number] => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  out.hipsY = a.hipsY + (b.hipsY - a.hipsY) * t;
  out.hipsRot = l3(a.hipsRot, b.hipsRot); out.torso = l3(a.torso, b.torso); out.head = l3(a.head, b.head);
  out.lShoulder = l3(a.lShoulder, b.lShoulder); out.rShoulder = l3(a.rShoulder, b.rShoulder);
  out.lElbow = a.lElbow + (b.lElbow - a.lElbow) * t; out.rElbow = a.rElbow + (b.rElbow - a.rElbow) * t;
  out.lHip = l3(a.lHip, b.lHip); out.rHip = l3(a.rHip, b.rHip);
  out.lKnee = a.lKnee + (b.lKnee - a.lKnee) * t; out.rKnee = a.rKnee + (b.rKnee - a.rKnee) * t;
  return out;
}
export function clonePose(p: Pose): Pose { return JSON.parse(JSON.stringify(p)); }

/** Skier poses: forward stance (no hips yaw), poles held forward. */
export const SKI_POSES: Record<string, Pose> = {
  neutral: { hipsY: 0.94, hipsRot: E(4, 0, 0), torso: E(12, 0, 0), head: E(-8, 0, 0), lShoulder: E(35, 0, -15), rShoulder: E(35, 0, 15), lElbow: 50, rElbow: 50, lHip: E(22, 0, -1.8), rHip: E(22, 0, 1.8), lKnee: 35, rKnee: 35 },
  tuck: { hipsY: 0.66, hipsRot: E(15, 0, 0), torso: E(60, 0, 0), head: E(-50, 0, 0), lShoulder: E(75, 0, -10), rShoulder: E(75, 0, 10), lElbow: 110, rElbow: 110, lHip: E(70, 0, -1.2), rHip: E(70, 0, 1.2), lKnee: 100, rKnee: 100 },
  carveToe: { hipsY: 0.84, hipsRot: E(6, 0, 12), torso: E(18, 0, -14), head: E(-8, 0, -4), lShoulder: E(30, 0, -40), rShoulder: E(30, 0, 10), lElbow: 50, rElbow: 60, lHip: E(35, 0, -6), rHip: E(45, 0, 1.2), lKnee: 55, rKnee: 75 },
  carveHeel: { hipsY: 0.84, hipsRot: E(6, 0, -12), torso: E(18, 0, 14), head: E(-8, 0, 4), lShoulder: E(30, 0, -10), rShoulder: E(30, 0, 40), lElbow: 60, rElbow: 50, lHip: E(45, 0, -1.2), rHip: E(35, 0, 6), lKnee: 75, rKnee: 55 },
  // FEAT-126 hard carve at full lean: hips low and rolled into the turn, chest angulated back over the outside ski
  carveToeDeep: { hipsY: 0.62, hipsRot: E(12, 0, 18), torso: E(24, 0, -26), head: E(-14, 0, -16), lShoulder: E(45, 0, -35), rShoulder: E(40, 0, 15), lElbow: 55, rElbow: 60, lHip: E(60, 0, -6), rHip: E(70, 0, 1.2), lKnee: 90, rKnee: 110 },
  carveHeelDeep: { hipsY: 0.62, hipsRot: E(12, 0, -18), torso: E(24, 0, 26), head: E(-14, 0, 16), lShoulder: E(40, 0, -15), rShoulder: E(45, 0, 35), lElbow: 60, rElbow: 55, lHip: E(70, 0, -1.2), rHip: E(60, 0, 6), lKnee: 110, rKnee: 90 },
  crouch: { hipsY: 0.55, hipsRot: E(8, 0, 0), torso: E(35, 0, 0), head: E(-25, 0, 0), lShoulder: E(-10, 0, -20), rShoulder: E(-10, 0, 20), lElbow: 40, rElbow: 40, lHip: E(80, 0, -1.8), rHip: E(80, 0, 1.8), lKnee: 115, rKnee: 115 },
  squat: { hipsY: 0.32, hipsRot: E(22, 0, 0), torso: E(18, 0, 0), head: E(-30, 0, 0), lShoulder: E(70, 0, -15), rShoulder: E(70, 0, 15), lElbow: 20, rElbow: 20, lHip: E(115, 0, -1.8), rHip: E(115, 0, 1.8), lKnee: 140, rKnee: 140 },
  air: { hipsY: 0.8, hipsRot: E(0, 0, 0), torso: E(10, 0, 0), head: E(-10, 0, 0), lShoulder: E(-20, 0, -70), rShoulder: E(-20, 0, 70), lElbow: 30, rElbow: 30, lHip: E(45, 0, -2.4), rHip: E(45, 0, 2.4), lKnee: 70, rKnee: 70 },
  grab: { hipsY: 0.62, hipsRot: E(10, 0, 0), torso: E(45, 0, 0), head: E(-30, 0, 0), lShoulder: E(70, 0, -20), rShoulder: E(70, 0, 20), lElbow: 20, rElbow: 20, lHip: E(90, 0, -2.4), rHip: E(90, 0, 2.4), lKnee: 120, rKnee: 120 },
  land: { hipsY: 0.52, hipsRot: E(8, 0, 0), torso: E(40, 0, 0), head: E(-25, 0, 0), lShoulder: E(30, 0, -30), rShoulder: E(30, 0, 30), lElbow: 70, rElbow: 70, lHip: E(85, 0, -1.8), rHip: E(85, 0, 1.8), lKnee: 125, rKnee: 125 },
  crash: { hipsY: 0.3, hipsRot: E(-70, 40, 60), torso: E(30, 0, 20), head: E(20, 0, 0), lShoulder: E(-80, 0, -120), rShoulder: E(40, 0, 140), lElbow: 90, rElbow: 30, lHip: E(30, 0, -12), rHip: E(-20, 0, 15), lKnee: 60, rKnee: 20 },
  seated: { hipsY: 0.42, hipsRot: E(0, 0, 0), torso: E(5, 0, 0), head: E(0, 0, 0), lShoulder: E(-20, 0, -15), rShoulder: E(-20, 0, 15), lElbow: 70, rElbow: 70, lHip: E(85, 0, -3), rHip: E(85, 0, 3), lKnee: 60, rKnee: 60 },
};
