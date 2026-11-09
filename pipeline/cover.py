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
HEIGHT_SIGMA = 3.0      # cells: canopy height is averaged over the forested cells around (it only lifts coarse chunks)
WC_TREE, WC_BUILT, WC_BARE = 10, 50, 60
ETH_NODATA = 255
TREE_MIN_H = 3.0        # m: WorldCover trees shorter than this in ETH are shrubs or clearings
BARE_ROCK = 0.6         # rock weight of a cell that is all bare ground (snow covers the gentler part)
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


def tree_heights(pack_dir, meta, cell, w, h):
    """mean tree height (m) per `cell` m over the pack bounds from the tree instances, row 0 = north; 0 = no trees"""
    inst = meta.get("instances") or {}
    b = meta["bounds"]
    nx, ny = int(math.ceil((b["maxX"] - b["minX"]) / cell)), int(math.ceil((b["maxY"] - b["minY"]) / cell))
    hs = np.zeros((ny, nx), np.float64); cn = np.zeros((ny, nx), np.float64)
    d = os.path.join(pack_dir, "trees")
    names = inst.get("treeCells") or ([f[:-4] for f in os.listdir(d) if f.endswith(".bin")] if os.path.isdir(d) else [])
    for nm in names:
        p = os.path.join(d, f"{nm}.bin")
        if not os.path.exists(p):
            continue
        t = np.fromfile(p, "<f4").reshape(-1, 6)
        c = ((t[:, 0] - b["minX"]) / cell).astype(int); r = ((b["maxY"] - t[:, 1]) / cell).astype(int)
        ok = (c >= 0) & (c < nx) & (r >= 0) & (r < ny)
        np.add.at(hs, (r[ok], c[ok]), t[ok, 3]); np.add.at(cn, (r[ok], c[ok]), 1)
    mean = np.where(cn > 0, hs / np.maximum(cn, 1), 0).astype(np.float32)
    k = int(round(cell / PACK_RES))
    return np.repeat(np.repeat(mean, k, 0), k, 1)[:h, :w]


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
    height = tree_heights(pack_dir, meta, 16.0, w, h)
    return write_level(pack_dir, "pack", to_rgba(forest, height, rock, np.zeros_like(forest)), PACK_RES, b["minX"], b["minY"])


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


def landcover_level(pack_dir, raw_dir, cfg, name, res, k, rect, runs, log=print):
    """one land cover level over rect = (minX, minY, w cells, h cells), local metres"""
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
    return write_level(pack_dir, name, to_rgba(forest, height, bare * BARE_ROCK, built), res, min_x, min_y)


def landcover_levels(pack_dir, raw_dir, cfg, meta, log=print):
    """DATA-019: the mid and far land cover levels, or [] without the raw land cover"""
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
        out.append(landcover_level(pack_dir, raw_dir, cfg, name, res, k, rect, runs, log))
    return out


def build_cover(pack_dir, raw_dir, cfg=None, log=print):
    """write cover/*.png and return the meta entry"""
    meta = json.load(open(os.path.join(pack_dir, "meta.json"), encoding="utf-8"))
    feats = json.load(open(os.path.join(pack_dir, "features.json"), encoding="utf-8"))
    levels = landcover_levels(pack_dir, raw_dir, cfg, meta, log)
    if meta.get("mask"):
        levels.append(pack_level(pack_dir, meta, feats.get("runs", []), log))
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
    with open(mp, "w") as f:
        json.dump(meta, f, indent=1)
    for lv in entry["levels"]:
        sz = os.path.getsize(os.path.join(pack, lv["file"]))
        print(f"{lv['file']}: {lv['w']} x {lv['h']} at {lv['res']:g} m, {sz / 1e6:.1f} MB")
