"""FEAT-175 step 2: the NAIP canopy and rock thresholds for this resort, from its own imagery.

`build_pack.py` stage 5 classifies canopy and rock with NDVI, brightness and saturation thresholds that were
measured on Vail's 2023 NAIP. NAIP is flown state by state, year by year, and its radiometry differs: Big Sky's
2021 Montana imagery is darker and much greyer than Vail's (median saturation of bare ground 0.20 against 0.34),
so Vail's "grey" test called 11 % of Big Sky rock, most of it the meadows and base area.

Each threshold keeps the percentile it sits at on Vail, read on two anchor classes that the lidar defines, not
the imagery: **forest** (2 m cells with lidar canopy over 8 m) and **low bare ground** (canopy under 0.3 m, below
the forest's median elevation: meadows, runs, roads and lawns among the forest belt). The threshold at this
resort is that percentile of each anchor's distribution here. One anchor alone confuses radiometry with what grows
or lies there (Breckenridge's beetle-killed lodgepole reads lower in NDVI than Vail's spruce-fir on the same 2023
imagery), so a threshold moves only when both anchors move it the same way, by the smaller of the two moves; a move
under 3 % is noise and keeps Vail's value; and every value stays inside an absolute range. Snow (brightness over
215 in 8-bit imagery) stays absolute. On Vail's own data the rule gives Vail's values back.

Pure helpers, tested in tests/test_naip_calib.py.
"""
import numpy as np

# name: (Vail's value, NAIP band, absolute range, Vail percentile on the forest anchor, on the low bare anchor).
# Percentiles measured on Vail's raw data (fresh stage 5 of main 1e2e586, every 3rd 2 m cell; 1.81 M forest cells,
# 0.46 M low bare cells, forest median elevation 3,069 m).
THRESHOLDS = {
    "canopy.veg_ndvi":  (0.30, "ndvi",   (0.20, 0.45), 33.60, 76.99),   # canopy needs vegetation in NAIP
    "canopy.leaf_ndvi": (0.45, "ndvi",   (0.30, 0.60), 68.82, 91.20),   # leafy canopy counts from 1.2 m of lidar height
    "canopy.grow_ndvi": (0.15, "ndvi",   (0.08, 0.25), 4.66, 45.06),    # BUG-028: 5 m+ returns over grey crowns
    "rock.ndvi":        (0.18, "ndvi",   (0.05, 0.25), 7.91, 54.57),    # rock is barer than this
    "rock.grey_sat":    (0.20, "sat",    (0.05, 0.30), 6.03, 11.21),    # and greyer (cured meadow is 0.22 to 0.42 on Vail)
    "rock.dark":        (60.0, "bright", (20.0, 90.0), 35.93, 11.91),   # and brighter (shadow is not rock)
    "rock.bare_ndvi":   (0.30, "ndvi",   (0.20, 0.45), 33.60, 76.99),   # steep ground barer than this is rock; meadow below
}
SNOW_BRIGHT = 215.0      # 8-bit NAIP: brighter than this is snow or a white roof, at any resort
FOREST_CHM = 8.0         # m: the forest anchor
BARE_CHM = 0.3           # m: the low bare anchor
MIN_CELLS = 20000        # an anchor with fewer 2 m cells (8 ha) is too small to say anything
NOISE = 0.03             # a move under 3 % of Vail's value keeps Vail's


def vail_thresholds() -> dict:
    return {k: v[0] for k, v in THRESHOLDS.items()}


def anchors(chm, dem, valid):
    """(forest, low bare, forest median elevation) boolean grids from the lidar canopy height and the DEM"""
    forest = valid & (chm > FOREST_CHM)
    if not forest.any():
        return forest, np.zeros_like(forest), None
    z_forest = float(np.median(dem[forest]))
    return forest, valid & (chm < BARE_CHM) & (dem < z_forest), z_forest


def pick(vail, a, b, lo, hi):
    """the threshold from Vail's value and the two anchors' candidates (see the module doc)"""
    if a is None or b is None or (a - vail) * (b - vail) <= 0:
        v = vail
    else:
        v = a if abs(a - vail) < abs(b - vail) else b
    if abs(v - vail) < NOISE * abs(vail):
        v = vail
    return float(min(max(v, lo), hi))


def derive(bands: dict, forest, low_bare, overrides=None):
    """thresholds for this resort and a log line per threshold. `bands` maps "ndvi", "sat", "bright" to 2 m grids
    on the anchors' grid; `overrides` (the config's `naip_thresholds`) wins over the derived value."""
    overrides = overrides or {}
    n_f, n_b = int(forest.sum()), int(low_bare.sum())
    usable = n_f >= MIN_CELLS and n_b >= MIN_CELLS
    out, info = {}, []
    cache = {}
    for name, (vail, band, (lo, hi), p_f, p_b) in THRESHOLDS.items():
        if name in overrides:
            out[name] = float(overrides[name])
            info.append(f"{name} {out[name]:.3f} (config; Vail {vail})")
            continue
        if not usable:
            out[name] = vail
            info.append(f"{name} {vail} (Vail's: anchors too small, forest {n_f} and low bare {n_b} cells)")
            continue
        if band not in cache:
            cache[band] = (bands[band][forest].astype(np.float32), bands[band][low_bare].astype(np.float32))
        fa, ba = cache[band]
        a, b = float(np.percentile(fa, p_f)), float(np.percentile(ba, p_b))
        out[name] = pick(vail, a, b, lo, hi)
        info.append(f"{name} {out[name]:.3f} (Vail {vail}; forest anchor {a:.3f}, low bare {b:.3f})")
    return out, info
