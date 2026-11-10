"""DATA-002: piste direction byte format and nearest-run direction field."""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from piste_dir import decode_angle, encode_angle, piste_direction  # noqa: E402

RES = 2.0
H = W = 100           # 200 m square, row 0 = north
MIN_X = 0.0
MAX_Y = H * RES


def groomed_run(points):
    return {"groomed": True, "area": False, "points": points}


def direction(runs, groomed=None, **kw):
    if groomed is None:
        groomed = np.zeros((H, W), np.float32)
    return piste_direction(runs, groomed, RES, MIN_X, MAX_Y, **kw)


def test_east_west_run_is_byte_1():
    d = direction([groomed_run([[20.0, 100.0], [180.0, 100.0]])])
    assert d[H // 2, W // 2] == 1


def test_north_south_run_is_byte_128():
    d = direction([groomed_run([[100.0, 20.0], [100.0, 180.0]])])
    assert d[H // 2, W // 2] == 128


def test_near_180_degrees_does_not_wrap_to_zero():
    b = encode_angle(np.array([math.radians(179.9)]))
    assert b[0] == 255
    assert encode_angle(np.array([math.pi]))[0] == 1  # exactly 180 is the same axis as 0


def test_encode_decode_round_trip_within_half_a_byte():
    theta = np.linspace(0.0, math.pi, 500, endpoint=False)
    back = decode_angle(encode_angle(theta))
    half_byte = math.radians(0.5 * 180.0 / 254.0)
    assert np.all(np.abs(back - theta) <= half_byte + 1e-6)


def test_far_ungroomed_cells_are_zero():
    d = direction([groomed_run([[20.0, 100.0], [60.0, 100.0]])], reach=30.0)
    assert d[H // 2, 5] != 0     # x = 10 m, on the run's footprint
    assert d[H // 2, 90] == 0    # x = 180 m, well beyond reach


def test_groomed_cell_keeps_direction_beyond_reach():
    groomed = np.zeros((H, W), np.float32)
    groomed[:, 90] = 1.0
    d = direction([groomed_run([[20.0, 100.0], [60.0, 100.0]])], groomed, reach=30.0)
    assert d[10, 90] != 0


def test_no_groomed_runs_gives_all_zeros():
    runs = [{"groomed": False, "area": False, "points": [[20.0, 100.0], [180.0, 100.0]]}]
    d = direction(runs)
    assert d.shape == (H, W) and d.dtype == np.uint8 and not d.any()
    assert not direction([]).any()
