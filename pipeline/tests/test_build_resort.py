"""FEAT-175 step 3: build_resort.py runs each stage once, skips it while its inputs are unchanged, trusts what is
already on disk the first time, and stops with a message on a failed check. The scripts are replaced by a fake
runner that writes their outputs into a temp folder."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import build_resort as B  # noqa: E402
from packwriter import FORMAT_VERSION  # noqa: E402

CFG = {"slug": "demo", "name": "Demo", "country": "US", "crs": "EPSG:26913", "utm_bbox": [0, 0, 1000, 1000],
       "lonlat_bbox": [-106.1, 39.4, -106.0, 39.5], "terrain_status_url": "https://www.demo.example/x.aspx",
       "lidar": {"ept": "https://x/", "dataset": "D", "nodes_file": "demo_ept_nodes.txt",
                 "far": {"pad_m": 5000, "max_depth": 9, "nodes_file": "demo_ept_far_nodes.txt"}}}


class Fake:
    """stands in for the scripts: records each command and writes what the script would"""

    def __init__(self, r, fail=None, fetch_code=0, osm=None):
        self.r, self.fail, self.fetch_code, self.osm = r, fail, fetch_code, osm
        self.calls = []

    def __call__(self, cmd, cwd=None):
        script = os.path.basename(cmd[1] if cmd[0] != "powershell" else cmd[cmd.index("-File") + 1])
        self.calls.append(script if "fetch_landfire" not in script else f"{script} {cmd[4]}")
        if self.fail and self.fail in script:
            return 1
        r = self.r
        if script == "ept_select.py":
            for p in r.node_files():
                open(p, "w").write("0-0-0-0 1-0-0-0")
        elif script == "gen_manifest.py":
            box = json.load(open(r.cfg_path))["utm_bbox"]      # the real manifest follows the box
            json.dump({"slug": "demo", "manifestVersion": 1, "items": [{"url": f"u{box}", "path": "dem1m/a.tif"}]},
                      open(r.man_path, "w"))
        elif script == "fetch.ps1":
            if self.fetch_code:
                return self.fetch_code
            for d in ("dem1m", "dem10m", "naip1m", "mapterhorn", "ept", "ept_far", "landcover/worldcover",
                      "landcover/eth_canopy"):
                os.makedirs(os.path.join(r.raw, d), exist_ok=True)
                open(os.path.join(r.raw, d, "ept.json" if d == "ept" else "a"), "w").write("x")
            os.makedirs(os.path.join(r.raw, "osm"), exist_ok=True)
            for q in B.OSM_NEED + ("pistes_wide",):
                json.dump(self.osm if self.osm is not None else {"elements": [{"id": 1}]},
                          open(os.path.join(r.raw, "osm", f"{q}.json"), "w"))
            open(os.path.join(r.raw, "FETCH_COMPLETE.txt"), "w").write("complete")
        elif script == "fetch_landfire.mjs":
            d = dict(B.LANDFIRE)[cmd[4]]
            os.makedirs(os.path.join(r.raw, d), exist_ok=True)
            open(os.path.join(r.raw, d, "c.tif"), "w").write("x")
        elif script == "fetch_grooming.py":
            os.makedirs(os.path.join(r.raw, "grooming"), exist_ok=True)
            open(os.path.join(r.raw, "grooming", "20240101.json"), "w").write("{}")
        elif script == "build_pack.py":
            os.makedirs(r.out, exist_ok=True)
            json.dump({"slug": "demo", "name": "Demo", "formatVersion": FORMAT_VERSION, "pipeline": "abc1234",
                       "build": "b1"}, open(os.path.join(r.out, "meta.json"), "w"))
        return 0


@pytest.fixture
def resort(tmp_path, monkeypatch):
    res, man = tmp_path / "resorts", tmp_path / "manifests"
    res.mkdir(); man.mkdir()
    json.dump(CFG, open(res / "demo.json", "w"))
    monkeypatch.setattr(B, "pipeline_code", lambda repo=B.REPO: "code1")
    monkeypatch.setattr(B, "same_code", lambda commit, repo=B.REPO: commit == "abc1234")
    r = B.Resort("demo", str(tmp_path / "raw" / "demo"), str(tmp_path / "packs" / "demo"), str(res), str(man))
    return r


def go(r, fake, **kw):
    lines = []
    B.build(r, B.Context(runner=fake, email="me@example.com", **{k: v for k, v in kw.items() if k in ("force", "gate")}),
            kw.get("first"), kw.get("last"), kw.get("dry", False), out=lines.append)
    return lines


def test_first_run_runs_every_stage_then_nothing_but_index_and_report(resort):
    f = Fake(resort)
    go(resort, f)
    assert f.calls == ["ept_select.py", "gen_manifest.py", "fetch.ps1", "fetch_landfire.mjs EVT",
                       "fetch_landfire.mjs EVC", "fetch_landfire.mjs EVH", "fetch_grooming.py", "build_pack.py",
                       "pack_report.py"]
    assert json.load(open(os.path.join(resort.out, "..", "index.json")))["packs"] == ["demo"]
    f2 = Fake(resort)
    lines = go(B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests), f2)
    assert f2.calls == ["pack_report.py"]
    assert "[fetch] skip: inputs unchanged" in lines and "[build] skip: inputs unchanged" in lines


def test_a_build_by_uncommitted_code_is_skipped_once_recorded(resort, monkeypatch):
    # build_pack.py stamps "<sha>+dirty" while pipeline/ has changes; the recorded fingerprint still matches
    monkeypatch.setattr(B, "same_code", lambda commit, repo=B.REPO: False)
    go(resort, Fake(resort))
    f = Fake(resort)
    go(B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests), f)
    assert f.calls == ["pack_report.py"]


def test_a_config_change_runs_the_stages_after_it(resort):
    go(resort, Fake(resort))
    cfg = dict(CFG, utm_bbox=[0, 0, 2000, 1000], lonlat_bbox=[-106.1, 39.4, -105.98, 39.5])
    json.dump(cfg, open(resort.cfg_path, "w"))
    r = B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests)
    f = Fake(r)
    go(r, f)
    # new box: new node lists, manifest, fetch (resumes), LANDFIRE clip again (forced: the box moved), build
    assert f.calls[:3] == ["ept_select.py", "gen_manifest.py", "fetch.ps1"]
    assert "fetch_landfire.mjs EVT" in f.calls and "build_pack.py" in f.calls
    assert "fetch_grooming.py" not in f.calls       # same feed URL


def test_existing_outputs_are_adopted_on_the_first_run(resort):
    # a resort fetched and built before build_resort.py: node lists, manifest, raw data, clips, reports, pack
    go(resort, Fake(resort))
    os.remove(resort.state_path)
    r = B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests)
    f = Fake(r)
    lines = go(r, f)
    assert f.calls == ["pack_report.py"]
    assert "[nodes] skip: already on disk (adopted)" in lines and "[build] skip: already on disk (adopted)" in lines
    # a pack from other pipeline code is built again
    os.remove(resort.state_path)
    m = json.load(open(os.path.join(resort.out, "meta.json")))
    json.dump(dict(m, pipeline="old9999"), open(os.path.join(resort.out, "meta.json"), "w"))
    r = B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests)
    f = Fake(r)
    go(r, f)
    assert f.calls == ["build_pack.py", "pack_report.py"]


def test_a_new_manifest_fetches_again(resort):
    go(resort, Fake(resort))
    json.dump({"slug": "demo", "manifestVersion": 1, "items": [{"url": "u2", "path": "landcover/x.tif"}]},
              open(resort.man_path, "w"))                 # a layer added to the download list
    r = B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests)
    f = Fake(r)
    lines = go(r, f)
    assert "[manifest] run: inputs changed" not in lines        # the manifest's own inputs did not change
    assert f.calls == ["fetch.ps1", "build_pack.py", "pack_report.py"]


def test_failed_downloads_stop_with_a_message(resort):
    with pytest.raises(B.Failed, match="some downloads failed"):
        go(resort, Fake(resort, fetch_code=2))
    assert "fetch" not in resort.state                          # not recorded: the next run fetches again
    assert resort.state["manifest"]


def test_an_overpass_error_page_is_caught_after_the_fetch(resort):
    with pytest.raises(B.Failed, match=r"OSM ski \(no elements: runtime error"):
        go(resort, Fake(resort, osm={"remark": "runtime error: Query timed out", "elements": []}))


def test_raw_data_fetched_earlier_is_checked_too(resort):
    go(resort, Fake(resort))
    os.remove(os.path.join(resort.raw, "osm", "ski.json"))
    r = B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests)
    with pytest.raises(B.Failed, match=r"OSM ski \(missing or not JSON\)"):
        go(r, Fake(r))


def test_land_cover_and_the_far_ring_are_required(resort):
    go(resort, Fake(resort))
    import shutil
    shutil.rmtree(os.path.join(resort.raw, "landcover", "eth_canopy"))
    os.remove(os.path.join(resort.raw, "osm", "pistes_wide.json"))
    shutil.rmtree(os.path.join(resort.raw, "ept_far"))
    r = B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests)
    with pytest.raises(B.Failed) as e:
        go(r, Fake(r))
    assert "ETH canopy height" in str(e.value) and "far ring lidar" in str(e.value) and "OSM pistes_wide" in str(e.value)
    assert "--force fetch" in str(e.value)
    # a config with land cover off and no far ring needs neither
    json.dump(dict(CFG, landcover={"enabled": False}, lidar={k: v for k, v in CFG["lidar"].items() if k != "far"}),
              open(resort.cfg_path, "w"))
    r = B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests)
    B.check_raw(r)


def test_an_old_manifest_is_made_again_but_the_same_items_fetch_nothing(resort):
    go(resort, Fake(resort))
    m = json.load(open(resort.man_path))
    del m["manifestVersion"]                            # a manifest from before FEAT-223
    json.dump(m, open(resort.man_path, "w"))
    os.remove(resort.state_path)                        # and never seen by build_resort.py
    r = B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests)
    f = Fake(r)
    lines = go(r, f)
    assert "[manifest] run: not done yet" in lines
    assert f.calls == ["gen_manifest.py", "pack_report.py"]    # same items: the fetch and the build are adopted


def test_landfire_without_an_email_stops(resort):
    f = Fake(resort)
    with pytest.raises(B.Failed, match="LANDFIRE needs an email"):
        B.build(resort, B.Context(runner=f), out=lambda *a: None)
    assert f.calls[-1] == "fetch.ps1"


def test_outside_the_us_and_without_a_feed_those_stages_skip(resort):
    json.dump(dict(CFG, country="CA", terrain_status_url=None), open(resort.cfg_path, "w"))
    r = B.Resort("demo", resort.raw, resort.out, resort.resorts, resort.manifests)
    f = Fake(r)
    lines = go(r, f)
    assert not any("landfire" in c or "grooming" in c for c in f.calls)
    assert "[landfire] skip: outside the US" in lines and "[grooming] skip: no terrain_status_url" in lines


def test_from_stop_after_force_and_dry_run(resort):
    f = Fake(resort)
    go(resort, f, last="manifest")
    assert f.calls == ["ept_select.py", "gen_manifest.py"]
    f = Fake(resort)
    lines = go(resort, f, dry=True)
    assert f.calls == [] and "[fetch] run: not done yet" in lines
    go(resort, Fake(resort))
    f = Fake(resort)
    go(resort, f, first="build", force=["build"])
    assert f.calls == ["build_pack.py", "pack_report.py"]
    f = Fake(resort)
    go(resort, f, force=["all"])
    assert len(f.calls) == 9


def test_a_failed_build_and_the_gate(resort):
    with pytest.raises(B.Failed, match="build_pack.py failed"):
        go(resort, Fake(resort, fail="build_pack"))
    with pytest.raises(B.Failed, match="MVP lines"):
        go(resort, Fake(resort, fail="pack_report"), gate=True)


def test_the_raw_folder_must_be_named_for_the_slug(resort, tmp_path):
    r = B.Resort("demo", str(tmp_path / "raw" / "other"), resort.out, resort.resorts, resort.manifests)
    with pytest.raises(B.Failed, match="not named demo"):
        go(r, Fake(r))


def test_raw_lives_in_the_main_checkout(monkeypatch, tmp_path):
    monkeypatch.delenv("SBA_RAW_ROOT", raising=False)
    root = B.default_raw_root()
    assert os.path.basename(root) == "raw" and os.path.isdir(os.path.join(os.path.dirname(root), ".git"))
    monkeypatch.setenv("SBA_RAW_ROOT", str(tmp_path))
    assert B.default_raw_root() == str(tmp_path)


def test_no_console_for_the_landfire_prompt_stops_cleanly(resort, monkeypatch):
    def eof(prompt=""):
        raise EOFError
    monkeypatch.setattr("builtins.input", eof)
    monkeypatch.delenv("LANDFIRE_EMAIL", raising=False)
    with pytest.raises(B.Failed, match="LANDFIRE needs an email"):
        B.build(resort, B.Context(runner=Fake(resort), interactive=True), out=lambda *a: None)


def test_pipeline_code_ignores_tests_and_configs():
    code = B.pipeline_code()
    if code is None:
        pytest.skip("not a git checkout")
    assert len(code.split("+")[0]) == 16
