"""FEAT-177: every meta.json a pipeline stage writes carries a fresh build id; re-indexing keeps it."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from packwriter import write_meta  # noqa: E402


def read(d):
    with open(os.path.join(d, "meta.json")) as f:
        return json.load(f)


def test_write_meta_stamps_a_new_build(tmp_path):
    pack = tmp_path / "packs" / "demo"
    pack.mkdir(parents=True)
    write_meta(str(pack), {"slug": "demo"})
    first = read(pack)["build"]
    write_meta(str(pack), read(pack))
    second = read(pack)["build"]
    assert first and second and first != second
    assert json.load(open(tmp_path / "packs" / "index.json"))["packs"] == ["demo"]


def test_reindex_keeps_the_build(tmp_path):
    pack = tmp_path / "packs" / "demo"
    pack.mkdir(parents=True)
    write_meta(str(pack), {"slug": "demo"})
    b = read(pack)["build"]
    write_meta(str(pack), read(pack), stamp=False)
    assert read(pack)["build"] == b
