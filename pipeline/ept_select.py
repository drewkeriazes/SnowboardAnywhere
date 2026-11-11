"""Select EPT lidar nodes over a resort for the manifest.

Usage: python pipeline/ept_select.py <slug> [--dry]

Reads pipeline/resorts/<slug>.json and, for the `lidar` source and each entry of `lidar.extra`, walks
ept-hierarchy on the public bucket and keeps every node with points that intersects the box: down to
`max_depth_resort` where the node touches the ski area (`lonlat_bbox`), `max_depth_outside` in the rest of the
buffered box (`utm_bbox`, in the config's `crs`). An extra source may carry its own `utm_bbox` to clip it to the
part the main dataset misses. Writes each source's `nodes_file` next to the config (not with --dry).

    python pipeline/ept_select.py <slug> --deep [--dry]

DATA-011: the deep tier. Selects the main source's nodes deeper than `max_depth_resort`, down to
`max_depth_deep`, that touch a disc of `deep_spots_m` round each compare spot named in `deep_spots`
(`docs/compare/<slug>/<name>/spot.json`) and sit under a node of `nodes_file` (EPT levels add points, so a deep node
is only worth having under its fetched parent), and writes them to `deep_nodes_file`; `gen_manifest.py` adds them to `ept/` beside the main nodes, and
`build_pack.py` reads every `ept/*.laz`, so the denser points merge into the DSM with no other change."""
import glob, json, os, sys, urllib.request
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))


def node_box(bounds, key):
    d, x, y, _ = map(int, key.split("-")); s = (bounds[3] - bounds[0]) / 2 ** d
    return bounds[0] + x * s, bounds[1] + y * s, bounds[0] + (x + 1) * s, bounds[1] + (y + 1) * s


def hit(r, q): return r[0] < q[2] and r[2] > q[0] and r[1] < q[3] and r[3] > q[1]


def clip(a, b): return max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])


def sources(cfg):
    """The main lidar source and the extra ones, each a dict with ept, dataset, depths and nodes_file."""
    main = {k: v for k, v in cfg["lidar"].items() if k != "extra"}
    return [main] + list(cfg["lidar"].get("extra", []))


def walk(base, fetch_json, keep):
    """every node with points that `keep(key, depth)` accepts, as (key, count); children are only visited
    under an accepted node, and sub-hierarchies are fetched on the way down"""
    cache = {}

    def hier(key):
        if key not in cache: cache[key] = fetch_json(f"{base}ept-hierarchy/{key}.json")
        return cache[key]

    counts = dict(hier("0-0-0-0"))
    out, stack = [], ["0-0-0-0"]
    while stack:
        key = stack.pop()
        c = counts.get(key)
        if c is None: continue
        if c == -1:
            counts.update(hier(key)); c = counts[key]
        if c <= 0: continue
        d, x, y, z = map(int, key.split("-"))
        if not keep(key, d): continue
        out.append((key, c))
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    stack.append(f"{d+1}-{2*x+dx}-{2*y+dy}-{2*z+dz}")
    return out


def _base(src): return src["ept"] if src["ept"].endswith("/") else src["ept"] + "/"


def _json(url): return json.load(urllib.request.urlopen(url, timeout=60))


def select(cfg, src, fetch_json=None):
    """Node keys to download for one source, plus the point count over the ski area."""
    fetch_json = fetch_json or _json
    base = _base(src)
    ept = fetch_json(base + "ept.json")
    b = ept["bounds"]; srs = ept["srs"].get("horizontal", "3857")
    utm_to = Transformer.from_crs(cfg["crs"], f"EPSG:{srs}", always_xy=True)
    ll_to = Transformer.from_crs("EPSG:4326", f"EPSG:{srs}", always_xy=True)

    def box(tr, x0, y0, x1, y1):
        pts = [tr.transform(x, y) for x in (x0, x1) for y in (y0, y1)]
        return min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)

    out = box(utm_to, *cfg["utm_bbox"])                   # buffered box
    if "utm_bbox" in src:
        out = clip(out, box(utm_to, *src["utm_bbox"]))
    inner = clip(box(ll_to, *cfg["lonlat_bbox"]), out)    # ski area
    deep, shallow = int(src["max_depth_resort"]), int(src["max_depth_outside"])

    def keep(key, d):
        r = node_box(b, key)
        return hit(r, out) and d <= (deep if hit(r, inner) else shallow)

    sel = walk(base, fetch_json, keep)
    return [k for k, _ in sel], sum(c for k, c in sel if hit(node_box(b, k), inner))


def deep_select(cfg, src, spots, have=None, fetch_json=None):
    """DATA-011: node keys deeper than `max_depth_resort`, to `max_depth_deep`, whose box touches a disc of
    `deep_spots_m` round any of `spots` (local metres, x east, y north of cfg["origin"]) and, with `have` (the
    fetched node keys), whose `max_depth_resort` ancestor is one of them; plus their point count"""
    fetch_json = fetch_json or _json
    base = _base(src)
    ept = fetch_json(base + "ept.json")
    b = ept["bounds"]; srs = ept["srs"].get("horizontal", "3857")
    to_local = Transformer.from_crs(f"EPSG:{srs}", cfg["crs"], always_xy=True)
    ox, oy = cfg["origin"]
    top, bottom, rad = int(src["max_depth_resort"]), int(src["max_depth_deep"]), float(src["deep_spots_m"])

    def keep(key, d):
        if d > bottom or (have is not None and d == top and key not in have): return False
        r = node_box(b, key)
        xs, ys = to_local.transform([r[0], r[2], r[0], r[2]], [r[1], r[1], r[3], r[3]])
        x0, x1, y0, y1 = min(xs) - ox, max(xs) - ox, min(ys) - oy, max(ys) - oy
        # disc against the node's box in local metres (the box of the projected corners, a few metres generous)
        return any((min(max(sx, x0), x1) - sx) ** 2 + (min(max(sy, y0), y1) - sy) ** 2 <= rad * rad
                   for sx, sy in spots)

    sel = [(k, c) for k, c in walk(base, fetch_json, keep) if int(k.split("-")[0]) > top]
    return [k for k, _ in sel], sum(c for _, c in sel)


def load_spots(slug):
    """{name: (x, y)} game positions (local metres) of the compare spots, docs/compare/<slug>/<name>/spot.json"""
    repo = os.path.dirname(HERE); out = {}
    for p in sorted(glob.glob(os.path.join(repo, "docs", "compare", slug, "*", "spot.json"))):
        with open(p, encoding="utf-8") as f:
            g = json.load(f)["game"]
        out[os.path.basename(os.path.dirname(p))] = (float(g["x"]), float(g["y"]))
    return out


def main(argv):
    if not argv or argv[0].startswith("-"):
        print(__doc__); return 2
    slug, dry = argv[0], "--dry" in argv
    cfg = json.load(open(os.path.join(HERE, "resorts", f"{slug}.json"), encoding="utf-8"))
    if "--deep" in argv:
        src = sources(cfg)[0]
        if "deep_nodes_file" not in src:
            print(f"{slug}.json lidar has no deep tier (max_depth_deep, deep_spots, deep_spots_m, deep_nodes_file)")
            return 2
        known = load_spots(slug)
        missing = [n for n in src["deep_spots"] if n not in known]
        if missing:
            print("no docs/compare spot for", ", ".join(missing)); return 2
        spots = [known[n] for n in src["deep_spots"]]
        with open(os.path.join(HERE, "resorts", src["nodes_file"])) as f:
            have = set(f.read().split())
        sel, pts = deep_select(cfg, src, spots, have)
        print(src["dataset"], "deep nodes", len(sel), "points", pts, "round", len(spots), "spots, depths",
              src["max_depth_resort"] + 1, "to", src["max_depth_deep"])
        if not dry:
            with open(os.path.join(HERE, "resorts", src["deep_nodes_file"]), "w") as f:
                f.write(" ".join(sel))
        return 0
    for src in sources(cfg):
        sel, pts_in = select(cfg, src)
        print(src["dataset"], "nodes", len(sel), "points in ski box", pts_in,
              "max depth", max((int(k.split("-")[0]) for k in sel), default=-1))
        if not dry:
            with open(os.path.join(HERE, "resorts", src["nodes_file"]), "w") as f:
                f.write(" ".join(sel))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
