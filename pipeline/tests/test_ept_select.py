"""DATA-011: the deep EPT tier picks only nodes round the spots and under fetched parents."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ept_select as es  # noqa: E402

# a 4 km EPSG:3857 cube at the origin; cfg is in EPSG:3857 too, so local metres are the 3857 metres
B = [0.0, 0.0, 0.0, 4096.0, 4096.0, 4096.0]
CFG = {"crs": "EPSG:3857", "origin": [0.0, 0.0]}


def fake_ept():
    """every node down to depth 3 holds 10 points, one hierarchy file"""
    counts = {}
    def add(d, x, y, z):
        counts[f"{d}-{x}-{y}-{z}"] = 10
        if d < 3:
            for dx in (0, 1):
                for dy in (0, 1):
                    add(d + 1, 2 * x + dx, 2 * y + dy, 2 * z)   # one z layer keeps it small
    add(0, 0, 0, 0)
    docs = {"ept.json": {"bounds": B, "srs": {"horizontal": "3857"}}, "ept-hierarchy/0-0-0-0.json": counts}
    return lambda url: docs[url.split("/x/", 1)[1]]


SRC = {"ept": "https://h/x/", "max_depth_resort": 1, "max_depth_deep": 3, "deep_spots_m": 100}


def test_deep_nodes_only_round_the_spot():
    sel, pts = es.deep_select(CFG, SRC, [(300.0, 300.0)], fetch_json=fake_ept())
    depths = sorted(int(k.split("-")[0]) for k in sel)
    assert set(depths) == {2, 3}                  # nothing at or above max_depth_resort, nothing below deep
    # depth 2 nodes are 1024 m, depth 3 512 m: a 100 m disc at (300, 300) touches one of each
    assert sel and all(es.node_box(B, k)[0] == 0.0 and es.node_box(B, k)[1] == 0.0 for k in sel)
    assert pts == 10 * len(sel)


def test_deep_nodes_need_a_fetched_parent():
    ept = fake_ept()
    assert es.deep_select(CFG, SRC, [(300.0, 300.0)], have={"1-1-1-0"}, fetch_json=ept)[0] == []
    sel, _ = es.deep_select(CFG, SRC, [(300.0, 300.0)], have={"1-0-0-0"}, fetch_json=ept)
    assert sel
