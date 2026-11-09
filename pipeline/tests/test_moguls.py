"""FEAT-059: mogul scoring and field painting."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from moguls import paint_field, run_mogul_score, slope_window  # noqa: E402


def run(**kw):
    base = {"name": "Prima", "difficulty": "expert", "gladed": False, "area": False}
    base.update(kw)
    return base


def test_mogul_tag_wins():
    assert run_mogul_score(run(difficulty="easy", gladed=True), 5.0, None, 1.0, True, False) == 1.0


def test_groomed_blue_scores_zero():
    assert run_mogul_score(run(difficulty="intermediate"), 25.0, 10.0, 0.9, False, True) == 0.0


def test_never_groomed_expert_north_scores_high():
    assert run_mogul_score(run(), 28.0, 10.0, 0.0, False, True) == 1.0


def test_unknown_grooming_falls_back():
    s = run_mogul_score(run(difficulty="advanced"), 28.0, 180.0, None, False, False)
    assert abs(s - 0.7 * 0.9 * 1.0 * 0.7 * 0.8) < 1e-6


def test_occasionally_groomed_scores_lower_than_never():
    never = run_mogul_score(run(difficulty="advanced"), 28.0, 10.0, 0.0, False, True)
    few = run_mogul_score(run(difficulty="advanced"), 28.0, 10.0, 3 / 42, False, True)
    assert never > few > 0.3


def test_blue_left_ungroomed_scores_some():
    assert run_mogul_score(run(difficulty="intermediate"), 28.0, 10.0, 4 / 42, False, True) > 0.2


def test_steep_pitch_counts_not_the_runout():
    # Highline: 75th percentile 24 deg although the whole line averages 15
    assert run_mogul_score(run(), 24.0, 10.0, 0.0, False, False) > 0.7
    assert run_mogul_score(run(), 13.0, 10.0, 0.0, False, False) < 0.2


def test_cat_track_and_glades_zero():
    assert run_mogul_score(run(name="Minnie's Mile Road"), 28.0, 10.0, 0.0, False, True) == 0.0
    assert run_mogul_score(run(gladed=True), 28.0, 10.0, 0.0, False, True) == 0.0
    assert run_mogul_score(run(difficulty="easy"), 28.0, 10.0, 0.0, False, True) == 0.0
    assert run_mogul_score(run(), 8.0, 10.0, 0.0, False, True) == 0.0


def test_slope_window():
    v = slope_window(np.array([10.0, 17.5, 25.0, 37.5, 45.0]))
    assert np.allclose(v, [0.0, 0.5, 1.0, 0.5, 0.0])
    assert slope_window(25.0) == 1.0


def test_paint_field_edge_fade():
    t = np.zeros((100, 100), np.float32)
    # raster: x0 = 0, y1 = 200 (north edge), res 2: cell (r, c) covers x in [2c, 2c+2), y in (200-2r-2, 200-2r]
    paint_field(t, [(100.0, 180.0), (100.0, 20.0)], 10.0, 1.0, 2.0, 0.0, 200.0)
    mid = t[50, 50]
    assert mid > 0.99
    assert abs(t[50, 50 + 4] - 1 / 3) < 0.2       # 8 to 9 m out: inside the 3 m fade
    assert t[50, 50 + 6] == 0.0                   # 12 m out
    assert t[50, 50 - 6] == 0.0
    assert t[2, 50] == 0.0                        # 15 m past the north end
