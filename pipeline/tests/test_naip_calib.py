"""FEAT-175 step 2: NAIP thresholds from the resort's own imagery (naip_calib.py)."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import naip_calib as nc  # noqa: E402


def test_anchors_from_lidar():
    chm = np.array([[10, 10, 0, 0], [0.1, 0.1, 12, 0.1]], np.float32)
    dem = np.array([[100, 200, 50, 300], [150, 400, 300, 120]], np.float32)
    forest, bare, z = nc.anchors(chm, dem, np.ones_like(chm, bool))
    assert forest.sum() == 3 and z == 200
    assert bare.tolist() == [[False, False, True, False], [True, False, False, True]]


def test_pick_rule():
    assert nc.pick(0.20, 0.10, 0.06, 0.05, 0.30) == 0.10       # both lower: the smaller move
    assert nc.pick(0.20, 0.27, 0.16, 0.05, 0.30) == 0.20       # they disagree: Vail's
    assert nc.pick(0.20, 0.204, 0.21, 0.05, 0.30) == 0.20      # under 3 %: noise
    assert nc.pick(0.20, 0.02, 0.01, 0.05, 0.30) == 0.05       # clamped to the absolute range
    assert nc.pick(0.20, None, 0.1, 0.05, 0.30) == 0.20


def test_vail_gets_vail_back_and_a_darker_image_moves_only_its_band():
    rng = np.random.default_rng(0)
    n = 30000
    forest = np.zeros(2 * n, bool); forest[:n] = True
    bare = ~forest

    def grid(scale_sat=1.0):
        out = {}
        for band in ("ndvi", "sat", "bright"):
            vals = np.empty(2 * n, np.float32)
            for anchor, sl, col in (("f", slice(0, n), 3), ("b", slice(n, 2 * n), 4)):
                # one band per anchor, built so each threshold of that band sits at its own Vail percentile
                ts = sorted((v[0], v[col]) for v in nc.THRESHOLDS.values() if v[1] == band)
                edges = [0.0] + [p / 100 for _, p in ts] + [1.0]
                pts = [ts[0][0] * 0.5] + [t for t, _ in ts] + [ts[-1][0] * 1.5]
                u = rng.random(n)
                vals[sl] = np.interp(u, edges, pts)
            out[band] = vals * (scale_sat if band == "sat" else 1.0)
        return out

    t, _ = nc.derive(grid(), forest, bare)
    assert t == nc.vail_thresholds()
    t, info = nc.derive(grid(scale_sat=0.5), forest, bare)
    assert abs(t["rock.grey_sat"] - 0.10) < 0.01
    assert {k: v for k, v in t.items() if k != "rock.grey_sat"} == {k: v for k, v in nc.vail_thresholds().items() if k != "rock.grey_sat"}
    assert any(l.startswith("rock.grey_sat 0.10") for l in info)


def test_small_anchors_and_overrides():
    forest = np.zeros(100, bool); forest[:10] = True
    bands = {b: np.zeros(100, np.float32) for b in ("ndvi", "sat", "bright")}
    t, info = nc.derive(bands, forest, ~forest)
    assert t == nc.vail_thresholds() and "too small" in info[0]
    t, _ = nc.derive(bands, forest, ~forest, {"rock.grey_sat": 0.12})
    assert t["rock.grey_sat"] == 0.12
