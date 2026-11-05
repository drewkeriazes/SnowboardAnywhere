import * as THREE from 'three';

/**
 * Low-poly articulated snowboarder built from primitives: hips -> torso -> head, upper/lower
 * arms, upper/lower legs, boots on a board with bindings. The board points -Z (forward), the
 * rider stands sideways (regular stance: left foot forward, chest facing +X / toe side).
 * Poses are a set of joint angles blended by weight each frame (see RiderView).
 * Material slots: jacket, pants, helmet, gloves, boots, board, skin so colours can be swapped.
 */
export interface Joints {
  /** lean pivot at the board: pitch/roll of the whole body happens here so the feet stay on the board */
  lean: THREE.Group;
  hips: THREE.Group; torso: THREE.Group; head: THREE.Group;
  lShoulder: THREE.Group; rShoulder: THREE.Group; lElbow: THREE.Group; rElbow: THREE.Group;
  lHip: THREE.Group; rHip: THREE.Group; lKnee: THREE.Group; rKnee: THREE.Group;
  board: THREE.Group;
}
export interface Pose {
  hipsY: number; // hips height above the board (m)
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
  neutral: { hipsY: 0.86, hipsRot: E(0, -70, 0), torso: E(10, 25, 0), head: E(-5, 40, 0), lShoulder: E(10, 0, -70), rShoulder: E(10, 0, 70), lElbow: 25, rElbow: 25, lHip: E(18, 0, 12), rHip: E(18, 0, -12), lKnee: 35, rKnee: 35 },
  tuck: { hipsY: 0.62, hipsRot: E(-10, -75, 0), torso: E(50, 20, 0), head: E(-35, 45, 0), lShoulder: E(60, 0, -20), rShoulder: E(60, 0, 20), lElbow: 90, rElbow: 90, lHip: E(60, 0, 10), rHip: E(60, 0, -10), lKnee: 95, rKnee: 95 },
  carveToe: { hipsY: 0.74, hipsRot: E(-28, -70, 0), torso: E(20, 30, 0), head: E(-10, 50, 0), lShoulder: E(-10, 0, -85), rShoulder: E(-10, 0, 40), lElbow: 20, rElbow: 60, lHip: E(35, 0, 14), rHip: E(35, 0, -14), lKnee: 60, rKnee: 60 },
  carveHeel: { hipsY: 0.72, hipsRot: E(22, -70, 0), torso: E(5, 15, 0), head: E(0, 35, 0), lShoulder: E(20, 0, -45), rShoulder: E(20, 0, 85), lElbow: 50, rElbow: 20, lHip: E(50, 0, 12), rHip: E(50, 0, -12), lKnee: 75, rKnee: 75 },
  crouch: { hipsY: 0.55, hipsRot: E(0, -70, 0), torso: E(35, 25, 0), head: E(-25, 45, 0), lShoulder: E(-30, 0, -60), rShoulder: E(-30, 0, 60), lElbow: 40, rElbow: 40, lHip: E(75, 0, 12), rHip: E(75, 0, -12), lKnee: 110, rKnee: 110 },
  air: { hipsY: 0.78, hipsRot: E(0, -70, 0), torso: E(10, 20, 0), head: E(-15, 40, 0), lShoulder: E(-40, 0, -110), rShoulder: E(-40, 0, 110), lElbow: 20, rElbow: 20, lHip: E(50, 0, 15), rHip: E(50, 0, -15), lKnee: 85, rKnee: 85 },
  grab: { hipsY: 0.6, hipsRot: E(0, -70, 0), torso: E(45, 20, 10), head: E(-30, 40, 0), lShoulder: E(30, 0, -40), rShoulder: E(80, 0, 30), lElbow: 30, rElbow: 10, lHip: E(85, 0, 15), rHip: E(85, 0, -15), lKnee: 125, rKnee: 125 },
  land: { hipsY: 0.5, hipsRot: E(0, -72, 0), torso: E(40, 25, 0), head: E(-25, 45, 0), lShoulder: E(20, 0, -50), rShoulder: E(20, 0, 50), lElbow: 60, rElbow: 60, lHip: E(85, 0, 12), rHip: E(85, 0, -12), lKnee: 125, rKnee: 125 },
  crash: { hipsY: 0.3, hipsRot: E(70, -40, 60), torso: E(30, 0, 20), head: E(20, 0, 0), lShoulder: E(-80, 0, -120), rShoulder: E(40, 0, 140), lElbow: 90, rElbow: 30, lHip: E(30, 0, 40), rHip: E(-20, 0, -50), lKnee: 60, rKnee: 20 },
  seated: { hipsY: 0.42, hipsRot: E(0, 0, 0), torso: E(-5, 0, 0), head: E(0, 0, 0), lShoulder: E(-20, 0, -15), rShoulder: E(-20, 0, 15), lElbow: 70, rElbow: 70, lHip: E(85, 0, 10), rHip: E(85, 0, -10), lKnee: 60, rKnee: 60 },
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
  neutral: { hipsY: 0.9, hipsRot: E(0, 0, 0), torso: E(15, 0, 0), head: E(-8, 0, 0), lShoulder: E(35, 0, -15), rShoulder: E(35, 0, 15), lElbow: 50, rElbow: 50, lHip: E(22, 0, 6), rHip: E(22, 0, -6), lKnee: 35, rKnee: 35 },
  tuck: { hipsY: 0.6, hipsRot: E(0, 0, 0), torso: E(70, 0, 0), head: E(-55, 0, 0), lShoulder: E(75, 0, -10), rShoulder: E(75, 0, 10), lElbow: 110, rElbow: 110, lHip: E(70, 0, 4), rHip: E(70, 0, -4), lKnee: 100, rKnee: 100 },
  carveToe: { hipsY: 0.76, hipsRot: E(0, 0, -25), torso: E(20, 0, 10), head: E(-8, 0, 5), lShoulder: E(30, 0, -40), rShoulder: E(30, 0, 10), lElbow: 50, rElbow: 60, lHip: E(35, 0, 20), rHip: E(45, 0, -4), lKnee: 55, rKnee: 75 },
  carveHeel: { hipsY: 0.76, hipsRot: E(0, 0, 25), torso: E(20, 0, -10), head: E(-8, 0, -5), lShoulder: E(30, 0, -10), rShoulder: E(30, 0, 40), lElbow: 60, rElbow: 50, lHip: E(45, 0, 4), rHip: E(35, 0, -20), lKnee: 75, rKnee: 55 },
  crouch: { hipsY: 0.55, hipsRot: E(0, 0, 0), torso: E(40, 0, 0), head: E(-25, 0, 0), lShoulder: E(-10, 0, -20), rShoulder: E(-10, 0, 20), lElbow: 40, rElbow: 40, lHip: E(80, 0, 6), rHip: E(80, 0, -6), lKnee: 115, rKnee: 115 },
  air: { hipsY: 0.8, hipsRot: E(0, 0, 0), torso: E(10, 0, 0), head: E(-10, 0, 0), lShoulder: E(-20, 0, -70), rShoulder: E(-20, 0, 70), lElbow: 30, rElbow: 30, lHip: E(45, 0, 8), rHip: E(45, 0, -8), lKnee: 70, rKnee: 70 },
  grab: { hipsY: 0.62, hipsRot: E(0, 0, 0), torso: E(50, 0, 0), head: E(-30, 0, 0), lShoulder: E(70, 0, -20), rShoulder: E(70, 0, 20), lElbow: 20, rElbow: 20, lHip: E(90, 0, 8), rHip: E(90, 0, -8), lKnee: 120, rKnee: 120 },
  land: { hipsY: 0.52, hipsRot: E(0, 0, 0), torso: E(45, 0, 0), head: E(-25, 0, 0), lShoulder: E(30, 0, -30), rShoulder: E(30, 0, 30), lElbow: 70, rElbow: 70, lHip: E(85, 0, 6), rHip: E(85, 0, -6), lKnee: 125, rKnee: 125 },
  crash: { hipsY: 0.3, hipsRot: E(70, 40, 60), torso: E(30, 0, 20), head: E(20, 0, 0), lShoulder: E(-80, 0, -120), rShoulder: E(40, 0, 140), lElbow: 90, rElbow: 30, lHip: E(30, 0, 40), rHip: E(-20, 0, -50), lKnee: 60, rKnee: 20 },
  seated: { hipsY: 0.42, hipsRot: E(0, 0, 0), torso: E(-5, 0, 0), head: E(0, 0, 0), lShoulder: E(-20, 0, -15), rShoulder: E(-20, 0, 15), lElbow: 70, rElbow: 70, lHip: E(85, 0, 10), rHip: E(85, 0, -10), lKnee: 60, rKnee: 60 },
};

/** Build the rider. `discipline` picks a snowboard with bindings or two skis and poles. */
export function buildRider(mats: RiderMaterials = defaultMaterials(), discipline: 'board' | 'ski' = 'board'): { root: THREE.Group; joints: Joints; mats: RiderMaterials; snowboard: THREE.Mesh } {
  const root = new THREE.Group();
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; return o; };
  const cap = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 3, 8);

  // board: pointed ends, slight camber, with two bindings and highbacks
  const board = new THREE.Group();
  const shape = new THREE.Shape();
  const L = 0.78, W = 0.13;
  shape.moveTo(-W, -L + 0.12); shape.quadraticCurveTo(-W, -L, 0, -L); shape.quadraticCurveTo(W, -L, W, -L + 0.12); shape.lineTo(W * 0.92, L - 0.12);
  shape.quadraticCurveTo(W, L, 0, L); shape.quadraticCurveTo(-W, L, -W * 0.92, L - 0.12); shape.lineTo(-W, -L + 0.12);
  const bg = new THREE.ExtrudeGeometry(shape, { depth: 0.022, bevelEnabled: false });
  bg.rotateX(-Math.PI / 2); bg.translate(0, 0, 0);
  let snowboard: THREE.Mesh;
  if (discipline === 'board') {
    snowboard = mesh(bg, mats.board);
    snowboard.receiveShadow = true;
    board.add(snowboard);
    // topsheet stripe
    board.add(mesh(new THREE.BoxGeometry(0.06, 0.004, 1.3), mats.jacket, 0, 0.024, 0));
    for (const z of [-0.28, 0.3]) {
      const b = new THREE.Group(); b.position.set(0, 0.025, z); b.rotation.y = z < 0 ? 0.3 : 0.15; // binding angles
      b.add(mesh(new THREE.BoxGeometry(0.28, 0.02, 0.3), mats.boots)); // baseplate
      b.add(mesh(new THREE.BoxGeometry(0.26, 0.26, 0.03), mats.boots, 0, 0.14, 0.14)); // highback
      board.add(b);
    }
  } else {
    // two skis with tips, bindings; poles hang from the hands (added to the elbows below)
    const skiShape = new THREE.Shape();
    const sl = 0.85, sw = 0.05;
    skiShape.moveTo(-sw, -sl + 0.1); skiShape.quadraticCurveTo(-sw, -sl, 0, -sl); skiShape.quadraticCurveTo(sw, -sl, sw, -sl + 0.1); skiShape.lineTo(sw, sl); skiShape.lineTo(-sw, sl); skiShape.lineTo(-sw, -sl + 0.1);
    const sg = new THREE.ExtrudeGeometry(skiShape, { depth: 0.015, bevelEnabled: false });
    sg.rotateX(-Math.PI / 2);
    snowboard = mesh(sg, mats.board, -0.12, 0, 0);
    const ski2 = mesh(sg, mats.board, 0.12, 0, 0);
    board.add(snowboard, ski2);
    for (const x of [-0.12, 0.12]) board.add(mesh(new THREE.BoxGeometry(0.09, 0.05, 0.32), mats.boots, x, 0.03, 0.05));
  }
  root.add(board); // re-parented to the lean pivot below once it exists

  // hips (root of the body); the stance rotates the pelvis sideways
  // lean: pivot at the board's contact edge. The board and the body are both children so the feet
  // stay on the board when it rolls onto an edge; the body inclines further (angulation) via the hips.
  const lean = new THREE.Group(); root.add(lean);
  lean.add(board);
  const hips = new THREE.Group(); hips.rotation.order = 'YXZ'; lean.add(hips);
  hips.add(mesh(new THREE.BoxGeometry(0.36, 0.2, 0.24), mats.pants, 0, 0.0, 0));
  const torso = new THREE.Group(); torso.position.y = 0.1; hips.add(torso);
  torso.add(mesh(cap(0.17, 0.3), mats.jacket, 0, 0.28, 0)); // chest
  torso.add(mesh(new THREE.BoxGeometry(0.4, 0.12, 0.24), mats.jacket, 0, 0.5, 0)); // shoulders
  const head = new THREE.Group(); head.position.y = 0.62; torso.add(head);
  head.add(mesh(new THREE.SphereGeometry(0.12, 12, 10), mats.skin, 0, 0.1, 0));
  head.add(mesh(new THREE.SphereGeometry(0.135, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), mats.helmet, 0, 0.11, 0)); // helmet shell
  head.add(mesh(new THREE.BoxGeometry(0.2, 0.07, 0.08), mats.goggles, 0, 0.1, -0.1)); // goggles (face is -Z, the nose of the board)

  const arm = (side: 1 | -1): [THREE.Group, THREE.Group] => {
    const sh = new THREE.Group(); sh.position.set(side * 0.22, 0.5, 0); torso.add(sh);
    sh.add(mesh(cap(0.055, 0.22), mats.jacket, 0, -0.15, 0));
    const el = new THREE.Group(); el.position.y = -0.3; sh.add(el);
    el.add(mesh(cap(0.05, 0.2), mats.jacket, 0, -0.13, 0));
    el.add(mesh(new THREE.SphereGeometry(0.06, 8, 6), mats.gloves, 0, -0.28, 0));
    if (discipline === 'ski') {
      const pole = mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.15, 5), mats.helmet, 0, -0.28 - 0.45, -0.05);
      pole.rotation.x = -0.25;
      el.add(pole);
      el.add(mesh(new THREE.TorusGeometry(0.05, 0.008, 5, 10), mats.boots, 0, -0.28 - 0.98, -0.3));
    }
    return [sh, el];
  };
  const [lShoulder, lElbow] = arm(-1), [rShoulder, rElbow] = arm(1);
  const leg = (side: 1 | -1): [THREE.Group, THREE.Group] => {
    const hp = new THREE.Group(); hp.position.set(side * 0.12, -0.08, 0); hips.add(hp);
    hp.add(mesh(cap(0.08, 0.3), mats.pants, 0, -0.2, 0));
    const kn = new THREE.Group(); kn.position.y = -0.4; hp.add(kn);
    kn.add(mesh(cap(0.07, 0.3), mats.pants, 0, -0.2, 0));
    kn.add(mesh(new THREE.BoxGeometry(0.16, 0.2, 0.28), mats.boots, 0, -0.42, -0.03)); // boot
    return [hp, kn];
  };
  const [lHip, lKnee] = leg(-1), [rHip, rKnee] = leg(1);
  return { root, snowboard, mats, joints: { lean, hips, torso, head, lShoulder, rShoulder, lElbow, rElbow, lHip, rHip, lKnee, rKnee, board } };
}

/** Apply a pose to the joints. Elbows and knees bend about X. */
export function applyPose(j: Joints, p: Pose): void {
  // hip height from the leg angles so the boots always rest on the board (thigh 0.4, shin + boot 0.52)
  const a = (p.lHip[0] + p.rHip[0]) / 2, k = (p.lKnee + p.rKnee) / 2 * d2r;
  j.hips.position.y = 0.08 + 0.4 * Math.cos(a) + 0.52 * Math.cos(k - a) - 0.03;
  // pose angles are all in the body frame (yaw = stance, pitch = bend at the waist); the physical
  // lean about the board is set separately by RiderView from the sim's lateral acceleration
  j.hips.rotation.set(p.hipsRot[0], p.hipsRot[1], p.hipsRot[2]);
  j.torso.rotation.set(p.torso[0], p.torso[1], p.torso[2]);
  j.head.rotation.set(p.head[0], p.head[1], p.head[2]);
  j.lShoulder.rotation.set(p.lShoulder[0], p.lShoulder[1], p.lShoulder[2]);
  j.rShoulder.rotation.set(p.rShoulder[0], p.rShoulder[1], p.rShoulder[2]);
  j.lElbow.rotation.set(p.lElbow * d2r, 0, 0);
  j.rElbow.rotation.set(p.rElbow * d2r, 0, 0);
  j.lHip.rotation.set(p.lHip[0], p.lHip[1], p.lHip[2]);
  j.rHip.rotation.set(p.rHip[0], p.rHip[1], p.rHip[2]);
  j.lKnee.rotation.set(-p.lKnee * d2r, 0, 0);
  j.rKnee.rotation.set(-p.rKnee * d2r, 0, 0);
}
