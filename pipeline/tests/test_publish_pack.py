"""FEAT-222: publish_pack.py's zip and catalog, the format constant shared with the client, and a round trip
through game/tools/get_pack.mjs (skipped when node is not installed)."""
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from packwriter import FORMAT_VERSION, write_meta  # noqa: E402
from publish_pack import catalog_entry, next_version, pack_files, update_catalog, zip_pack  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def make_pack(root, slug="demo", fmt=FORMAT_VERSION):
    d = root / slug
    (d / "fine").mkdir(parents=True)
    (d / "debug").mkdir()
    (d / "fine" / "0_0.png").write_bytes(b"\x89PNG" + bytes(range(256)) * 40)
    (d / "debug" / "species.png").write_bytes(b"debug")
    (d / ".catalog.json").write_text("{}")
    write_meta(str(d), {"version": 1, "formatVersion": fmt, "slug": slug, "name": "Demo Mountain", "lonlat": [-106, 39]})
    return d


def test_client_reads_the_format_the_pipeline_writes():
    ts = open(os.path.join(REPO, "game", "src", "pack", "format.ts"), encoding="utf-8").read()
    assert int(re.search(r"PACK_FORMAT\s*=\s*(\d+)", ts).group(1)) == FORMAT_VERSION


def test_zip_is_stored_repeatable_and_leaves_out_debug(tmp_path):
    pack = make_pack(tmp_path / "packs")
    assert pack_files(str(pack)) == ["fine/0_0.png", "meta.json"]
    a, b = tmp_path / "a.zip", tmp_path / "b.zip"
    size, sha = zip_pack(str(pack), str(a))
    assert (size, sha) == zip_pack(str(pack), str(b))
    with zipfile.ZipFile(a) as z:
        assert z.namelist() == ["fine/0_0.png", "meta.json"]
        assert all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist())


def test_next_version_skips_deleted_releases_and_other_resorts():
    cat = {"resorts": [{"slug": "vail", "pack": {"version": 2}}]}
    assert next_version("vail", ["vail-v1", "vail-v3", "vail-east-v9", "bigsky-v4"], cat) == 4
    assert next_version("bigsky", [], cat) == 1


def test_catalog_replaces_the_resort_and_sorts_by_name():
    meta = {"slug": "vail", "name": "Vail", "formatVersion": FORMAT_VERSION, "build": "b1", "lonlat": [-106.35, 39.6]}
    e = catalog_entry(meta, {"region": "Colorado", "country": "US"}, version=2, size=10, sha256="ab", pipeline="abc1234",
                      tier="gold", status="preview", report=None)
    assert e["pack"]["url"].endswith("/releases/download/vail-v2/vail.zip")
    cat = {"resorts": [{"slug": "vail", "name": "Vail", "pack": {"version": 1, "formatVersion": 0}},
                       {"slug": "bigsky", "name": "Big Sky", "pack": {"version": 1, "formatVersion": FORMAT_VERSION}}]}
    out = update_catalog(cat, e)
    assert [r["slug"] for r in out["resorts"]] == ["bigsky", "vail"]
    assert out["resorts"][1]["pack"]["version"] == 2 and out["formatVersion"] == FORMAT_VERSION


@pytest.mark.skipif(not shutil.which("node"), reason="node not installed")
def test_get_pack_installs_a_published_zip(tmp_path):
    pack = make_pack(tmp_path / "src")
    zpath = tmp_path / "demo.zip"
    size, sha = zip_pack(str(pack), str(zpath))
    entry = catalog_entry(json.load(open(pack / "meta.json")), {}, version=1, size=size, sha256=sha, pipeline="x",
                          tier="gold", status="preview", report=None)
    entry["pack"]["url"] = str(zpath)            # get_pack reads a local path the same as a URL
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps(update_catalog({}, entry)))
    packs = tmp_path / "packs"
    tool = os.path.join(REPO, "game", "tools", "get_pack.mjs")
    run = lambda *a: subprocess.run(["node", tool, "demo", "--catalog", str(catalog), "--packs", str(packs), *a],
                                    capture_output=True, text=True)
    r = run()
    assert r.returncode == 0, r.stderr
    assert (packs / "demo" / "fine" / "0_0.png").read_bytes() == (pack / "fine" / "0_0.png").read_bytes()
    assert not (packs / "demo" / "debug").exists()
    assert json.load(open(packs / "demo" / ".catalog.json"))["sha256"] == sha
    assert json.load(open(packs / "index.json"))["packs"] == ["demo"]
    assert "already" in run().stdout
    # a bad checksum is refused and leaves the installed pack alone
    entry["pack"]["sha256"] = "0" * 64
    entry["pack"]["version"] = 2
    catalog.write_text(json.dumps(update_catalog({}, entry)))
    r = run()
    assert r.returncode == 1 and "sha256" in r.stderr
    assert (packs / "demo" / "meta.json").exists() and not any(p.name.startswith(".demo") for p in packs.iterdir())
    # a pack built on this PC (no catalog marker) is only replaced with --force
    os.remove(packs / "demo" / ".catalog.json")
    entry["pack"]["sha256"] = sha
    catalog.write_text(json.dumps(update_catalog({}, entry)))
    assert "--force" in run().stderr
    assert run("--force").returncode == 0
