"""Select EPT lidar nodes over a resort for the manifest.

Usage: python pipeline/ept_select.py <dataset> <depth_in_ski_area> <depth_in_buffer> [out.txt]
Boxes are hard-coded below for Breckenridge; edit OUT / IN for another resort (TODO: read from the resort config).
Walks ept-hierarchy on the public bucket and keeps every node with points that intersects the box."""
from pyproj import Transformer
ds, deep, shallow = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
BASE = f"https://s3-us-west-2.amazonaws.com/usgs-lidar-public/{ds}/"
ept = json.load(urllib.request.urlopen(BASE + "ept.json", timeout=30))
b = ept["bounds"]; srs = ept["srs"].get("horizontal", "3857")
to = Transformer.from_crs("EPSG:26913", f"EPSG:{srs}", always_xy=True)
def box(x0, y0, x1, y1):
    pts = [to.transform(x, y) for x in (x0, x1) for y in (y0, y1)]
    return min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)
OUT = box(401900, 4364800, 412000, 4375300)          # utm_bbox incl. 1 km buffer
llto = Transformer.from_crs("EPSG:4326", f"EPSG:{srs}", always_xy=True)
p0 = llto.transform(-106.128, 39.438); p1 = llto.transform(-106.036, 39.512)
IN = (p0[0], p0[1], p1[0], p1[1])                      # ski area
def nb(key):
    d, x, y, z = map(int, key.split("-")); s = (b[3] - b[0]) / 2 ** d
    return b[0] + x * s, b[1] + y * s, b[0] + (x + 1) * s, b[1] + (y + 1) * s
def hit(r, q): return r[0] < q[2] and r[2] > q[0] and r[1] < q[3] and r[3] > q[1]
cache = {}
def hier(key):
    if key not in cache: cache[key] = json.load(urllib.request.urlopen(f"{BASE}ept-hierarchy/{key}.json", timeout=60))
    return cache[key]
counts = dict(hier("0-0-0-0"))
sel, pts_in = [], 0
def walk(key):
    global pts_in
    c = counts.get(key)
    if c is None: return
    if c == -1:
        counts.update(hier(key)); c = counts[key]
    if c <= 0: return
    r = nb(key); d = int(key.split("-")[0])
    lim = deep if hit(r, IN) else shallow
    if not hit(r, OUT) or d > lim: return
    sel.append(key)
    if hit(r, IN): pts_in += c
    _, x, y, z = map(int, key.split("-"))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                walk(f"{d+1}-{2*x+dx}-{2*y+dy}-{2*z+dz}")
walk("0-0-0-0")
print(ds, "nodes", len(sel), "points in ski box", pts_in, "max depth", max(int(k.split('-')[0]) for k in sel))
if len(sys.argv) > 4: open(sys.argv[4], "w").write(" ".join(sel))
