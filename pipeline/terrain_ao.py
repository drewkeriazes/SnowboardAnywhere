"""Baked sky visibility (ambient occlusion) from a DEM, for FEAT-047.

For each cell and each of `n_dirs` azimuths, march outwards at log-spaced distances and keep the
highest horizon angle. The angle is measured above the cell's own tangent plane, not above the
horizontal: a plain 35 degree slope is fully open to the sky in its own hemisphere (the renderer's
hemisphere light already darkens it by its normal), while gullies, couloirs, the inside of cirques
and the foot of cliffs see terrain rise above that plane and darken. Visibility per direction is
1 - sin(h); the result is the mean over directions, 0..1.
"""
import math

import numpy as np

DISTS = (2, 4, 6, 9, 13, 19, 28, 40, 58, 84, 120, 170)  # metres


def sky_visibility(z: np.ndarray, res: float, n_dirs: int = 16, dists=DISTS, log=print) -> np.ndarray:
    """z: (H, W) float32 heights in metres, row 0 = north. Returns (H, W) float32 in 0..1."""
    z = np.asarray(z, np.float32)
    if np.isnan(z).any():
        z = np.where(np.isnan(z), np.nanmedian(z), z).astype(np.float32)
    H, W = z.shape
    # slope along rows (southwards) and columns (eastwards), metres per metre
    g_row, g_col = np.gradient(z, res)
    g_row = g_row.astype(np.float32); g_col = g_col.astype(np.float32)
    P = int(math.ceil(max(dists) / res)) + 1
    zp = np.pad(z, P, mode="edge")
    vis = np.zeros((H, W), np.float32)
    for k in range(n_dirs):
        a = 2 * math.pi * k / n_dirs
        ur, uc = -math.cos(a), math.sin(a)  # azimuth from north, clockwise; north is row -1
        best = np.full((H, W), -np.inf, np.float32)
        seen = set()
        for d in dists:
            di, dj = int(round(d * ur / res)), int(round(d * uc / res))
            if (di, dj) in seen or (di == 0 and dj == 0):
                continue
            seen.add((di, dj))
            dist = res * math.hypot(di, dj)
            shifted = zp[P + di:P + di + H, P + dj:P + dj + W]
            # rise above the tangent plane along this exact step, per metre
            rel = shifted - z
            rel -= (g_row * np.float32(di * res) + g_col * np.float32(dj * res))
            rel *= np.float32(1.0 / dist)
            np.maximum(best, rel, out=best)
            del rel
        h = np.arctan(best)
        np.clip(h, 0, math.pi / 2, out=h)
        vis += 1.0 - np.sin(h)
        del best, h
        if log and k % 4 == 3:
            log(f"    ao {k + 1}/{n_dirs} directions")
    vis /= n_dirs
    return vis
