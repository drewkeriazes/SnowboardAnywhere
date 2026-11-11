"""Treeline from a resort's own canopy (DATA-021, toward FEAT-175 step 2).

The client used a Colorado treeline (3,480 m) for the procedural forest, the open valley floor below it and the
snow-ghost band. Big Sky's is about 500 m lower, so the build measures it: the share of ground under canopy in
25 m elevation bands, smoothed over three bands; the treeline is the first band above the most forested one where
that share falls under half the peak and stays there (the middle of the forest's fade, which is
where the client centres its procedural treeline). `build_pack.py` writes it to meta.json as `treeline`
(a config `treeline_m` overrides it). Pure helpers, tested in tests/test_treeline.py."""
import numpy as np

BIN_M = 25.0
MIN_CELLS = 2000      # bands with fewer cells than this are too small to say anything
DROP = 0.5            # treeline: the canopy share falls under this fraction of the peak


def canopy_by_band(elev, forest, valid=None, bin_m=BIN_M):
    """(band floor elevations, canopy share, cell count) per bin_m band."""
    e = np.asarray(elev, np.float32).ravel(); f = np.asarray(forest).ravel().astype(bool)
    ok = np.isfinite(e)
    if valid is not None:
        ok &= np.asarray(valid).ravel().astype(bool)
    e, f = e[ok], f[ok]
    if e.size == 0:
        return np.zeros(0), np.zeros(0), np.zeros(0, int)
    lo = np.floor(e.min() / bin_m) * bin_m
    idx = ((e - lo) // bin_m).astype(int)
    n = np.bincount(idx); k = np.bincount(idx, weights=f)
    share = np.where(n > 0, k / np.maximum(n, 1), 0.0)
    return lo + np.arange(len(n)) * bin_m, share, n


def derive_treeline(elev, forest, valid=None, bin_m=BIN_M, min_cells=MIN_CELLS, drop=DROP):
    """Elevation (m) where the forest ends, or None when the area has no clear forest belt."""
    z, share, n = canopy_by_band(elev, forest, valid, bin_m)
    keep = n >= min_cells
    if keep.sum() < 4:
        return None
    z, share = z[keep], share[keep]
    sm = np.convolve(np.pad(share, 1, mode="edge"), np.ones(3) / 3, mode="valid")
    peak = int(np.argmax(sm))
    if sm[peak] < 0.05:
        return None
    lim = drop * sm[peak]
    for i in range(peak + 1, len(sm)):
        if np.all(sm[i:] < lim):
            return float(z[i])
    return None
