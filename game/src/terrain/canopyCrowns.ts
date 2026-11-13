/**
 * FEAT-278 prototype (`?canopy=crowns`): far forest as crowns faked in the terrain fragment shader, no geometry.
 *
 * The ground is split into the 4 m cells of the pack's cover level (the level with `crowns`, bound as `uTreeMap`:
 * R the forest share seen from far, G the closed stands, B the drawn trees' canopy, and with this mode A the canopy
 * height, see CoverSet.ts). Each cell holds at most one crown, an upright ellipsoid inside the cell, kept where a
 * per-cell hash is under the cell's share of the canopy the drawn trees leave, sized and jittered by the hash, as
 * tall as the cell's canopy. A second, coarser level does the same on 8 m cells from the texture's first mip
 * (clumps of crowns), for pixels too big for the 4 m lattice.
 *
 * Per pixel the view ray is walked back from the ground point toward the camera through the cells its ground track
 * crosses (a 2D DDA from where it is at the canopy top, at most CR_VIEW_N cells), intersecting each cell's crown
 * analytically, so a slope seen at a grazing angle shows the crowns standing up and hiding the snow behind them
 * (parallax with exact occlusion order, no height steps). Each crown's edge is soft over the pixel, so a crown that
 * shrinks toward a pixel fades instead of sparkling. A lattice of cells aliases into moire once a cell is under
 * about 1.5 pixels however soft the crowns are, so the 4 m crowns hand over to the 8 m clumps over CR_FOOT_LO..HI m
 * of pixel size (square to the view), and the clumps to the flat canopy the terrain had before (the gap fraction
 * `seen` and the timber tone) over twice that. A second walk toward the sun from what the pixel shows (a crown or
 * the snow between them) shades it by the crowns in the way: short shadows on the snow, crowns shading each other.
 *
 * Outputs (globals for the lighting chunks, set in TerrainMaterial): the crown cover, albedo and normal (the pixel
 * is lit with the crown's normal, so the sun side is bright and the far side dark), and the crown shadow on it.
 */

/** cells walked along the view ray and toward the sun, at most (the 8 m level walks fewer) */
export const CR_VIEW_N = 20;
export const CR_SUN_N = 6;

/** GLSL for the fragment shader's global scope, after covUV / covW, uTreeMap and uSunDir are declared. */
export const CROWNS_GLSL = /* glsl */ `
  #define CR_CELL 4.0
  #define CR_VIEW_N ${CR_VIEW_N}
  #define CR_SUN_N ${CR_SUN_N}
  // ground share one crown of mean size covers in its cell
  #define CR_SHARE 0.4
  // the 4 m crowns hand over to the 8 m clumps as a pixel's size square to the view grows from LO to HI m, and
  // the clumps to the flat canopy from 2 LO to 2 HI (a cell under about 1.5 pixels bands into moire)
  #define CR_FOOT_LO 1.4
  #define CR_FOOT_HI 2.8
  // share of the sun a crown's lit face returns (needles, the shade inside the crown)
  #define CR_SUN 0.45
  #define CR_SNOW 0.4
  #define CR_SHADOW 0.75
  const vec3 CR_ALB = vec3(0.030, 0.060, 0.034);
  const vec3 CR_SNOWCOL = vec3(0.78, 0.82, 0.88);
  // crown: an upright ellipsoid widest at 0.2 H (its lower part under the snow), so it tapers to a rounded tip
  #define CR_ZC 0.2
  #define CR_HZ 0.8
  uvec4 crPcg(uvec4 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
    v ^= v >> 16u;
    v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
    return v;
  }
  vec4 crHash(vec2 cell, float lev) { return vec4(crPcg(uvec4(uvec2(ivec2(cell) + 131072), 0x2f6bu, 0x91c3u + uint(lev)))) * (1.0 / 4294967296.0); }
  // per pixel, set before the walks: the drawn trees' share of the canopy here (rho), how much this is inside the
  // drawn trees' reach, the pixel's own forest share and canopy height (used off the tree map), how much of the tree
  // map is here, how far the near share (G, closed stands) has gone toward the far one (R), and the share of the
  // crowns shown (the terrain's forest ramp in from FOREST_NEAR: crowns come in one by one, each over a short span)
  float gCrRho, gCrReach, gCrSPix, gCrHPix, gCrTM, gCrFarK, gCrRamp;
  // the crown in a cell of level lev (cell size cs): centre (pack xy), radius, height (radius 0 when the cell has
  // none), its opacity while it comes in, and a per-crown random for its snow and tone
  vec4 crownAt(vec2 cell, float lev, float cs, out float alpha, out float snowy) {
    vec4 h = crHash(cell, lev);
    vec2 ctr = uTreeMapRect.xy + (cell + 0.5) * cs;
    vec4 d = textureLod(uTreeMap, covUV(ctr, uTreeMapRect), lev);
    // inside the drawn trees' reach the share the flat canopy uses there (closed stands near, BUG-069), so the
    // crowns fill in only what it did; past it the ground's share under crowns from the whole forest (R, which
    // saturates in closed stands, sparse trees included) varied by the drawn trees' canopy (B), so stands keep
    // their own gaps and clumps
    float sFar = clamp(0.3 * d.r + 0.3 * d.b, 0.0, 0.75);
    float s = mix(gCrSPix * 0.6, mix(sFar, smoothstep(0.1, 0.9, mix(d.g, d.r, gCrFarK)), gCrReach), gCrTM);
    float hgt = mix(gCrHPix, d.a * 40.0, gCrTM * step(0.02, d.a));
    // the share of the ground under crowns the drawn trees miss (as the gap fraction in the terrain's \`seen\`)
    float sRes = 1.0 - (1.0 - s) / max(1.0 - gCrRho * s, 1e-3);
    // at most 3 cells in 4 keep a crown, so even closed forest is not a jittered lattice (which bands)
    float q = min(sRes / CR_SHARE, 0.75) * gCrRamp;
    snowy = h.w;
    alpha = smoothstep(0.0, 0.08, q - h.x);
    if (alpha <= 0.0) return vec4(0.0);
    // jittered over most of the cell so the grid does not read as an orchard, the crown shrunk where it would
    // cross the cell edge (the walks look in the cells they cross only)
    float half_ = 0.5 * cs, rmax = 0.49 * cs;
    vec2 j = (h.zw - 0.5) * 1.1 * half_;
    float r = min(half_ * (0.5 + 0.35 * h.y) * mix(1.0, 1.35, smoothstep(0.25, 0.7, sRes)), rmax - max(abs(j.x), abs(j.y)));
    float H = clamp(hgt * (0.6 + 0.35 * fract(h.y * 13.7)), 5.0, 28.0);
    return vec4(ctr + j, r, H);
  }
  // DDA set-up: from s along unit dir, cells of size cs; returns the first cell, and (in tM, tD) the distances to
  // the next cell edge on each axis and between edges
  vec2 crDda(vec2 s, vec2 dir, float cs, out vec2 st, out vec2 tM, out vec2 tD) {
    vec2 g0 = (s - uTreeMapRect.xy) / cs;
    vec2 cell = floor(g0);
    st = vec2(dir.x >= 0.0 ? 1.0 : -1.0, dir.y >= 0.0 ? 1.0 : -1.0);
    vec2 inv = 1.0 / max(abs(dir), vec2(1e-5));
    tM = (st * (cell - g0) + max(st, 0.0)) * inv * cs;
    tD = inv * cs;
    return cell;
  }
  // level lev at ground point p (pack xy): V = view direction (world, camera to pixel), n = ground normal (world),
  // foot = the pixel's size square to the view (m). Returns the crown cover; alb, nW (world) the crowns' albedo
  // and normal, sh the crowns' shadow on what the pixel shows
  float crownsLevel(float lev, vec2 p, vec3 V, vec3 n, float foot, out vec3 alb, out vec3 nW, out float sh) {
    alb = CR_ALB; nW = n; sh = 0.0;
    float cs = CR_CELL * (1.0 + lev);
    int nView = lev > 0.5 ? 12 : CR_VIEW_N, nSun = lev > 0.5 ? 4 : CR_SUN_N;
    float footL = foot / (1.0 + lev);
    vec2 w = vec2(-V.x, V.z);
    float wl = max(length(w), 1e-4);
    float k = max(dot(n, -V), 0.02) / max(n.y, 0.2);
    float Hm = max(gCrHPix * 1.3, 12.0);
    float L0 = Hm / k * wl, L = min(L0, float(nView - 1) * cs);
    // a walk cut short (grazing views) would start on a hard line at a fixed distance before the pixel, which
    // bands as that line crosses cell rows: crowns fade in over the first 3 cells instead
    float tauIn = L / wl, fadeIn = L0 > L + 0.5 ? 3.0 * cs / wl : 0.0;
    vec2 dir = -w / wl, st, tM, tD;
    vec2 cell = crDda(p - dir * L, dir, cs, st, tM, tD);
    float a = 0.0;
    vec3 accA = vec3(0.0), accN = vec3(0.0);
    for (int i = 0; i < CR_VIEW_N; i++) {
      if (i >= nView) break;
      float snowy, al;
      vec4 cr = crownAt(cell, lev, cs, al, snowy);
      if (cr.z > 0.0) {
        float hz = CR_HZ * cr.w;
        vec3 A = vec3((p - cr.xy) / cr.z, -CR_ZC / CR_HZ);
        vec3 D = vec3(w / cr.z, k / hz);
        float dd = dot(D, D), ad = dot(A, D);
        float tc = -ad / dd;
        float rm2 = max(dot(A, A) - ad * ad / dd, 0.0), rm = sqrt(rm2);
        // the edge is soft over the pixel, and softer still (a prefilter) as the lattice nears its hand-over
        float fw = clamp(footL * (1.0 + lev) / cr.z * 0.35, 0.06, 0.6) + 0.6 * smoothstep(1.0, CR_FOOT_HI, footL);
        float th = rm < 1.0 ? tc + sqrt((1.0 - rm2) / dd) : tc;
        float cov = al * (1.0 - smoothstep(1.0 - fw, 1.0 + fw, rm)) * smoothstep(-0.5, 0.5, th * k);
        if (fadeIn > 0.0) cov *= smoothstep(tauIn, tauIn - fadeIn, th);
        if (cov > 0.002) {
          vec3 P = A + D * max(th, 0.0);
          vec3 ne = normalize(vec3(P.xy / cr.z, P.z / hz));
          float zf = clamp(k * th / cr.w, 0.0, 1.0);
          // needles darker low in the crown, snow lying on the upward faces (more on some crowns than others)
          float snowK = smoothstep(0.45, 0.95, ne.z * 0.8 + snowy * 0.45) * CR_SNOW;
          vec3 c = mix(CR_ALB * (0.7 + 0.6 * fract(snowy * 7.3)) * mix(0.55, 1.1, zf), CR_SNOWCOL, snowK);
          float wgt = (1.0 - a) * cov;
          accA += wgt * c; accN += wgt * vec3(ne.x, ne.z, -ne.y);
          a += wgt;
          if (a > 0.92) break;
        }
      }
      float tr;
      if (tM.x < tM.y) { tr = tM.x; tM.x += tD.x; cell.x += st.x; } else { tr = tM.y; tM.y += tD.y; cell.y += st.y; }
      if (tr > L) break;
    }
    if (a > 1e-3) { alb = accA / a; nW = normalize(accN); }
    // the sun on the snow at p
    vec3 Ls = uSunDir;
    float lh = length(Ls.xz);
    float kS = dot(n, Ls) / (max(n.y, 0.2) * max(lh, 1e-3));
    // (only where the snow between the crowns shows: a crown's own lower part is darkened by its height above)
    if (Ls.y < 0.02 || lh < 1e-3 || kS <= 0.0 || a > 0.6) return a;
    vec2 s = p; float z0 = 0.0; vec2 skip = vec2(-1e6);
    vec2 sdir = vec2(Ls.x, -Ls.z) / lh;
    float Lm = min(max(Hm - z0, 0.0) / kS, float(nSun - 1) * cs);
    cell = crDda(s, sdir, cs, st, tM, tD);
    float lit = 1.0;
    for (int i = 0; i < CR_SUN_N; i++) {
      if (i >= nSun) break;
      if (cell != skip) {
        float snowy, al;
        vec4 cr = crownAt(cell, lev, cs, al, snowy);
        if (cr.z > 0.0) {
          float hz = CR_HZ * cr.w;
          vec3 A = vec3((s - cr.xy) / cr.z, (z0 - CR_ZC * cr.w) / hz);
          vec3 D = vec3(sdir / cr.z, kS / hz);
          float dd = dot(D, D), ad = dot(A, D);
          float rm = sqrt(max(dot(A, A) - ad * ad / dd, 0.0));
          // shadows are soft (the sun's disc, the crown's ragged edge)
          float fw = clamp(foot / cr.z * 0.6 + 0.12, 0.12, 1.2);
          lit *= 1.0 - al * (1.0 - smoothstep(1.0 - fw, 1.0 + fw, rm)) * step(0.0, -ad) * 0.9;
        }
      }
      float tr;
      if (tM.x < tM.y) { tr = tM.x; tM.x += tD.x; cell.x += st.x; } else { tr = tM.y; tM.y += tD.y; cell.y += st.y; }
      if (tr > Lm || lit < 0.03) break;
    }
    sh = 1.0 - lit;
    return a;
  }
`;
