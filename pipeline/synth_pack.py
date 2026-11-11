#!/usr/bin/env python3
"""Synthetic resort pack for client development. Same format as the real pipeline output.

python3 pipeline/synth_pack.py client/public/packs/synth
"""
import os, sys, json, math
import numpy as np
from packwriter import (FORMAT_VERSION, write_height_set, write_mask_set, write_instances, write_meta, write_features)
import species as spc
import stands
from terrain_ao import sky_visibility
from piste_dir import piste_direction
from moguls import paint_field, slope_window

out = sys.argv[1] if len(sys.argv) > 1 else "client/public/packs/synth"
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(7)

# ------------------------------------------------------------------ noise
def hash2(ix, iy, seed):
    h = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263 + seed * 1442695041) & 0x7fffffff
    h = (h ^ (h >> 13)) * 1274126177 & 0x7fffffff
    return ((h ^ (h >> 16)) & 0xffff).astype(np.float32) / 65535.0

def value_noise(x, y, seed):
    ix = np.floor(x); iy = np.floor(y)
    fx = x - ix; fy = y - iy
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
    a = hash2(ix, iy, seed); b = hash2(ix + 1, iy, seed); c = hash2(ix, iy + 1, seed); d = hash2(ix + 1, iy + 1, seed)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy

def fbm(x, y, octaves, base_freq, gain=0.5, seed=1):
    out = np.zeros_like(x, dtype=np.float32); amp = 1.0; f = base_freq; norm = 0.0
    for i in range(octaves):
        out += amp * (value_noise(x * f, y * f, seed + i) * 2 - 1)
        norm += amp; amp *= gain; f *= 2.0
    return out / norm

def ridged(x, y, octaves, base_freq, seed=9):
    out = np.zeros_like(x, dtype=np.float32); amp = 1.0; f = base_freq; norm = 0.0
    for i in range(octaves):
        n = 1.0 - np.abs(value_noise(x * f, y * f, seed + i) * 2 - 1)
        out += amp * n * n; norm += amp; amp *= 0.5; f *= 2.1
    return out / norm

# ------------------------------------------------------------------ terrain function (local metres)
# A main E-W ridge at y = -1500 (summit ~3500 m), front side faces north down to a valley at y = +2500
# (base ~2500 m), bowls on the south side. Big ranges beyond.
def height(x, y):
    x = x.astype(np.float32); y = y.astype(np.float32)
    ridge_y = -1500 + 400 * fbm(x, y * 0 + 1, 3, 1 / 6000.0, seed=31)
    d = y - ridge_y
    # cross-section: north slope ~ 22 deg avg, south ~ 18 deg, flattening in the valley
    north = np.clip(d, 0, None); south = np.clip(-d, 0, None)
    prof = 3450 - 0.40 * north + 0.0000180 * north ** 2 - 0.30 * south + 0.0000250 * south ** 2
    prof = np.maximum(prof, 2480)  # valley floor
    # distance-limited: beyond ~5 km the regional terrain takes over
    big = 2600 + 900 * ridged(x, y, 5, 1 / 25000.0) + 300 * fbm(x, y, 4, 1 / 9000.0, seed=5)
    w = np.clip(1 - (np.abs(d) - 3500) / 2500, 0, 1)
    h = w * prof + (1 - w) * big
    # medium detail: gullies and spurs along the fall line
    h += 60 * fbm(x, y, 5, 1 / 1200.0, seed=11) * np.clip(1 - np.abs(d) / 5000, 0, 1)
    # fine detail: 1 to 10 m rolls, stronger on steep ground
    h += 4.0 * fbm(x, y, 5, 1 / 60.0, seed=17)
    return h.astype(np.float32)

def grid(min_x, min_y, n_x, n_y, res):
    xs = min_x + (np.arange(n_x, dtype=np.float32) + 0.5) * res
    ys = min_y + (np.arange(n_y, dtype=np.float32) + 0.5) * res
    X, Y = np.meshgrid(xs, ys[::-1])  # row 0 = north
    return X, Y

meta = {"version": 1, "formatVersion": FORMAT_VERSION, "slug": "synth", "name": "Synthetic test mountain", "crs": "local", "origin": [0, 0],
        "lonlat": [-106.35, 39.6], "zRange": [2300, 3700], "terrain": {}, "attribution": ["synthetic"]}

# fine: 4 km x 4 km at 1 m centred on the front side
FX0, FY0, FS = -2048, -1024, 4096
X, Y = grid(FX0, FY0, FS, FS, 1.0)
print("fine ..."); Hf = height(X, Y)
meta["terrain"]["fine"] = write_height_set(out, "fine", Hf, 1.0, FX0, FY0)
meta["bounds"] = {"minX": FX0, "minY": FY0, "maxX": FX0 + FS, "maxY": FY0 + FS}

# mid: 40 km at 16 m
MX0 = -20480; MS = 2560
X, Y = grid(MX0, MX0, MS, MS, 16.0)
print("mid ..."); Hm = height(X, Y)
meta["terrain"]["mid"] = write_height_set(out, "mid", Hm, 16.0, MX0, MX0)

# far: 262 km at 128 m
AX0 = -131072; AS = 2048
X, Y = grid(AX0, AX0, AS, AS, 128.0)
print("far ..."); Ha = height(X, Y)
meta["terrain"]["far"] = write_height_set(out, "far", Ha, 128.0, AX0, AX0)

# ------------------------------------------------------------------ runs, lift
def polyline_down(x_start, y_start, y_end, wobble, seed):
    ys = np.arange(y_start, y_end, 25.0 if y_end > y_start else -25.0)
    xs = x_start + wobble * np.cumsum(rng.normal(0, 1, len(ys))) * 2.0
    return np.stack([xs, ys], axis=1)

runs = []
# FEAT-059: mogul score per run (Fall Line is a full bump run, Chute a partial one, groomers none)
specs = [("Ridge Run", "easy", True, 800, 0.6, 0.0), ("Blue Streak", "intermediate", True, -300, 1.0, 0.0),
         ("Fall Line", "advanced", False, 300, 1.4, 1.0), ("Chute", "expert", False, -900, 0.5, 0.6)]
for name, diff, groomed, x0, wob, mogul in specs:
    pts = polyline_down(x0, -1400, 2400, wob, 1)
    pts = pts[(pts[:, 0] > FX0 + 50) & (pts[:, 0] < FX0 + FS - 50)]
    z = height(pts[:, 0], pts[:, 1])
    runs.append({"name": name, "difficulty": diff, "groomed": groomed, "gladed": False, "osmId": None, "mogulScore": mogul,
                 "points": [[float(a), float(b), float(c)] for a, b, c in zip(pts[:, 0], pts[:, 1], z)]})

lift_pts = np.array([[0.0, 2300.0], [0.0, -1350.0]])
n_tow = int(np.hypot(*(lift_pts[1] - lift_pts[0])) // 150)
tow = np.linspace(lift_pts[0], lift_pts[1], n_tow + 1)[1:-1]
tz = height(tow[:, 0], tow[:, 1])
sz = height(lift_pts[:, 0], lift_pts[:, 1])
lifts = [{"name": "Synth Express", "type": "chair_lift", "capacity": 4,
          "stations": [[0.0, 2300.0, float(sz[0])], [0.0, -1350.0, float(sz[1])]],
          "towers": [[float(a), float(b), float(c), 12.0] for a, b, c in zip(tow[:, 0], tow[:, 1], tz)],
          "cable": []}]

features = {"lifts": lifts, "runs": runs, "buildings": [], "roads": [], "water": [],
            "peaks": [{"name": "Synth Peak", "x": 0.0, "y": -1500.0, "z": float(height(np.array([0.0]), np.array([-1500.0]))[0])}],
            "labels": []}
write_features(out, features)

# ------------------------------------------------------------------ mask (2 m) + trees + rocks over the fine area
R = 2.0; N = FS // 2
X, Y = grid(FX0, FY0, N, N, R)
H = height(X, Y)
gy, gx = np.gradient(H, R)
slope = np.degrees(np.arctan(np.hypot(gx, gy)))
forest = fbm(X, Y, 4, 1 / 700.0, seed=41) * 0.5 + 0.5
treeline = np.clip((3380 - H) / 150.0, 0, 1)          # fades out above ~3300 m
forest = np.clip(forest * 1.3 - 0.25, 0, 1) * treeline * (slope < 42)
# clear corridors for runs and the lift line
yy_idx = lambda y: ((FY0 + N * R) - y) / R
xx_idx = lambda x: (x - FX0) / R
clear = np.zeros_like(forest, dtype=bool)
groomed = np.zeros_like(forest, dtype=np.float32)
ii, jj = np.mgrid[0:N, 0:N]
for r in runs:
    pts = np.array(r["points"])[:, :2]
    for k in range(len(pts) - 1):
        a = pts[k]; b = pts[k + 1]
        for t in np.linspace(0, 1, 4):
            p = a + (b - a) * t
            ci, cj = yy_idx(p[1]), xx_idx(p[0])
            rad = 22 if r["difficulty"] in ("easy", "intermediate") else 14
            lo_i, hi_i = int(max(ci - rad, 0)), int(min(ci + rad + 1, N))
            lo_j, hi_j = int(max(cj - rad, 0)), int(min(cj + rad + 1, N))
            d2 = (ii[lo_i:hi_i, lo_j:hi_j] - ci) ** 2 + (jj[lo_i:hi_i, lo_j:hi_j] - cj) ** 2
            clear[lo_i:hi_i, lo_j:hi_j] |= d2 < rad * rad
            if r["groomed"]:
                groomed[lo_i:hi_i, lo_j:hi_j] = np.maximum(groomed[lo_i:hi_i, lo_j:hi_j], (d2 < (rad - 2) ** 2).astype(np.float32))
for k in range(n_tow):
    p = np.linspace(lift_pts[0], lift_pts[1], n_tow * 6 + 1)
    for q in p:
        ci, cj = int(yy_idx(q[1])), int(xx_idx(q[0]))
        if 0 <= ci < N and 0 <= cj < N:
            clear[max(ci - 5, 0):ci + 6, max(cj - 5, 0):cj + 6] = True
forest[clear] = 0
rock = np.clip((slope - 32) / 10.0, 0, 1) * (fbm(X, Y, 3, 1 / 300.0, seed=51) * 0.5 + 0.7)
rock = np.clip(rock, 0, 1); rock[H < 2700] *= 0.3
scree = np.clip((slope - 24) / 8.0, 0, 1) * (1 - rock) * np.clip((H - 3250) / 150.0, 0, 1)
rgba = np.stack([rock * 255, scree * 255, groomed * 255, forest * 255], axis=-1).astype(np.uint8)
meta["mask"] = write_mask_set(out, rgba, R, FX0, FY0)
meta["dir"] = write_mask_set(out, piste_direction(runs, groomed, R, FX0, FY0 + N * R), R, FX0, FY0, kind="dir", pad=0)
ao = sky_visibility(H.astype(np.float32), R, log=None)
meta["ao"] = write_mask_set(out, (np.clip(ao, 0, 1) * 255 + 0.5).astype(np.uint8), R, FX0, FY0, kind="ao")
# FEAT-059: mogul amplitude along the bump runs, times the slope window, none on groomed corduroy
mog = np.zeros((N, N), np.float32)
for r in runs:
    if r["mogulScore"] > 0:
        paint_field(mog, [(p[0], p[1]) for p in r["points"]], 12.0, r["mogulScore"], R, FX0, FY0 + N * R)
mog = np.clip(mog * slope_window(slope) * (1 - groomed), 0, 1)
meta["moguls"] = write_mask_set(out, (mog * 255 + 0.5).astype(np.uint8), R, FX0, FY0, kind="moguls", pad=0)
print(f"moguls: {(mog > 0.05).sum() * R * R / 1e4:.1f} ha, mean amplitude {mog[mog > 0.05].mean():.2f} m")

# trees: jittered 5 m grid, keep where forest density beats a random draw
print("trees ...")
step = 5.0
tx = np.arange(FX0 + 2.5, FX0 + FS, step); ty = np.arange(FY0 + 2.5, FY0 + FS, step)
TX, TY = np.meshgrid(tx, ty)
TX = TX + rng.uniform(-2.2, 2.2, TX.shape); TY = TY + rng.uniform(-2.2, 2.2, TY.shape)
ci = np.clip(yy_idx(TY).astype(int), 0, N - 1); cj = np.clip(xx_idx(TX).astype(int), 0, N - 1)
dens = forest[ci, cj]
# FEAT-074: a third of the trees are "detected crowns" in the pack; the stand density below fills the rest
keep = rng.uniform(0, 1, TX.shape) < dens * 0.3
TX, TY = TX[keep], TY[keep]
TZ = height(TX, TY)
hgt = rng.gamma(6.0, 2.2, len(TX)).astype(np.float32) + 3.0
hgt *= np.clip((3400 - TZ) / 400.0, 0.35, 1.0)
# species ids 0..7 (DATA-020) from the no-LANDFIRE rules: spruce / fir split, lodgepole low, aspen groves,
# plus the synthetic treeline's krummholz and a few snags
nt = len(TX); z0 = np.zeros(nt)
aspen_like = (TZ < 2950) & (rng.uniform(0, 1, nt) < 0.45)
species = spc.assign_species(TX, TY, TZ, hgt, np.zeros(nt, np.int8), z0, np.zeros(nt, bool), aspen_like, z0, z0,
                             np.zeros(nt, bool), z0, False)
species[TZ > 3280] = spc.KRUMMHOLZ
species[(species != spc.KRUMMHOLZ) & (spc.hash01(TX, TY, 9) < 0.02)] = spc.SNAG
crown = spc.crown_radius(species, hgt)
trees = np.stack([TX, TY, TZ, hgt, crown, species.astype(np.float32)], axis=1).astype(np.float32)
CELL = 1000.0; cells = int(FS // CELL)
meta["instances"] = {"cellSize": CELL, "minX": FX0, "minY": FY0, "cellsX": cells, "cellsY": cells}
meta["instances"]["treeCount"] = write_instances(out, "trees", trees, CELL, FX0, FY0, cells, cells)
meta["treeSpecies"] = spc.TREE_SPECIES_VERSION

# FEAT-074: stand density per 4 m cell from the forest field, the crowns above counting against it
N4 = N // 2
f4 = forest[:N4 * 2, :N4 * 2].reshape(N4, 2, N4, 2).mean(axis=(1, 3)).astype(np.float32)
X4, Y4 = grid(FX0, FY0, N4, N4, 4.0)
Z4 = height(X4, Y4).astype(np.float32)
H4 = np.clip(19.0 * np.clip((3400 - Z4) / 400.0, 0.35, 1.0), 3.0, 45.0).astype(np.float32)
det4 = np.zeros((N4, N4), np.float32)
np.add.at(det4, (np.clip(((FY0 + FS) - TY) // 4, 0, N4 - 1).astype(int), np.clip((TX - FX0) // 4, 0, N4 - 1).astype(int)), 1)
n4 = int((f4 > 0).sum()); fi, fj = np.nonzero(f4 > 0); zz = np.zeros(n4)
SP4 = np.zeros((N4, N4), np.int16)
SP4[fi, fj] = spc.assign_species(X4[fi, fj], Y4[fi, fj], Z4[fi, fj], H4[fi, fj], np.zeros(n4, np.int8), zz, np.zeros(n4, bool),
                                 (Z4[fi, fj] < 2950) & (spc.hash01(X4[fi, fj], Y4[fi, fj], 8) < 0.45), zz, zz, np.zeros(n4, bool),
                                 spc.hash01(X4[fi, fj], Y4[fi, fj], 9), False)   # aspen groves as the crowns above
SP4[(Z4 > 3280) & (f4 > 0)] = spc.KRUMMHOLZ
P4 = stands.stem_chance(f4, H4, SP4, det4)
P4[f4 <= 0] = 0
meta["stands"] = stands.write(out, P4, H4, SP4, Z4, CELL, FX0, FY0, cells, cells, meta["zRange"][0])
print(f"stands: {meta['stands']['stems']} stems at full density in {len(meta['stands']['cells'])} cells")

# shrubs: on the thin forest edge, young conifers up high, juniper, sagebrush and willow lower down
SX = rng.uniform(FX0, FX0 + FS, 400000); SY = rng.uniform(FY0, FY0 + FS, 400000)
sd = forest[np.clip(yy_idx(SY).astype(int), 0, N - 1), np.clip(xx_idx(SX).astype(int), 0, N - 1)]
sk = (sd > 0.05) & (sd < 0.5) & (rng.uniform(0, 1, len(SX)) < 0.5)
SX, SY = SX[sk], SY[sk]; SZ = height(SX, SY)
kind = np.where(SZ > 2950, spc.YOUNG_CONIFER, rng.choice([spc.WILLOW, spc.JUNIPER, spc.SAGE], len(SX))).astype(np.float32)
sh = np.select([kind == spc.WILLOW, kind == spc.YOUNG_CONIFER], [rng.uniform(1, 3, len(SX)), rng.uniform(1, 4, len(SX))], rng.uniform(0.3, 1.2, len(SX)))
shrubs = np.stack([SX, SY, SZ, sh, sh * 0.5, kind], axis=1).astype(np.float32)
meta["instances"]["shrubCount"] = write_instances(out, "shrubs", shrubs, CELL, FX0, FY0, cells, cells)

# rocks: on rock mask
rk = rock > 0.5
ri, rj = np.nonzero(rk)
pick = rng.uniform(0, 1, len(ri)) < 0.08
ri, rj = ri[pick], rj[pick]
RX = FX0 + (rj + rng.uniform(0, 1, len(rj))) * R; RY = (FY0 + N * R) - (ri + rng.uniform(0, 1, len(ri))) * R
RZ = height(RX, RY)
rocks = np.stack([RX, RY, RZ, rng.gamma(3, 0.8, len(RX)) + 0.6, rng.uniform(0, 6.283, len(RX)), rng.integers(0, 3, len(RX))], axis=1).astype(np.float32)
meta["instances"]["rockCount"] = write_instances(out, "rocks", rocks, CELL, FX0, FY0, cells, cells)

meta["start"] = {"x": 650.0, "y": -1300.0, "heading": 0.0}
meta["sun"] = {"azimuth": 150, "elevation": 35}
write_meta(out, meta)
print("done:", json.dumps(meta["instances"]))
