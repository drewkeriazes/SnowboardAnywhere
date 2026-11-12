"""FEAT-175 step 1: pack_report.py on a tiny hand-built pack, its measures, and publish_pack's status gate."""
import json
import math
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from packwriter import FORMAT_VERSION, write_features, write_height_set, write_instances, write_mask_set, write_meta  # noqa: E402
import pack_report as pr  # noqa: E402
from publish_pack import report_status  # noqa: E402

HALF = 300.0          # the pack is 600 x 600 m round the origin
START = (100.0, 200.0)


def ground(x, y):
    return 2500.0 + 0.3 * y          # falls 0.3 m per m to the south (17 deg)


def make_pack(root, trees_at_start=False, cover=False):
    d = root / "demo"
    d.mkdir(parents=True)
    ys = HALF - np.arange(int(2 * HALF))
    xs = -HALF + np.arange(int(2 * HALF))
    fine = np.broadcast_to(ground(xs[None, :], ys[:, None]), (len(ys), len(xs))).astype(np.float32)
    meta = {"version": 1, "formatVersion": FORMAT_VERSION, "slug": "demo", "name": "Demo Mountain", "crs": "EPSG:26913",
            "origin": [400000, 4400000], "bounds": {"minX": -HALF, "minY": -HALF, "maxX": HALF, "maxY": HALF},
            "terrain": {"fine": write_height_set(str(d), "fine", fine, 1.0, -HALF, -HALF),
                        "mid": write_height_set(str(d), "mid", np.full((64, 64), 2500, np.float32), 16.0, -512, -512),
                        "far": write_height_set(str(d), "far", np.full((32, 32), 2500, np.float32), 128.0, -2048, -2048)}}
    n = int(HALF)                     # 2 m mask cells across the pack
    rgba = np.zeros((n, n, 4), np.uint8)
    rgba[:, : n // 2, 3] = 200        # canopy over the west half
    rgba[:30, -30:, 0] = 255          # a rock patch in the north-east corner: 900 of 90,000 cells
    col = int((START[0] + HALF) / 2)
    rgba[:, col - 5:col + 5, 2] = 255  # the groomed run
    meta["mask"] = write_mask_set(str(d), rgba, 2.0, -HALF, -HALF)
    for k in ("ao", "dir", "moguls"):
        meta[k] = write_mask_set(str(d), np.full((n, n), 128, np.uint8), 2.0, -HALF, -HALF, kind=k)
    rng = np.random.default_rng(1)
    tx, ty = rng.uniform(-HALF + 5, -5, 400), rng.uniform(-HALF + 5, HALF - 5, 400)
    trees = np.stack([tx, ty, ground(tx, ty), np.full(400, 12.0), np.full(400, 1.5), np.zeros(400)], 1).astype(np.float32)
    if trees_at_start:
        trees = np.vstack([trees, [[START[0] + 1, START[1], ground(*START), 10, 1.5, 0]]]).astype(np.float32)
    rocks = np.array([[250, 280, ground(250, 280), 2, 0, 0]], np.float32)
    inst = {"cellSize": 1000.0, "minX": -HALF, "minY": -HALF, "cellsX": 1, "cellsY": 1, "treeCells": ["0_0"], "rockCells": ["0_0"],
            "treeCount": write_instances(str(d), "trees", trees, 1000.0, -HALF, -HALF, 1, 1),
            "rockCount": write_instances(str(d), "rocks", rocks, 1000.0, -HALF, -HALF, 1, 1)}
    meta.update({"instances": inst, "treeSpecies": 2, "start": {"x": START[0], "y": START[1], "heading": math.pi, "run": "Main"},
                 "attribution": ["Elevation: USGS 3DEP", "Canopy: 3DEP lidar", "Imagery: NAIP", "Background terrain: Mapterhorn",
                                 "OpenStreetMap contributors (ODbL)"]})
    if cover:
        (d / "cover").mkdir()
        meta["cover"] = {"levels": [{"name": nm, "file": f"cover/{nm}.png"} for nm in ("pack", "mid", "far")]}
        for nm in ("pack", "mid", "far"):
            (d / "cover" / f"{nm}.png").write_bytes(b"png")
    run = [[START[0], y, ground(START[0], y)] for y in np.linspace(HALF - 10, -HALF + 10, 30)]
    lift = [[150.0, -HALF + 10, ground(150, -HALF + 10)], [150.0, HALF - 10, ground(150, HALF - 10)]]
    write_features(str(d), {"runs": [{"name": "Main", "difficulty": "easy", "groomed": True, "gladed": False, "area": False,
                                      "points": run, "mogulScore": 0.0}],
                            "lifts": [{"name": "Chair 1", "type": "chair_lift", "stations": lift, "towers": [[150, 0, 2500, 10]]}],
                            "buildings": [], "roads": [], "water": [], "peaks": [], "labels": []})
    write_meta(str(d), meta)
    return d


def line(rep, id_):
    return next(ln for ln in rep.lines if ln["id"] == id_)


def test_tiny_pack(tmp_path):
    pack = make_pack(tmp_path / "packs")
    rep = pr.build_report(str(pack), repo=str(tmp_path))
    assert line(rep, "F")["status"] == pr.PASS
    assert line(rep, "1")["status"] == pr.FAIL                     # no resort config
    assert line(rep, "2")["status"] == pr.PASS                     # from the pack, no --raw
    assert line(rep, "4")["status"] == pr.SKIP                     # no LANDFIRE credit, no raw: cannot tell
    assert line(rep, "5")["status"] == pr.PASS
    assert line(rep, "7")["status"] == pr.FAIL                     # no stands/
    assert line(rep, "8")["status"] == pr.FAIL and line(rep, "8b")["status"] == pr.FAIL
    assert line(rep, "10")["status"] == pr.PASS, line(rep, "10")["detail"]
    assert line(rep, "12")["status"] == pr.PASS                    # 580 m long, 174 m drop
    assert line(rep, "13")["status"] == pr.PASS
    assert rep.numbers["rockShare"] == pytest.approx(0.01, abs=1e-4)
    assert rep.numbers["canopyShare"] == pytest.approx(0.5 * 200 / 255, abs=1e-3)
    assert rep.numbers["runCanopy"] == 0.0
    assert rep.numbers["voidShare"] == 0.0
    assert rep.numbers["zMin"] == pytest.approx(2410, abs=3) and rep.numbers["zMax"] == pytest.approx(2590, abs=3)
    assert rep.numbers["treesPerKm2"] == round(400 / 0.36)
    playable, failing = pr.gate(rep.lines)
    assert not playable and {"1", "4", "7", "8", "8b"} <= set(failing)
    assert "15" not in failing                                     # polish lines never gate


def test_start_in_trees_and_cover(tmp_path):
    pack = make_pack(tmp_path / "packs", trees_at_start=True, cover=True)
    rep = pr.build_report(str(pack), repo=str(tmp_path))
    assert line(rep, "10")["status"] == pr.FAIL and "crowns within" in line(rep, "10")["detail"]
    assert line(rep, "8")["status"] == pr.PASS
    assert line(rep, "13")["status"] == pr.FAIL                    # mid / far cover without the WorldCover credit


def test_main_writes_json_and_markdown(tmp_path):
    pack = make_pack(tmp_path / "packs")
    with pytest.raises(SystemExit):
        pr.main([str(pack), "--gate"])
    j = json.load(open(pack / "report.json", encoding="utf-8"))
    assert j["slug"] == "demo" and j["playable"] is False and j["build"]
    md = open(pack / "report.md", encoding="utf-8").read()
    assert md.startswith("# Pack report: Demo Mountain") and "| 8b |" in md


def test_steepest_pitch():
    flat_then_steep = [[0, 0, 100], [0, 100, 100], [0, 130, 100 - 30 * math.tan(math.radians(35))], [0, 200, 70]]
    assert pr.steepest_pitch(flat_then_steep) == pytest.approx(35, abs=1.5)
    assert pr.steepest_pitch([[0, 0, 10], [0, 10, 10]]) == 0.0


def test_density_by_band():
    z = np.array([2005.0] * 4 + [2105.0] * 4)          # 8 cells of 0.25 km2: two 1 km2 bands
    rows = pr.density_by_band(z, 0.25, np.array([2010.0, 2150.0]), np.array([2050.0]), np.array([0.5]))
    assert [(r["z"], r["areaKm2"], r["crowns"], r["perKm2"]) for r in rows] == [(2000.0, 1.0, 1, 2), (2100.0, 1.0, 1, 1)]


def test_trees_per_ha():
    trees = np.array([[0, 0, 0, 10, 1, 0], [50, 0, 0, 10, 1, 0], [150, 0, 0, 10, 1, 0]], np.float32)
    stands = np.array([[10, 10, 0, 0.5], [500, 0, 0, 1.0]], np.float32)
    assert pr.trees_per_ha(trees, stands, 0, 0) == pytest.approx(2.5 / math.pi)


def test_publish_status_follows_the_report(tmp_path):
    meta = {"build": "b1"}
    assert report_status(str(tmp_path), meta, None)[0] == "preview"
    with pytest.raises(SystemExit):
        report_status(str(tmp_path), meta, "playable")
    (tmp_path / "report.json").write_text(json.dumps({"build": "b1", "playable": True, "failing": []}))
    assert report_status(str(tmp_path), meta, None)[0] == "playable"
    (tmp_path / "report.json").write_text(json.dumps({"build": "b0", "playable": True, "failing": []}))
    assert report_status(str(tmp_path), meta, None)[0] == "preview"      # made for another build
    (tmp_path / "report.json").write_text(json.dumps({"build": "b1", "playable": False, "failing": ["8b"]}))
    with pytest.raises(SystemExit, match="8b"):
        report_status(str(tmp_path), meta, "playable")


# ------------------------------------------------------------------ FEAT-232: courses scale with the resort
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def test_course_thresholds_scale_with_the_hill():
    assert pr.course_thresholds(900.0) == (300.0, 60.0)       # a mountain keeps 300 m and 60 m
    assert pr.course_thresholds(120.0) == (300.0, 60.0)
    assert pr.course_thresholds(60.0) == (150.0, 30.0)        # Boston Mills
    assert pr.course_thresholds(10.0) == (100.0, 20.0)        # never under 20 m of drop
    assert pr.course_thresholds(0.0) == (100.0, 20.0)


def test_course_rule_matches_the_game():
    import re
    ts = open(os.path.join(REPO, "game", "src", "sim", "Courses.ts"), encoding="utf-8").read()
    val = lambda k: float(re.search(rf"const {k} = (\d+(?:\.\d+)?)", ts).group(1))
    assert (val("MIN_LENGTH"), val("MIN_DROP"), val("MIN_DROP_FLOOR")) == \
        (pr.COURSE_MIN_LENGTH, pr.COURSE_MIN_DROP, pr.COURSE_MIN_DROP_FLOOR)
    assert "Math.max(MIN_DROP_FLOOR, maxDrop / 2)" in ts and "drop * LENGTH_PER_DROP" in ts


def run(name, length, drop):
    return {"name": name, "points": [[0.0, 0.0, drop], [length, 0.0, 0.0]]}


def test_course_candidates_on_a_small_hill_and_a_mountain():
    hill = [run("Buttermilk", 358, 60.0), run("Outer Limits", 401, 52.3), run("Croyle", 222, 56.8),
            run("Downdraft", 199, 33.9), run("Summit", 133, 20.2), run("Frosty", 113, 10.4)]
    names, th = pr.course_candidates(hill)
    assert th == (150.0, 30.0) and names == ["Buttermilk", "Croyle", "Downdraft", "Outer Limits"]
    mountain = hill + [run("Riva Ridge", 5800, 900.0)]
    names, th = pr.course_candidates(mountain)
    assert th == (300.0, 60.0) and names == ["Buttermilk", "Riva Ridge"]     # Buttermilk: 358 m, 60 m: still one


@pytest.mark.parametrize("slug,expect", [("vail", (300.0, 60.0)), ("breckenridge", (300.0, 60.0)),
                                         ("bigsky", (300.0, 60.0)), ("boston-mills", (150.0, 30.0))])
def test_real_packs_keep_or_gain_courses(slug, expect):
    for root in (os.path.join(REPO, "packs"), os.path.join(os.path.dirname(REPO), "SnowboardAnywhere", "packs"),
                 os.path.join(os.path.dirname(REPO), "wt-mp4", "packs")):
        f = os.path.join(root, slug, "features.json")
        if os.path.isfile(f):
            break
    else:
        pytest.skip(f"no {slug} pack on this machine")
    runs = json.load(open(f, encoding="utf-8"))["runs"]
    names, th = pr.course_candidates(runs)
    assert th == pytest.approx(expect, abs=0.5) and names
