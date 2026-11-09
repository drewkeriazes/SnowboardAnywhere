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


def test_osm_pistes_ways_areas_relations(tmp_path):
    """DATA-019: ways are lines unless closed with area=yes; relation outers are areas; geometry to local"""
    import json
    from cover import osm_pistes
    sq = [{"lon": 0, "lat": 0}, {"lon": 1, "lat": 0}, {"lon": 1, "lat": 1}, {"lon": 0, "lat": 1}, {"lon": 0, "lat": 0}]
    els = [
        {"type": "way", "tags": {"piste:type": "downhill", "piste:difficulty": "easy"}, "geometry": sq[:3]},
        {"type": "way", "tags": {"piste:type": "downhill", "area": "yes"}, "geometry": sq},
        {"type": "way", "tags": {"piste:type": "downhill", "piste:gladed": "yes"}, "geometry": sq[:2]},
        {"type": "relation", "tags": {"piste:type": "downhill"}, "members": [
            {"type": "way", "role": "outer", "geometry": sq}, {"type": "way", "role": "inner", "geometry": sq}]},
    ]
    p = tmp_path / "pistes.json"
    p.write_text(json.dumps({"elements": els}))
    runs = osm_pistes(str(p), lambda lon, lat: (lon * 10.0, lat * 10.0))
    assert [r["area"] for r in runs] == [False, True, False, True]
    assert runs[0]["difficulty"] == "easy" and runs[0]["points"][1][:2] == [10.0, 0.0]
    assert runs[2]["gladed"] and not runs[0]["gladed"]
