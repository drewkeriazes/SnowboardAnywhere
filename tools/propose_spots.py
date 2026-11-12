"""Propose compare spots for a resort from its pack's OSM features, with game stills (FEAT-175 step 4).

    python tools/propose_spots.py <pack> [--count 10] [--shoot] [--replace] [--dry-run]

Picks up to `--count` spots spread over the resort (at least 300 m apart, then 150 or 100 m if that leaves too few): the
lift tops (highest first, half the count), the base areas (lift bottom stations within 250 m of each other, the
biggest first, a third) and the named peaks inside the pack bounds (the rest), any shortfall from the others.
Each gets two views, the ones a Street View photo there most likely has: from beside a lift's unload (20 m down and
20 m to the side a run leaves from) down the lift line and across the slope, from a base area up the hill and across
it, from a peak toward the resort and away.

Writes `docs/compare/<pack>/<spot>/spot.json` for each, in the shape `gmaps2game.py --add` writes, with `"proposed"`
saying where it came from, the spot's `latlon` and a Google Maps link to find a Street View there (a link only: no
Google image goes in the repo), and each view's game pose (pack metres, grid heading) with an empty `streetview`.
A spot folder that already has a spot.json is left alone (`--replace` rewrites only proposals still without a Street
View link). `--shoot` then renders each new view's game still, `eye-<view>.jpg`, with `game/tools/shoot_spots.mjs`
on the GPU (after `npx vite build`).

Then Drew finds a Street View photo near each spot and adds it to the proposed view:
`python tools/gmaps2game.py "<maps url>" <pack> --spot <spot>/<view> --add` (it updates the view in place).

The pack is read from packs/<pack>/, or SHOT_PACKS/<pack>/ (build_resort.py's spots stage points it at MapPacker's).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

from pyproj import Transformer

REPO = Path(__file__).resolve().parent.parent
AERIAL = {"chair_lift", "gondola", "cable_car", "mixed_lift", "drag_lift", "t-bar", "j-bar", "platter", "rope_tow"}
APART_M = (300.0, 150.0, 100.0)
BASE_CLUSTER_M = 250.0
FOV = 75.0
HOST = "http://localhost:5173/"


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:40].strip("-") or "spot"


def heading_to(ax, ay, bx, by) -> float:
    """grid heading (degrees clockwise from grid north) from a to b"""
    return math.degrees(math.atan2(bx - ax, by - ay)) % 360


def near_run(runs, x, y) -> float:
    """distance from (x, y) to the nearest run vertex (runs: point lists)"""
    return min((math.hypot(p[0] - x, p[1] - y) for pts in runs for p in pts), default=0.0)


def aerial(lifts):
    return [lf for lf in lifts if (lf.get("type") or "") in AERIAL and len(lf.get("stations") or []) >= 2]


def candidates(features: dict, bounds: dict) -> dict:
    """{'lift': [...], 'base': [...], 'peak': [...]}, each a list of spots best first"""
    inside = lambda x, y: bounds["minX"] + 30 <= x < bounds["maxX"] - 30 and bounds["minY"] + 30 <= y < bounds["maxY"] - 30
    lifts = aerial(features.get("lifts", []))
    runs = [r["points"] for r in features.get("runs", []) if len(r.get("points") or []) >= 2]
    stations = [s for lf in lifts for s in lf["stations"]]
    cx = sum(s[0] for s in stations) / len(stations) if stations else 0.0
    cy = sum(s[1] for s in stations) / len(stations) if stations else 0.0
    out = {"lift": [], "base": [], "peak": []}
    for lf in sorted(lifts, key=lambda lf: -max(s[2] for s in lf["stations"])):
        st = sorted(lf["stations"], key=lambda s: s[2])
        (bx, by, _), (tx, ty, tz) = st[0][:3], st[-1][:3]
        L = math.hypot(tx - bx, ty - by) or 1.0
        ux, uy = (tx - bx) / L, (ty - by) / L
        # beside the unload, a little down the hill, on the side a run leaves from: the terminal is behind both views
        side = min((1, -1), key=lambda k: near_run(runs, tx - ux * 20 + uy * 20 * k, ty - uy * 20 - ux * 20 * k))
        x, y = tx - ux * 20 + uy * 20 * side, ty - uy * 20 - ux * 20 * side
        if inside(x, y):
            name = lf.get("name") or "the lift"
            out["lift"].append({"kind": "lift", "name": f"Top of {name}", "x": x, "y": y, "z": tz, "views": [
                ("down", heading_to(tx, ty, bx, by), -8.0), ("across", heading_to(0, 0, uy * side, -ux * side), -4.0)]})
    # base areas: bottom stations close together, the biggest cluster first
    bottoms = [(sorted(lf["stations"], key=lambda s: s[2])[0], lf) for lf in lifts]
    clusters: list[list] = []
    for (s, lf) in sorted(bottoms, key=lambda b: b[0][2]):
        for c in clusters:
            if math.hypot(s[0] - c[0][0][0], s[1] - c[0][0][1]) < BASE_CLUSTER_M:
                c.append((s, lf))
                break
        else:
            clusters.append([(s, lf)])
    for c in sorted(clusters, key=lambda c: -len(c)):
        x = sum(s[0] for s, _ in c) / len(c)
        y = sum(s[1] for s, _ in c) / len(c)
        top = max((t for _, lf in c for t in lf["stations"]), key=lambda t: t[2])
        if not inside(x, y):
            continue
        name = max(c, key=lambda b: max(t[2] for t in b[1]["stations"]))[1].get("name") or "the lifts"
        out["base"].append({"kind": "base", "name": f"Base of {name}", "x": x, "y": y, "z": min(s[2] for s, _ in c), "views": [
            ("up", heading_to(x, y, top[0], top[1]), 6.0), ("across", (heading_to(x, y, top[0], top[1]) + 90) % 360, 0.0)]})
    for pk in sorted(features.get("peaks", []), key=lambda p: -(p.get("z") or 0)):
        if pk.get("name") and inside(pk["x"], pk["y"]):
            to_resort = heading_to(pk["x"], pk["y"], cx, cy)
            out["peak"].append({"kind": "peak", "name": pk["name"], "x": pk["x"], "y": pk["y"], "z": pk.get("z"), "views": [
                ("resort", to_resort, -6.0), ("away", (to_resort + 180) % 360, -3.0)]})
    return out


def pick(cands: dict, count: int) -> list:
    """spread spots: quotas per kind (lift tops half, bases a third, peaks the rest), then any kind, apart"""
    quota = {"lift": (count + 1) // 2, "base": max(1, count // 3)}
    quota["peak"] = max(0, count - quota["lift"] - quota["base"])
    for apart in APART_M:
        chosen: list = []
        ok = lambda s: all(math.hypot(s["x"] - c["x"], s["y"] - c["y"]) >= apart for c in chosen)
        for kind in ("lift", "base", "peak"):
            n = 0
            for s in cands[kind]:
                if n >= quota[kind]:
                    break
                if ok(s):
                    chosen.append(s)
                    n += 1
        for kind in ("lift", "base", "peak"):         # the shortfall from whatever is left
            for s in cands[kind]:
                if len(chosen) >= count:
                    break
                if s not in chosen and ok(s):
                    chosen.append(s)
        if len(chosen) >= count:
            break
    return chosen[:count]


def spot_json(meta: dict, pack: str, slug: str, s: dict, host: str = HOST) -> dict:
    ox, oy = meta["origin"]
    to_ll = Transformer.from_crs(meta["crs"], "EPSG:4326", always_xy=True)
    to_grid = Transformer.from_crs("EPSG:4326", meta["crs"], always_xy=True)
    lon, lat = to_ll.transform(s["x"] + ox, s["y"] + oy)
    e, n = to_grid.transform(lon, lat)
    e2, n2 = to_grid.transform(lon, lat + 1e-4)
    convergence = math.degrees(math.atan2(e2 - e, n2 - n))          # grid azimuth of true north (gmaps2game.py)
    views = []
    for vid, h, pitch in s["views"]:
        views.append({"id": vid, "heading": round((h - convergence) % 360, 1), "pitch": pitch, "fov": FOV, "streetview": "",
                      "x": round(s["x"], 1), "y": round(s["y"], 1), "h": round(h, 1),
                      "game": f"{host}?pack={pack}&x={s['x']:.1f}&y={s['y']:.1f}&h={h:.1f}&pitch={pitch:.1f}&fov={FOV:.1f}&cam=eye&spot={slug}/{vid}"})
    return {"name": s["name"],
            "proposed": f"FEAT-175 tools/propose_spots.py: a {s['kind']} spot from OSM; find a Street View photo near latlon "
                        f"(the maps link) and add it to a view with tools/gmaps2game.py --spot {slug}/<view> --add",
            "latlon": [round(lat, 7), round(lon, 7)],
            "maps": f"https://www.google.com/maps/@{lat:.7f},{lon:.7f},17z",
            "game": {"x": round(s["x"]), "y": round(s["y"])}, "views": views,
            "streetview_capture": "TODO: month year, contributor (shown at the bottom of the Street View)"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pack")
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--shoot", action="store_true", help="render each new view's game still (shoot_spots.mjs, GPU)")
    ap.add_argument("--replace", action="store_true", help="rewrite proposals that still have no Street View link")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)        # in order with shoot_spots.mjs's output
    packs = Path(os.environ["SHOT_PACKS"]) if os.environ.get("SHOT_PACKS") else REPO / "packs"
    pdir = packs / a.pack
    if not (pdir / "meta.json").exists():
        print(f"no pack at {pdir}")
        return 2
    meta = json.loads((pdir / "meta.json").read_text(encoding="utf-8"))
    features = json.loads((pdir / "features.json").read_text(encoding="utf-8"))
    chosen = pick(candidates(features, meta["bounds"]), a.count)
    out_dir = REPO / "docs" / "compare" / a.pack
    written, slugs = [], set()
    for s in chosen:
        slug = slugify(s["name"])
        while slug in slugs:
            slug += "-2"
        slugs.add(slug)
        f = out_dir / slug / "spot.json"
        if f.exists():
            old = json.loads(f.read_text(encoding="utf-8"))
            mine = old.get("proposed") and not any(v.get("streetview") for v in old.get("views", []))
            if not (a.replace and mine):
                print(f"  {slug}: has a spot.json, left alone")
                continue
        spec = spot_json(meta, a.pack, slug, s)
        print(f"  {slug:28} {s['kind']:4} {s['name'][:34]:34} x {s['x']:7.0f} y {s['y']:7.0f}  {spec['latlon'][0]:.5f}, {spec['latlon'][1]:.5f}  "
              f"views {', '.join(f'{v[0]} {v[1]:.0f} deg' for v in s['views'])}")
        if not a.dry_run:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")
            written.append(slug)
    print(f"{len(written)} spots proposed in {out_dir.relative_to(REPO).as_posix()}/ ({len(chosen)} picked)")
    if a.shoot and written:
        game = REPO / "game"
        npx = "npx.cmd" if sys.platform == "win32" else "npx"
        if subprocess.run([npx, "vite", "build"], cwd=game).returncode:
            print("the game did not build (cd game && npx vite build)")
            return 1
        code = subprocess.run(["node", "tools/shoot_spots.mjs", a.pack, *written, "--gpu"], cwd=game).returncode
        if code:
            print(f"shoot_spots.mjs exited {code}")
            return 1
    if written:
        print(f"next: a Street View photo near each spot's latlon, then\n  python tools/gmaps2game.py \"<maps url>\" {a.pack} --spot <spot>/<view> --add")
    return 0


if __name__ == "__main__":
    sys.exit(main())
