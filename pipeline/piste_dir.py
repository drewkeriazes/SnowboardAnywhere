"""Piste direction (DATA-002): the grooming axis of every groomed cell, for piste-aligned corduroy.

A groomer drives along the run, so its corduroy runs along the run's axis, not straight down the
fall line (a cat track that traverses the hill has ridges along the track). This module turns the
groomed runs' centre lines into a byte per 2 m cell on the mask grid:

  0        no piste direction (not groomed, and more than `reach` metres from a groomed run)
  1..255   axis angle theta = (byte - 1) / 254 * 180 degrees, measured from east toward north,
           in [0, 180). The axis is undirected (corduroy ridges look the same both ways); the
           client picks the downhill sense from the terrain.

Each cell takes the direction of the nearest groomed centre-line segment (Euclidean distance
transform), encoded as a doubled-angle vector (cos 2t, sin 2t) so the field can be blurred across
segment kinks without 0/180 wrap-around. Written as `dir/<tx>_<ty>.png` (greyscale, same tiling
as `mask/` and `ao/`, `meta.dir`), see docs/pack-format.md.

CLI, to add the set to an existing pack without a rebuild:
  python pipeline/piste_dir.py packs/vail [packs/synth ...]
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

REACH_M = 30.0     # keep a direction this far (m) beyond a groomed run's centre line, groomed or not
SMOOTH_CELLS = 3.0 # gaussian sigma (cells) that softens the field across polyline kinks


def encode_angle(theta_rad: np.ndarray) -> np.ndarray:
    """axis angle (radians, any range) -> byte 1..255 on [0, 180) degrees"""
    deg = np.degrees(theta_rad) % 180.0
    return (1 + np.rint(deg / 180.0 * 254.0)).clip(1, 255).astype(np.uint8)


def decode_angle(byte: np.ndarray) -> np.ndarray:
    """byte 1..255 -> axis angle in radians, [0, pi); undefined for 0"""
    return np.radians((byte.astype(np.float32) - 1.0) / 254.0 * 180.0)


def piste_direction(runs, groomed: np.ndarray, res: float, min_x: float, max_y: float,
                    reach: float = REACH_M, smooth: float = SMOOTH_CELLS, log=None) -> np.ndarray:
    """runs: feature records (`groomed`, `area`, `points` [[x, y, ...], ...] in local metres);
    groomed: (H, W) groomed weight 0..1, row 0 = north (y = max_y), col 0 at x = min_x.
    Returns the (H, W) uint8 direction byte described in the module doc."""
    H, W = groomed.shape
    cos2 = np.zeros((H, W), np.float32)
    sin2 = np.zeros((H, W), np.float32)
    line = np.zeros((H, W), bool)
    n_runs = 0
    for r in runs:
        if not r.get("groomed") or r.get("area") or len(r["points"]) < 2:
            continue
        n_runs += 1
        pts = [(p[0], p[1]) for p in r["points"]]
        for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
            dx, dy = bx - ax, by - ay
            length = math.hypot(dx, dy)
            if length < 1e-6:
                continue
            t2 = 2.0 * math.atan2(dy, dx)
            c2, s2 = math.cos(t2), math.sin(t2)
            steps = max(1, int(length / (res * 0.7)))
            for s in range(steps + 1):
                t = s / steps
                c = int((ax + dx * t - min_x) / res)
                rr = int((max_y - (ay + dy * t)) / res)
                if 0 <= rr < H and 0 <= c < W:
                    cos2[rr, c] = c2
                    sin2[rr, c] = s2
                    line[rr, c] = True
    if not line.any():
        if log:
            log("  piste direction: no groomed runs, set left empty")
        return np.zeros((H, W), np.uint8)
    # every cell takes the nearest centre-line cell's axis
    dist, (ri, ci) = ndimage.distance_transform_edt(~line, return_indices=True)
    dist = dist.astype(np.float32) * res
    cos2 = cos2[ri, ci]
    sin2 = sin2[ri, ci]
    del ri, ci, line
    if smooth > 0:
        cos2 = ndimage.gaussian_filter(cos2, smooth)
        sin2 = ndimage.gaussian_filter(sin2, smooth)
    theta = 0.5 * np.arctan2(sin2, cos2)
    del cos2, sin2
    keep = (groomed > 0) | (dist <= reach)
    out = np.where(keep, encode_angle(theta), 0).astype(np.uint8)
    if log:
        cells = int(keep.sum())
        log(f"  piste direction: {n_runs} groomed runs, {cells * res * res / 1e4:.1f} ha carry a direction "
            f"({(groomed > 0).sum() * res * res / 1e4:.1f} ha groomed), reach {reach:.0f} m, sigma {smooth * res:.0f} m")
    return out


def read_mask_channel(pack_dir: str, meta: dict, channel: int = 2, kind: str = "mask") -> np.ndarray:
    """assemble one channel of a mask-grid tile set onto the full (padded) grid, row 0 = north; 0 where a tile is missing"""
    m = meta[kind]
    n = m["tileSize"]
    H, W = m["tilesY"] * n, m["tilesX"] * n
    out = np.zeros((H, W), np.float32)
    for ty in range(m["tilesY"]):
        for tx in range(m["tilesX"]):
            p = os.path.join(pack_dir, kind, f"{tx}_{ty}.png")
            if not os.path.isfile(p):
                continue
            px = np.asarray(Image.open(p).convert("RGBA"))
            r0 = (m["tilesY"] - 1 - ty) * n
            out[r0:r0 + n, tx * n:(tx + 1) * n] = px[..., channel] / 255.0
    return out


def add_to_pack(pack_dir: str) -> dict:
    """compute the direction set for an existing pack from its features and mask tiles; updates meta.json"""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from packwriter import write_mask_set, write_meta
    with open(os.path.join(pack_dir, "meta.json")) as f:
        meta = json.load(f)
    with open(os.path.join(pack_dir, "features.json")) as f:
        runs = json.load(f).get("runs", [])
    m = meta["mask"]
    groomed = read_mask_channel(pack_dir, meta, 2)
    H, W = groomed.shape
    # work on the resort area only (the tile padding north and east is empty), anchored south-west like the writer
    b = meta.get("bounds")
    if b:
        rows = min(H, int(round((b["maxY"] - m["minY"]) / m["res"])))
        cols = min(W, int(round((b["maxX"] - m["minX"]) / m["res"])))
        groomed = groomed[H - rows:, :cols]
        H, W = groomed.shape
    max_y = m["minY"] + H * m["res"]
    d = piste_direction(runs, groomed, m["res"], m["minX"], max_y, log=print)
    meta["dir"] = write_mask_set(pack_dir, d, m["res"], m["minX"], m["minY"], kind="dir", pad=0)
    write_meta(pack_dir, meta)
    return meta["dir"]


if __name__ == "__main__":
    for pack in sys.argv[1:]:
        info = add_to_pack(pack)
        print(f"{pack}: dir set {info['tilesX']} x {info['tilesY']} tiles written, meta.json updated")
