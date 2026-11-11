#!/usr/bin/env python3
"""Generate the download manifest for a resort.

Reads pipeline/resorts/<slug>.json and writes pipeline/manifests/<slug>.json, a flat
list of {url, path, method?, body?} items that fetch.ps1 downloads on the PC.

Sources:
  - USGS 3DEP ImageServer exportImage  -> 1 m DEM chunks (F32 GeoTIFF, UTM) + 10 m mid ring
  - Microsoft Planetary Computer       -> NAIP 4-band 1 m crops per quarter-quad (GeoTIFF, UTM)
  - Mapterhorn                         -> z11 Terrarium WebP tiles for the far ring
  - AWS usgs-lidar-public (EPT)        -> selected LAZ nodes (pre-selected node list)
  - Overpass                           -> OSM features (pistes, lifts, buildings, roads, natural, peaks)
"""
import json, math, sys, os
from urllib.parse import urlencode, quote
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
slug = sys.argv[1] if len(sys.argv) > 1 else "vail"
cfg = json.load(open(os.path.join(HERE, "resorts", f"{slug}.json")))
crs = cfg["crs"]
to_utm = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
to_ll = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

items = []
def add(url, path, **kw):
    items.append({"url": url, "path": path.replace("\\", "/"), **kw})

# ---------------------------------------------------------------- 1 m DEM chunks
x0, y0, x1, y1 = cfg["utm_bbox"]
res = cfg["dem"]["res_m"]; chunk = cfg["dem"]["chunk_px"]
EXPORT = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?"
epsg = crs.split(":")[1]
def export_url(bx0, by0, bx1, by1, w, h):
    return EXPORT + urlencode({
        "bbox": f"{bx0},{by0},{bx1},{by1}", "bboxSR": epsg, "imageSR": epsg,
        "size": f"{w},{h}", "format": "tiff", "pixelType": "F32", "noData": "-9999",
        "interpolation": "RSP_BilinearInterpolation", "f": "image"})

nx = math.ceil((x1 - x0) / (chunk * res)); ny = math.ceil((y1 - y0) / (chunk * res))
for j in range(ny):
    for i in range(nx):
        bx0 = x0 + i * chunk * res; by0 = y0 + j * chunk * res
        bx1 = min(bx0 + chunk * res, x1); by1 = min(by0 + chunk * res, y1)
        w = int(round((bx1 - bx0) / res)); h = int(round((by1 - by0) / res))
        add(export_url(bx0, by0, bx1, by1, w, h), f"dem1m/dem_{i}_{j}.tif",
            meta={"bbox": [bx0, by0, bx1, by1], "size": [w, h], "res": res})

# ---------------------------------------------------------------- 10 m mid ring
ox, oy = cfg["origin"]; S = cfg["mid_ring"]["size_m"]; r = cfg["mid_ring"]["res_m"]
mx0, my0 = ox - S / 2, oy - S / 2; mx1, my1 = ox + S / 2, oy + S / 2
# Split into 2x2 chunks: the ImageServer returns HTTP 500 for single exports much above ~1500 px of
# full-resolution data. Processing mosaics dem10m/mid_{i}_{j}.tif back together (rasterio.merge).
half = S / 2
for j in range(2):
    for i in range(2):
        bx0 = mx0 + i * half; by0 = my0 + j * half; bx1 = bx0 + half; by1 = by0 + half
        n = int(half / r)
        add(export_url(bx0, by0, bx1, by1, n, n), f"dem10m/mid_{i}_{j}.tif", meta={"bbox": [bx0, by0, bx1, by1], "size": [n, n], "res": r})

# ---------------------------------------------------------------- NAIP crops
CROP = "https://planetarycomputer.microsoft.com/api/data/v1/item/crop/"
nres = cfg["naip"]["res_m"]; maxpx = cfg["naip"]["max_px"]
for item, (ilon0, ilat0, ilon1, ilat1) in cfg["naip"]["item_bboxes_ll"].items():
    # item footprint in UTM (inner box to avoid nodata edges)
    cs = [to_utm.transform(lo, la) for lo, la in [(ilon0, ilat0), (ilon1, ilat0), (ilon1, ilat1), (ilon0, ilat1)]]
    xs = [c[0] for c in cs]; ys = [c[1] for c in cs]
    ix0 = max(sorted(xs)[1], x0); ix1 = min(sorted(xs)[2], x1)
    iy0 = max(sorted(ys)[1], y0); iy1 = min(sorted(ys)[2], y1)
    if ix1 - ix0 < 50 or iy1 - iy0 < 50:
        continue
    # snap to the 1 m grid
    ix0 = math.floor(ix0); iy0 = math.floor(iy0); ix1 = math.ceil(ix1); iy1 = math.ceil(iy1)
    cx = math.ceil((ix1 - ix0) / (maxpx * nres)); cy = math.ceil((iy1 - iy0) / (maxpx * nres))
    for j in range(cy):
        for i in range(cx):
            bx0 = ix0 + i * maxpx * nres; by0 = iy0 + j * maxpx * nres
            bx1 = min(bx0 + maxpx * nres, ix1); by1 = min(by0 + maxpx * nres, iy1)
            w = int(round((bx1 - bx0) / nres)); h = int(round((by1 - by0) / nres))
            q = urlencode({"collection": "naip", "item": item, "assets": "image", "asset_bidx": "image|1,2,3,4",
                           "coord_crs": crs, "dst_crs": crs, "resampling": "average", "max_size": str(maxpx)})
            add(f"{CROP}{bx0},{by0},{bx1},{by1}/{w}x{h}.tif?{q}", f"naip1m/{item}_{i}_{j}.tif",
                meta={"bbox": [bx0, by0, bx1, by1], "size": [w, h], "res": nres, "item": item})

# ---------------------------------------------------------------- Mapterhorn far ring
z = cfg["far_ring"]["mapterhorn_zoom"]; F = cfg["far_ring"]["size_m"]
def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    xt = (lon + 180) / 360 * n
    yt = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return xt, yt
fl = [to_ll.transform(ox - F / 2, oy - F / 2), to_ll.transform(ox + F / 2, oy + F / 2)]
tx0, ty1 = lonlat_to_tile(fl[0][0], fl[0][1], z); tx1, ty0 = lonlat_to_tile(fl[1][0], fl[1][1], z)
for ty in range(int(math.floor(ty0)), int(math.floor(ty1)) + 1):
    for tx in range(int(math.floor(tx0)), int(math.floor(tx1)) + 1):
        add(f"https://tiles.mapterhorn.com/{z}/{tx}/{ty}.webp", f"mapterhorn/{z}/{tx}_{ty}.webp")

# ---------------------------------------------------------------- Lidar EPT nodes
# The main source goes to ept/, each of cfg["lidar"]["extra"] (a second dataset over the part the first one
# misses, e.g. Big Sky's east strip) to ept/<dataset>/: node keys repeat between datasets.
for k_src, src in enumerate([cfg["lidar"]] + list(cfg["lidar"].get("extra", []))):
    ept = src["ept"]; sub = "ept" if k_src == 0 else f"ept/{src['dataset']}"
    add(ept + "ept.json", f"{sub}/ept.json")
    nodes = open(os.path.join(HERE, "resorts", src["nodes_file"])).read().split()
    # DATA-011: the deep tier (ept_select.py --deep), deeper nodes round chosen spots, beside the main ones
    deep = os.path.join(HERE, "resorts", src.get("deep_nodes_file", ""))
    if src.get("deep_nodes_file") and os.path.exists(deep):
        nodes += open(deep).read().split()
    for k in nodes:
        add(f"{ept}ept-data/{k}.laz", f"{sub}/{k}.laz")

# ---------------------------------------------------------------- Overpass
lon0, lat0, lon1, lat1 = cfg["lonlat_bbox"]
pad = 0.015  # ~1.3 km
bb = f"{lat0 - pad},{lon0 - pad},{lat1 + pad},{lon1 + pad}"
def ov(q): return "[out:json][timeout:180][maxsize:536870912];" + q + "out geom;"
queries = {
    "ski": ov(f'(way["piste:type"]({bb});relation["piste:type"]({bb});way["aerialway"]({bb});node["aerialway"]({bb});way["landuse"="winter_sports"]({bb}););'),
    "built": ov(f'(way["building"]({bb});relation["building"]({bb});way["highway"]({bb});way["man_made"]({bb});node["man_made"]({bb});way["amenity"]({bb});node["amenity"]({bb});node["tourism"]({bb});way["tourism"]({bb});way["parking"]({bb});way["amenity"="parking"]({bb}););'),
    "natural": ov(f'(way["natural"]({bb});relation["natural"]({bb});way["landuse"]({bb});relation["landuse"]({bb});way["waterway"]({bb});relation["waterway"]({bb});node["natural"="peak"]({bb});node["natural"="saddle"]({bb}););'),
}
# peaks over a wide area for the horizon
far = [to_ll.transform(ox - F / 2, oy - F / 2), to_ll.transform(ox + F / 2, oy + F / 2)]
fbb = f"{far[0][1]},{far[0][0]},{far[1][1]},{far[1][0]}"
# Two light queries instead of one heavy one: the far box is ~200 km across and the combined
# peaks+places scan was timing out (502/504) on every Overpass host.
queries["peaks_far"] = "[out:json][timeout:300][maxsize:536870912];" + f'node["natural"="peak"]["ele"]({fbb});' + "out;"
# places_far (towns for horizon labels) dropped for now: optional, and it queued for minutes on every host.
# DATA-019: downhill pistes of every resort in view (Beaver Creek, Copper, Breckenridge, ...), burned into the
# far land cover as cleared strips. One box cfg["landcover"]["pistes_km"] wide, geometry out.
lc = cfg.get("landcover", {})
pk = lc.get("pistes_km", 140) * 500.0
wide = [to_ll.transform(ox - pk, oy - pk), to_ll.transform(ox + pk, oy + pk)]
wbb = f"{wide[0][1]},{wide[0][0]},{wide[1][1]},{wide[1][0]}"
queries["pistes_wide"] = ov(f'(way["piste:type"="downhill"]({wbb});relation["piste:type"="downhill"]({wbb}););')
for name, q in queries.items():
    # GET rather than POST: .NET's POST sends "Expect: 100-continue", which Overpass rejects
    enc = quote(q, safe="")
    add("https://overpass-api.de/api/interpreter?data=" + enc, f"osm/{name}.json",
        alts=["https://overpass.private.coffee/api/interpreter?data=" + enc,   # kumi.systems removed: 502/504 on every try
              "https://lz4.overpass-api.de/api/interpreter?data=" + enc])

# ---------------------------------------------------------------- land cover for the far terrain (DATA-019)
# ESA WorldCover 2021 v200 (10 m classes, AWS open data) and the ETH Global Sentinel-2 canopy height 2020
# (10 m, ETH libdrive), whole 3 x 3 degree COG tiles (80 to 290 MB each) over the far ring, named by their
# south-west corner. cover.py reads only the windows it needs.
WC = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{t}_Map.tif"
ETH = "https://libdrive.ethz.ch/index.php/s/cO8or7iOe5dT2Rt/download?path=%2F3deg_cogs&files=ETH_GlobalCanopyHeight_10m_2020_{t}_Map.tif"
if lc.get("enabled", True):
    cs = [to_ll.transform(ox + sx * F / 2, oy + sy * F / 2) for sx in (-1, 1) for sy in (-1, 1)]
    lo0, lo1 = min(c[0] for c in cs), max(c[0] for c in cs); la0, la1 = min(c[1] for c in cs), max(c[1] for c in cs)
    for la in range(int(math.floor(la0 / 3) * 3), int(math.floor(la1 / 3) * 3) + 1, 3):
        for lo in range(int(math.floor(lo0 / 3) * 3), int(math.floor(lo1 / 3) * 3) + 1, 3):
            t = f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"
            ll = {"sw": [lo, la], "deg": 3}
            add(WC.format(t=t), f"landcover/worldcover/{t}.tif", meta=ll)
            add(ETH.format(t=t), f"landcover/eth_canopy/{t}.tif", meta=ll)

os.makedirs(os.path.join(HERE, "manifests"), exist_ok=True)
out = os.path.join(HERE, "manifests", f"{slug}.json")
json.dump({"slug": slug, "items": items}, open(out, "w"))
from collections import Counter
c = Counter(i["path"].split("/")[0] for i in items)
print(f"wrote {out}: {len(items)} items", dict(c))
