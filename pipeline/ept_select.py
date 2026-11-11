"""Select EPT lidar nodes over a resort for the manifest.

Usage: python pipeline/ept_select.py <slug> [--dry]

Reads pipeline/resorts/<slug>.json and, for the `lidar` source and each entry of `lidar.extra`, walks
ept-hierarchy on the public bucket and keeps every node with points that intersects the box: down to
`max_depth_resort` where the node touches the ski area (`lonlat_bbox`), `max_depth_outside` in the rest of the
buffered box (`utm_bbox`, in the config's `crs`). An extra source may carry its own `utm_bbox` to clip it to the
part the main dataset misses. Writes each source's `nodes_file` next to the config (not with --dry).

BUG-081: `lidar.far` ({"pad_m", "max_depth", "nodes_file"}) adds the far tree ring: the main source's nodes down to
`max_depth` in `utm_bbox` grown by `pad_m` on every side, less the nodes the main list already has. They go to
`ept_far/` (gen_manifest.py) and `far_trees.py` turns them into the trees drawn on the ridges round the resort."""
import copy, json, os, sys, urllib.request
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))


def node_box(bounds, key):
    d, x, y, _ = map(int, key.split("-")); s = (bounds[3] - bounds[0]) / 2 ** d
    return bounds[0] + x * s, bounds[1] + y * s, bounds[0] + (x + 1) * s, bounds[1] + (y + 1) * s


def hit(r, q): return r[0] < q[2] and r[2] > q[0] and r[1] < q[3] and r[3] > q[1]


def clip(a, b): return max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])


def sources(cfg):
    """The main lidar source and the extra ones, each a dict with ept, dataset, depths and nodes_file."""
    main = {k: v for k, v in cfg["lidar"].items() if k not in ("extra", "far")}
    return [main] + list(cfg["lidar"].get("extra", []))


def select(cfg, src, fetch_json=None, stats=None):
    """Node keys to download for one source, plus the point count over the ski area. `stats`, a dict, gets each
    selected node's point count ("points": {key: count}, used by resort.py plan to size the download)."""
    fetch_json = fetch_json or (lambda url: json.load(urllib.request.urlopen(url, timeout=60)))
    base = src["ept"] if src["ept"].endswith("/") else src["ept"] + "/"
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
    cache = {}

    def hier(key):
        if key not in cache: cache[key] = fetch_json(f"{base}ept-hierarchy/{key}.json")
        return cache[key]

    counts = dict(hier("0-0-0-0"))
    sel, pts_in, node_pts = [], 0, {}
    stack = ["0-0-0-0"]
    while stack:
        key = stack.pop()
        c = counts.get(key)
        if c is None: continue
        if c == -1:
            counts.update(hier(key)); c = counts[key]
        if c <= 0: continue
        r = node_box(b, key); d, x, y, z = map(int, key.split("-"))
        lim = deep if hit(r, inner) else shallow
        if not hit(r, out) or d > lim: continue
        sel.append(key)
        node_pts[key] = c
        if hit(r, inner): pts_in += c
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    stack.append(f"{d+1}-{2*x+dx}-{2*y+dy}-{2*z+dz}")
    if stats is not None:
        stats["points"] = node_pts
    return sel, pts_in


def far_box(cfg):
    """The far tree ring's outer box (config crs): `utm_bbox` grown by `lidar.far.pad_m`."""
    p = float(cfg["lidar"]["far"]["pad_m"]); x0, y0, x1, y1 = cfg["utm_bbox"]
    return [x0 - p, y0 - p, x1 + p, y1 + p]


def select_far(cfg, fetch_json=None, have=(), stats=None):
    """Node keys for the far tree ring (BUG-081): every node of the main source down to `lidar.far.max_depth` in
    the grown box, without the ones in `have` (the main list)."""
    c = copy.deepcopy(cfg); c["utm_bbox"] = far_box(cfg)
    src = {k: v for k, v in cfg["lidar"].items() if k not in ("extra", "far")}
    d = int(cfg["lidar"]["far"]["max_depth"]); src["max_depth_resort"] = src["max_depth_outside"] = d
    st = {}
    sel, _ = select(c, src, fetch_json, stats=st)
    have = set(have)
    out = [k for k in sel if k not in have]
    if stats is not None:
        stats["points"] = {k: st["points"][k] for k in out}
    return out


def main(argv):
    if not argv or argv[0].startswith("-"):
        print(__doc__); return 2
    slug, dry = argv[0], "--dry" in argv
    cfg = json.load(open(os.path.join(HERE, "resorts", f"{slug}.json"), encoding="utf-8"))
    for src in sources(cfg):
        sel, pts_in = select(cfg, src)
        print(src["dataset"], "nodes", len(sel), "points in ski box", pts_in,
              "max depth", max((int(k.split("-")[0]) for k in sel), default=-1))
        if not dry:
            with open(os.path.join(HERE, "resorts", src["nodes_file"]), "w") as f:
                f.write(" ".join(sel))
    far = cfg["lidar"].get("far")
    if far:
        have = open(os.path.join(HERE, "resorts", cfg["lidar"]["nodes_file"])).read().split()
        sel = select_far(cfg, have=have)
        print("far ring", far["pad_m"], "m: nodes", len(sel))
        if not dry:
            with open(os.path.join(HERE, "resorts", far["nodes_file"]), "w") as f:
                f.write(" ".join(sel))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
