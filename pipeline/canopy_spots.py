"""BUG-028: canopy cover at the photo-pair spots, on the ground that can hold forest.

The canopy mask is cut by every run corridor, building and road (the trail cuts are real), so canopy cover
over a whole disc round a spot is capped by how much run it holds: 41 % of the 80 m disc at Born Free is
groomed run. This measures canopy over the disc's off-run cells only, using the same run widths as the
pack build (`RUN_HALF_WIDTH`), plus the whole-disc figure for reference.

    python pipeline/canopy_spots.py packs/vail [--before packs/vail_main] [--radius 80]

The table uses --radius; the targets below use their own radius per spot. Exits 1 if a target fails.

Reads `meta.json`, `features.json` and the mask alpha (canopy cover) of each pack, and the spots in
`docs/compare/<slug>/*/spot.json`. Prints a markdown table and checks the BUG-028 targets. Where the pack has
tree instances (`trees/*.bin`), the table also gives the detected crowns per hectare of the disc's off-run ground
(snags, species 7, left out), the crown count DATA-011 compares between lidar densities.
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from piste_dir import read_mask_channel  # noqa: E402

# half width (m) of the corridor a run is cut through the forest, by difficulty; build_pack.py stage 7 uses it
RUN_HALF_WIDTH = {"novice": 22, "easy": 20, "intermediate": 18, "advanced": 14, "expert": 10}
RUN_HALF_WIDTH_DEFAULT = 12
ROAD_HALF_WIDTH_MAJOR, ROAD_HALF_WIDTH = 8, 4      # motorway / trunk / primary, everything else
BUILDING_MARGIN = 6

# BUG-028 targets: (radius m, off-run canopy at least) at the closed-forest spots, and open bowls that must not
# gain canopy. Mid-Vail's off-run ground within 80 m is lidar-open (the lawns and plaza between the terminals:
# returns everywhere, canopy height under 1 m on 95 % of it); its spruce walls start 80 to 120 m out, so 100 m.
FOREST_TARGETS = {"born-free": (80.0, 0.5), "mid-vail-wildwood": (100.0, 0.5)}
OPEN_SPOTS = ["mongolia-bowl", "china-bowl-north-rim", "china-bowl-poppyfields", "back-bowls-campbells"]
OPEN_TOLERANCE = 0.02
SNAG = 7                                            # species id of standing dead trees (pack-format.md)


def run_half_width(run):
    return RUN_HALF_WIDTH.get(run.get("difficulty") or "", RUN_HALF_WIDTH_DEFAULT)


def cleared_ground(features):
    """one shapely geometry covering every non-glade run corridor, road corridor and building (plus margin)"""
    parts = []
    for r in features.get("runs", []):
        if r.get("area") or r.get("gladed") or len(r["points"]) < 2:
            continue
        parts.append(LineString([(p[0], p[1]) for p in r["points"]]).buffer(run_half_width(r)))
    for rd in features.get("roads", []):
        if len(rd["points"]) < 2:
            continue
        hw = ROAD_HALF_WIDTH_MAJOR if rd.get("kind") in ("motorway", "trunk", "primary") else ROAD_HALF_WIDTH
        parts.append(LineString([(p[0], p[1]) for p in rd["points"]]).buffer(hw))
    for b in features.get("buildings", []):
        if len(b["points"]) < 3:
            continue
        poly = Polygon([(p[0], p[1]) for p in b["points"]])
        parts.append((poly if poly.is_valid else poly.buffer(0)).buffer(BUILDING_MARGIN))
    return shapely.union_all(parts) if parts else Polygon()


def disc_cells(cover, mask_meta, x, y, radius):
    """the canopy cover values and cell centres of the mask cells within `radius` of (x, y)"""
    res, n = mask_meta["res"], mask_meta["tileSize"]
    top = mask_meta["minY"] + mask_meta["tilesY"] * n * res      # y of padded row 0's north edge
    c0, c1 = int((x - radius - mask_meta["minX"]) / res), int((x + radius - mask_meta["minX"]) / res) + 1
    r0, r1 = int((top - (y + radius)) / res), int((top - (y - radius)) / res) + 1
    c0, r0 = max(c0, 0), max(r0, 0)
    c1, r1 = min(c1, cover.shape[1]), min(r1, cover.shape[0])
    rr, cc = np.mgrid[r0:r1, c0:c1]
    xs = mask_meta["minX"] + (cc + 0.5) * res
    ys = top - (rr + 0.5) * res
    inside = (xs - x) ** 2 + (ys - y) ** 2 <= radius * radius
    return cover[r0:r1, c0:c1][inside], xs[inside], ys[inside]


def spot_canopy(cover, mask_meta, cleared, x, y, radius):
    """(whole-disc canopy, off-run share of the disc, off-run canopy) round one spot"""
    vals, xs, ys = disc_cells(cover, mask_meta, x, y, radius)
    if not len(vals):
        return float("nan"), 0.0, float("nan")
    off = ~shapely.contains_xy(cleared, xs, ys) if not cleared.is_empty else np.ones(len(vals), bool)
    whole = float(vals.mean())
    return whole, float(off.mean()), (float(vals[off].mean()) if off.any() else float("nan"))


def load_spots(slug, repo):
    spots = {}
    for p in sorted(glob.glob(os.path.join(repo, "docs", "compare", slug, "*", "spot.json"))):
        with open(p, encoding="utf-8") as f:
            g = json.load(f)["game"]
        spots[os.path.basename(os.path.dirname(p))] = (float(g["x"]), float(g["y"]))
    return spots


class PackCanopy:
    """a pack's canopy cover (mask alpha) and cleared ground, measured round any point"""
    def __init__(self, pack_dir):
        with open(os.path.join(pack_dir, "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        with open(os.path.join(pack_dir, "features.json"), encoding="utf-8") as f:
            features = json.load(f)
        self.mask = meta["mask"]
        self.cover = read_mask_channel(pack_dir, meta, 3)
        self.cleared = cleared_ground(features)
        shapely.prepare(self.cleared)
        self.trees = read_trees(pack_dir)

    def at(self, x, y, radius):
        return spot_canopy(self.cover, self.mask, self.cleared, x, y, radius)

    def crowns(self, x, y, radius):
        """live detected crowns per hectare of off-run ground within `radius`, NaN without tree instances"""
        if self.trees is None:
            return float("nan")
        return spot_crowns(self.trees, self.cleared, x, y, radius, self.at(x, y, radius)[1])


def read_trees(pack_dir):
    """every tree instance of the pack as an (N, 6) float32 array (x, y, z, height, crownRadius, species), or None"""
    files = sorted(glob.glob(os.path.join(pack_dir, "trees", "*.bin")))
    if not files:
        return None
    return np.concatenate([np.fromfile(p, "<f4").reshape(-1, 6) for p in files])


def spot_crowns(trees, cleared, x, y, radius, off_share):
    """live crowns (not snags) per hectare of off-run ground within `radius` of (x, y); `off_share` is the off-run
    share of the disc (spot_canopy)"""
    area_ha = np.pi * radius * radius * off_share / 1e4
    if area_ha <= 0:
        return float("nan")
    t = trees[((trees[:, 0] - x) ** 2 + (trees[:, 1] - y) ** 2 <= radius * radius) & (trees[:, 5] != SNAG)]
    off = ~shapely.contains_xy(cleared, t[:, 0], t[:, 1]) if not cleared.is_empty else np.ones(len(t), bool)
    return float(off.sum()) / area_ha


def check_targets(after, before, spots):
    """(ok, report lines) for the BUG-028 targets; `before` (a PackCanopy or None) enables the open-bowl check"""
    ok, lines = True, []
    for name, (radius, target) in FOREST_TARGETS.items():
        if name in spots:
            v = after.at(*spots[name], radius)[2]
            passed = v >= target
            ok &= passed
            lines.append(f"{'PASS' if passed else 'FAIL'} {name}: off-run canopy within {radius:.0f} m {v:.2f}, target {target:.2f}")
    if before:
        for name in OPEN_SPOTS:
            if name in spots:
                b, a = before.at(*spots[name], 80.0)[2], after.at(*spots[name], 80.0)[2]
                passed = not a - b > OPEN_TOLERANCE
                ok &= passed
                lines.append(f"{'PASS' if passed else 'FAIL'} {name}: open bowl off-run canopy within 80 m {b:.2f} -> {a:.2f}")
    return ok, lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pack", help="pack directory, for example packs/vail")
    ap.add_argument("--before", help="a second pack to compare against (for example main's build)")
    ap.add_argument("--slug", help="compare spots folder under docs/compare (default: the pack folder name)")
    ap.add_argument("--radius", type=float, default=80.0)
    a = ap.parse_args()
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    slug = a.slug or os.path.basename(os.path.normpath(a.pack))
    spots = load_spots(slug, repo)
    if not spots:
        sys.exit(f"no spots in docs/compare/{slug}; pass --slug")
    after_pack = PackCanopy(a.pack)
    before_pack = PackCanopy(a.before) if a.before else None
    after = {n: after_pack.at(x, y, a.radius) for n, (x, y) in spots.items()}
    before = {n: before_pack.at(x, y, a.radius) for n, (x, y) in spots.items()} if before_pack else None

    r = int(a.radius)
    crowns = after_pack.trees is not None
    pair = " (before / after)" if before else ""
    head = f"| spot | off-run share of {r} m disc | canopy, whole disc{pair} | canopy, off-run{pair} |"
    print(head + (f" crowns per off-run ha{pair} |" if crowns else ""))
    print("|---|---:|---:|---:|" + ("---:|" if crowns else ""))
    for name in spots:
        w, share, off = after[name]
        n = after_pack.crowns(*spots[name], a.radius) if crowns else None
        if before:
            bw, _, boff = before[name]
            row = f"| {name} | {share:.2f} | {bw:.2f} / {w:.2f} | {boff:.2f} / {off:.2f} |"
            if crowns:
                row += f" {before_pack.crowns(*spots[name], a.radius):.0f} / {n:.0f} |"
        else:
            row = f"| {name} | {share:.2f} | {w:.2f} | {off:.2f} |" + (f" {n:.0f} |" if crowns else "")
        print(row)
    ok, lines = check_targets(after_pack, before_pack, spots)
    print("\n".join(lines))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
