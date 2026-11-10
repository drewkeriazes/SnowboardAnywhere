// FEAT-181: the image side of ghost_lines.mjs, plain functions on pixel arrays (no browser, no three.js).
//   fitShot     where the game's render of the shot sits in a screenshot (scale, offset, drift phase), from edges
//   extractLines the lines drawn on the screenshot, as ordered pixel polylines named by colour
// An image is { w, h, data } with data RGBA bytes (ImageData layout). A grey image is { w, h, g: Float32Array }.

/** luminance 0..255 */
export function grey(img) {
  const { w, h, data } = img, g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return { w, h, g };
}

/** 1D area resample of `n` values (stride `st`, from `off`) to `m`: each output averages the input it covers */
function area1(src, off, st, n, m, dst, doff, dst_st) {
  const r = n / m;
  for (let i = 0; i < m; i++) {
    const a = i * r, b = a + r;
    let s = 0, wsum = 0;
    for (let k = Math.floor(a); k < Math.min(n, Math.ceil(b)); k++) {
      const w = Math.min(b, k + 1) - Math.max(a, k);
      if (w > 0) { s += src[off + k * st] * w; wsum += w; }
    }
    dst[doff + i * dst_st] = wsum ? s / wsum : 0;
  }
}
/** a grey image resized to w x h (area averaging down, nearest-ish up) */
export function resize(im, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const tmp = new Float32Array(w * im.h), out = new Float32Array(w * h);
  for (let y = 0; y < im.h; y++) area1(im.g, y * im.w, 1, im.w, w, tmp, y * w, 1);
  for (let x = 0; x < w; x++) area1(tmp, x, w, im.h, h, out, x, w);
  return { w, h, g: out };
}

/** edge strength: the gradient magnitude, square-rooted so a few hard edges (UI text) don't outweigh the terrain */
export function edges(im) {
  const { w, h, g } = im, e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w];
    e[i] = Math.sqrt(Math.hypot(gx, gy));
  }
  return { w, h, g: e };
}

// ---- FFT (radix 2, in place), for the coarse search ----
function fft1(re, im, n, off, st, inv) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const a = off + i * st, b = off + j * st; let t = re[a]; re[a] = re[b]; re[b] = t; t = im[a]; im[a] = im[b]; im[b] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = off + (i + k) * st, b = off + (i + k + len / 2) * st;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function fft2(re, im, W, H, inv) {
  for (let y = 0; y < H; y++) fft1(re, im, W, y * W, 1, inv);
  for (let x = 0; x < W; x++) fft1(re, im, H, x, W, inv);
  if (inv) { const n = W * H; for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; } }
}
/** the FFT of a w x h real array placed at the origin of a W x H zero field */
function spec(a, w, h, W, H) {
  const re = new Float64Array(W * H), im = new Float64Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) re[y * W + x] = a[y * w + x];
  fft2(re, im, W, H, false);
  return [re, im];
}
/** two cross-correlations in one inverse FFT: conj(A1) B1 + i conj(A2) B2 (both results are real) */
function xcorr2(A1, B1, A2, B2, W, H) {
  const n = W * H, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = A1[0][i] * B1[0][i] + A1[1][i] * B1[1][i], q = A1[0][i] * B1[1][i] - A1[1][i] * B1[0][i];
    const r = A2[0][i] * B2[0][i] + A2[1][i] * B2[1][i], s = A2[0][i] * B2[1][i] - A2[1][i] * B2[0][i];
    re[i] = p - s; im[i] = q + r;
  }
  fft2(re, im, W, H, true);
  return [re, im];
}
const pow2 = (n) => 2 ** Math.ceil(Math.log2(n));

/**
 * Masked normalised cross-correlation of the render `I` (all valid) against the screenshot `T` at every offset
 * (render pixel p sits on screenshot pixel p + o). Returns the best offsets, each { ox, oy, score }.
 */
function nccAll(I, T, minOverlap, top = 3) {
  const W = pow2(I.w + T.w), H = pow2(I.h + T.h);
  const ones = (n) => new Float32Array(n).fill(1);
  const sq = (a) => a.map((v) => v * v);
  const FT = spec(T.g, T.w, T.h, W, H), FT2 = spec(sq(T.g), T.w, T.h, W, H), FMt = spec(ones(T.w * T.h), T.w, T.h, W, H);
  const FI = spec(I.g, I.w, I.h, W, H), FI2 = spec(sq(I.g), I.w, I.h, W, H), FMi = spec(ones(I.w * I.h), I.w, I.h, W, H);
  const [A, B] = xcorr2(FI, FT, FI, FMt, W, H); // sum I T, sum I Mt
  const [C, N] = xcorr2(FMi, FT, FMi, FMt, W, H); // sum Mi T, sum Mi Mt
  const [D, E] = xcorr2(FI2, FMt, FMi, FT2, W, H); // sum I^2 Mt, sum Mi T^2
  const best = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, n = N[i];
    if (n < minOverlap) continue;
    const num = A[i] - B[i] * C[i] / n, d1 = D[i] - B[i] * B[i] / n, d2 = E[i] - C[i] * C[i] / n;
    if (d1 <= 1e-6 || d2 <= 1e-6) continue;
    const score = num / Math.sqrt(d1 * d2);
    // circular index -> offset of the render on the screenshot
    const ox = x > W - I.w ? x - W : x, oy = y > H - I.h ? y - H : y;
    if (best.length < top || score > best[best.length - 1].score) {
      best.push({ ox, oy, score }); best.sort((a, b) => b.score - a.score);
      // keep distinct peaks only
      for (let j = 1; j < best.length; j++) if (Math.abs(best[j].ox - best[j - 1].ox) < 3 && Math.abs(best[j].oy - best[j - 1].oy) < 3) best.splice(j--, 1);
      best.length = Math.min(best.length, top);
    }
  }
  return best;
}

/** NCC of the render placed at (ox, oy) on the screenshot, over their overlap (null under minOverlap pixels) */
function nccAt(I, T, ox, oy, minOverlap) {
  const x0 = Math.max(0, ox), y0 = Math.max(0, oy), x1 = Math.min(T.w, ox + I.w), y1 = Math.min(T.h, oy + I.h);
  const n = (x1 - x0) * (y1 - y0);
  if (x1 <= x0 || y1 <= y0 || n < minOverlap) return null;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y++) {
    const ti = y * T.w, ii = (y - oy) * I.w - ox;
    for (let x = x0; x < x1; x++) { const a = T.g[ti + x], b = I.g[ii + x]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; }
  }
  const d = (saa - sa * sa / n) * (sbb - sb * sb / n);
  return d > 1e-9 ? (sab - sa * sb / n) / Math.sqrt(d) : null;
}

/**
 * Where the game's render of the shot sits in the screenshot. `renders` are the shot rendered at drift phases
 * [{ k, img }] (all the same size, the full canvas at the shot's fov); the screenshot may hold browser bars, the
 * taskbar, the menu's UI and a cropped or scaled canvas. Unknowns: the scale (screenshot px per render px), the
 * offset (render pixel p on screenshot pixel p * s + o) and the drift phase k. A coarse search over the scale by
 * FFT (at k = 0.5), then a local search at finer levels with k free.
 * Returns { k, s, ox, oy, score, overlap } (offsets in screenshot pixels; overlap is the share of the screenshot covered).
 */
export function fitShot(shot, renders, { sMin = 0.25, sMax = 2.5, log = () => {} } = {}) {
  const S0 = grey(shot), R0 = renders.map((r) => ({ k: r.k, g: grey(r.img) }));
  const mid = R0.reduce((a, b) => (Math.abs(b.k - 0.5) < Math.abs(a.k - 0.5) ? b : a));
  // coarse: the screenshot at 128 px on its long side
  let r = Math.max(S0.w, S0.h) / 128;
  let T = edges(resize(S0, S0.w / r, S0.h / r));
  const minOv = (t) => 0.45 * t.w * t.h;
  const cands = [];
  for (let s = sMin; s <= sMax * 1.0001; s *= 1.03) {
    const I = edges(resize(mid.g, mid.g.w * s / r, mid.g.h * s / r));
    if (I.w < 8 || I.h < 8) continue;
    for (const b of nccAll(I, T, minOv(T), 2)) cands.push({ k: mid.k, s, ox: b.ox, oy: b.oy, score: b.score });
  }
  cands.sort((a, b) => b.score - a.score);
  // the best few distinct (scale and place) starts
  const starts = [];
  for (const c of cands) {
    if (starts.some((d) => Math.abs(Math.log(c.s / d.s)) < 0.05 && Math.abs(c.ox * r / c.s - d.ox * r / d.s) < 30)) continue;
    starts.push(c); if (starts.length >= 4) break;
  }
  log(`coarse: ${starts.map((c) => `s ${c.s.toFixed(3)} at (${Math.round(c.ox * r)}, ${Math.round(c.oy * r)}) ncc ${c.score.toFixed(3)}`).join('; ')}`);
  // refine: 256, 512, 1024 px on the long side; offsets in level pixels
  let results = starts.map((c) => ({ ...c, ox: c.ox * r, oy: c.oy * r })); // offsets in screenshot px
  const ks = R0.map((x) => x.k);
  for (const [long, sStep, first] of [[256, 0.01, true], [512, 0.005, false], [1024, 0.0025, false]]) {
    const rl = Math.max(1, Math.max(S0.w, S0.h) / long);
    T = edges(resize(S0, S0.w / rl, S0.h / rl));
    const cache = new Map();
    const render = (ki, s) => { const key = `${ki}|${s.toFixed(5)}`; if (!cache.has(key)) { const g = R0[ki].g; cache.set(key, edges(resize(g, g.w * s / rl, g.h * s / rl))); } return cache.get(key); };
    results = results.map((c) => {
      let best = { ...c, score: -2 };
      const kis = first ? ks.map((_, i) => i) : [ks.indexOf(c.k) - 1, ks.indexOf(c.k), ks.indexOf(c.k) + 1].filter((i) => i >= 0 && i < ks.length);
      const span = first ? 3 : 2;
      for (const ki of kis) for (let j = -2; j <= 2; j++) {
        const s = c.s * (1 + sStep * j), I = render(ki, s);
        const bx = Math.round(c.ox / rl), by = Math.round(c.oy / rl);
        for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
          const v = nccAt(I, T, bx + dx, by + dy, minOv(T));
          if (v !== null && v > best.score) best = { k: ks[ki], s, ox: (bx + dx) * rl, oy: (by + dy) * rl, score: v };
        }
      }
      return best;
    });
    results.sort((a, b) => b.score - a.score);
    log(`refine ${long}: ${results.map((c) => `k ${c.k} s ${c.s.toFixed(4)} at (${Math.round(c.ox)}, ${Math.round(c.oy)}) ncc ${c.score.toFixed(3)}`).join('; ')}`);
    results = results.slice(0, first ? 2 : 1);
  }
  const b = results[0], rw = R0[0].g.w * b.s, rh = R0[0].g.h * b.s;
  const ov = (Math.min(S0.w, b.ox + rw) - Math.max(0, b.ox)) * (Math.min(S0.h, b.oy + rh) - Math.max(0, b.oy)) / (S0.w * S0.h);
  return { k: b.k, s: b.s, ox: b.ox, oy: b.oy, score: b.score, overlap: ov };
}

// ---- line extraction ----

/** the named colours lines are called by (hue in degrees) */
const HUES = [['red', 0], ['orange', 28], ['yellow', 52], ['lime', 85], ['green', 125], ['teal', 160], ['cyan', 190], ['blue', 222], ['purple', 270], ['pink', 312]];
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
export const colourName = (hue) => HUES.reduce((a, b) => (hueDist(hue, b[1]) < hueDist(hue, a[1]) ? b : a))[0];

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, mx ? d / mx : 0, mx];
}

/**
 * The aligned render in screenshot pixels (nearest render pixel), and the canvas: where the screenshot shows the
 * game (inside the render's footprint, in rows and columns that match it; the browser bars, taskbar and a desktop
 * beside a cropped window do not).
 */
export function alignRender(shot, render, fit) {
  const { w, h } = shot, ref = new Uint8ClampedArray(w * h * 4), inside = new Uint8Array(w * h);
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    const x = Math.floor((u + 0.5 - fit.ox) / fit.s), y = Math.floor((v + 0.5 - fit.oy) / fit.s);
    if (x < 0 || y < 0 || x >= render.w || y >= render.h) continue;
    const i = v * w + u, j = (y * render.w + x) * 4;
    inside[i] = 1; ref[i * 4] = render.data[j]; ref[i * 4 + 1] = render.data[j + 1]; ref[i * 4 + 2] = render.data[j + 2]; ref[i * 4 + 3] = 255;
  }
  // the render is the canvas's full height and at least its width, so its footprint is the canvas (a colour test
  // per row or column doesn't work: the menu darkens the backdrop behind its text and cards). A desktop showing
  // beside a narrow window would be inside the footprint: leave it out with --ignore.
  const rowOk = new Uint8Array(h), colOk = new Uint8Array(w);
  for (let v = 0; v < h; v++) { let n = 0; for (let u = 0; u < w; u += 4) n += inside[v * w + u]; rowOk[v] = n > w / 40 ? 1 : 0; }
  for (let u = 0; u < w; u++) { let n = 0; for (let v = 0; v < h; v += 4) n += inside[v * w + u]; colOk[u] = n > h / 40 ? 1 : 0; }
  // the canvas is one block: the longest run of good rows and of good columns (a gap of a few bad rows inside is kept)
  const span = (ok) => {
    let best = [0, -1], s = -1, bad = 0;
    for (let i = 0; i <= ok.length; i++) {
      if (i < ok.length && ok[i]) { if (s < 0) s = i; bad = 0; if (i - s > best[1] - best[0]) best = [s, i]; }
      else if (s >= 0 && ++bad > 12) { s = -1; bad = 0; }
    }
    return best;
  };
  const [v0, v1] = span(rowOk), [u0, u1] = span(colOk);
  const canvas = new Uint8Array(w * h);
  for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) canvas[v * w + u] = inside[v * w + u];
  return { ref: { w, h, data: ref }, canvas, box: [u0, v0, u1 + 1, v1 + 1] };
}

/** connected components (8-neighbour) of a 0/1 mask; returns the label per pixel (0 = none) and the count */
function components(mask, w, h) {
  const lab = new Int32Array(w * h), stack = [];
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || lab[i]) continue;
    lab[i] = ++n; stack.push(i);
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (mask[q] && !lab[q]) { lab[q] = n; stack.push(q); }
      }
    }
  }
  return { lab, n };
}
/** a box sum table for counting mask pixels in squares */
function integral(mask, w, h) {
  const I = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += mask[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  return (x0, y0, x1, y1) => { // inclusive-exclusive, clamped
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
    return x1 <= x0 || y1 <= y0 ? 0 : I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
  };
}

/** a stroke's pixels as an ordered polyline: 6 px cells walked from one end (with a pull to keep going the same way) */
function orderStroke(pts, CELL = 6) {
  const cells = new Map();
  for (const [x, y] of pts) { const k = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`; const c = cells.get(k); if (c) { c[0] += x; c[1] += y; c[2]++; } else cells.set(k, [x, y, 1]); }
  const cc = [...cells.values()].filter((c) => c[2] >= 2).map((c) => [c[0] / c[2], c[1] / c[2]]);
  if (cc.length < 2) return cc;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // one end: the cell farthest from the cell farthest from the mean (the long axis of the stroke)
  const mean = cc.reduce((a, c) => [a[0] + c[0] / cc.length, a[1] + c[1] / cc.length], [0, 0]);
  let a = cc.reduce((p, c) => (d(c, mean) > d(p, mean) ? c : p));
  a = cc.reduce((p, c) => (d(c, a) > d(p, a) ? c : p));
  const left = new Set(cc); left.delete(a);
  const out = [a];
  while (left.size) {
    const cur = out[out.length - 1], prev = out[out.length - 2];
    let best = null, bs = Infinity;
    for (const c of left) {
      const dd = d(c, cur);
      if (dd > 30) continue;
      let turn = 0;
      if (prev) { const ax = cur[0] - prev[0], ay = cur[1] - prev[1], bx = c[0] - cur[0], by = c[1] - cur[1]; turn = 1 - (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1); }
      const sc = dd * (1 + 0.6 * turn);
      if (sc < bs) { bs = sc; best = c; }
    }
    if (!best) break;
    out.push(best); left.delete(best);
    // cells passed by on the way (within 5 px of the step) are part of it
    for (const c of [...left]) if (d(c, best) < 5) left.delete(c);
  }
  return out.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]);
}

/**
 * The lines drawn on the screenshot. A drawn pixel is a strong colour (saturation over `sat`, value over 90) or
 * pure black (max channel under `blackMax`), inside the canvas, and not in the render (no render pixel within 2 px is
 * close to its colour: the sky's blue and dark trees are in the render too). Pixels are grouped by colour (hue
 * peaks, told apart by value too) and into strokes (connected after a 2 px dilation). A stroke is dropped when it is filled
 * (the RIDE button), a rectangle's outline (the selected card) or short. A colour used twice gives two lines,
 * named `<colour>-1`, `<colour>-2` left to right.
 * Returns { lines: [{ name, colour, hue, px: [[x, y], ...] }], dropped: [{ colour, why, box }] }.
 */
export function extractLines(shot, aligned, { sat = 0.45, value = 90, blackMax = 6, minCells = 20, cellPx = 6, notInRender = 50, hueSplit = 20, valueWeight = 0.3, joinCost = 35, joinPx = 30, ignore = [] } = {}) {
  const { w, h, data } = shot, ref = aligned.ref.data, canvas = aligned.canvas;
  const cls = new Int16Array(w * h).fill(-1); // -1 none, 360 black (then its class), else the colour's class
  const ignored = (u, v) => ignore.some(([x0, y0, x1, y1]) => u >= x0 && u < x1 && v >= y0 && v < y1);
  const near = (i, r, g, b) => {
    const u = i % w, v = (i - u) / w;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const uu = u + dx, vv = v + dy;
      if (uu < 0 || vv < 0 || uu >= w || vv >= h) continue;
      const j = (vv * w + uu) * 4;
      if (Math.max(Math.abs(ref[j] - r), Math.abs(ref[j + 1] - g), Math.abs(ref[j + 2] - b)) < notInRender) return true;
    }
    return false;
  };
  // the drawn colours: peaks of the hue histogram (at least hueSplit degrees apart), each with the median value of
  // its pixels; a pixel joins the peak nearest in hue plus valueWeight x value (a dark purple and a light pink are
  // close in hue but not in value), within joinCost
  const H = new Float32Array(w * h), Vv = new Uint8Array(w * h), hist = new Float32Array(72), cand = [];
  for (let i = 0; i < w * h; i++) {
    if (!canvas[i]) continue;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], [hu, s, v] = hsv(r, g, b);
    const black = v < blackMax, col = s > sat && v > value;
    if (!black && !col) continue;
    const u = i % w;
    if (ignored(u, (i - u) / w) || near(i, r, g, b)) continue;
    if (black) { cls[i] = 360; continue; }
    H[i] = hu; Vv[i] = v; cand.push(i); hist[Math.floor(hu / 5) % 72]++;
  }
  const sm = hist.map((_, i) => hist[(i + 71) % 72] * 0.25 + hist[i] * 0.5 + hist[(i + 1) % 72] * 0.25);
  const total = hist.reduce((a, b) => a + b, 0);
  let peaks = [];
  for (let i = 0; i < 72; i++) if (sm[i] >= sm[(i + 71) % 72] && sm[i] > sm[(i + 1) % 72] && sm[i] > Math.max(30, total * 0.002)) peaks.push(i * 5 + 2.5);
  peaks.sort((a, b) => sm[Math.floor(b / 5)] - sm[Math.floor(a / 5)]);
  peaks = peaks.filter((p, i) => !peaks.slice(0, i).some((q) => hueDist(p, q) < hueSplit));
  const pv = peaks.map((p) => { const vs = cand.filter((i) => hueDist(H[i], p) < 7.5).map((i) => Vv[i]).sort((a, b) => a - b); return vs.length ? vs[vs.length >> 1] : 200; });
  if (process.env.GHOST_DEBUG) console.log(`  hue peaks: ${peaks.map((p, j) => `${p} (${Math.round(sm[Math.floor(p / 5)])} px, value ${pv[j]})`).join(', ')}`);
  const classes = [...peaks.map((p) => ({ hue: p, colour: colourName(p) })), { hue: null, colour: 'black' }];
  for (let i = 0; i < w * h; i++) if (cls[i] === 360) cls[i] = classes.length - 1;
  for (const i of cand) {
    let bi = -1, bd = joinCost;
    peaks.forEach((p, j) => { const d = hueDist(H[i], p) + valueWeight * Math.abs(Vv[i] - pv[j]); if (d < bd) { bd = d; bi = j; } });
    cls[i] = bi;
  }
  const lines = [], dropped = [];
  classes.forEach((c, ci) => {
    const mask = new Uint8Array(w * h);
    let any = 0;
    for (let i = 0; i < w * h; i++) if (cls[i] === ci) { mask[i] = 1; any++; }
    if (any < 20) return;
    const box = integral(mask, w, h);
    // dilate 2 px so a stroke broken by compression stays one stroke
    const dil = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (box(x - 2, y - 2, x + 3, y + 3)) dil[y * w + x] = 1;
    const { lab, n } = components(dil, w, h);
    const strokes = Array.from({ length: n + 1 }, () => []);
    for (let i = 0; i < w * h; i++) if (mask[i]) strokes[lab[i]].push(i);
    for (const st of strokes) {
      if (!st.length) continue;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, solid = 0;
      for (const i of st) {
        const x = i % w, y = (i - x) / w;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        if (box(x - 3, y - 3, x + 4, y + 4) === 49) solid++; // the middle of a 7 x 7 block: filled, not a stroke
      }
      const bb = [x0, y0, x1 + 1, y1 + 1], size = Math.hypot(x1 - x0, y1 - y0);
      if (size < minCells * cellPx) { if (st.length > 30) dropped.push({ colour: c.colour, why: `short (${Math.round(size)} px)`, box: bb }); continue; }
      if (solid > 0.15 * st.length) { dropped.push({ colour: c.colour, why: 'filled (a button or a shape, not a line)', box: bb }); continue; }
      // black over what the render has dark (shaded pines are near black too): not a line drawn on the snow
      if (c.hue === null) {
        let dark = 0;
        for (const i of st) if (0.299 * ref[i * 4] + 0.587 * ref[i * 4 + 1] + 0.114 * ref[i * 4 + 2] < 70) dark++;
        if (dark > 0.4 * st.length) { dropped.push({ colour: c.colour, why: 'over trees or shade (dark in the render too)', box: bb }); continue; }
      }
      // a rectangle's outline: mask along at least three sides of its box
      if (x1 - x0 > 30 && y1 - y0 > 20) {
        const cover = (along, fixed, horiz) => { let hit = 0; for (let t = along[0]; t < along[1]; t += 2) { const ok = horiz ? box(t, fixed - 4, t + 1, fixed + 5) : box(fixed - 4, t, fixed + 5, t + 1); if (ok) hit++; } return hit / Math.max(1, (along[1] - along[0]) / 2); };
        const sides = [cover([x0, x1], y0, true), cover([x0, x1], y1, true), cover([y0, y1], x0, false), cover([y0, y1], x1, false)];
        if (sides.filter((s) => s > 0.6).length >= 3) { dropped.push({ colour: c.colour, why: 'a rectangle outline (UI)', box: bb }); continue; }
      }
      // a long straight edge along x or y (a card's border): drawn lines are never that straight
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (Math.min(bw, bh) <= 20 && Math.max(bw, bh) >= 100 && Math.max(bw, bh) > 8 * Math.min(bw, bh)) { dropped.push({ colour: c.colour, why: 'a straight edge (UI)', box: bb }); continue; }
      const pts = st.map((i) => [i % w, Math.floor(i / w)]);
      const px = orderStroke(pts, cellPx);
      if (px.length < minCells) { dropped.push({ colour: c.colour, why: `short (${px.length} cells)`, box: bb }); continue; }
      // a scribble or a patch (dark trees): its walk folds back on itself far more than any drawn line
      const walk = px.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - px[i][0], q[1] - px[i][1]), 0);
      if (walk > 4 * Math.hypot(bw, bh)) { dropped.push({ colour: c.colour, why: 'a scribble or a patch, not a line', box: bb }); continue; }
      lines.push({ colour: c.colour, hue: c.hue, px, x: (x0 + x1) / 2, box: bb, length: Math.round(px.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - px[i][0], q[1] - px[i][1]), 0)) });
    }
  });
  // one stroke broken where it crosses another line: join two of one colour whose ends meet (within joinPx)
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < lines.length && !again; i++) for (let j = i + 1; j < lines.length && !again; j++) {
      const a = lines[i], b = lines[j];
      if (a.colour !== b.colour) continue;
      const ends = [[a.px.at(-1), b.px[0], false, false], [a.px.at(-1), b.px.at(-1), false, true], [a.px[0], b.px[0], true, false], [a.px[0], b.px.at(-1), true, true]];
      const hit = ends.find(([p, q]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < joinPx);
      if (!hit) continue;
      const pa = hit[2] ? a.px.slice().reverse() : a.px, pb = hit[3] ? b.px.slice().reverse() : b.px;
      a.px = [...pa, ...pb];
      a.box = [Math.min(a.box[0], b.box[0]), Math.min(a.box[1], b.box[1]), Math.max(a.box[2], b.box[2]), Math.max(a.box[3], b.box[3])];
      a.x = (a.box[0] + a.box[2]) / 2; a.length += b.length + Math.round(Math.hypot(pa.at(-1)[0] - pb[0][0], pa.at(-1)[1] - pb[0][1]));
      lines.splice(j, 1); again = true;
    }
  }
  // names: the colour, numbered left to right when it is used more than once
  const byColour = {};
  for (const l of lines) (byColour[l.colour] ??= []).push(l);
  for (const [col, ls] of Object.entries(byColour)) {
    ls.sort((a, b) => a.x - b.x);
    ls.forEach((l, i) => { l.name = ls.length > 1 ? `${col}-${i + 1}` : col; });
  }
  lines.sort((a, b) => a.x - b.x);
  return { lines: lines.map(({ name, colour, hue, px, box, length }) => ({ name, colour, hue, px, box, length })), dropped };
}
