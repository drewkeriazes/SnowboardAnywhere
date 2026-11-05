#!/usr/bin/env python3
"""Turn pipeline/raw/<slug>/ into packs/<slug>/ (heightmap tiles, masks, trees, features).

Stages follow docs/bonvo-teardown-and-build-plan.md section 4. Each stage is a
function so they can be run and validated one at a time.

Usage: python build_pack.py vail [--stage dem|trees|masks|features|snow|pack|all]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

RAW = Path(__file__).resolve().parents[2] / "raw"
PACKS = Path(__file__).resolve().parents[2] / "packs"


def stage_dem(slug: str) -> None:
    """Mosaic 1 m GeoTIFFs, fill voids, resample to a 1 m UTM grid at the resort origin, write z0..z3 PNG tiles + 30 m background."""
    raise NotImplementedError("M0: implement with rasterio + numpy")


def stage_trees(slug: str) -> None:
    """Read 3DEP EPT for the bbox, DSM - DTM = CHM, local-maximum crown segmentation -> trees.bin."""
    raise NotImplementedError("M0: implement with laspy/pdal + scipy.ndimage")


def stage_masks(slug: str) -> None:
    """NAIP NDVI + brightness + slope -> conifer/aspen/meadow/rock/scree/water/built masks, unioned with OSM landcover."""
    raise NotImplementedError("M0")


def stage_features(slug: str) -> None:
    """OSM pistes/aerialways/buildings/roads/water/peaks + OpenSkiData runs/lifts joined by source id -> features.json."""
    raise NotImplementedError("M0")


def stage_snow(slug: str) -> None:
    """Groomed-piste mask, wind-scour from aspect/exposure, depth from elevation -> detail channels in masks."""
    raise NotImplementedError("M0")


def stage_pack(slug: str) -> None:
    """Write meta.json (origin, bounds, UTM zone, attributions) and validate tile counts."""
    out = PACKS / slug
    out.mkdir(parents=True, exist_ok=True)
    (out / "meta.json").write_text(json.dumps({"slug": slug, "status": "stub"}, indent=2))


STAGES = {
    "dem": stage_dem,
    "trees": stage_trees,
    "masks": stage_masks,
    "features": stage_features,
    "snow": stage_snow,
    "pack": stage_pack,
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--stage", default="all", choices=["all", *STAGES])
    args = ap.parse_args()
    if not (RAW / args.slug).exists():
        raise SystemExit(f"No raw data at {RAW / args.slug}. Run pipeline/fetch/fetch-resort.mjs first.")
    for name, fn in STAGES.items():
        if args.stage in ("all", name):
            print(f"== {name}")
            fn(args.slug)


if __name__ == "__main__":
    main()
