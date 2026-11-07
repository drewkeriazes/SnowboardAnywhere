"""Shared writer for resort packs (see docs/pack-format.md).

All inputs are numpy arrays in local metres. Height grids are row 0 = NORTH (max y), like an image.
"""
import json, os, struct
import numpy as np
from PIL import Image

TILE = 512

def encode_terrarium(h: np.ndarray) -> np.ndarray:
    """float32 heights (NaN = void) -> uint8 RGB (H,W,3)."""
    v = np.where(np.isfinite(h), h, -32768.0).astype(np.float64) + 32768.0
    v = np.clip(v, 0, 65535.996)
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.floor((v - r * 256.0 - g) * 256.0)
    return np.stack([r, g, b], axis=-1).astype(np.uint8)

def decode_terrarium(rgb: np.ndarray) -> np.ndarray:
    rgb = rgb.astype(np.float32)
    h = rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0
    h[h <= -32767.5] = np.nan
    return h

def write_height_set(out_dir: str, name: str, grid: np.ndarray, res: float, min_x: float, min_y: float) -> dict:
    """grid: (H, W) float32, row 0 = north. Lower-left corner of sample (H-1, 0) is (min_x, min_y).
    Pads to a whole number of tiles with void. Returns the meta block."""
    H, W = grid.shape
    tiles_x = int(np.ceil(W / TILE)); tiles_y = int(np.ceil(H / TILE))
    padded = np.full((tiles_y * TILE, tiles_x * TILE), np.nan, np.float32)
    # keep the south-west anchored: pad on the north and east
    padded[tiles_y * TILE - H:, :W] = grid
    d = os.path.join(out_dir, name); os.makedirs(d, exist_ok=True)
    for ty in range(tiles_y):          # ty counts from the south
        for tx in range(tiles_x):
            r0 = (tiles_y - 1 - ty) * TILE
            sub = padded[r0:r0 + TILE, tx * TILE:(tx + 1) * TILE]
            if not np.isfinite(sub).any():
                continue
            Image.fromarray(encode_terrarium(sub), "RGB").save(os.path.join(d, f"{tx}_{ty}.png"), optimize=True)
    return {"res": res, "tileSize": TILE, "minX": float(min_x), "minY": float(min_y), "tilesX": tiles_x, "tilesY": tiles_y,
            "maxX": float(min_x + tiles_x * TILE * res), "maxY": float(min_y + tiles_y * TILE * res)}

def write_mask_set(out_dir: str, rgba: np.ndarray, res: float, min_x: float, min_y: float, kind: str = "mask") -> dict:
    """rgba: (H, W, 4) uint8 RGBA, or (H, W) uint8 greyscale (the AO set); row 0 = north."""
    H, W = rgba.shape[:2]
    grey = rgba.ndim == 2
    tiles_x = int(np.ceil(W / TILE)); tiles_y = int(np.ceil(H / TILE))
    padded = np.zeros((tiles_y * TILE, tiles_x * TILE) + (() if grey else (4,)), np.uint8)
    if grey:
        padded[:] = 255  # open sky outside the data
    padded[tiles_y * TILE - H:, :W] = rgba
    d = os.path.join(out_dir, kind); os.makedirs(d, exist_ok=True)
    for ty in range(tiles_y):
        for tx in range(tiles_x):
            r0 = (tiles_y - 1 - ty) * TILE
            sub = padded[r0:r0 + TILE, tx * TILE:(tx + 1) * TILE]
            Image.fromarray(sub, "L" if grey else "RGBA").save(os.path.join(d, f"{tx}_{ty}.png"), optimize=True)
    return {"res": res, "tileSize": TILE, "minX": float(min_x), "minY": float(min_y), "tilesX": tiles_x, "tilesY": tiles_y}

def write_instances(out_dir: str, kind: str, recs: np.ndarray, cell: float, min_x: float, min_y: float, cells_x: int, cells_y: int) -> int:
    """recs: (N, 6) float32 with x, y in local metres in the first two columns."""
    d = os.path.join(out_dir, kind); os.makedirs(d, exist_ok=True)
    if len(recs) == 0:
        return 0
    cx = np.floor((recs[:, 0] - min_x) / cell).astype(int)
    cy = np.floor((recs[:, 1] - min_y) / cell).astype(int)
    ok = (cx >= 0) & (cx < cells_x) & (cy >= 0) & (cy < cells_y)
    recs, cx, cy = recs[ok], cx[ok], cy[ok]
    key = cy * cells_x + cx
    order = np.argsort(key, kind="stable")
    recs, key = recs[order], key[order]
    bounds = np.flatnonzero(np.diff(key)) + 1
    starts = np.concatenate([[0], bounds]); ends = np.concatenate([bounds, [len(key)]])
    for s, e in zip(starts, ends):
        k = int(key[s]); tx, ty = k % cells_x, k // cells_x
        recs[s:e].astype("<f4").tofile(os.path.join(d, f"{tx}_{ty}.bin"))
    return int(len(recs))

def index_cells(out_dir: str, meta: dict) -> None:
    """List the tree and rock cells that have a file, so the client never asks for empty ones (BUG-036)."""
    inst = meta.get("instances")
    if not inst:
        return
    for kind, field in (("trees", "treeCells"), ("rocks", "rockCells")):
        d = os.path.join(out_dir, kind)
        names = sorted(f[:-4] for f in os.listdir(d) if f.endswith(".bin")) if os.path.isdir(d) else []
        inst[field] = names  # "cx_cy", matching the file names

def index_packs(packs_dir: str) -> None:
    """packs/index.json: slugs of every pack with a meta.json, so the menu does not probe missing resorts (BUG-036)."""
    slugs = sorted(n for n in os.listdir(packs_dir) if os.path.isfile(os.path.join(packs_dir, n, "meta.json")))
    with open(os.path.join(packs_dir, "index.json"), "w") as f:
        json.dump({"packs": slugs}, f, indent=1)

def write_meta(out_dir: str, meta: dict):
    index_cells(out_dir, meta)
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    index_packs(os.path.dirname(os.path.abspath(out_dir)))

if __name__ == "__main__":
    # Re-index an existing pack without rebuilding it: python pipeline/packwriter.py packs/vail
    import sys
    for pack_dir in sys.argv[1:]:
        with open(os.path.join(pack_dir, "meta.json")) as f:
            m = json.load(f)
        write_meta(pack_dir, m)
        inst = m.get("instances") or {}
        print(f"{pack_dir}: {len(inst.get('treeCells', []))} tree cells, {len(inst.get('rockCells', []))} rock cells; packs/index.json updated")

def write_features(out_dir: str, features: dict):
    with open(os.path.join(out_dir, "features.json"), "w") as f:
        json.dump(features, f)
