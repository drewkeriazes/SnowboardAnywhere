// Ghost lines prototype, step 3: ride each cast line with the real rider physics (a steering bot), two riders
// per line, and write backdrop takes.
// node docs/research/ghost-lines-prototype/ride_lines.mjs <pack> <in.world.json> <out dir> [--prefix line2]
// Writes <out dir>/<prefix>-<line>-lead.json and -mate.json (AttractTake, backdrop: true). Copy them to
// game/public/attract/<pack>/ and list them under the pack's "ghosts" in game/public/attract/index.json.
// Prints per rider: waypoints reached, length, seconds in view, first seen, vmax, crashes, stalls skipped,
// nearest distance to the camera, and for the lead which part of the line it kept.
import fs from 'node:fs';
import path from 'node:path';
import { openPage, arg } from './common.mjs';

const [pack, inFile, outDir] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const PREFIX = arg('prefix', 'line');
const world = JSON.parse(fs.readFileSync(inFile, 'utf8'));
// two different outfits per line, neighbouring lines different again, alternate sides and stances
const OUTFITS = ['Classic red', 'Neon 90s', 'Safety orange', 'Powder blue', 'Forest', 'All black'];
const PLAN = Object.fromEntries(Object.keys(world).map((n, i) => [n, [OUTFITS[(i * 2) % 6], OUTFITS[(i * 2 + 3) % 6], i % 2 ? -1 : 1, i % 3 === 1]]));
const { page, close } = await openPage(pack);
const res = await page.evaluate(async ({ world, PLAN }) => {
  const S = window.__sim, pack = S.pack, cam = S.cam.camera;
  const V = cam.position.constructor, RiderC = S.rider.constructor;
  const all = Object.values(world).flat();
  const xs = all.map((q) => q[0]), ys = all.map((q) => q[1]);
  pack.fine.request(Math.min(...xs) - 600, Math.min(...ys) - 600, Math.max(...xs) + 600, Math.max(...ys) + 600);
  pack.mask?.request(Math.min(...xs) - 600, Math.min(...ys) - 600, Math.max(...xs) + 600, Math.max(...ys) + 600);
  // the shot's pose where the menu goes live: what decides "in sight"
  const p0 = S.shotPose(0); S.eyeAt(p0.x, p0.y, p0.h, p0.pitch, p0.fov, p0.eye);
  for (let i = 0; i < 400; i++) { window.__step(1, 1 / 60); if (all.every(([x, y]) => !Number.isNaN(pack.fine.sample(x, y)))) break; await new Promise((r) => setTimeout(r, 50)); }
  window.__step(1, 0); cam.updateMatrixWorld();
  const gz = (x, y) => pack.groundHeight(x, y, 5000);
  const inFrame = (x, y, z) => { const v = new V(x, z + 1, -y).project(cam); return v.z < 1 && Math.abs(v.x) < 1.02 && Math.abs(v.y) < 1.02; };
  const occluded = (x, y, z) => { const c = cam.position; const w = new V(x, z + 1, -y); for (let k = 0.02; k < 0.97; k += 0.01) { const px = c.x + (w.x - c.x) * k, py = -(c.z + (w.z - c.z) * k), pz = c.y + (w.y - c.y) * k; const g = gz(px, py); if (Number.isFinite(g) && g > pz + 0.5) return true; } return false; };
  const seen = (x, y, z) => inFrame(x, y, z) && !occluded(x, y, z);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // waypoints: the line's longest run on one stretch of visible snow (a cast line jumps between slopes where it
  // crosses an edge), ridden from its high end, hits that keep descending, about 6% of their distance apart (8..50 m)
  const waypoints = (raw, allRuns = false) => {
    const runs = [[raw[0]]];
    for (const q of raw.slice(1)) { const last = runs[runs.length - 1].at(-1); if (dist(q, last) > Math.max(30, 0.05 * q[3])) runs.push([q]); else runs[runs.length - 1].push(q); }
    let p = allRuns ? runs.filter((r) => r.length >= 5).flat() : runs.reduce((a, b) => (b.length > a.length ? b : a));
    if (p[0][2] < p[p.length - 1][2]) p = p.slice().reverse();
    const out = [p[0]];
    for (const q of p.slice(1)) {
      const last = out[out.length - 1], d = dist(q, last);
      if (d < Math.max(8, Math.min(50, 0.06 * q[3]))) continue;
      if (q[2] > last[2] - Math.max(0.3, 0.04 * d)) continue;
      out.push(q);
    }
    const end = p[p.length - 1]; if (dist(end, out[out.length - 1]) > 6 && end[2] < out[out.length - 1][2]) out.push(end);
    return { wps: out.map(([x, y]) => [x, y]), kept: p.length, of: raw.length, near: Math.round(Math.min(...p.map((q) => q[3]))), far: Math.round(Math.max(...p.map((q) => q[3]))) };
  };
  const fallDir = (x, y) => { const e = 3, gx = gz(x + e, y) - gz(x - e, y), gy = gz(x, y + e) - gz(x, y - e), l = Math.hypot(gx, gy) || 1; return [-gx / l, -gy / l]; };
  const sim = (W) => {
    // start: back from the first waypoint until out of sight; beyond 300 m never back over a crest (backing up
    // must climb), so a line under a skyline starts at the crest and comes over it (the game fades it in)
    const l0 = dist(W[0], W[1]), ux = (W[1][0] - W[0][0]) / l0, uy = (W[1][1] - W[0][1]) / l0;
    let sx = W[0][0], sy = W[0][1], hiddenFor = 0;
    for (let s = 2; s < 300; s += 2) {
      const bx = W[0][0] - ux * s, by = W[0][1] - uy * s;
      if (cam.position.distanceTo(new V(bx, gz(bx, by), -by)) > 300 && gz(bx, by) < gz(sx, sy) + 0.1) break;
      sx = bx; sy = by;
      if (!seen(sx, sy, gz(sx, sy))) { hiddenFor += 2; if (hiddenFor > 4) break; } else hiddenFor = 0;
    }
    const r = new RiderC(pack, null);
    r.discipline = 'board'; r.fallLine = 0; // fall line off: the Realistic fall line's edge catches crash a bot on traverses
    r.reset(sx, sy, Math.atan2(ux, uy)); r.vx = ux * 8; r.vy = uy * 8;
    const input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
    const samples = []; let t = 0, acc = 0.05, wi = 0, hidden = 0, everSeen = false, crashes = 0, vmax = 0, dsum = 0, done = false, stall = 0, skipped = 0;
    for (let step = 0; step < 60 * 180; step++) {
      const sp = Math.hypot(r.vx, r.vy);
      let tx, ty;
      // skip a waypoint that isn't below the rider (the far side of a dip), and one the rider stalls on for 2 s
      while (wi < W.length && gz(W[wi][0], W[wi][1]) > r.z - Math.min(2, 0.04 * dist([r.x, r.y], W[wi]))) wi++;
      stall = sp < 2.5 ? stall + 1 / 60 : 0;
      if (stall > 2 && wi < W.length) { wi++; stall = 0; skipped++; }
      if (wi < W.length) {
        const w = W[wi], d = dist([r.x, r.y], w), prev = wi > 0 ? W[wi - 1] : [sx, sy];
        const lx = w[0] - prev[0], ly = w[1] - prev[1];
        if (d < 18 || ((r.x - w[0]) * lx + (r.y - w[1]) * ly) > 0) { wi++; continue; } // reached or passed
        // carve: aim at a point swung 7 m across the leg on a 40 m wave
        const ll = Math.hypot(lx, ly) || 1, nx = ly / ll, ny = -lx / ll;
        dsum += sp / 60;
        const swing = 7 * Math.sin(dsum * 2 * Math.PI / 40);
        tx = w[0] + nx * swing - r.x; ty = w[1] + ny * swing - r.y;
      } else {
        done = true; // past the line: down the fall line until out of sight
        const [fx, fy] = fallDir(r.x, r.y); dsum += sp / 60;
        const swing = 0.5 * Math.sin(dsum * 2 * Math.PI / 40);
        tx = fx + fy * swing; ty = fy - fx * swing;
      }
      let err = Math.atan2(tx, ty) - r.heading; err = Math.atan2(Math.sin(err), Math.cos(err));
      input.steer = Math.max(-0.75, Math.min(0.75, err * 1.6)); // full steer at speed washes out
      input.brake = sp > 16; input.tuck = sp < 8 && Math.abs(err) < 0.15;
      r.update(1 / 60, input);
      t += 1 / 60; acc += 1 / 60; vmax = Math.max(vmax, sp);
      if (r.crashed > 0) crashes++;
      if (acc >= 0.05) { // Replay.record's sample, 20 Hz
        acc = 0;
        const f = (r.onGround ? 1 : 0) | (input.tuck ? 2 : 0) | (r.crashed > 0 ? 4 : 0) | (r.switch ? 8 : 0) | (r.goofy ? 16 : 0);
        samples.push({ t: +t.toFixed(3), x: r.x, y: r.y, z: r.z, h: r.boardYaw, lg: r.lateralG, e: r.edgeAngle, f, hd: r.heading, vx: r.vx, vy: r.vy, vz: r.vz, ln: r.lean, fl: r.flip, sq: r.squat, jc: r.jumpCharge, on: r.onFoot ? 1 : 0, hc: r.hardCarve, cf: r.crashFall, cs: r.crashSide });
        if (seen(r.x, r.y, r.z)) { everSeen = true; hidden = 0; } else hidden += 0.05;
        if (everSeen && hidden > 1.5 && (done || wi >= W.length - 1)) break;
        if (done && hidden > 1.5) break;
      }
    }
    const vis = samples.map((s) => seen(s.x, s.y, s.z));
    const near = Math.min(...samples.map((s) => cam.position.distanceTo(new V(s.x, s.z, -s.y))));
    return { samples, stats: { reached: `${Math.min(wi, W.length)}/${W.length}`, dur: +t.toFixed(1), inView: +(vis.filter(Boolean).length * 0.05).toFixed(1), firstSeen: +(vis.indexOf(true) * 0.05).toFixed(1), vmax: +vmax.toFixed(1), crashes, skipped, nearest: Math.round(near) } };
  };
  const out = [];
  for (const [name, raw] of Object.entries(world)) {
    if (raw.length < 5) continue;
    const [lead, mate, side, goofy] = PLAN[name];
    let wp = waypoints(raw), a = sim(wp.wps);
    if (a.stats.inView < 3) { wp = waypoints(raw, true); a = sim(wp.wps); wp.near = `all runs, ${wp.near}`; } // never on screen: use every run
    // the partner rides beside the lead: the lead's take shifted 5 m (+-1.5 m drift) across its averaged direction of
    // travel, 0.5 s behind, on the snow there, with the lead's pose. Simulating a partner separately drifted 100+ m apart.
    const A = a.samples, LAG = 10;
    const beside = (sd) => {
      const bs = A.map((q, i) => {
        const src = A[Math.max(0, i - LAG)];
        const j0 = Math.max(0, i - LAG - 30), j1 = Math.min(A.length - 1, i - LAG + 30);
        let dx = A[Math.max(0, j1)].x - A[j0].x, dy = A[Math.max(0, j1)].y - A[j0].y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
        const off = sd * (5 + 1.5 * Math.sin(q.t * 2 * Math.PI / 23));
        const x = src.x + dy * off, y = src.y - dx * off;
        return { ...src, t: q.t, x, y, z: gz(x, y) + (src.z - gz(src.x, src.y)), f: (src.f & ~16) | (goofy ? 16 : 0) };
      });
      const visB = bs.map((q) => seen(q.x, q.y, q.z));
      const startNear = visB[0] && cam.position.distanceTo(new V(bs[0].x, bs[0].z, -bs[0].y)) < 300;
      return { samples: bs, stats: { side: sd, firstSeen: +(visB.indexOf(true) * 0.05).toFixed(1), inView: +(visB.filter(Boolean).length * 0.05).toFixed(1), startNear } };
    };
    let b = beside(side);
    if (b.stats.startNear) { const o = beside(-side); if (!o.stats.startNear) b = o; } // would start in view close up: other side
    // both start 1 s before the first of them comes into sight (one cut keeps them together)
    const cut = Math.max(0, Math.min(a.stats.firstSeen, b.stats.firstSeen) - 1);
    for (const r of [a, b]) { r.samples = r.samples.filter((q) => q.t >= cut); r.stats.cut = +cut.toFixed(1); }
    a.stats.line = `${wp.kept}/${wp.of} pts, ${wp.near}..${wp.far} m out`;
    out.push({ name, who: 'lead', outfit: lead, goofy: false, ...a }, { name, who: 'mate', outfit: mate, goofy, ...b });
  }
  return out;
}, { world, PLAN });
fs.mkdirSync(outDir, { recursive: true });
for (const r of res) {
  const t0 = r.samples[0].t;
  const take = { version: 1, pack, discipline: 'board', stance: r.goofy ? 'goofy' : 'regular', outfit: r.outfit, backdrop: true, samples: r.samples.map((s) => Object.fromEntries(Object.entries({ ...s, t: s.t - t0 }).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v]))) };
  fs.writeFileSync(path.join(outDir, `${PREFIX}-${r.name.toLowerCase()}-${r.who}.json`), JSON.stringify(take));
  console.log(r.name.padEnd(10), r.who, r.outfit.padEnd(14), JSON.stringify(r.stats));
}
await close();
