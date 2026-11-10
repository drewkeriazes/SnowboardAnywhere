// FEAT-181: the in-page side of ghost_lines.mjs. Each export is passed to page.evaluate, so each is self-contained
// (no imports, no closures): it runs in a headless game page (?pack=<slug>&headless&cam=eye) through window.__sim.

/** The shot in its own conditions, the ghosts hidden; returns the shot, the canvas size, the fov and the pack build. */
export function setup() {
  const S = window.__sim;
  S.shotConditions?.();
  S.ghosts.setVisible(false);
  const p = S.shotPose(0);
  S.eyeAt(p.x, p.y, p.h, p.pitch, p.fov, p.eye);
  window.__step(1, 0);
  const c = S.renderer.domElement;
  return { shot: S.shot, w: c.width, h: c.height, fov: S.cam.camera.fov, build: S.pack.meta.build ?? '' };
}

/** Is everything near the shot streamed in and built? (the count of what is still pending) */
export function busy() {
  const s = window.__sim, p = s.pack;
  const pend = [p.fine, p.mid, p.far, p.mask].reduce((n, t) => n + (t?.pending?.size ?? 0), 0);
  const veg = [...(s.veg.cells?.values?.() ?? [])].filter((c) => c.loading).length;
  return pend + veg + s.veg.pending + s.terrain.stats.builds;
}

/** The camera on the shot's drift at phase k (0..1 of the dolly, shotPose; 0 is where the menu goes live), the clouds at the shot's start. */
export function poseAt(k) {
  const S = window.__sim, shot = S.shot;
  const t = Math.acos(1 - 2 * k) * shot.period / (2 * Math.PI);
  const p = S.shotPose(t);
  S.shotConditions?.();
  S.eyeAt(p.x, p.y, p.h, p.pitch, p.fov, p.eye);
  window.__step(1, 0);
  S.cam.camera.updateMatrixWorld();
  return p;
}

/** The current frame: a PNG data URL and its RGBA bytes (base64). */
export async function grab() {
  const url = window.__shot();
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
  return { w: c.width, h: c.height, b64: btoa(s), png: url };
}

/** An image file (a data URL) decoded to RGBA bytes, base64. */
export async function decode(url) {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
  return { w: c.width, h: c.height, b64: btoa(s) };
}

/**
 * Cast each line's screenshot pixels onto the terrain from the fitted camera (the pose at fit.k): pixel (u, v) is
 * render pixel ((u - ox) / s, (v - oy) / s). A march out to cfg.maxM, then a bisection.
 * Returns per line [x, y, z, metres along the ray] per pixel that hits.
 */
export async function cast({ lines, fit, rw, rh, cfg }) {
  const S = window.__sim, pack = S.pack, cam = S.cam.camera, V = cam.position.constructor;
  const f = (rh / 2) / Math.tan(cam.fov / 2 * Math.PI / 180);
  const gz = (x, y) => pack.groundHeight(x, y, 9000);
  const c0 = cam.position;
  pack.fine.request(c0.x - 6000, -c0.z - 6000, c0.x + 6000, -c0.z + 6000);
  for (let i = 0; i < 200; i++) { window.__step(1, 0); await new Promise((r) => setTimeout(r, 50)); if (!pack.fine.pending?.size) break; }
  cam.updateMatrixWorld();
  const out = {};
  for (const l of lines) {
    const hits = [];
    for (const [u, v] of l.px) {
      const x = (u - fit.ox) / fit.s, y = (v - fit.oy) / fit.s;
      const d = new V((x - rw / 2) / f, -(y - rh / 2) / f, -1).transformDirection(cam.matrixWorld), o = cam.position;
      let prev = 0;
      for (let s = 1; s < cfg.maxM; s += Math.max(1, s * 0.004)) {
        const px = o.x + d.x * s, py = -(o.z + d.z * s), pz = o.y + d.y * s, g = gz(px, py);
        if (Number.isFinite(g) && pz <= g) {
          let a = prev, b = s;
          for (let i = 0; i < 14; i++) { const m = (a + b) / 2; if (o.y + d.y * m <= gz(o.x + d.x * m, -(o.z + d.z * m))) b = m; else a = m; }
          const hx = o.x + d.x * b, hy = -(o.z + d.z * b);
          hits.push([+hx.toFixed(2), +hy.toFixed(2), +gz(hx, hy).toFixed(2), Math.round(b)]);
          break;
        }
        prev = s;
      }
    }
    out[l.name] = hits;
  }
  return out;
}

/**
 * Ride each line with the rider physics. `plan[name]` = { riders: [{ discipline, goofy, outfit }], side }; `cfg` is
 * ghost_lines.config.json's cast, waypoints, bot and group. The method that worked on Vail
 * (docs/research/ghost-lines-prototype/README.md):
 *  - waypoints: the longest run of the cast line (it jumps between slopes where it crosses an edge), from its high
 *    end, descending, spaced with the distance; every run of minRun+ points when the rider is then hardly on screen
 *  - a steering bot on the real physics: fall line off, capped steer, brake when fast, a carving swing, skip a
 *    waypoint not below the rider or after a stall, the fall line after the last, end once out of sight
 *  - start out of sight: back up from the first waypoint until hidden (never back over a crest far out); near the
 *    camera out of frame at startSpeed
 *  - the other riders: the lead's take shifted across its averaged direction of travel (gapM for the first, then
 *    gapMinM..gapMaxM further out, alternating sides), lagS more behind each, a slow drift; on the other side when
 *    it would start in view close up; no two closer than minGapM at any sample (else the formation loosens)
 *  - every rider of a line trimmed by one cut, to cutBeforeS before the first of them comes into sight
 * "In sight" is from the shot's pose at t = 0 (where the menu goes live): in the frustum and not behind terrain.
 */
export async function ride({ world, plan, cfg }) {
  const { cast: C, waypoints: WP, bot: B, group: G } = cfg;
  const S = window.__sim, pack = S.pack, cam = S.cam.camera;
  const V = cam.position.constructor, RiderC = S.rider.constructor;
  const all = Object.values(world).flat();
  if (!all.length) return [];
  const xs = all.map((q) => q[0]), ys = all.map((q) => q[1]);
  pack.fine.request(Math.min(...xs) - 600, Math.min(...ys) - 600, Math.max(...xs) + 600, Math.max(...ys) + 600);
  pack.mask?.request(Math.min(...xs) - 600, Math.min(...ys) - 600, Math.max(...xs) + 600, Math.max(...ys) + 600);
  const p0 = S.shotPose(0); S.eyeAt(p0.x, p0.y, p0.h, p0.pitch, p0.fov, p0.eye);
  for (let i = 0; i < 400; i++) { window.__step(1, 0); if (all.every(([x, y]) => !Number.isNaN(pack.fine.sample(x, y)))) break; await new Promise((r) => setTimeout(r, 50)); }
  window.__step(1, 0); cam.updateMatrixWorld();
  const gz = (x, y) => pack.groundHeight(x, y, 9000);
  const inFrame = (x, y, z) => { const v = new V(x, z + 1, -y).project(cam); return v.z < 1 && Math.abs(v.x) < 1.02 && Math.abs(v.y) < 1.02; };
  const occluded = (x, y, z) => { const c = cam.position; const w = new V(x, z + 1, -y); for (let k = 0.02; k < 0.97; k += 0.01) { const px = c.x + (w.x - c.x) * k, py = -(c.z + (w.z - c.z) * k), pz = c.y + (w.y - c.y) * k; const g = gz(px, py); if (Number.isFinite(g) && g > pz + 0.5) return true; } return false; };
  const seen = (x, y, z) => inFrame(x, y, z) && !occluded(x, y, z);
  const camDist = (x, y, z) => cam.position.distanceTo(new V(x, z, -y));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const waypoints = (raw, allRuns) => {
    const runs = [[raw[0]]];
    for (const q of raw.slice(1)) { const last = runs[runs.length - 1].at(-1); if (dist(q, last) > Math.max(C.jumpM, C.jumpFrac * q[3])) runs.push([q]); else runs[runs.length - 1].push(q); }
    let p = allRuns ? runs.filter((r) => r.length >= C.minRun).flat() : runs.reduce((a, b) => (b.length > a.length ? b : a));
    if (!p.length) p = runs.reduce((a, b) => (b.length > a.length ? b : a));
    if (p[0][2] < p[p.length - 1][2]) p = p.slice().reverse();
    const out = [p[0]];
    for (const q of p.slice(1)) {
      const last = out[out.length - 1], d = dist(q, last);
      if (d < Math.max(WP.minM, Math.min(WP.maxM, WP.spacingFrac * q[3]))) continue;
      if (q[2] > last[2] - Math.max(0.3, 0.04 * d)) continue;
      out.push(q);
    }
    const end = p[p.length - 1]; if (dist(end, out[out.length - 1]) > 6 && end[2] < out[out.length - 1][2]) out.push(end);
    return { wps: out.map(([x, y, , d]) => [x, y, d]), kept: p.length, of: raw.length, near: Math.round(Math.min(...p.map((q) => q[3]))), far: Math.round(Math.max(...p.map((q) => q[3]))) };
  };
  const fallDir = (x, y) => { const e = 3, gx = gz(x + e, y) - gz(x - e, y), gy = gz(x, y + e) - gz(x, y - e), l = Math.hypot(gx, gy) || 1; return [-gx / l, -gy / l]; };
  const sim = (W, discipline, phase = 0, straight = false) => {
    if (W.length < 2) { const [fx, fy] = fallDir(W[0][0], W[0][1]); W = [W[0], [W[0][0] + fx * 20, W[0][1] + fy * 20]]; }
    // the line's own direction at its start (over its first 40 m or quarter, not the first leg: a wiggle's first leg
    // points sideways): the start backs up against it, and the rider sets off along it
    let along = 0, ai = 1;
    const total = W.slice(1).reduce((s, w, i) => s + dist(w, W[i]), 0);
    for (; ai < W.length - 1; ai++) { along += dist(W[ai], W[ai - 1]); if (along >= Math.min(40, total / 4)) break; }
    const l0 = dist(W[0], W[ai]) || 1, ux = (W[ai][0] - W[0][0]) / l0, uy = (W[ai][1] - W[0][1]) / l0;
    let sx = W[0][0], sy = W[0][1], hiddenFor = 0, crest = false;
    for (let s = 2; s < 300; s += 2) {
      const bx = W[0][0] - ux * s, by = W[0][1] - uy * s;
      if (camDist(bx, by, gz(bx, by)) > B.crestBeyondM && gz(bx, by) < gz(sx, sy) + 0.1) { crest = true; break; }
      sx = bx; sy = by;
      if (!seen(sx, sy, gz(sx, sy))) { hiddenFor += 2; if (hiddenFor > 4) break; } else hiddenFor = 0;
    }
    const r = new RiderC(pack, null);
    r.discipline = discipline; r.fallLine = 0; // the Realistic fall line's edge catches crash a bot on traverses
    r.reset(sx, sy, Math.atan2(ux, uy)); r.vx = ux * B.startSpeed; r.vy = uy * B.startSpeed;
    const input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
    // the path: the waypoints every 1 m (arc length s), smoothed over a stretch that grows with the distance from the
    // camera (close up the drawn wiggles are the turns; far out they are hand shake)
    const raw = [];
    for (let i = 0; i < W.length - 1; i++) {
      const a = W[i], b = W[i + 1], l = dist(a, b), n = Math.max(1, Math.round(l));
      for (let k = 0; k < n; k++) raw.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, (a[2] ?? 300) + ((b[2] ?? 300) - (a[2] ?? 300)) * k / n, i]);
    }
    raw.push([...W[W.length - 1].slice(0, 2), W[W.length - 1][2] ?? 300, W.length - 1]);
    const path = raw.map((q, i) => {
      const h = Math.round(Math.max(1, Math.min(B.smoothMaxM, B.smoothFrac * q[2])));
      let x = 0, y = 0, n = 0;
      for (let k = Math.max(0, i - h); k <= Math.min(raw.length - 1, i + h); k++) { x += raw[k][0]; y += raw[k][1]; n++; }
      return [x / n, y / n, q[2], q[3]];
    });
    const samples = []; let t = 0, acc = 0.05, si = 0, hidden = 0, everSeen = false, crashes = 0, vmax = 0, done = false, stall = 0, skipped = 0, wasCrashed = false, tail = 0, braking = false;
    // linked turns: a sine across the path, its wavelength from the distance from the camera, its width set by the
    // speed (wider across the fall line when too fast, as a rider checks speed); the phase runs with the distance ridden
    let turnPhase = phase * 2 * Math.PI, amp = -1;
    const lam = (d) => Math.max(B.turnMinM, Math.min(B.turnMaxM, B.turnBaseM + B.turnFrac * d));
    for (let step = 0; step < 60 * B.maxS; step++) {
      const sp = Math.hypot(r.vx, r.vy), dt = 1 / 60;
      // progress along the path: the nearest point a little ahead, never back
      let best = si, bd = Infinity;
      for (let k = si; k < Math.min(path.length, si + 40); k++) { const d = (path[k][0] - r.x) ** 2 + (path[k][1] - r.y) ** 2; if (d < bd) { bd = d; best = k; } }
      si = best;
      stall = sp < B.stallSpeed ? stall + dt : 0;
      if (stall > B.stallS && !done) { si = Math.min(path.length - 1, si + 10); stall = 0; skipped++; }
      if (si >= path.length - 2) done = true;
      const cd = camDist(r.x, r.y, r.z);
      // the speed this stretch wants: slower close to the camera and in moguls (soak the bumps up), fast for a straightliner
      const bumps = pack.mogulAmp ? pack.mogulAmp(r.x, r.y) : 0;
      let cap = straight ? B.straightOver : Math.min(B.brakeOver, Math.max(B.brakeMin, B.brakeFrac * cd));
      if (bumps > B.mogulAmpM) cap = Math.min(cap, B.mogulOver);
      const look = Math.max(B.lookMinM, Math.min(B.lookMaxM, B.lookFrac * sp));
      let bx, by, nx, ny, d0;
      if (!done) {
        const ti = Math.min(path.length - 1, si + Math.round(look)), q = path[ti], q0 = path[Math.max(0, ti - 2)], q1 = path[Math.min(path.length - 1, ti + 2)];
        const l = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1;
        bx = q[0]; by = q[1]; nx = (q1[1] - q0[1]) / l; ny = -(q1[0] - q0[0]) / l; d0 = q[2];
      } else {
        // past the line: on down the fall line, still turning
        const [fx, fy] = fallDir(r.x, r.y);
        bx = r.x + fx * look; by = r.y + fy * look; nx = fy; ny = -fx; d0 = cd;
      }
      const L = lam(d0);
      // the turns' width: none for a straightliner; grows when too fast, shrinks when slow, within a share of the wavelength
      const near = Math.max(B.turnNearShare, Math.min(1, (d0 - B.swingNearM) / (B.swingFullM - B.swingNearM)));
      if (amp < 0) amp = B.turnStartShare * L;
      amp = Math.max(B.turnMinShare * L, Math.min(B.turnMaxShare * L, amp + B.turnGain * (sp - cap) * dt));
      turnPhase += 2 * Math.PI * sp * dt / L;
      const off = straight ? 0 : near * amp * Math.sin(turnPhase + 2 * Math.PI * look / L);
      const tx = bx + nx * off - r.x, ty = by + ny * off - r.y;
      let err = Math.atan2(tx, ty) - r.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
      // the steering eased in (a rider rolls from edge to edge, never snaps)
      const cmd = Math.max(-B.steerCap, Math.min(B.steerCap, err * B.steerGain));
      input.steer += (cmd - input.steer) * Math.min(1, dt / B.steerEaseS);
      // in the air: hands off the steering and grab (a crooked landing without a grab crashes, rider/Tricks.ts)
      input.grab = !r.onGround;
      if (!r.onGround) input.steer = 0;
      // the brake only as a backstop (the turns check the speed): on brakeBand over the cap, off at it
      if (!braking && sp > cap + B.brakeBand) braking = true;
      else if (braking && sp < cap) braking = false;
      input.brake = r.onGround && braking;
      input.tuck = r.onGround && !braking && (straight || sp < B.tuckUnder) && bumps <= B.mogulAmpM && Math.abs(err) < 0.15;
      r.update(1 / 60, input);
      t += 1 / 60; acc += 1 / 60; vmax = Math.max(vmax, sp);
      const crashedNow = r.crashed > 0;
      if (crashedNow && !wasCrashed) crashes++;
      wasCrashed = crashedNow;
      if (acc >= 0.05) { // Replay.record's sample, 20 Hz
        acc = 0;
        const f = (r.onGround ? 1 : 0) | (input.tuck ? 2 : 0) | (r.crashed > 0 ? 4 : 0) | (r.switch ? 8 : 0) | (r.goofy ? 16 : 0);
        samples.push({ t: +t.toFixed(3), x: r.x, y: r.y, z: r.z, h: r.boardYaw, lg: r.lateralG, e: r.edgeAngle, f, hd: r.heading, vx: r.vx, vy: r.vy, vz: r.vz, ln: r.lean, fl: r.flip, sq: r.squat, jc: r.jumpCharge, on: r.onFoot ? 1 : 0, hc: r.hardCarve, cf: r.crashFall, cs: r.crashSide });
        if (seen(r.x, r.y, r.z)) { everSeen = true; hidden = 0; } else hidden += 0.05;
        if (everSeen && hidden > B.endAfterS && (done || si >= path.length - 10)) break;
        if (done && hidden > B.endAfterS) break;
        // a view that sees all the way down the valley: end tailS after the last waypoint (the menu fades it out)
        if (done && (tail += 0.05) > B.tailS) break;
      }
    }
    const vis = samples.map((s) => seen(s.x, s.y, s.z));
    const passed = Math.min(W.length, (path[Math.min(si, path.length - 1)][3] ?? 0) + (done ? 1 : 0));
    return { samples, crest, stats: { reached: `${passed}/${W.length}`, dur: +t.toFixed(1), inView: +(vis.filter(Boolean).length * 0.05).toFixed(1), firstSeen: vis.indexOf(true) < 0 ? -1 : +(vis.indexOf(true) * 0.05).toFixed(1), vmax: +vmax.toFixed(1), crashes, skipped } };
  };
  // a rider beside the lead: its take shifted `off(t)` metres across the averaged direction of travel, `lag` samples behind
  const beside = (A, off, lag, goofy) => A.map((q, i) => {
    const src = A[Math.max(0, i - lag)];
    const j0 = Math.max(0, i - lag - 30), j1 = Math.min(A.length - 1, Math.max(0, i - lag + 30));
    let dx = A[j1].x - A[j0].x, dy = A[j1].y - A[j0].y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const o = off(q.t), x = src.x + dy * o, y = src.y - dx * o;
    return { ...src, t: q.t, x, y, z: gz(x, y) + (src.z - gz(src.x, src.y)), f: (src.f & ~16) | (goofy ? 16 : 0) };
  });
  const firstSeen = (bs) => { const i = bs.findIndex((q) => seen(q.x, q.y, q.z)); return i < 0 ? -1 : i * 0.05; };
  const nearStart = (bs) => seen(bs[0].x, bs[0].y, bs[0].z) && camDist(bs[0].x, bs[0].y, bs[0].z) < G.nearM;
  const LAG = Math.round(G.lagS / 0.05);
  const out = [];
  // a variant's line: shifted `side` x (variantShiftFrac of the distance from the camera, variantShiftMinM..MaxM) across its way
  const shift = (W, side) => (side ? W.map((w, i) => {
    const a = W[Math.max(0, i - 1)], b = W[Math.min(W.length - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const o = side * Math.max(G.variantShiftMinM, Math.min(G.variantShiftMaxM, G.variantShiftFrac * (w[2] ?? 300)));
    return [w[0] + (b[1] - a[1]) / l * o, w[1] - (b[0] - a[0]) / l * o, w[2]];
  }) : W);
  for (const [name, raw] of Object.entries(world)) for (const [v, P] of (plan[name]?.variants ?? []).entries()) {
    if (!P.riders.length) continue;
    if (raw.length < C.minRun) { if (v === 0) out.push({ name, v, skipped: `only ${raw.length} points hit the terrain` }); continue; }
    let wp = waypoints(raw, false), a = sim(shift(wp.wps, P.shift), P.riders[0].discipline, P.phase, P.straight), allRuns = false;
    if (a.stats.inView < C.minInViewS) { const wp2 = waypoints(raw, true), a2 = sim(shift(wp2.wps, P.shift), P.riders[0].discipline, P.phase, P.straight); if (a2.stats.inView > a.stats.inView) { wp = wp2; a = a2; allRuns = true; } }
    const A = a.samples, n = P.riders.length;
    // the formation: rider i (1..n-1) on side +-1 alternately, further out each pair, lagS more behind each
    let spread = 1, riders = [A], minGap = Infinity, tries = 0;
    for (; n > 1 && tries < 6; tries++, spread += G.loosen) {
      const outSide = { 1: 0, '-1': 0 };
      riders = [A];
      for (let i = 1; i < n; i++) {
        const gap = (i === 1 ? G.gapM : G.gapMinM + ((i * 7 + name.length * 3) % (G.gapMaxM - G.gapMinM + 1))) * spread;
        const phase = i * 1.7, goofy = P.riders[i].goofy;
        const make = (side) => { const base = outSide[side] + gap; return { side, base, bs: beside(A, (t) => side * (base + G.driftM * Math.sin(t * 2 * Math.PI / G.driftPeriodS + phase)), LAG * i, goofy) }; };
        let pick = make(i % 2 ? P.side : -P.side);
        if (nearStart(pick.bs)) { const o = make(-pick.side); if (!nearStart(o.bs)) pick = o; } // would start in view close up
        outSide[pick.side] = pick.base;
        riders.push(pick.bs);
      }
      minGap = Infinity;
      for (let j = 0; j < A.length; j++) for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) minGap = Math.min(minGap, Math.hypot(riders[p][j].x - riders[q][j].x, riders[p][j].y - riders[q][j].y));
      if (minGap >= G.minGapM) break;
    }
    // the gap between the lead and its first partner while both ride (from when the partner sets off)
    let pairMin = Infinity, pairMax = 0;
    if (n > 1) for (let j = LAG; j < A.length; j++) { const d = Math.hypot(riders[0][j].x - riders[1][j].x, riders[0][j].y - riders[1][j].y); pairMin = Math.min(pairMin, d); pairMax = Math.max(pairMax, d); }
    // one cut for the whole group: cutBeforeS before the first of them comes into sight
    const seens = riders.map(firstSeen).filter((v) => v >= 0);
    const cut = seens.length ? Math.max(0, Math.min(...seens) - G.cutBeforeS) : 0;
    const group = riders.map((rs, i) => {
      const s = rs.filter((q) => q.t >= cut), s0 = s[0], sl = s[s.length - 1];
      const startSeen = seen(s0.x, s0.y, s0.z), startDist = Math.round(camDist(s0.x, s0.y, s0.z));
      return {
        rider: i + 1, samples: s,
        start: !startSeen ? 'out of sight' : startDist >= G.nearM ? (a.crest ? 'far crest (fades in)' : 'far (fades in)') : `in view ${startDist} m (fades in)`,
        startNear: startSeen && startDist < G.nearM,
        end: seen(sl.x, sl.y, sl.z) ? 'in view (fades out)' : 'out of sight',
        nearest: Math.round(Math.min(...s.map((q) => camDist(q.x, q.y, q.z)))),
        inView: +(s.filter((q) => seen(q.x, q.y, q.z)).length * 0.05).toFixed(1),
        vis: i === 0 ? s.map((q) => seen(q.x, q.y, q.z)) : undefined,
      };
    });
    out.push({ name, v, lead: { ...a.stats, cut: +cut.toFixed(1), line: `${wp.kept}/${wp.of} pts${allRuns ? ' (all runs)' : ''}, ${wp.near}..${wp.far} m out` }, minGap: n > 1 ? +minGap.toFixed(1) : null, pair: n > 1 ? [+pairMin.toFixed(1), +pairMax.toFixed(1)] : null, loosened: tries, group, wps: wp.wps });
  }
  return out;
}

/** Project world points (pack x, y, z) into the image through the fitted camera (pose at fit.k). [u, v] or null behind it. */
export function project({ paths, fit, rw, rh }) {
  const S = window.__sim, cam = S.cam.camera, V = cam.position.constructor;
  cam.updateMatrixWorld();
  return paths.map((p) => p.map(([x, y, z]) => {
    const v = new V(x, z + 1, -y).project(cam);
    if (v.z > 1) return null;
    return [(v.x + 1) / 2 * rw * fit.s + fit.ox, (1 - v.y) / 2 * rh * fit.s + fit.oy];
  }));
}

/** The check picture: the image dimmed, each line as found (numbered, white edged) and its lead's ridden path (dots every 0.5 s, hollow where the shot doesn't see it). */
export async function overlay({ url, lines, rides, box }) {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, c.width, c.height);
  if (box) { g.strokeStyle = 'rgba(255,255,255,0.8)'; g.setLineDash([8, 6]); g.lineWidth = 1; g.strokeRect(box[0] + 0.5, box[1] + 0.5, box[2] - box[0] - 1, box[3] - box[1] - 1); g.setLineDash([]); }
  const col = (l) => (l.hue === null ? '#000' : `hsl(${l.hue},100%,55%)`);
  lines.forEach((l, n) => {
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = '#fff'; g.lineWidth = 5; g.beginPath(); l.px.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    g.strokeStyle = col(l); g.lineWidth = 3; g.stroke();
    const [x0, y0] = l.px[0];
    const label = `${n + 1} ${l.name}`;
    g.font = 'bold 15px sans-serif'; g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 3;
    g.strokeText(label, x0 + 6, y0 - 6); g.fillText(label, x0 + 6, y0 - 6);
  });
  for (const r of rides) {
    const l = lines.find((q) => q.name === r.name);
    if (!l) continue;
    r.pts.forEach((p, i) => {
      if (!p || i % 10) return;
      g.beginPath(); g.arc(p[0], p[1], 3.5, 0, Math.PI * 2);
      g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke();
      if (r.vis[i]) { g.fillStyle = col(l); g.fill(); }
    });
  }
  return c.toDataURL('image/png');
}

/**
 * The menu as it plays, at `times` (s): with the takes `before` loaded, then with `after` added. Returns a frame
 * (with everything) and the draw calls with and without the added takes at each time.
 */
export async function preview({ before, after, times }) {
  const S = window.__sim, cam = S.cam.camera, g = S.ghosts, info = S.renderer.info;
  const p0 = S.shotPose(0);
  g.setVisible(true);
  info.autoReset = false;
  const frame = (t) => {
    S.shotConditions?.();
    S.eyeAt(p0.x, p0.y, p0.h, p0.pitch, p0.fov, p0.eye); window.__step(1, 0); cam.updateMatrixWorld();
    g.restartOutOfView(cam);
    const p = S.shotPose(t); S.eyeAt(p.x, p.y, p.h, p.pitch, p.fov, p.eye); window.__step(1, 0); cam.updateMatrixWorld();
    g.update(t); g.update(0);
    info.reset(); const png = window.__shot(); return { calls: info.render.calls, png };
  };
  await g.load('./', before);
  const without = times.map((t) => frame(t).calls);
  await g.load('./', after);
  const res = times.map((t, i) => { const f = frame(t); return { t, calls: f.calls, callsBefore: without[i], png: f.png }; });
  info.autoReset = true;
  g.setVisible(false);
  return { frames: res, count: g.count };
}

/** Takes as positions over time (for the gap check across every pair): [{ file, build, pts: [[x, y, in frame] or null per 0.1 s of menu time] }] (in the frame where the menu goes live). */
export async function takePaths({ files, horizon = 120 }) {
  const S = window.__sim, cam = S.cam.camera, V = cam.position.constructor;
  const p0 = S.shotPose(0); S.eyeAt(p0.x, p0.y, p0.h, p0.pitch, p0.fov, p0.eye); window.__step(1, 0); cam.updateMatrixWorld();
  const inFrame = (x, y, z) => { const v = new V(x, z + 1, -y).project(cam); return v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1; };
  const out = [];
  for (const f of files) {
    try {
      const r = await fetch(`./attract/${window.__sim.pack.meta.slug}/${f}`);
      if (!r.ok) continue;
      const tk = await r.json(), s = tk.samples, t0 = s[0].t, pts = [], dur = s[s.length - 1].t - t0;
      // menu time (every take starts with the menu, after its delay, again every `every` seconds), null while it isn't out
      const delay = tk.delay ?? 0, every = Math.max(dur, tk.every ?? 0);
      const at = (lt) => { let lo = 0, hi = s.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].t - t0 <= lt) lo = m; else hi = m; } return s[lo]; };
      for (let t = 0; t <= horizon; t += 0.1) {
        const lt = t < delay ? -1 : (t - delay) % every;
        if (lt < 0 || lt > dur) { pts.push(null); continue; }
        const q = at(lt); pts.push([q.x, q.y, inFrame(q.x, q.y, q.z)]);
      }
      out.push({ file: f, build: tk.build ?? null, pts });
    } catch { /* skip */ }
  }
  return out;
}

/**
 * Go on from a recorded take's last sample down the fall line with the bot (linked turns, grab in the air) until the
 * rider is out of sight (endAfterS) or tailS more seconds in view. Returns { samples, added (s), end } or added 0 when
 * the take already ends out of sight.
 */
export async function extend({ samples, cfg }) {
  const { bot: B } = cfg;
  const S = window.__sim, pack = S.pack, cam = S.cam.camera, V = cam.position.constructor, RiderC = S.rider.constructor;
  const p0 = S.shotPose(0); S.eyeAt(p0.x, p0.y, p0.h, p0.pitch, p0.fov, p0.eye); window.__step(1, 0); cam.updateMatrixWorld();
  const last = samples[samples.length - 1];
  pack.fine.request(last.x - 800, last.y - 800, last.x + 800, last.y + 800);
  for (let i = 0; i < 200 && Number.isNaN(pack.fine.sample(last.x, last.y)); i++) { window.__step(1, 0); await new Promise((r) => setTimeout(r, 50)); }
  const gz = (x, y) => pack.groundHeight(x, y, 9000);
  const inFrame = (x, y, z) => { const v = new V(x, z + 1, -y).project(cam); return v.z < 1 && Math.abs(v.x) < 1.02 && Math.abs(v.y) < 1.02; };
  const occluded = (x, y, z) => { const c = cam.position; const w = new V(x, z + 1, -y); for (let k = 0.02; k < 0.97; k += 0.01) { const px = c.x + (w.x - c.x) * k, py = -(c.z + (w.z - c.z) * k), pz = c.y + (w.y - c.y) * k; const g = gz(px, py); if (Number.isFinite(g) && g > pz + 0.5) return true; } return false; };
  const seen = (x, y, z) => inFrame(x, y, z) && !occluded(x, y, z);
  if (!seen(last.x, last.y, last.z)) return { samples: [], added: 0 };
  const fallDir = (x, y) => { const e = 3, gx = gz(x + e, y) - gz(x - e, y), gy = gz(x, y + e) - gz(x, y - e), l = Math.hypot(gx, gy) || 1; return [-gx / l, -gy / l]; };
  const r = new RiderC(pack, null);
  r.discipline = 'board'; r.fallLine = 0; r.goofy = !!(last.f & 16);
  r.reset(last.x, last.y, last.hd); r.vx = last.vx; r.vy = last.vy;
  const input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
  const out = []; let t = 0, acc = 0, hidden = 0, braking = false, phase = 0, amp = -1, end = 'tail in view (fades out)';
  const lam = (d) => Math.max(B.turnMinM, Math.min(B.turnMaxM, B.turnBaseM + B.turnFrac * d));
  for (let step = 0; step < 60 * B.maxS; step++) {
    const sp = Math.hypot(r.vx, r.vy), dt = 1 / 60, cd = cam.position.distanceTo(new V(r.x, r.z, -r.y));
    let cap = Math.min(B.brakeOver, Math.max(B.brakeMin, B.brakeFrac * cd));
    const bumps = pack.mogulAmp ? pack.mogulAmp(r.x, r.y) : 0;
    if (bumps > B.mogulAmpM) cap = Math.min(cap, B.mogulOver);
    const look = Math.max(B.lookMinM, Math.min(B.lookMaxM, B.lookFrac * sp)), L = lam(cd);
    if (amp < 0) amp = B.turnStartShare * L;
    amp = Math.max(B.turnMinShare * L, Math.min(B.turnMaxShare * L, amp + B.turnGain * (sp - cap) * dt));
    phase += 2 * Math.PI * sp * dt / L;
    const [fx, fy] = fallDir(r.x, r.y), off = amp * Math.sin(phase + 2 * Math.PI * look / L);
    const tx = fx * look + fy * off, ty = fy * look - fx * off;
    let err = Math.atan2(tx, ty) - r.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
    input.steer += (Math.max(-B.steerCap, Math.min(B.steerCap, err * B.steerGain)) - input.steer) * Math.min(1, dt / B.steerEaseS);
    input.grab = !r.onGround; if (!r.onGround) input.steer = 0;
    if (!braking && sp > cap + B.brakeBand) braking = true; else if (braking && sp < cap) braking = false;
    input.brake = r.onGround && braking; input.tuck = false;
    r.update(dt, input);
    t += dt; acc += dt;
    if (acc >= 0.05) {
      acc = 0;
      const f = (r.onGround ? 1 : 0) | (r.crashed > 0 ? 4 : 0) | (r.switch ? 8 : 0) | (r.goofy ? 16 : 0);
      out.push({ t: +(last.t + t).toFixed(3), x: r.x, y: r.y, z: r.z, h: r.boardYaw, lg: r.lateralG, e: r.edgeAngle, f, hd: r.heading, vx: r.vx, vy: r.vy, vz: r.vz, ln: r.lean, fl: r.flip, sq: r.squat, jc: r.jumpCharge, on: r.onFoot ? 1 : 0, hc: r.hardCarve, cf: r.crashFall, cs: r.crashSide });
      hidden = seen(r.x, r.y, r.z) ? 0 : hidden + 0.05;
      if (hidden > B.endAfterS) { end = 'out of sight'; break; }
      if (t > B.extendMaxS) break;
    }
  }
  return { samples: out, added: t, end };
}

/**
 * Copies of a recorded take beside it: each sample shifted `shift(t)` metres across the averaged direction of travel,
 * `lag` samples behind, on the snow there (the same height above it), with the take's own pose: the rider moves the
 * way it was ridden. `goofy` sets the stance flag. Returns the samples.
 */
export function shiftedTake({ samples, shifts }) {
  const pack = window.__sim.pack, gz = (x, y) => pack.groundHeight(x, y, 9000), A = samples;
  return shifts.map(({ base, drift, period, phase, lag, goofy }) => A.map((q, i) => {
    const src = A[Math.max(0, i - lag)];
    const j0 = Math.max(0, i - lag - 30), j1 = Math.min(A.length - 1, Math.max(0, i - lag + 30));
    let dx = A[j1].x - A[j0].x, dy = A[j1].y - A[j0].y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const o = base + drift * Math.sin((q.t - A[0].t) * 2 * Math.PI / period + phase), x = src.x + dy * o, y = src.y - dx * o;
    return { ...src, t: q.t, x, y, z: gz(x, y) + (src.z - gz(src.x, src.y)), f: (src.f & ~16) | (goofy ? 16 : 0) };
  }));
}
