"""FEAT-224: resort.py add runs resolve, plan, the build_resort.py stages, the headless ride and publish in order,
skips what is done, prints the DATA-022 gate and stops on the first failure. Everything that talks to a host, the
GPU or GitHub is replaced."""
import argparse
import json
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import resort as R  # noqa: E402

PLANNED = {"slug": "demo", "name": "Demo", "country": "US", "crs": "EPSG:26917", "tier": "gold",
           "openskidata": {"ids": ["a"]}}
REPORT = {"build": "b1", "playable": False, "failing": ["8b"], "lines": [
    {"id": "7", "item": "Trees", "status": "pass", "detail": "ok", "mvp": True},
    {"id": "8b", "item": "Far tree ring", "status": "fail", "detail": "none: set lidar.far", "mvp": True},
    {"id": "17", "item": "Main menu shot", "status": "fail", "detail": "missing", "mvp": False}]}


class World:
    """the fakes: resolve writes a stub, plan writes the planned config, build_resort's build writes a pack"""

    def __init__(self, tmp, monkeypatch, hand=False):
        self.tmp, self.calls = tmp, []
        self.resorts = tmp / "resorts"
        self.resorts.mkdir()
        self.out = tmp / "packs" / "demo"
        if hand:
            json.dump({"slug": "demo", "name": "Demo", "crs": "EPSG:26913"}, open(self.resorts / "demo.json", "w"))
        world = self

        def resolve_and_write(a, hosts, keep_planned=False):
            world.calls.append(("resolve", keep_planned))
            p = world.resorts / "demo.json"
            if p.exists() and (json.load(open(p)).get("openskidata") is None) and not a.force:
                return 4, None
            if not (keep_planned and p.exists() and "crs" in json.load(open(p))):
                json.dump({"slug": "demo", "name": "Demo", "openskidata": {"ids": ["a"]}}, open(p, "w"))
            return 0, "demo"

        def cmd_plan(a, hosts):
            world.calls.append(("plan", a.slug))
            json.dump(PLANNED, open(world.resorts / "demo.json", "w"))
            (world.resorts / "demo-plan.md").write_text("# plan")
            return 0

        def ride(slug, raw, out, runner=None, log=print):
            world.calls.append(("ride", slug))
            return True

        monkeypatch.setattr(R, "resolve_and_write", resolve_and_write)
        monkeypatch.setattr(R, "cmd_plan", cmd_plan)
        monkeypatch.setattr(R, "ride", ride)
        monkeypatch.setattr(R, "published", lambda slug, pack, repo_dir=None: world.is_published)
        self.is_published = False
        self.fail_at = None

        class Failed(Exception):
            pass

        def build(r, ctx, first, last, dry=False, out=print):
            world.calls.append(("build_resort", first, last))
            if world.fail_at == first:
                raise Failed("raw data incomplete")
            if first == "build":
                os.makedirs(world.out, exist_ok=True)
                json.dump({"build": "b1"}, open(world.out / "meta.json", "w"))
            if first == "report":
                json.dump(REPORT, open(world.out / "report.json", "w"))

        self.br = types.SimpleNamespace(STAGES=["nodes", "manifest", "fetch", "landfire", "grooming", "build", "index",
                                                "report"], Failed=Failed, build=build,
                                        Resort=lambda slug, raw, out: (slug, raw, out),
                                        Context=lambda force, email, interactive: ("ctx", tuple(force)))

    def publish(self, argv):
        self.calls.append(("publish", tuple(argv)))

    def add(self, **kw):
        a = argparse.Namespace(name="Demo", id=None, with_=None, alone=False, slug=None, first=None, last=None,
                               force=False, force_list=[], raw_root=str(self.tmp / "raw"), out=str(self.out),
                               email=None, no_publish=False, resorts_dir=str(self.resorts))
        for k, v in kw.items():
            setattr(a, k, v)
        return R.cmd_add(a, None, publish=self.publish, br=self.br)


@pytest.fixture
def world(tmp_path, monkeypatch):
    return World(tmp_path, monkeypatch)


def test_add_runs_every_stage_in_order_and_prints_the_gate(world, capsys):
    assert world.add() == 0
    assert world.calls == [("resolve", True), ("plan", "demo"),
                           ("build_resort", "nodes", "grooming"), ("build_resort", "build", "index"),
                           ("build_resort", "report", "report"), ("ride", "demo"),
                           ("publish", (str(world.out), "--tier", "gold"))]
    out = capsys.readouterr().out
    assert "DATA-022 gate: preview, held back by:" in out and "8b Far tree ring: none: set lidar.far" in out
    assert "17 Main menu shot" not in out              # not an MVP line


def test_a_second_run_skips_the_plan_and_a_published_build(world, capsys):
    world.add()
    world.calls.clear()
    world.is_published = True
    assert world.add() == 0
    assert ("plan", "demo") not in world.calls and not any(c[0] == "publish" for c in world.calls)
    out = capsys.readouterr().out
    assert "plan: skip: planned" in out and "publish: skip: the catalog already has this build" in out
    world.calls.clear()
    world.add(force_list=["plan", "publish"])
    assert ("plan", "demo") in world.calls and any(c[0] == "publish" for c in world.calls)


def test_stop_after_plan_fetches_nothing(world):
    assert world.add(last="plan") == 0
    assert world.calls == [("resolve", True), ("plan", "demo")]


def test_review_plan_stops_after_a_new_plan_only(world, capsys):
    assert world.add(review_plan=True) == 0
    assert [c[0] for c in world.calls] == ["resolve", "plan"]
    assert "then run the same command again" in capsys.readouterr().out
    world.calls.clear()
    assert world.add(review_plan=True) == 0                  # planned now: the run goes on
    assert [c[0] for c in world.calls][-1] == "publish"


def test_a_failed_stage_stops_the_run(world, capsys):
    world.fail_at = "nodes"
    assert world.add() == 1
    assert world.calls[-1] == ("build_resort", "nodes", "grooming")
    assert "stopped at fetch: raw data incomplete" in capsys.readouterr().out


def test_no_publish_and_from(world, capsys):
    world.add(no_publish=True)
    assert not any(c[0] == "publish" for c in world.calls)
    world.calls.clear()
    assert world.add(first="ride", slug="demo") == 0
    assert [c[0] for c in world.calls] == ["ride", "publish"]
    assert world.add(first="publish", last="plan") == 2


def test_a_hand_written_config_is_kept_unless_forced(tmp_path, monkeypatch, capsys):
    w = World(tmp_path, monkeypatch, hand=True)
    assert w.add() == 4                                   # resolve refuses to replace it
    assert w.add(first="plan", slug="demo", last="plan") == 0
    assert "skip: demo.json is hand-written" in capsys.readouterr().out
    assert w.add(force=True, force_list=["resolve"], last="plan") == 0
    assert ("plan", "demo") in w.calls


def test_ride_builds_the_game_shoots_and_records_the_build(tmp_path):
    out = tmp_path / "packs" / "demo"
    out.mkdir(parents=True)
    json.dump({"build": "b1"}, open(out / "meta.json", "w"))
    raw = tmp_path / "raw" / "demo"
    seen = []

    def runner(cmd, cwd, env=None):
        seen.append((os.path.basename(cmd[0]).split(".")[0], cmd[1:3], (env or {}).get("SHOT_PACKS")))
        text = "first frame ms 900\nconsole issues: 1\n   warning: slow" if "shoot.mjs" in " ".join(cmd) else "built"
        return types.SimpleNamespace(returncode=0, stdout=text, stderr="")
    assert R.ride("demo", str(raw), str(out), runner, log=lambda *a: None) is True
    assert seen[0][0] == "npx" and seen[0][1] == ["vite", "build"]
    assert seen[1][1] == [os.path.join("tools", "shoot.mjs"), "demo"] and seen[1][2] == str(tmp_path / "packs")
    assert json.load(open(raw / "shots" / "ride.json"))["build"] == "b1"
    assert R.ride("demo", str(raw), str(out), runner, log=lambda *a: None) is False      # same build: skipped
    json.dump({"build": "b2"}, open(out / "meta.json", "w"))

    def bad(cmd, cwd, env=None):
        return types.SimpleNamespace(returncode=0, stdout="console issues: 1\n   pageerror: x is undefined", stderr="")
    with pytest.raises(SystemExit, match="page errors"):
        R.ride("demo", str(raw), str(out), bad, log=lambda *a: None)


def test_ride_serves_packs_by_absolute_path(tmp_path, monkeypatch):
    out = tmp_path / "packs" / "demo"
    out.mkdir(parents=True)
    json.dump({"build": "b1"}, open(out / "meta.json", "w"))
    monkeypatch.chdir(tmp_path)
    seen = []

    def runner(cmd, cwd, env=None):
        seen.append((env or {}).get("SHOT_PACKS"))
        return types.SimpleNamespace(returncode=0, stdout="console issues: 0", stderr="")
    R.ride("demo", os.path.join("raw", "demo"), os.path.join("packs", "demo"), runner, log=lambda *a: None)
    assert seen[-1] == str(tmp_path / "packs")           # not "packs", which shoot.mjs would read from game/
    assert (tmp_path / "raw" / "demo" / "shots" / "ride.json").exists()


def test_gate_lines_and_published(tmp_path):
    pack = tmp_path / "demo"
    pack.mkdir()
    json.dump(REPORT, open(pack / "report.json", "w"))
    json.dump({"build": "b1"}, open(pack / "meta.json", "w"))
    assert R.gate_lines(str(pack)) == (False, [("8b", "Far tree ring", "none: set lidar.far")])
    repo = tmp_path / "mp"
    repo.mkdir()
    json.dump({"resorts": [{"slug": "demo", "pack": {"build": "b0"}}]}, open(repo / "catalog.json", "w"))
    assert not R.published("demo", str(pack), str(repo))
    json.dump({"resorts": [{"slug": "demo", "pack": {"build": "b1"}}]}, open(repo / "catalog.json", "w"))
    assert R.published("demo", str(pack), str(repo))
    assert not R.published("demo", str(pack), str(tmp_path / "nowhere"))


def test_same_areas():
    old = {"crs": "x", "openskidata": {"ids": ["a", "b"]}, "exclude": [{"name": "Club", "openskidata_id": "c"},
                                                                       {"name": "Drawn", "lonlat": []}]}
    assert R.same_areas(old, {"openskidata": {"ids": ["a", "b"]}, "exclude": [{"name": "Club"}]})
    assert not R.same_areas(old, {"openskidata": {"ids": ["a"]}, "exclude": [{"name": "Club"}]})
    assert not R.same_areas(old, {"openskidata": {"ids": ["a", "b"]}})
    assert not R.same_areas({"openskidata": {"ids": ["a"]}}, {"openskidata": {"ids": ["a"]}})     # not planned
