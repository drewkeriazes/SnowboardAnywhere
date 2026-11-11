"""BUG-081: the far tree ring (far_trees.py) and the cover's forest from it (cover.crown_grid)."""
import os, sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import far_trees as ft          # noqa: E402
import cover                    # noqa: E402
from ept_select import far_box  # noqa: E402

INST = {"cellSize": 1000.0, "minX": -5800.0, "minY": -5850.0, "cellsX": 12, "cellsY": 12}
BOUNDS = {"minX": -5800, "minY": -5850, "maxX": 5800, "maxY": 5850}


def test_far_box_grows_the_utm_box():
    cfg = {"utm_bbox": [100, 200, 300, 400], "lidar": {"far": {"pad_m": 50}}}
    assert far_box(cfg) == [50, 150, 350, 450]


def test_ring_grid_covers_the_box_in_whole_cells():
    # the pack grid runs to 6200 / 6150, so a box out to 10800 needs 5 cells past it on the far side (4.6 km)
    ring, gx0, gy0, gcx, gcy = ft.ring_grid(INST, BOUNDS, (-10800, -10850, 10800, 10850))
    assert ring == 5
    assert (gx0, gy0, gcx, gcy) == (-10800, -10850, 22, 22)
    assert ft.ring_grid(INST, BOUNDS, (-5800, -5850, 5800, 5850))[0] == 0


def test_write_far_cells_keys_on_the_pack_grid(tmp_path):
    recs = np.array([[-6000.5, 0, 2500, 20, 2, 0],      # cell -1, 5 (west of the grid)
                     [6500, 6500, 2600, 15, 1.5, 3],    # cell 12, 12 (north-east, past the grid)
                     [5900, 0, 2550, 10, 1, 4],         # cell 11, 5 (the grid's edge cell, outside the bounds)
                     [-6001, 10, 2500, 22, 2, 0],       # cell -1, 5 again
                     [99999, 0, 0, 1, 1, 0]], np.float32)  # past the ring: dropped
    names = ft.write_far_cells(str(tmp_path), recs, INST, 5)
    assert names == ["-1_5", "11_5", "12_12"]
    got = np.fromfile(tmp_path / "farTrees" / "-1_5.bin", "<f4").reshape(-1, 6)
    assert got.shape == (2, 6) and np.allclose(got[:, 3], [20, 22])
    # a rerun replaces the set instead of adding to it
    assert ft.write_far_cells(str(tmp_path), recs[:1], INST, 5) == ["-1_5"]
    assert sorted(os.listdir(tmp_path / "farTrees")) == ["-1_5.bin"]


def test_fill_ground_follows_the_lidar_and_falls_back_to_the_drawn_ground():
    base = np.full((40, 40), 2500.0, np.float32)
    lidar = np.full((40, 40), np.nan, np.float32)
    lidar[:, :20] = 2501.0                          # the lidar saw the ground a metre above the drawn one, west half
    g = ft.fill_ground(lidar, base)
    assert np.allclose(g[:, :20], 2501.0)
    assert abs(g[20, 21] - 2501.0) < 0.2            # the offset spreads into the gap next to it
    assert abs(g[20, 39] - 2500.0) < 0.05           # and fades to the drawn ground far from any return


def test_detect_finds_crowns_and_skips_cliffs():
    chm = np.zeros((30, 30), np.float32)
    chm[10, 10] = 18.0; chm[9:12, 9:12] = np.maximum(chm[9:12, 9:12], 12.0)
    chm[19:22, 19:22] = 7.0; chm[20, 20] = 9.0
    chm[5, 25] = 15.0                                # on a cliff
    has = np.ones_like(chm, bool)
    slope = np.zeros_like(chm); slope[3:8, 23:28] = 60.0
    r, c, h = ft.detect(chm, has, slope)
    got = sorted(zip(r.tolist(), c.tolist(), h.tolist()))
    assert [(a, b) for a, b, _ in got] == [(10, 10), (20, 20)]
    assert got[0][2] == 18.0                         # the tallest return round the peak (BUG-023)


def test_crown_grid_shares_and_heights():
    # one spruce (species 0, crown 0.13 h) of 20 m in a 16 m cell: pi (2.6)^2 / 256
    recs = [np.array([[8.0, 8.0, 2500, 20, 2.6, 0]], np.float32)]
    share, hs, n = cover.crown_grid(recs, 16.0, 0.0, 16.0, 2, 1)
    assert np.isclose(share[0, 0], np.pi * 2.6 ** 2 / 256, rtol=1e-3) and share[0, 1] == 0
    assert hs[0, 0] == 20 and n[0, 0] == 1
