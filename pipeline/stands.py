"""Stand density per 4 m cell: the stems the client generates when a tree cell loads (FEAT-074).

The pack stores the detected crowns (`trees/`) and, per 1 km tree cell, `stands/<cx>_<cy>.png`: how likely a
generated stem is in each 4 m cell, the stand's height and species, and the ground height. The client draws
the stems with a seeded hash (stable between sessions) only near the camera, so millions of fill stems never
sit in the pack or in memory.

stands/<cx>_<cy>.png: RGB, SIZE wide and 2 * SIZE tall, row 0 = north.
  rows 0 .. SIZE-1, one pixel per 4 m cell:
    R  chance of one generated stem in the cell, 0..255 = 0..1
    G  stand height, H_STEP m per step
    B  species id 0..7 (species.py)
  rows SIZE .. 2*SIZE-1: the ground height at the cell centre, (z - zBase) * Z_SCALE as 16 bits, R high and G low,
    where a stem can stand and one cell round it; 0 elsewhere (no data). zBase is the pack's lowest ground, so
    a pack spans at most 2,048 m of relief.
RGB only: a browser decoder that premultiplies alpha would zero the colour where alpha is 0.
"""
import math
import os
import numpy as np
from PIL import Image
from scipy import ndimage

RES = 4.0
H_STEP = 0.25
Z_SCALE = 32.0
# crown area per m2 of canopy that reads as closed forest: the stems' crowns cover the canopy once over
K_CLOSE = 1.0
# the client's crown radius / height per species id (game/src/world/trees/species.ts SPECIES[].radius)
CROWN_RATIO = np.array([0.13, 0.17, 1.1, 0.1, 0.09, 0.17, 0.35, 0.05])
# detected crowns count against the stand over this radius (m), so stems fill gaps instead of doubling clumps
DETECTED_SIGMA = 6.0


def stem_chance(canopy4, height4, species4, detected4):
    """chance (0..1) of one generated stem per 4 m cell.

    canopy4: share of the cell under canopy 0..1; height4: stand height (m); species4: species id per cell;
    detected4: detected crowns per cell. A closed stand wants K_CLOSE / (pi r^2) stems per m2 (r the drawn crown
    radius), scaled by the canopy share; the detected crowns nearby are subtracted."""
    r = CROWN_RATIO[np.clip(species4, 0, len(CROWN_RATIO) - 1).astype(np.int64)] * np.maximum(height4, 1.0)
    want = canopy4 * K_CLOSE / (np.pi * np.maximum(r, 0.5) ** 2)                 # stems per m2
    have = ndimage.gaussian_filter(detected4.astype(np.float32), DETECTED_SIGMA / RES) / RES ** 2
    return np.clip((want - have) * RES ** 2, 0, 1).astype(np.float32)


def encode(p, height, species, z, z_base):
    """one cell's (SIZE x SIZE) fields to the RGB stand image (2 * SIZE x SIZE x 3, uint8)"""
    top = np.stack([np.round(np.clip(p, 0, 1) * 255),
                    np.round(np.clip(height / H_STEP, 0, 255)),
                    np.clip(species, 0, 255)], axis=-1)
    # ground height where a stem can stand and one cell round it (the client interpolates it bilinearly)
    near = ndimage.binary_dilation(p > 0, structure=np.ones((3, 3), bool))
    q = np.where(near, np.round(np.clip((z - z_base) * Z_SCALE, 1, 65535)), 0).astype(np.int64)
    bot = np.stack([q >> 8, q & 255, np.zeros_like(q)], axis=-1)
    return np.concatenate([top, bot], axis=0).astype(np.uint8)


def decode(img, z_base):
    """the inverse of `encode`: p, height (m), species, z (m) per 4 m cell"""
    n = img.shape[0] // 2
    t, b = img[:n].astype(np.float32), img[n:].astype(np.float32)
    return t[..., 0] / 255, t[..., 1] * H_STEP, t[..., 2].astype(np.int64), (b[..., 0] * 256 + b[..., 1]) / Z_SCALE + z_base


def write(out_dir, p, height, species, z, cell, min_x, min_y, cells_x, cells_y, z_base):
    """split the pack-wide 4 m fields (row 0 = north, the south edge at min_y) into stands/<cx>_<cy>.png per tree
    cell; cells with no stem chance get no file. Returns the meta entry."""
    size = int(round(cell / RES))
    H, W = p.shape
    d = os.path.join(out_dir, "stands"); os.makedirs(d, exist_ok=True)
    # south-aligned: pad (or crop) the north rows and the east columns to whole cells
    pad = lambda a: np.pad(a, ((max(0, cells_y * size - H), 0), (0, max(0, cells_x * size - W))))[-cells_y * size:, :cells_x * size]
    P, Hh, S, Z = pad(p), pad(height), pad(species), pad(z)
    names, stems = [], 0.0
    for cy in range(cells_y):
        r0 = (cells_y - 1 - cy) * size
        for cx in range(cells_x):
            sl = (slice(r0, r0 + size), slice(cx * size, (cx + 1) * size))
            if not (P[sl] > 0.5 / 255).any():
                continue
            Image.fromarray(encode(P[sl], Hh[sl], S[sl], Z[sl], z_base), "RGB").save(os.path.join(d, f"{cx}_{cy}.png"), optimize=True)
            names.append(f"{cx}_{cy}"); stems += float(np.round(P[sl] * 255).sum() / 255)
    return {"res": RES, "size": size, "zBase": float(z_base), "zScale": Z_SCALE, "hStep": H_STEP, "cells": sorted(names),
            "stems": int(round(stems))}


def read_all(pack_dir, meta):
    """yield (cx, cy, p, height, species, z) per stand file of a built pack"""
    st = meta.get("stands")
    if not st:
        return
    for nm in st["cells"]:
        f = os.path.join(pack_dir, "stands", f"{nm}.png")
        if os.path.exists(f):
            cx, cy = (int(v) for v in nm.split("_"))
            yield (cx, cy) + decode(np.asarray(Image.open(f).convert("RGB")), st["zBase"])


def expected_crowns(pack_dir, meta, res, w, h, shadow_h):
    """FEAT-074: the crown share the generated stems add per `res` m cell over the pack bounds (row 0 = north),
    in expectation (chance x crown area), plus the shadow-weighted share and height sums, for cover.py"""
    area = np.zeros((h, w), np.float64); shade = np.zeros((h, w), np.float64)
    hsum = np.zeros((h, w), np.float64); hcnt = np.zeros((h, w), np.float64)
    st, inst, b = meta.get("stands"), meta.get("instances") or {}, meta["bounds"]
    if not st:
        return area, shade, hsum, hcnt
    size, sres, cs = st["size"], st["res"], inst["cellSize"]
    for cx, cy, p, hh, sp, _z in read_all(pack_dir, meta):
        i, j = np.nonzero(p > 0)
        x = inst["minX"] + cx * cs + (j + 0.5) * sres
        y = inst["minY"] + (cy + 1) * cs - (i + 0.5) * sres
        c = ((x - b["minX"]) / res).astype(int); r = ((b["maxY"] - y) / res).astype(int)
        ok = (c >= 0) & (c < w) & (r >= 0) & (r < h)
        pp, hv = p[i, j][ok], hh[i, j][ok]
        a = pp * np.pi * (CROWN_RATIO[np.clip(sp[i, j][ok], 0, 7)] * hv * 0.875) ** 2   # mean height 0.875 x the stand's
        np.add.at(area, (r[ok], c[ok]), a)
        np.add.at(shade, (r[ok], c[ok]), a * np.clip(hv * 0.875 / shadow_h, 0, 1.5))
        np.add.at(hsum, (r[ok], c[ok]), pp * hv * 0.875); np.add.at(hcnt, (r[ok], c[ok]), pp)
    k = res * res
    return area / k, shade / k, hsum, hcnt
