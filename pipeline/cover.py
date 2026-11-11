#!/usr/bin/env python3
"""Forest cover levels for the terrain at a distance (FEAT-153, DATA-019).

python pipeline/cover.py <slug> <raw_dir> <pack_dir>

Writes cover/<level>.png (RGBA, row 0 = north) and the `cover` entry of meta.json. The client samples
these per pixel in the terrain shader (forest, GPU mipmaps do the box filtering at every distance) and
per vertex on the coarse chunks (forest, canopy height, rock), in place of the procedural treeline.

  R  forest: share of the cell under closed canopy, 0..1 (already contrast-lifted, so it reads linearly)
  G  canopy height of the forested part, 0..heightMax m
  B  rock / bare ground the data saw, 0..1
  A  not built-up: 255 = open, 0 = all town or road (inverted so a premultiplying decoder keeps RGB)

Levels
  pack  4 m over the pack bounds, from the pack's own 2 m mask (lidar canopy with the trails already cut
        out), tree heights from the tree instances, and the pack's OSM runs burned in as cleared strips.
  mid   16 m over the mid height grid (40 km) and
  far   80 m over the far ring's data (200 km), both from the land cover (DATA-019): ESA WorldCover 2021
        classes (10 tree cover, 60 bare, 50 built-up) and the ETH 2020 canopy height, sampled on a k x k
        sub-grid per cell, with the downhill pistes of every resort in view (osm/pistes_wide.json) burned in.
        Needs raw/<slug>/landcover/{worldcover,eth_canopy}/<tile>.tif; skipped without them.

Runs standalone on a built pack (no rebuild) and from build_pack.py as its last step.
"""
import glob, json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None   # the burn rasters are up to 10,240 px square

PACK_RES = 4.0
HEIGHT_MAX = 40.0       # G channel scale (m)
BLEND_M = 500.0         # a finer level fades in over this many metres inside its edge
# the shader's lift of the under-detected lidar canopy (TerrainMaterial FOREST_LO..FOREST_HI, BUG-028),
# applied before averaging so a 4 m cell holds the share of ground under closed canopy
FOREST_LO, FOREST_HI = 0.08, 0.45
# half-widths (m) of a piste line by difficulty, as the groomed corridors in build_pack.py
RUN_HW = {"novice": 22, "easy": 20, "intermediate": 18, "advanced": 14, "expert": 10}
# inside the pack the lidar has the real trail edges, so the OSM line only narrowly reinforces them
PACK_RUN_K = 0.6
# DATA-019 land cover levels: (name, cell size m, sub-samples per side). mid spans the mid height grid,
# far the far ring's data (cfg far_ring size_m)
LC_LEVELS = (("mid", 16.0, 4), ("far", 100.0, 3))
# BUG-069: the lifted lidar canopy reads a sparse stand (a tree every 10 m or so) as closed canopy, so far off
# its snow went black between the few trees drawn there. The pack level's forest is weighted by the trees the
# client draws, twice:
#   R (seen from far off, where single trees no longer read): by the share of the ground under their crowns,
#     averaged over FAR_SIGMA m, full weight from CROWN_FULL up (dense timber on Vail draws 0.2 to 0.4, sparse
#     bowl stands 0.05 to 0.15), so timber stays a solid dark mass and sparse stands fade to mostly white.
#   stands (seen from near, where every tree shows): only closed stands keep it: the crown share (averaged
#     over CROWN_SIGMA m) passes CROWN_LO..CROWN_HI and the stand is at least 2 x STAND_MIN_R m across (a grey
#     opening, then a closing to fill the holes), so a clump of a dozen trees on open snow is carried by its
#     trees alone instead of a dark patch around them.
FAR_SIGMA = 16.0
CROWN_FULL = 0.2
CROWN_SIGMA = 10.0
CROWN_LO, CROWN_HI = 0.05, 0.14
STAND_MIN_R = 20.0
# FEAT-168: the tree height (m) the shader's shadow length stands for (TerrainMaterial TREE_SHADOW_H)
SHADOW_H = 12.0
# natural crown radius / height per species id, as game/src/world/trees/species.ts SPECIES[].radius
# (tests/test_cover.py parses species.ts and fails if they drift apart)
CROWN_RATIO = np.array([0.13, 0.17, 1.1, 0.1, 0.09, 0.17, 0.35, 0.05])
HEIGHT_SIGMA = 3.0     # cells: canopy height is averaged over the forested cells around (it only lifts coarse chunks)
WC_TREE, WC_BUILT, WC_BARE = 10, 50, 60
ETH_NODATA = 255
TREE_MIN_H = 3.0        # m: WorldCover trees shorter than this in ETH are shrubs or clearings
BARE_ROCK = 0.6         # rock weight of a cell that is all bare ground (snow covers the gentler part)
# BUG-081: WorldCover calls a 10 m pixel tree cover from about 10% canopy, so its tree share runs over the pack
# level's forest (the share under closed canopy, weighted by the drawn trees and their stems), most on the
# south-facing slopes (Vail, current build: 0.75 against 0.71, south faces 0.65 against 0.57; against a pack from
# before FEAT-074's stems it read twice). The land cover levels are calibrated to the pack level where they overlap: a lookup on the tree share (blurred over CAL_SIGMA_M, so a lone 10 m tree pixel counts
# as the clump it is) and how south-facing the cell is, fitted per pack with bilinear weights on CAL_T x CAL_S nodes.
# A node with fewer than CAL_K cells' weight shrinks toward the share-only curve. Without a pack level (or with too
# little overlap, CAL_MIN_CELLS) the level keeps the raw share. 16 m of blur fits as well as 32 m (Vail, fitted on
# one half of the pack and checked on the other) and keeps the stand edges crisper. The result is stored in CAL_Q
# steps (the raw share only ever took k * k of them): a smooth share compresses about 2x worse in the PNG.
CAL_SIGMA_M = 16.0
CAL_Q = 32
CAL_T = np.linspace(0.0, 1.0, 11)
CAL_S = np.linspace(-1.0, 1.0, 5)
CAL_K = 30.0
CAL_MIN_CELLS = 500
CAL_FLAT = 0.05         # height gradient below which a cell faces nowhere (aspect 0)
# BUG-081: in the far tree ring (far_trees.py) the land cover levels take their forest from the lidar crowns instead:
# the drawn crowns' share of the ground (the pack's and the ring's), averaged over FAR_SIGMA, mapped onto the pack
# level's forest by a lookup fitted the same way (CAL_*) where the pack's own crowns and its forest overlap. The
# share is read as t = share / RING_T_FULL (Vail's closed timber draws about 0.3 to 0.4). The ring's own forest
# also joins the pack level as what the land cover is calibrated to, so the fit sees the ridges round the resort.
RING_T_FULL = 0.4
ATTRIBUTION = [
    "Land cover: ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0)",
    "Canopy height: Lang et al. 2023, ETH Global Sentinel-2 10m Canopy Height 2020 (CC BY 4.0)",
]


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def box(a, k):
    """mean over k x k blocks (crops the remainder)"""
    h, w = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:h, :w].reshape(h // k, k, w // k, k).mean(axis=(1, 3))


def read_mask(pack_dir, meta):
    """the pack's 2 m RGBA mask over its bounds as float 0..1, row 0 = north"""
    m = meta["mask"]; T = m["tileSize"]
    big = np.zeros((m["tilesY"] * T, m["tilesX"] * T, 4), np.uint8)
    for ty in range(m["tilesY"]):
        for tx in range(m["tilesX"]):
            p = os.path.join(pack_dir, "mask", f"{tx}_{ty}.png")
            if os.path.exists(p):
                r0 = (m["tilesY"] - 1 - ty) * T
                big[r0:r0 + T, tx * T:(tx + 1) * T] = np.asarray(Image.open(p).convert("RGBA"))
    b = meta["bounds"]
    W = int(round((b["maxX"] - m["minX"]) / m["res"])); H = int(round((b["maxY"] - m["minY"]) / m["res"]))
    return big[big.shape[0] - H:, :W].astype(np.float32) / 255.0


def burn_runs(runs, w, h, res, min_x, max_y, k=1.0, to_px=None):
    """0..1 raster (row 0 = north) of the runs as cleared strips: areas filled, lines at their corridor
    width times k. Gladed runs keep their trees. `to_px` maps local (x, y) to pixel (col, row)."""
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    to_px = to_px or (lambda x, y: ((x - min_x) / res, (max_y - y) / res))
    for r in runs:
        if r.get("gladed") or len(r["points"]) < 2:
            continue
        pts = [to_px(p[0], p[1]) for p in r["points"]]
        if r.get("area") and len(pts) >= 3:
            d.polygon(pts, fill=255)
        else:
            wpx = max(1, int(round(2 * RUN_HW.get(r.get("difficulty") or "", 12) * k / res)))
            d.line(pts, fill=255, width=wpx, joint="curve")
    return np.asarray(img, np.float32) / 255.0


def tree_records(pack_dir, meta, kind="trees"):
    """the pack's tree instances, one (n, 6) float32 array per cell: x, y, z, height, crown radius, species;
    kind "farTrees" gives the far tree ring's (BUG-081)"""
    inst = meta.get("instances") or {}
    d = os.path.join(pack_dir, kind)
    listed = inst.get("treeCells" if kind == "trees" else "farTreeCells")
    names = listed or ([f[:-4] for f in os.listdir(d) if f.endswith(".bin")] if os.path.isdir(d) else [])
    for nm in names:
        p = os.path.join(d, f"{nm}.bin")
        if os.path.exists(p):
            yield np.fromfile(p, "<f4").reshape(-1, 6)


def tree_heights(pack_dir, meta, cell, w, h):
    """mean tree height (m) per `cell` m over the pack bounds from the tree instances, row 0 = north; 0 = no trees"""
    b = meta["bounds"]
    nx, ny = int(math.ceil((b["maxX"] - b["minX"]) / cell)), int(math.ceil((b["maxY"] - b["minY"]) / cell))
    hs = np.zeros((ny, nx), np.float64); cn = np.zeros((ny, nx), np.float64)
    for t in tree_records(pack_dir, meta):
        c = ((t[:, 0] - b["minX"]) / cell).astype(int); r = ((b["maxY"] - t[:, 1]) / cell).astype(int)
        ok = (c >= 0) & (c < nx) & (r >= 0) & (r < ny)
        np.add.at(hs, (r[ok], c[ok]), t[ok, 3]); np.add.at(cn, (r[ok], c[ok]), 1)
    # FEAT-074: the stand's generated stems, weighted by their chance
    import stands
    _a, _s, shs, scn = stands.expected_crowns(pack_dir, meta, cell, nx, ny, SHADOW_H)
    hs += shs; cn += scn
    mean = np.where(cn > 0, hs / np.maximum(cn, 1), 0).astype(np.float32)
    k = int(round(cell / PACK_RES))
    return np.repeat(np.repeat(mean, k, 0), k, 1)[:h, :w]


def crown_radii(species, height, crown):
    """the crown radius (m) the client draws per record, as game/src/world/trees/species.ts: speciesFor (an id
    outside the table draws as species 0) then crownRadius (the natural radius of the species times the
    height, pulled 0.85..1.25x toward the crown in the record)"""
    s = np.rint(species).astype(int)
    sp = np.where((s >= 0) & (s < len(CROWN_RATIO)), s, 0)
    nat = CROWN_RATIO[sp] * height
    k = np.where((nat > 0) & (crown > 0), crown / np.maximum(nat, 1e-6), 1.0)
    return nat * np.clip(k, 0.85, 1.25)


def crown_area(pack_dir, meta, w, h):
    """BUG-069: the share of each PACK_RES cell over the pack bounds (row 0 = north) under the crowns the
    client draws, unsmoothed. Overlapping crowns are summed, so a cell can pass 1 and a clump reads a little
    denser than the ground it shades; fine for weighting the cover, which saturates at CROWN_FULL anyway.
    Also returns the same raster with each tree weighted by its height over SHADOW_H (FEAT-168: what throws a
    shadow of the length the shader assumes; krummholz mats throw next to none)."""
    b = meta["bounds"]
    area = np.zeros((h, w), np.float64); shade = np.zeros((h, w), np.float64)
    for t in tree_records(pack_dir, meta):
        cr = crown_radii(t[:, 5], t[:, 3], t[:, 4])
        c = ((t[:, 0] - b["minX"]) / PACK_RES).astype(int); r = ((b["maxY"] - t[:, 1]) / PACK_RES).astype(int)
        ok = (c >= 0) & (c < w) & (r >= 0) & (r < h)
        a = np.pi * cr[ok] ** 2
        np.add.at(area, (r[ok], c[ok]), a)
        np.add.at(shade, (r[ok], c[ok]), a * np.clip(t[ok, 3] / SHADOW_H, 0, 1.5))
    # FEAT-074: plus the stems the client generates from the stand density, in expectation
    import stands
    sa, ss, _h, _c = stands.expected_crowns(pack_dir, meta, PACK_RES, w, h, SHADOW_H)
    return (area / PACK_RES ** 2 + sa).astype(np.float32), (shade / PACK_RES ** 2 + ss).astype(np.float32)


def closed_stand(crowns):
    """BUG-069: 0..1 weight of the ground under a closed stand of drawn trees, from their smoothed crown share"""
    from scipy import ndimage
    dense = smoothstep(CROWN_LO, CROWN_HI, crowns).astype(np.float32)
    r = int(round(STAND_MIN_R / PACK_RES))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    disc = (xx * xx + yy * yy) <= r * r
    # drop the clumps, then fill the holes the same size inside the stands that stay
    core = ndimage.grey_closing(ndimage.grey_opening(dense, footprint=disc), footprint=disc)
    return ndimage.gaussian_filter(core, 1.0)


def to_rgba(forest, height, rock, built):
    """pack the channels; G, B and A are quantised (2.5 m of canopy, 1/8 of rock, 1/4 of built-up), which
    the per-vertex lift and the rock threshold never resolve, so the PNGs compress about 3x better"""
    q = lambda a, n: np.round(np.clip(a, 0, 1) * n) / n
    ch = [np.clip(forest, 0, 1), q(height / HEIGHT_MAX, 16), q(rock, 8), 1 - q(built, 4)]
    return (np.stack(ch, axis=-1) * 255 + 0.5).astype(np.uint8)


def write_level(pack_dir, name, rgba, res, min_x, min_y):
    d = os.path.join(pack_dir, "cover"); os.makedirs(d, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(os.path.join(d, f"{name}.png"), optimize=True)
    h, w = rgba.shape[:2]
    return {"name": name, "res": res, "minX": float(min_x), "minY": float(min_y), "w": int(w), "h": int(h), "file": f"cover/{name}.png"}


def pack_level(pack_dir, meta, runs, log=print):
    """FEAT-153: the pack's own canopy at 4 m with its runs burned in"""
    b = meta["bounds"]
    mask = read_mask(pack_dir, meta)
    k = int(round(PACK_RES / meta["mask"]["res"]))
    forest = box(smoothstep(FOREST_LO, FOREST_HI, mask[..., 3]), k)
    rock = box(mask[..., 0], k)
    del mask
    h, w = forest.shape
    burn = burn_runs(runs, w, h, PACK_RES, b["minX"], b["maxY"], PACK_RUN_K)
    log(f"  pack cover {w} x {h} at {PACK_RES:g} m: forest {forest.mean()*100:.1f}%, "
        f"runs clear {(forest * burn).sum() / max(forest.sum(), 1) * 100:.1f}% of it")
    forest *= 1 - burn
    crowns, shade = crown_area(pack_dir, meta, w, h)
    stands = None
    if crowns.any():   # a pack without tree instances keeps its canopy (the ground then carries the forest)
        from scipy import ndimage
        before = forest.sum()
        stands = forest * closed_stand(ndimage.gaussian_filter(crowns, CROWN_SIGMA / PACK_RES))
        forest *= np.clip(ndimage.gaussian_filter(crowns, FAR_SIGMA / PACK_RES) / CROWN_FULL, 0, 1)
        log(f"  drawn trees keep {forest.sum() / max(before, 1) * 100:.1f}% of the forest from far off, "
            f"closed stands {stands.sum() / max(before, 1) * 100:.1f}% from near (BUG-069)")
    height = tree_heights(pack_dir, meta, 16.0, w, h)
    lv = write_level(pack_dir, "pack", to_rgba(forest, height, rock, np.zeros_like(forest)), PACK_RES, b["minX"], b["minY"])
    if stands is not None:
        lv["stands"] = "cover/pack-stands.png"
        lv["crowns"] = True   # FEAT-168: G of the stands image is where the drawn trees stand, for their shadows
        img = np.stack([stands, shade, np.zeros_like(stands)], axis=-1)
        Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").save(os.path.join(pack_dir, lv["stands"]), optimize=True)
    return lv


# ------------------------------------------------------------------ BUG-081: land cover calibrated to the lidar
def _weights(v, nodes):
    """(lower node index, weight of the upper node) of each value on an evenly spaced node axis"""
    f = np.clip((v - nodes[0]) / (nodes[1] - nodes[0]), 0, len(nodes) - 1 - 1e-6)
    i = np.floor(f).astype(np.int64)
    return i, (f - i).astype(np.float64)


def fit_calibration(t, south, p):
    """lookup (len(CAL_T), len(CAL_S)) of the mean pack forest p by land cover tree share t and south-facing
    -1..1, from flat arrays of overlapping cells. Bilinear weights; each node shrinks toward the share-only curve
    by CAL_K cells; the result never falls as the share rises."""
    nt, ns = len(CAL_T), len(CAL_S)
    it, wt = _weights(t, CAL_T)
    js, ws = _weights(south, CAL_S)
    p = p.astype(np.float64)
    # share-only curve
    s1 = np.bincount(it, p * (1 - wt), nt) + np.bincount(it + 1, p * wt, nt)
    c1 = np.bincount(it, 1 - wt, nt) + np.bincount(it + 1, wt, nt)
    have = c1 > 1e-6
    m = np.interp(np.arange(nt), np.flatnonzero(have), s1[have] / c1[have])
    s2 = np.zeros(nt * ns); c2 = np.zeros(nt * ns)
    for di, wi in ((0, 1 - wt), (1, wt)):
        for dj, wj in ((0, 1 - ws), (1, ws)):
            k = (it + di) * ns + js + dj
            s2 += np.bincount(k, p * wi * wj, nt * ns); c2 += np.bincount(k, wi * wj, nt * ns)
    lut = ((s2 + CAL_K * np.repeat(m, ns)) / (c2 + CAL_K)).reshape(nt, ns)
    return np.maximum.accumulate(lut, axis=0)


def apply_calibration(lut, t, south):
    """bilinear lookup of fit_calibration's table"""
    it, wt = _weights(t, CAL_T)
    js, ws = _weights(south, CAL_S)
    return ((lut[it, js] * (1 - ws) + lut[it, js + 1] * ws) * (1 - wt)
            + (lut[it + 1, js] * (1 - ws) + lut[it + 1, js + 1] * ws) * wt).astype(np.float32)


def south_facing(hgt, res):
    """-1 (faces north) .. 1 (faces south) per cell of a height grid (row 0 = north); 0 on the flat and on voids"""
    h = np.where(np.isfinite(hgt), hgt, np.nanmean(hgt) if np.isfinite(hgt).any() else 0.0)
    d_row, d_col = np.gradient(h, res)
    dzdy = -d_row   # rows run south
    g = np.hypot(d_col, dzdy)
    s = np.where(g > CAL_FLAT, dzdy / np.maximum(g, 1e-9), 0.0)   # a south face rises to the north
    return np.where(np.isfinite(hgt), s, 0.0).astype(np.float32)


def read_height_set(pack_dir, meta, name):
    """a whole height set as one float32 grid (row 0 = north) and its (res, minX, maxY), or None"""
    from packwriter import decode_terrarium
    m = (meta.get("terrain") or {}).get(name)
    if not m:
        return None
    T = m["tileSize"]
    big = np.full((m["tilesY"] * T, m["tilesX"] * T), np.nan, np.float32)
    for ty in range(m["tilesY"]):
        for tx in range(m["tilesX"]):
            p = os.path.join(pack_dir, name, f"{tx}_{ty}.png")
            if os.path.exists(p):
                r0 = (m["tilesY"] - 1 - ty) * T
                big[r0:r0 + T, tx * T:(tx + 1) * T] = decode_terrarium(np.asarray(Image.open(p).convert("RGB")))
    return big, m["res"], m["minX"], m["minY"] + m["tilesY"] * T * m["res"]


def heights_at(hs, xs, ys):
    """nearest heights of a read_height_set grid at cell centres xs (east) by ys (north, falling), (len(ys), len(xs))"""
    big, res, min_x, max_y = hs
    c = np.floor((xs - min_x) / res).astype(np.int64); r = np.floor((max_y - ys) / res).astype(np.int64)
    okc = (c >= 0) & (c < big.shape[1]); okr = (r >= 0) & (r < big.shape[0])
    out = np.full((len(ys), len(xs)), np.nan, np.float32)
    out[np.ix_(okr, okc)] = big[np.ix_(r[okr], c[okc])]
    return out


class PackForest:
    """the pack level's forest (R, 0..1 at PACK_RES, row 0 = north) and its bounds, for calibrating the land cover"""
    def __init__(self, forest, bounds):
        self.forest, self.b = forest, bounds

    def at(self, res, xs, ys):
        """the forest averaged over res-sized cells centred at xs by ys, and which of them lie inside the pack at
        least BLEND_M from its edge (where the client shows the pack level alone)"""
        from scipy import ndimage
        k = max(1, int(round(res / PACK_RES)))
        f = ndimage.uniform_filter(self.forest, k, mode="nearest") if k > 1 else self.forest
        b = self.b
        c = np.floor((xs - b["minX"]) / PACK_RES).astype(np.int64); r = np.floor((b["maxY"] - ys) / PACK_RES).astype(np.int64)
        inc = (xs > b["minX"] + BLEND_M) & (xs < b["maxX"] - BLEND_M) & (c >= 0) & (c < f.shape[1])
        inr = (ys > b["minY"] + BLEND_M) & (ys < b["maxY"] - BLEND_M) & (r >= 0) & (r < f.shape[0])
        out = np.zeros((len(ys), len(xs)), np.float32)
        out[np.ix_(inr, inc)] = f[np.ix_(r[inr], c[inc])]
        return out, np.outer(inr, inc)


def calibrate(forest, built, south, res, truth, name, log=print):
    """BUG-081: the land cover tree share of one level mapped onto the lidar forest (see CAL_*). `truth` is
    (forest, where it holds) on the level's grid: the pack level's, and the far tree ring's where there is one."""
    from scipy import ndimage
    if truth is None:
        return forest
    sig = CAL_SIGMA_M / res
    t = ndimage.gaussian_filter(forest, sig) if sig >= 0.5 else forest
    p, inside = truth
    ok = inside & (built < 0.1)
    if ok.sum() < CAL_MIN_CELLS:
        log(f"  {name}: {ok.sum()} cells overlap the lidar forest, too few to calibrate; raw land cover share kept")
        return forest
    lut = fit_calibration(t[ok], south[ok], p[ok])
    out = np.round(apply_calibration(lut, t, south) * CAL_Q) / CAL_Q
    def part(sel, what):
        if not sel.any():
            return f"{what} none"
        return f"{what} {forest[sel].mean():.3f} -> {out[sel].mean():.3f} (lidar {p[sel].mean():.3f})"
    log(f"  {name} calibrated on {ok.sum()} cells (BUG-081): {part(ok, 'forest where both')}; "
        f"{part(ok & (south < -0.3), 'north-facing')}, {part(ok & (south > 0.3), 'south-facing')}; "
        f"whole level {forest.mean():.3f} -> {out.mean():.3f}")
    return out


def crown_grid(recs, res, min_x, max_y, w, h):
    """the drawn crowns' share of each res-sized cell (row 0 = north), their summed height and count"""
    area = np.zeros((h, w), np.float64); hs = np.zeros((h, w), np.float64); n = np.zeros((h, w), np.float64)
    for t in recs:
        cr = crown_radii(t[:, 5], t[:, 3], t[:, 4])
        c = np.floor((t[:, 0] - min_x) / res).astype(np.int64); r = np.floor((max_y - t[:, 1]) / res).astype(np.int64)
        ok = (c >= 0) & (c < w) & (r >= 0) & (r < h)
        np.add.at(area, (r[ok], c[ok]), np.pi * cr[ok] ** 2)
        np.add.at(hs, (r[ok], c[ok]), t[ok, 3]); np.add.at(n, (r[ok], c[ok]), 1)
    return (area / res ** 2).astype(np.float32), hs, n


def ring_forest(pack_dir, meta, res, min_x, max_y, w, h, south, pack_truth, name, log=print):
    """BUG-081: the forest, canopy height and weight (0..1, fading in over BLEND_M inside the ring's outer edge) of
    the far tree ring on one land cover level's grid, or None (no ring, or too little of the pack to fit on)"""
    inst = meta.get("instances") or {}
    box_l = inst.get("farTreeBox")
    if not inst.get("farTreeCells") or not box_l or pack_truth is None:
        return None
    from scipy import ndimage
    p, inside = pack_truth
    if inside.sum() < CAL_MIN_CELLS:
        return None
    own, ohs, on = crown_grid(tree_records(pack_dir, meta), res, min_x, max_y, w, h)
    far, fhs, fn = crown_grid(tree_records(pack_dir, meta, "farTrees"), res, min_x, max_y, w, h)
    sig = FAR_SIGMA / res
    blur = (lambda a: ndimage.gaussian_filter(a, sig)) if sig >= 0.5 else (lambda a: a)
    t_own = np.clip(blur(own) / RING_T_FULL, 0, 1); t_all = np.clip(blur(own + far) / RING_T_FULL, 0, 1)
    lut = fit_calibration(t_own[inside], south[inside], p[inside])
    forest = np.round(apply_calibration(lut, t_all, south) * CAL_Q) / CAL_Q
    cnt = on + fn
    hgt = np.where(cnt > 0, (ohs + fhs) / np.maximum(cnt, 1), 0).astype(np.float32)
    has = (cnt > 0).astype(np.float32)
    hgt = np.where(forest > 0, ndimage.gaussian_filter(hgt, HEIGHT_SIGMA) / np.maximum(ndimage.gaussian_filter(has, HEIGHT_SIGMA), 1e-3), 0)
    cx = min_x + (np.arange(w) + 0.5) * res; cy = max_y - (np.arange(h) + 0.5) * res
    dx = np.minimum(cx - box_l[0], box_l[2] - cx); dy = np.minimum(cy - box_l[1], box_l[3] - cy)
    wgt = np.outer(smoothstep(0, BLEND_M, dy), smoothstep(0, BLEND_M, dx)).astype(np.float32)
    sel = wgt > 0.99
    log(f"  {name} far tree ring (BUG-081): forest {forest[sel].mean() if sel.any() else 0:.3f} over "
        f"{sel.sum() * res * res / 1e6:.0f} km2 from {fn.sum():.0f} far crowns, fitted on {inside.sum()} pack cells "
        f"(pack {p[inside].mean():.3f}, its crowns mapped {apply_calibration(lut, t_own[inside], south[inside]).mean():.3f})")
    return forest, hgt, wgt


# ------------------------------------------------------------------ DATA-019: land cover outside the pack
def read_window(path, lon_a, lat_a, lon_b, lat_b, level, fill):
    """pixels of one pyramid level of a 3 x 3 degree EPSG:4326 COG inside a lon/lat box, decoding only the
    tiles it touches. Returns (array, west lon, north lat, deg per px lon, deg per px lat) or None."""
    import tifffile
    with tifffile.TiffFile(path) as tif:
        full = tif.pages[0]
        tie = full.tags["ModelTiepointTag"].value; sc = full.tags["ModelPixelScaleTag"].value
        lon0, lat0 = tie[3], tie[4]
        pg = tif.series[0].levels[level].keyframe
        H, W = pg.shape[:2]
        dx = sc[0] * full.imagewidth / W; dy = sc[1] * full.imagelength / H
        c0 = max(0, int(math.floor((lon_a - lon0) / dx))); c1 = min(W, int(math.ceil((lon_b - lon0) / dx)))
        r0 = max(0, int(math.floor((lat0 - lat_b) / dy))); r1 = min(H, int(math.ceil((lat0 - lat_a) / dy)))
        if c1 <= c0 or r1 <= r0:
            return None
        tw, tl = pg.tilewidth, pg.tilelength; ntx = (W + tw - 1) // tw
        out = np.full((r1 - r0, c1 - c0), fill, pg.dtype)
        fh = tif.filehandle
        for ty in range(r0 // tl, (r1 - 1) // tl + 1):
            for tx in range(c0 // tw, (c1 - 1) // tw + 1):
                i = ty * ntx + tx
                if not pg.databytecounts[i]:
                    continue
                fh.seek(pg.dataoffsets[i])
                seg = pg.decode(fh.read(pg.databytecounts[i]), i)[0][0, :, :, 0]
                ya, xa = ty * tl, tx * tw
                ra, rb = max(r0, ya), min(r1, ya + tl); ca, cb = max(c0, xa), min(c1, xa + tw)
                out[ra - r0:rb - r0, ca - c0:cb - c0] = seg[ra - ya:rb - ya, ca - xa:cb - xa]
    return out, lon0 + c0 * dx, lat0 - r0 * dy, dx, dy


class Mosaic:
    """windows of the 3 x 3 degree tiles of one dataset covering a lon/lat box, looked up by nearest pixel"""
    def __init__(self, paths, box_ll, level, fill):
        self.fill = fill
        self.wins = [w for w in (read_window(p, *box_ll, level, fill) for p in paths) if w is not None]

    def lookup(self, lon, lat):
        out = np.full(lon.shape, self.fill, np.uint8)
        for a, w0, n0, dx, dy in self.wins:
            c = np.floor((lon - w0) / dx).astype(np.int64); r = np.floor((n0 - lat) / dy).astype(np.int64)
            ok = (c >= 0) & (c < a.shape[1]) & (r >= 0) & (r < a.shape[0])
            out[ok] = a[r[ok], c[ok]]
        return out


def osm_pistes(path, to_local):
    """downhill pistes from an Overpass `out geom` dump as run records (local metres): ways as lines, or
    areas when closed and tagged area=yes; multipolygon relations as their outer rings"""
    if not os.path.exists(path):
        return []
    runs = []
    def rec(t, geom, area):
        pts = [[*to_local(g["lon"], g["lat"]), 0.0] for g in geom if g]
        if len(pts) >= 2:
            runs.append({"difficulty": t.get("piste:difficulty"), "area": area,
                         "gladed": t.get("piste:gladed") == "yes" or t.get("gladed") == "yes", "points": pts})
    for el in json.load(open(path, encoding="utf-8"))["elements"]:
        t = el.get("tags", {})
        if el.get("type") == "way" and el.get("geometry"):
            g = el["geometry"]
            rec(t, g, len(g) > 3 and g[0] == g[-1] and t.get("area") == "yes")
        elif el.get("type") == "relation":
            for m in el.get("members", []):
                if m.get("type") == "way" and m.get("role") in ("outer", "") and m.get("geometry"):
                    rec(t, m["geometry"], True)
    return runs


def landcover_level(pack_dir, raw_dir, cfg, name, res, k, rect, runs, log=print, pack=None, heights=None):
    """one land cover level over rect = (minX, minY, w cells, h cells), local metres; calibrated to `pack` (a
    PackForest) with the aspect from `heights` (a read_height_set grid) when both are given (BUG-081)"""
    from pyproj import Transformer
    min_x, min_y, w, h = rect
    max_y = min_y + h * res
    ox, oy = cfg["origin"]
    to_ll = Transformer.from_crs(cfg["crs"], "EPSG:4326", always_xy=True)
    lc = os.path.join(raw_dir, "landcover")
    wc_paths = sorted(glob.glob(os.path.join(lc, "worldcover", "*.tif")))
    eth_paths = sorted(glob.glob(os.path.join(lc, "eth_canopy", "*.tif")))
    # lon/lat box of the level (corners and edge midpoints) with a small margin
    xs = [min_x, min_x + w * res / 2, min_x + w * res]; ys = [min_y, min_y + h * res / 2, max_y]
    lo, la = to_ll.transform([x + ox for x in xs for _ in ys], [y + oy for _ in xs for y in ys])
    box_ll = (min(lo) - 0.01, min(la) - 0.01, max(lo) + 0.01, max(la) + 0.01)
    # coarsest pyramid level whose pixels (9.3 m north-south at level 0) are no larger than a sub-sample
    sub = res / k
    lvl = max(0, int(math.floor(math.log2(max(1.0, sub / 9.3)))))
    wc = Mosaic(wc_paths, box_ll, lvl, 0)
    eth = Mosaic(eth_paths, box_ll, lvl, ETH_NODATA) if eth_paths else None
    # pistes on the sub-sample grid
    W, Hs = w * k, h * k
    burn = burn_runs(runs, W, Hs, sub, min_x, max_y) > 0.5
    forest = np.zeros((h, w), np.float32); height = np.zeros((h, w), np.float32)
    bare = np.zeros((h, w), np.float32); built = np.zeros((h, w), np.float32)
    block = max(1, 2_000_000 // (W * k)) * k    # sub-rows per block, a multiple of k
    sx = min_x + (np.arange(W) + 0.5) * sub + ox
    for r0 in range(0, Hs, block):
        r1 = min(Hs, r0 + block)
        sy = max_y - (np.arange(r0, r1) + 0.5) * sub + oy
        GX, GY = np.meshgrid(sx, sy)
        lon, lat = to_ll.transform(GX, GY)
        c = wc.lookup(lon, lat)
        e = eth.lookup(lon, lat) if eth else np.full(c.shape, ETH_NODATA, np.uint8)
        tree = (c == WC_TREE) & ((e == ETH_NODATA) | (e >= TREE_MIN_H)) & ~burn[r0:r1]
        tn = tree & (e != ETH_NODATA)
        th = np.where(tn, e, 0).astype(np.float32)
        cr0, cr1 = r0 // k, r1 // k
        forest[cr0:cr1] = box(tree.astype(np.float32), k)
        hs, hn = box(th, k), box(tn.astype(np.float32), k)
        height[cr0:cr1] = np.where(hn > 0, hs / np.maximum(hn, 1e-6), 0)
        bare[cr0:cr1] = box((c == WC_BARE).astype(np.float32), k)
        built[cr0:cr1] = box((c == WC_BUILT).astype(np.float32), k)
    from scipy import ndimage
    has = (height > 0).astype(np.float32)
    height = np.where(forest > 0, ndimage.gaussian_filter(height, HEIGHT_SIGMA) / np.maximum(ndimage.gaussian_filter(has, HEIGHT_SIGMA), 1e-3), 0)
    log(f"  {name} cover {w} x {h} at {res:g} m (pyramid level {lvl}, {k} x {k} samples): forest {forest.mean()*100:.1f}%, "
        f"bare {bare.mean()*100:.1f}%, built-up {built.mean()*100:.1f}%, pistes on {burn.mean()*100:.2f}% of it")
    if pack is not None and heights is not None:
        cx = min_x + (np.arange(w) + 0.5) * res; cy = max_y - (np.arange(h) + 0.5) * res
        south = south_facing(heights_at(heights, cx, cy), res)
        truth = pack.at(res, cx, cy)
        meta = json.load(open(os.path.join(pack_dir, "meta.json"), encoding="utf-8"))
        ring = ring_forest(pack_dir, meta, res, min_x, max_y, w, h, south, truth, name, log)
        if ring is not None:
            # the ring's lidar forest is what the land cover is calibrated to as well, outside the pack
            rf, rh, rw = ring
            p, inside = truth
            truth = (np.where(inside, p, rf), inside | (rw > 0.99))
        forest = calibrate(forest, built, south, res, truth, name, log)
        if ring is not None:
            forest = forest * (1 - rw) + rf * rw
            height = np.where(rh > 0, height * (1 - rw) + rh * rw, height * (1 - rw))
    return write_level(pack_dir, name, to_rgba(forest, height, bare * BARE_ROCK, built), res, min_x, min_y)


def landcover_levels(pack_dir, raw_dir, cfg, meta, log=print, pack=None):
    """DATA-019: the mid and far land cover levels, or [] without the raw land cover; calibrated to `pack` (a
    PackForest, BUG-081) with the aspect from the height set of the same name"""
    if not cfg or not glob.glob(os.path.join(raw_dir, "landcover", "worldcover", "*.tif")):
        log("  no land cover (raw/<slug>/landcover/worldcover/*.tif); the far terrain keeps the procedural treeline")
        return []
    from pyproj import Transformer
    to_utm = Transformer.from_crs("EPSG:4326", cfg["crs"], always_xy=True)
    ox, oy = cfg["origin"]
    def to_local(lon, lat):
        x, y = to_utm.transform(lon, lat)
        return x - ox, y - oy
    runs = osm_pistes(os.path.join(raw_dir, "osm", "pistes_wide.json"), to_local)
    log(f"  pistes in view: {len(runs)} ways")
    out = []
    for name, res, k in LC_LEVELS:
        if name == "mid":
            m = meta["terrain"].get("mid")
            if not m:
                continue
            rect = (m["minX"], m["minY"], int(round((m["maxX"] - m["minX"]) / res)), int(round((m["maxY"] - m["minY"]) / res)))
        else:
            half = cfg["far_ring"]["size_m"] / 2
            n = int(round(2 * half / res))
            rect = (-half, -half, n, n)
        heights = read_height_set(pack_dir, meta, name) if pack is not None else None
        out.append(landcover_level(pack_dir, raw_dir, cfg, name, res, k, rect, runs, log, pack, heights))
        del heights
    return out


def build_cover(pack_dir, raw_dir, cfg=None, log=print):
    """write cover/*.png and return the meta entry. The pack level comes first: the land cover levels are
    calibrated to its forest (BUG-081)."""
    meta = json.load(open(os.path.join(pack_dir, "meta.json"), encoding="utf-8"))
    feats = json.load(open(os.path.join(pack_dir, "features.json"), encoding="utf-8"))
    pack_lv, pack = None, None
    if meta.get("mask"):
        pack_lv = pack_level(pack_dir, meta, feats.get("runs", []), log)
        r = np.asarray(Image.open(os.path.join(pack_dir, pack_lv["file"])))[..., 0].astype(np.float32) / 255.0
        pack = PackForest(r, meta["bounds"])
    levels = landcover_levels(pack_dir, raw_dir, cfg, meta, log, pack)
    if pack_lv:
        levels.append(pack_lv)
    return {"heightMax": HEIGHT_MAX, "blend": BLEND_M, "levels": levels}


if __name__ == "__main__":
    slug, raw, pack = sys.argv[1], sys.argv[2], sys.argv[3]
    HERE = os.path.dirname(os.path.abspath(__file__))
    cfg = json.load(open(os.path.join(HERE, "resorts", f"{slug}.json"), encoding="utf-8"))
    entry = build_cover(pack, raw, cfg)
    mp = os.path.join(pack, "meta.json")
    meta = json.load(open(mp, encoding="utf-8"))
    meta["cover"] = entry
    if any(lv["name"] in ("mid", "far") for lv in entry["levels"]):
        meta["attribution"] = meta.get("attribution", []) + [a for a in ATTRIBUTION if a not in meta.get("attribution", [])]
    from packwriter import stamp_build
    stamp_build(meta)  # FEAT-177: the cover changed, so the pack is a new build
    with open(mp, "w") as f:
        json.dump(meta, f, indent=1)
    for lv in entry["levels"]:
        sz = os.path.getsize(os.path.join(pack, lv["file"]))
        print(f"{lv['file']}: {lv['w']} x {lv['h']} at {lv['res']:g} m, {sz / 1e6:.1f} MB")
