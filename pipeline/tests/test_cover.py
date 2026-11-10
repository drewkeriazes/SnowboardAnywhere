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


# ------------------------------------------------------------------ BUG-069: forest weighted by drawn crowns
SPECIES_TS = os.path.join(os.path.dirname(__file__), "..", "..", "game", "src", "world", "trees", "species.ts")


def test_crown_ratio_matches_client_species():
    """CROWN_RATIO is a hand copy of SPECIES[].radius in species.ts: same ids, same order, same values"""
    import re
    from cover import CROWN_RATIO
    src = open(SPECIES_TS, encoding="utf-8").read()
    table = src[src.index("export const SPECIES"):]
    table = table[:table.index("];")]
    rows = re.findall(r"\{\s*id:\s*(\d+),[^\n]*?\bradius:\s*([\d.]+)", table)
    assert [int(i) for i, _ in rows] == list(range(len(rows))), "species ids are not 0..n-1 in order"
    assert len(rows) == len(CROWN_RATIO), f"species.ts has {len(rows)} species, CROWN_RATIO {len(CROWN_RATIO)}"
    assert np.allclose([float(r) for _, r in rows], CROWN_RATIO), "CROWN_RATIO drifted from species.ts radius"


def test_crown_radii_as_client():
    """crownRadius: natural radius x height, nudged 0.85..1.25x toward the record; bad ids draw as species 0"""
    from cover import crown_radii, CROWN_RATIO
    sp = np.array([0, 0, 0, 0, 2, 99, -1], np.float32)
    h = np.full(7, 10.0, np.float32)
    cr = np.array([1.3, 5.0, 0.1, 0.0, 11.0, 1.3, 1.3], np.float32)
    out = crown_radii(sp, h, cr)
    nat0 = CROWN_RATIO[0] * 10
    assert np.allclose(out, [nat0, nat0 * 1.25, nat0 * 0.85, nat0, CROWN_RATIO[2] * 10, nat0, nat0])


def _pack(tmp_path, spacing=None, size=400.0):
    """a pack of `size` m square, all lidar canopy (mask alpha 255), no runs, and spruce 10 m tall with their
    natural 1.3 m crowns on a `spacing` m grid (or no trees/ at all)"""
    import json
    from PIL import Image
    n = int(size / 2)
    os.makedirs(tmp_path / "mask")
    m = np.zeros((n, n, 4), np.uint8); m[..., 3] = 255
    Image.fromarray(m, "RGBA").save(tmp_path / "mask" / "0_0.png")
    meta = {"bounds": {"minX": 0.0, "minY": 0.0, "maxX": size, "maxY": size},
            "mask": {"tileSize": n, "tilesX": 1, "tilesY": 1, "minX": 0.0, "minY": 0.0, "res": 2.0}}
    if spacing:
        g = np.arange(spacing / 2, size, spacing)
        X, Y = np.meshgrid(g, g)
        t = np.zeros((X.size, 6), np.float32)
        t[:, 0], t[:, 1], t[:, 3], t[:, 4] = X.ravel(), Y.ravel(), 10.0, 1.3
        os.makedirs(tmp_path / "trees")
        t.tofile(tmp_path / "trees" / "0_0.bin")
        meta["instances"] = {"treeCells": ["0_0"]}
    return str(tmp_path), meta


def _pack_forest(pack_dir, meta):
    """build the pack level; R of cover/pack.png (0..1) and the level entry"""
    from PIL import Image
    from cover import pack_level
    lv = pack_level(pack_dir, meta, [], log=lambda *_: None)
    r = np.asarray(Image.open(os.path.join(pack_dir, lv["file"])))[..., 0] / 255.0
    return r, lv


def test_pack_without_trees_keeps_canopy(tmp_path):
    from cover import crown_area
    pack_dir, meta = _pack(tmp_path)
    assert not crown_area(pack_dir, meta, 100, 100).any()
    r, lv = _pack_forest(pack_dir, meta)
    assert r.min() == 1.0 and "stands" not in lv


def test_sparse_stand_fades_from_far(tmp_path):
    """a tree every 10 m (5.3 m2 of crown per 100 m2, about 0.05 share) keeps under 0.3 of the forest"""
    from cover import crown_area
    pack_dir, meta = _pack(tmp_path, spacing=10.0)
    share = crown_area(pack_dir, meta, 100, 100)[20:80, 20:80].mean()
    assert 0.04 < share < 0.07
    r, _ = _pack_forest(pack_dir, meta)
    assert r[20:80, 20:80].max() < 0.3


def test_dense_timber_keeps_full_forest(tmp_path):
    """a tree every 4 m (about 0.33 share, over CROWN_FULL) keeps the forest whole, and the closed stand too"""
    from PIL import Image
    pack_dir, meta = _pack(tmp_path, spacing=4.0)
    r, lv = _pack_forest(pack_dir, meta)
    assert r[20:80, 20:80].min() == 1.0
    stands = np.asarray(Image.open(os.path.join(pack_dir, lv["stands"]))) / 255.0
    assert stands[20:80, 20:80].min() > 0.95
