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

Runs standalone on a built pack (no rebuild) and from build_pack.py as its last step.
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw

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
    ch = [np.clip(forest, 0, 1), np.clip(height / HEIGHT_MAX, 0, 1), np.clip(rock, 0, 1), 1 - np.clip(built, 0, 1)]
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


def build_cover(pack_dir, raw_dir, cfg=None, log=print):
    """write cover/*.png and return the meta entry"""
    meta = json.load(open(os.path.join(pack_dir, "meta.json"), encoding="utf-8"))
    feats = json.load(open(os.path.join(pack_dir, "features.json"), encoding="utf-8"))
    levels = []
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
    with open(mp, "w") as f:
        json.dump(meta, f, indent=1)
    for lv in entry["levels"]:
        sz = os.path.getsize(os.path.join(pack, lv["file"]))
        print(f"{lv['file']}: {lv['w']} x {lv['h']} at {lv['res']:g} m, {sz / 1e6:.1f} MB")
