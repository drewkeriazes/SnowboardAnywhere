"""BUG-028: off-run canopy cover round a spot."""
import os
import sys

import numpy as np
import shapely

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from canopy_spots import cleared_ground, spot_canopy  # noqa: E402

# a 400 m square mask grid at 2 m, one tile, minX = minY = 0, row 0 = north
MASK = {"res": 2.0, "tileSize": 200, "minX": 0.0, "minY": 0.0, "tilesX": 1, "tilesY": 1}


def closed_forest_with_a_run():
    """full canopy everywhere except a 40 m wide east-west run through the middle (y = 200)"""
    cover = np.ones((200, 200), np.float32)
    cover[90:110, :] = 0.0
    features = {"runs": [{"difficulty": "easy", "points": [[0, 200, 0], [400, 200, 0]]}]}
    return cover, features


def test_run_corridor_is_left_out():
    cover, features = closed_forest_with_a_run()
    cleared = cleared_ground(features)
    whole, share, off = spot_canopy(cover, MASK, cleared, 200, 200, 80)
    assert whole < 0.75                      # the run takes about a third of the disc
    assert 0.5 < share < 0.75
    assert off > 0.99                        # the forest beside it is closed


def test_glades_and_areas_are_not_cleared():
    features = {"runs": [
        {"difficulty": "expert", "gladed": True, "points": [[0, 200, 0], [400, 200, 0]]},
        {"difficulty": "easy", "area": True, "points": [[0, 0, 0], [400, 0, 0], [400, 400, 0]]},
    ]}
    assert cleared_ground(features).is_empty


def test_buildings_and_roads_are_cleared():
    features = {
        "buildings": [{"points": [[190, 190], [210, 190], [210, 210], [190, 210]]}],
        "roads": [{"kind": "service", "points": [[0, 100, 0], [400, 100, 0]]}],
    }
    cleared = cleared_ground(features)
    assert shapely.contains_xy(cleared, 200, 200)
    assert shapely.contains_xy(cleared, 213, 200)          # inside the 6 m margin
    assert not shapely.contains_xy(cleared, 220, 200)
    assert shapely.contains_xy(cleared, 50, 103)
    assert not shapely.contains_xy(cleared, 50, 106)


def test_no_cleared_ground_matches_the_whole_disc():
    cover = np.full((200, 200), 0.4, np.float32)
    whole, share, off = spot_canopy(cover, MASK, cleared_ground({}), 200, 200, 80)
    assert share == 1.0
    assert abs(whole - 0.4) < 1e-6 and abs(off - 0.4) < 1e-6


def test_targets_use_their_own_radius(monkeypatch):
    import canopy_spots

    class Fake:
        """canopy 0.6 within 90 m of a spot, 0.3 beyond"""
        def at(self, x, y, radius):
            v = 0.6 if radius <= 90 else 0.3
            return v, 1.0, v

    monkeypatch.setattr(canopy_spots, "FOREST_TARGETS", {"near": (80.0, 0.5), "far": (100.0, 0.5)})
    ok, lines = canopy_spots.check_targets(Fake(), None, {"near": (0, 0), "far": (0, 0)})
    assert not ok
    assert lines[0].startswith("PASS near") and lines[1].startswith("FAIL far")


def test_crowns_count_live_trees_off_the_run():
    from canopy_spots import spot_crowns
    _, features = closed_forest_with_a_run()
    cleared = cleared_ground(features)
    # 10 live crowns and 3 snags off the run (y = 260), 5 live crowns on it (y = 200), 2 outside the disc
    rows = [[200 + i, 260, 0, 15, 2, 0] for i in range(10)] + [[200 + i, 260, 0, 15, 2, 7] for i in range(3)]
    rows += [[200 + i, 200, 0, 15, 2, 4] for i in range(5)] + [[390, 390, 0, 15, 2, 0]] * 2
    trees = np.array(rows, np.float32)
    _, share, _ = spot_canopy(np.ones((200, 200), np.float32), MASK, cleared, 200, 200, 80)
    per_ha = spot_crowns(trees, cleared, 200, 200, 80, share)
    assert abs(per_ha - 10 / (np.pi * 80 * 80 * share / 1e4)) < 1e-3
