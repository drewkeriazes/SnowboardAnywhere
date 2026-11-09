"""FEAT-153: forest cover helpers (box filter, run burn-in)."""
import os, sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from cover import box, burn_runs, smoothstep, to_rgba, HEIGHT_MAX


def test_box_averages_blocks():
    a = np.array([[0, 1, 1, 1], [0, 1, 1, 1]], np.float32)
    assert np.allclose(box(a, 2), [[0.5, 1.0]])


def test_burn_line_width_and_glades():
    run = {"difficulty": "intermediate", "points": [[10, 50, 0], [90, 50, 0]]}
    m = burn_runs([run], 100, 100, 1.0, 0.0, 100.0)
    # an 18 m half-width corridor along y = 50 (row 50): cleared across it, untouched 30 m away
    assert m[50, 50] == 1.0 and m[50 - 15, 50] == 1.0 and m[50 - 30, 50] == 0.0
    assert burn_runs([dict(run, gladed=True)], 100, 100, 1.0, 0.0, 100.0).max() == 0.0
    narrow = burn_runs([run], 100, 100, 1.0, 0.0, 100.0, k=0.5)
    assert narrow[50 - 15, 50] == 0.0 and narrow[50 - 8, 50] == 1.0


def test_burn_area_fills_polygon():
    run = {"area": True, "difficulty": "easy", "points": [[20, 20, 0], [80, 20, 0], [80, 80, 0], [20, 80, 0], [20, 20, 0]]}
    m = burn_runs([run], 100, 100, 1.0, 0.0, 100.0)
    assert m[50, 50] == 1.0 and m[5, 5] == 0.0


def test_rgba_channels():
    one = np.ones((1, 1), np.float32)
    px = to_rgba(one * 0.5, one * HEIGHT_MAX, one * 0.0, one * 0.0)[0, 0]
    assert tuple(px) == (128, 255, 0, 255)   # A is 255 - built-up
    assert smoothstep(0.08, 0.45, np.float32(0.45)) == 1.0
