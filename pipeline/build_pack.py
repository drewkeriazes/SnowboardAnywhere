#!/usr/bin/env python3
"""Build a resort pack from the raw downloads.

python3 pipeline/build_pack.py vail <raw_dir> <out_dir>

Steps
  1. DEM: mosaic the 1 m 3DEP chunks (F32 GeoTIFF, UTM) -> fine height set
  2. Mid ring: 10 m 3DEP export -> resampled to 16 m -> mid set
  3. Far ring: Mapterhorn z11 WebP tiles (Terrarium, Web Mercator) -> reprojected to a 128 m UTM grid -> far set
  4. Lidar: EPT LAZ nodes -> DSM (max per 2 m cell) -> canopy height model = DSM - DEM
  5. NAIP: 4-band 1 m -> NDVI, brightness -> canopy / aspen / rock / scree / meadow classes
  6. OSM: pistes, lifts (+pylons, stations), buildings, roads, water, peaks -> features.json
  7. Masks (2 m): rock, scree, groomed piste corridors, canopy cover; piste direction for the groomers
  8. Trees: crown detection on the CHM/NDVI, species 0..7 (species.py: LANDFIRE class, elevation, aspect,
     water, ridges, grey dead crowns); shrubs from LANDFIRE, streams, NAIP and forest edges; rocks on the rock mask
  9. Write the pack
"""
import json, math, os, sys, glob, time
import numpy as np
from PIL import Image
import tifffile
from scipy import ndimage
from pyproj import Transformer
from packwriter import (write_height_set, write_mask_set, write_instances, write_meta, write_features, decode_terrarium)
from piste_dir import piste_direction
from terrain_ao import sky_visibility
from moguls import run_mogul_score, slope_window, paint_field, paint_polygon
import species as spc
from species import evt_luts

HERE = os.path.dirname(os.path.abspath(__file__))
slug = sys.argv[1]
raw = sys.argv[2]
out = sys.argv[3]
cfg = json.load(open(os.path.join(HERE, "resorts", f"{slug}.json"), encoding="utf-8"))
manifest = json.load(open(os.path.join(HERE, "manifests", f"{slug}.json"), encoding="utf-8"))
os.makedirs(out, exist_ok=True)
T0 = time.time()
def log(*a):
    print(f"[{time.time()-T0:6.0f}s]", *a, flush=True)

OX, OY = cfg["origin"]
X0, Y0, X1, Y1 = cfg["utm_bbox"]           # UTM metres
W = X1 - X0; H = Y1 - Y0                   # 1 m grid size
crs = cfg["crs"]
to_ll = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
to_utm = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
merc_to_utm = Transformer.from_crs("EPSG:3857", crs, always_xy=True)

def read_tiff(path):
    return tifffile.imread(path)

# ------------------------------------------------------------------ 1. fine DEM (1 m)
log("DEM mosaic")
dem = np.full((H, W), np.nan, np.float32)   # row 0 = north
for it in manifest["items"]:
    if not it["path"].startswith("dem1m/"):
        continue
    p = os.path.join(raw, it["path"])
    if not os.path.exists(p):
        log("  missing", it["path"]); continue
    a = read_tiff(p).astype(np.float32)
    if a.ndim == 3: a = a[..., 0]
    a[a <= -9000] = np.nan
    bx0, by0, bx1, by1 = it["meta"]["bbox"]
    w, h = it["meta"]["size"]
    if a.shape != (h, w):
        log("  unexpected shape", it["path"], a.shape, (h, w))
        a = np.array(Image.fromarray(a).resize((w, h), Image.BILINEAR))
    c0 = int(bx0 - X0); r0 = int(Y1 - by1)
    dem[r0:r0 + h, c0:c0 + w] = a
void = np.isnan(dem)
log(f"  dem {dem.shape}, void {void.mean()*100:.2f}%, range {np.nanmin(dem):.0f}..{np.nanmax(dem):.0f}")
if void.any():
    # fill small voids by nearest neighbour
    idx = ndimage.distance_transform_edt(void, return_distances=False, return_indices=True)
    dem = dem[tuple(idx)]
dem_local = dem  # heights are absolute metres; x,y are local
fine_meta = write_height_set(out, "fine", dem, 1.0, X0 - OX, Y0 - OY)
log("  fine written", fine_meta["tilesX"], "x", fine_meta["tilesY"])

# ------------------------------------------------------------------ 2. mid (16 m from the 10 m export)
log("mid ring")
mid_items = [i for i in manifest["items"] if i["path"].startswith("dem10m/")]
mx0 = min(i["meta"]["bbox"][0] for i in mid_items); my0 = min(i["meta"]["bbox"][1] for i in mid_items)
mx1 = max(i["meta"]["bbox"][2] for i in mid_items); my1 = max(i["meta"]["bbox"][3] for i in mid_items)
MR = mid_items[0]["meta"]["res"]
mW = int(round((mx1 - mx0) / MR)); mH = int(round((my1 - my0) / MR))
m = np.full((mH, mW), np.nan, np.float32)
for it in mid_items:
    p = os.path.join(raw, it["path"])
    if not os.path.exists(p):
        log("  missing", it["path"]); continue
    a = read_tiff(p).astype(np.float32)
    if a.ndim == 3: a = a[..., 0]
    a[a <= -9000] = np.nan
    bx0, by0, bx1, by1 = it["meta"]["bbox"]; w, h = it["meta"]["size"]
    if a.shape != (h, w):
        a = np.array(Image.fromarray(a).resize((w, h), Image.BILINEAR))
    c0 = int(round((bx0 - mx0) / MR)); r0 = int(round((my1 - by1) / MR))
    m[r0:r0 + h, c0:c0 + w] = a
log(f"  mid {m.shape} at {MR} m, void {np.isnan(m).mean()*100:.2f}%")
# 10 m -> 16 m by resampling
n16 = int((mx1 - mx0) / 16)
m16 = np.array(Image.fromarray(np.nan_to_num(m, nan=np.nanmean(m))).resize((n16, n16), Image.BILINEAR), np.float32)
mid_meta = write_height_set(out, "mid", m16, 16.0, mx0 - OX, my0 - OY)

# ------------------------------------------------------------------ 3. far (128 m from Mapterhorn z11)
log("far ring")
far_size = cfg["far_ring"]["size_m"]
FR = 128.0
nf = int(far_size / FR)
fx0 = OX - far_size / 2; fy0 = OY - far_size / 2
# target grid centres in UTM -> lon/lat -> mercator tile pixel
xs = fx0 + (np.arange(nf) + 0.5) * FR
ys = fy0 + (np.arange(nf)[::-1] + 0.5) * FR   # row 0 = north
GX, GY = np.meshgrid(xs, ys)
lon, lat = to_ll.transform(GX, GY)
z = cfg["far_ring"]["mapterhorn_zoom"]; n = 2 ** z
px = (lon + 180) / 360 * n * 512
py = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / np.pi) / 2 * n * 512
far = np.full((nf, nf), np.nan, np.float32)
tiles = {}
for it in manifest["items"]:
    if it["path"].startswith("mapterhorn/"):
        p = os.path.join(raw, it["path"])
        if os.path.exists(p):
            tx, ty = os.path.basename(it["path"])[:-5].split("_")
            tiles[(int(tx), int(ty))] = decode_terrarium(np.array(Image.open(p).convert("RGB")))
tx = np.floor(px / 512).astype(int); ty = np.floor(py / 512).astype(int)
cx = np.clip((px - tx * 512).astype(int), 0, 511); cy = np.clip((py - ty * 512).astype(int), 0, 511)
for (ax, ay), arr in tiles.items():
    sel = (tx == ax) & (ty == ay)
    if sel.any():
        far[sel] = arr[cy[sel], cx[sel]]
log(f"  far coverage {np.isfinite(far).mean()*100:.1f}% from {len(tiles)} tiles")
far_meta = write_height_set(out, "far", far, FR, fx0 - OX, fy0 - OY)

# ------------------------------------------------------------------ 4. canopy height model from lidar
log("lidar -> DSM")
import laspy
R2 = 2.0
H2, W2 = H // 2, W // 2
dsm = np.full((H2, W2), -1e9, np.float32)
cnt = np.zeros((H2, W2), np.int32)
dtm_l = np.full((H2, W2), 1e9, np.float32)
n_pts = 0
ept = json.load(open(os.path.join(raw, "ept/ept.json"), encoding="utf-8"))
scale = None
for p in sorted(glob.glob(os.path.join(raw, "ept", "*.laz"))):
    try:
        las = laspy.read(p)
    except Exception as e:
        log("  bad laz", p, e); continue
    x = np.asarray(las.x); y = np.asarray(las.y); zz = np.asarray(las.z)
    cls = np.asarray(las.classification)
    # EPT is in EPSG:3857; convert to UTM
    ux, uy = merc_to_utm.transform(x, y)
    col = ((ux - X0) / R2).astype(int); row = ((Y1 - uy) / R2).astype(int)
    ok = (col >= 0) & (col < W2) & (row >= 0) & (row < H2) & (cls != 7) & (cls != 18)  # drop noise classes
    col, row, zz, cls = col[ok], row[ok], zz[ok], cls[ok]
    n_pts += len(zz)
    flat = row * W2 + col
    np.maximum.at(dsm.ravel(), flat, zz.astype(np.float32))
    np.add.at(cnt.ravel(), flat, 1)
    g = cls == 2
    if g.any():
        np.minimum.at(dtm_l.ravel(), flat[g], zz[g].astype(np.float32))
log(f"  {n_pts/1e6:.1f} M points, cells with data {np.mean(cnt>0)*100:.1f}%")
dsm[cnt == 0] = np.nan
# cells with a lidar return (dilated by one cell): canopy is only believed where the lidar actually saw something
has_pts = ndimage.binary_dilation(cnt > 0, iterations=1)
del cnt, dtm_l
# DEM at 2 m (mean of 2x2)
dem2 = dem[:H2 * 2, :W2 * 2].reshape(H2, 2, W2, 2).mean(axis=(1, 3)).astype(np.float32)
chm = dsm - dem2
del dsm
chm[np.isnan(chm)] = 0
chm = np.clip(chm, 0, 60).astype(np.float32)
# fill isolated empty cells from neighbours
chm = ndimage.grey_closing(chm, size=3)
log(f"  CHM: {np.mean(chm>2)*100:.1f}% of cells > 2 m, p99 {np.percentile(chm, 99):.1f} m")

# ------------------------------------------------------------------ 5. NAIP classes (1 m)
log("NAIP")
# The Planetary Computer crop endpoint capped every crop at 2048 px, so the crops are ~2 m.
# Work at the 2 m grid directly: resample each crop onto its bbox.
naip2 = np.zeros((4, H2, W2), np.uint8)
have2 = np.zeros((H2, W2), bool)
for it in manifest["items"]:
    if not it["path"].startswith("naip1m/"):
        continue
    p = os.path.join(raw, it["path"])
    if not os.path.exists(p):
        continue
    a = read_tiff(p)
    if a.ndim == 3 and a.shape[0] in (4, 5) and a.shape[0] < a.shape[2]:
        a = np.moveaxis(a, 0, -1)
    bx0, by0, bx1, by1 = it["meta"]["bbox"]
    w2 = int(round((bx1 - bx0) / R2)); h2 = int(round((by1 - by0) / R2))
    bands = np.stack([np.array(Image.fromarray(a[..., b]).resize((w2, h2), Image.BILINEAR)) for b in range(4)], axis=-1)
    c0 = int(round((bx0 - X0) / R2)); r0 = int(round((Y1 - by1) / R2))
    c0c, r0c = max(c0, 0), max(r0, 0)
    c1c, r1c = min(c0 + w2, W2), min(r0 + h2, H2)
    if c1c <= c0c or r1c <= r0c:
        continue
    sub = bands[r0c - r0:r1c - r0, c0c - c0:c1c - c0]
    valid = sub.sum(axis=-1) > 0
    dst = naip2[:, r0c:r1c, c0c:c1c]
    for b in range(4):
        dst[b][valid] = sub[..., b][valid]
    have2[r0c:r1c, c0c:c1c] |= valid
log(f"  NAIP coverage {have2.mean()*100:.1f}%")
red2 = naip2[0].astype(np.float32); grn2 = naip2[1].astype(np.float32); blu2 = naip2[2].astype(np.float32); nir2 = naip2[3].astype(np.float32)
del naip2
ndvi2 = ((nir2 - red2) / np.maximum(nir2 + red2, 1)).astype(np.float32)
bright2 = ((red2 + grn2 + blu2) / 3).astype(np.float32)

# slope at 2 m
gy, gx = np.gradient(dem2, R2)
slope2 = np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)
# gx, gy stay alive for the mogul aspect term (freed after scoring)

# classes
# canopy needs (a) height above ground AND (b) vegetation in NAIP AND (c) a lidar return nearby. (b) and (c)
# stop steep bare slopes above treeline reading as forest: the DSM is the max point in a 2 m cell and the DEM
# the mean, so a 35 deg slope alone gives > 2 m of "height", and grey_closing spread that into empty cells.
canopy = ((chm > 2.5) | ((ndvi2 > 0.45) & (chm > 1.2))) & (ndvi2 > 0.30) & has_pts & have2
del has_pts
# rock: low NDVI, GREY (low colour saturation), not snow. Late-summer NAIP shows cured meadow and
# groomed pistes as tan grass with NDVI < 0.18 too; saturation 0.22..0.42 for grass vs < 0.15 for rock
# (measured on the Vail 2023 imagery). Without the saturation test 25 % of the resort came out as rock.
snowfield = (bright2 > 215) & (ndvi2 < 0.1)
mx2 = np.maximum(np.maximum(red2, grn2), blu2); mn2 = np.minimum(np.minimum(red2, grn2), blu2)
sat2 = ((mx2 - mn2) / np.maximum(mx2, 1)).astype(np.float32)
del mx2, mn2
grey = sat2 < 0.20
rock = (ndvi2 < 0.18) & (bright2 > 60) & (bright2 < 215) & grey & have2 & (chm < 1.5)
meadow = (ndvi2 < 0.30) & ~grey & have2 & (chm < 1.5)   # cured grass; no trees, no rock
del sat2, red2, blu2
# very steep bare ground is rock whatever colour the imagery gives it (shadowed cliff bands read as dark, not grey)
rock_steep = (rock & (slope2 > 28)) | ((slope2 > 38) & (ndvi2 < 0.30) & (chm < 1.5) & have2)
scree = rock & (slope2 <= 28) & (slope2 > 12)
# R carries rock the imagery saw, nothing else (FEAT-020): full weight on steep bare ground, half on
# grey rock on gentler slopes, where winter snow covers most of it. The renderer adds rock from slope
# (> ~45 deg) and wind-scoured ridges itself and breaks the weight into crisp patches with noise; a
# slope-only ramp here put 0.3..0.6 rock on every 30..40 deg snow slope and read as a brown wash.
rock_w = rock_steep.astype(np.float32) + (rock & ~rock_steep).astype(np.float32) * 0.5
rock_w = np.clip(ndimage.gaussian_filter(rock_w, 0.75), 0, 1)
scree_w = np.clip(scree.astype(np.float32) * 0.8, 0, 1) * (1 - rock_w)
# aspen vs conifer: aspen is bright green and high NIR in summer; conifer darker
# aspen vs conifer from NAIP alone is approximate (no clean NIR split in the Sept 2023 imagery);
# these thresholds pick the brightest ~15 % of canopy. Replace with LANDFIRE EVT classes when raw/vail/landfire exists.
aspen_like = canopy & (ndvi2 > 0.50) & (grn2 > 68) & (nir2 > 135)
del grn2, nir2, snowfield, scree
log(f"  canopy {canopy.mean()*100:.1f}%  rock {rock.mean()*100:.1f}%  meadow {meadow.mean()*100:.1f}%  aspen-like {aspen_like.mean()*100:.1f}%")

# ------------------------------------------------------------------ 5b. LANDFIRE EVT (30 m) species, optional
# raw/<slug>/landfire/*.tif from fetch_landfire.mjs (LFPS, any LF version) + its .tif.vat.dbf class table.
# Classes are matched by NAME, not code: LF 2.4/2.5 renumbered EVT (aspen 3011 -> 7011).
def read_dbf(path):
    f = open(path, "rb").read()
    n = int.from_bytes(f[4:8], "little"); hl = int.from_bytes(f[8:10], "little"); rl = int.from_bytes(f[10:12], "little")
    fields, o = [], 32
    while f[o] != 0x0D:
        fields.append((f[o:o + 11].split(b"\0")[0].decode(), f[o + 16])); o += 32
    rows = []
    for i in range(n):
        rec = f[hl + i * rl + 1:hl + (i + 1) * rl]; p0 = 0; r = {}
        for nm, ln in fields:
            r[nm.upper()] = rec[p0:p0 + ln].decode("latin1").strip(); p0 += ln
        rows.append(r)
    return rows

evt = None
lf_tifs = sorted(glob.glob(os.path.join(raw, "landfire", "*.tif")))
if lf_tifs:
    lf = lf_tifs[-1]
    tfw = [float(v) for v in open(lf[:-4] + ".tfw").read().split()]
    evt_img = read_tiff(lf).astype(np.int32)
    if evt_img.ndim == 3:
        evt_img = evt_img[..., 0] if evt_img.shape[-1] < evt_img.shape[0] else evt_img[0]
    table = read_dbf(lf + ".vat.dbf") if os.path.exists(lf + ".vat.dbf") else []
    # per class (species.classify_evt, DATA-020): tree group, aspen fraction, forest (Tree life form, not
    # urban), alpine (turf, dwarf-shrubland, bedrock and scree, wet meadow), riparian, sagebrush, Gambel oak
    lut_n = int(evt_img.max()) + 1
    lut = evt_luts(table, lut_n)
    aspen_lut, forest_lut, alpine_lut, group_lut = lut["aspen"], lut["forest"], lut["alpine"], lut["group"]
    ex0, ey0, epx = tfw[4], tfw[5], tfw[0]   # top-left pixel centre and pixel size (m)
    def evt_at(x_utm, y_utm):
        c = np.clip(np.round((x_utm - ex0) / epx).astype(np.int64), 0, evt_img.shape[1] - 1)
        r = np.clip(np.round((ey0 - y_utm) / epx).astype(np.int64), 0, evt_img.shape[0] - 1)
        return evt_img[r, c]
    evt = evt_at
    # forest mask on the 2 m grid, for gating the synthetic fill trees
    gx2 = X0 + (np.arange(W2) + 0.5) * R2; gy2 = Y1 - (np.arange(H2) + 0.5) * R2
    cc = np.clip(np.round((gx2 - ex0) / epx).astype(np.int64), 0, evt_img.shape[1] - 1)
    rr_ = np.clip(np.round((ey0 - gy2) / epx).astype(np.int64), 0, evt_img.shape[0] - 1)
    evt2 = np.clip(evt_img[np.ix_(rr_, cc)], 0, lut_n - 1).astype(np.int16 if lut_n < 32768 else np.int32)
    lf_forest2 = forest_lut[evt2]
    lf_open2 = lut["open"][evt2]   # BUG-027: the fill-tree gate; developed and urban ground is not "open"
    del gx2, gy2, cc, rr_   # evt2 stays for the shrubs and the species debug map (stage 8)
    names = {int(float(r.get("VALUE", 0) or 0)): r.get("EVT_NAME", "") for r in table}
    vals, cnts = np.unique(evt_img, return_counts=True)
    top = sorted(zip(cnts, vals), reverse=True)[:5]
    log(f"  LANDFIRE {os.path.basename(lf)} {evt_img.shape}: " + ", ".join(f"{names.get(int(v), v)[:28]} {c/cnts.sum()*100:.0f}%" for c, v in top))
    log(f"  LANDFIRE forest on the 2 m grid {lf_forest2.mean()*100:.1f}%, open {lf_open2.mean()*100:.1f}%, aspen classes {sum(c for c, v in zip(cnts, vals) if aspen_lut[min(v, lut_n-1)] > 0)/cnts.sum()*100:.1f}%")
else:
    log("  no LANDFIRE clip (raw/<slug>/landfire/*.tif); species from elevation, aspect and NAIP colour (species.py fallback)")

# ------------------------------------------------------------------ 6. OSM features
log("OSM")
def load_osm(name):
    p = os.path.join(raw, "osm", f"{name}.json")
    if not os.path.exists(p):
        log("  missing osm", name); return {"elements": []}
    return json.load(open(p, encoding="utf-8"))
ski = load_osm("ski"); built = load_osm("built"); natural = load_osm("natural"); peaks_far = load_osm("peaks_far"); places_far = load_osm("places_far")

def to_local(lon, lat):
    x, y = to_utm.transform(lon, lat)
    return float(x - OX), float(y - OY)

def ground(xl, yl):
    """height from the 1 m DEM at local coords (fallback to mid)"""
    c = int(xl + OX - X0); r = int(Y1 - (yl + OY))
    if 0 <= c < W and 0 <= r < H:
        return float(dem[r, c])
    mc = int((xl + OX - mx0) / 16); mr = int((my1 - (yl + OY)) / 16)
    if 0 <= mc < n16 and 0 <= mr < n16:
        return float(m16[mr, mc])
    return float(cfg["elevation_range_m"][0])

def way_points(el):
    return [to_local(p["lon"], p["lat"]) for p in el.get("geometry", [])]

DIFF = {"novice": "novice", "easy": "easy", "intermediate": "intermediate", "advanced": "advanced", "expert": "expert", "freeride": "freeride", "extreme": "extreme"}
runs = []
piste_polys = []   # (points, difficulty, groomed, width)
for el in ski["elements"]:
    if el.get("type") != "way":
        continue
    t = el.get("tags", {})
    if t.get("piste:type") not in ("downhill", "nordic", "skitour", "sled", "snow_park"):
        continue
    pts = way_points(el)
    if len(pts) < 2:
        continue
    diff = DIFF.get(t.get("piste:difficulty", ""), None)
    grooming = t.get("piste:grooming")
    # groomed only where the map says so (piste:grooming); no guessing from difficulty, and mogul
    # runs are not corduroy. The game is 1:1 with real data: an untagged run stays ungroomed snow.
    groomed = grooming in ("classic", "classic+skating", "skating", "scooter")
    closed = pts[0] == pts[-1] and len(pts) > 3 and t.get("area") == "yes"
    rec = {"name": t.get("name") or t.get("piste:name"), "difficulty": diff, "groomed": bool(groomed),
           "gladed": t.get("piste:gladed") == "yes" or t.get("gladed") == "yes", "osmId": el["id"], "area": closed,
           "points": [[x, y, ground(x, y)] for x, y in pts]}
    if t.get("bridge", "no") != "no":
        rec["bridge"] = True   # bare-earth DEM has no bridge; the client builds a deck
    rec["mogulTag"] = grooming == "mogul"   # FEAT-059: popped before writing
    runs.append(rec)
log(f"  runs {len(runs)}")

# real grooming: the resort's own nightly reports (raw/<slug>/grooming/*.json from fetch_grooming.py).
# A run is groomed if the resort groomed it on any saved night (or OSM tags it groomed above).
# Names are compared with case, spaces and punctuation ignored; "Run - Section" also matches on the
# run ("Simba - Lower" in the report vs one "Simba" way in OSM) when the exact section is not in both.
# cfg["grooming_aliases"] maps report spellings to OSM ones ("mil creek road" -> "mill creek road").
import re as _re
def run_key(n):
    return _re.sub(r"[^a-z0-9]", "", (n or "").lower())
def run_base(n):
    return run_key((n or "").split(" - ")[0])
aliases = {run_key(a): run_key(b) for a, b in cfg.get("grooming_aliases", {}).items()}
groom_nights = {}       # report trail key -> nights groomed
base_nights = {}        # report run base -> nights any section was groomed
listed = set()          # every trail key the reports list, groomed or not
run_base_of = {}        # report trail key -> its run base
reports = sorted(glob.glob(os.path.join(raw, "grooming", "*.json")))
for fp in reports:
    for tr in json.load(open(fp, encoding="utf-8"))["trails"]:
        k = run_key(tr["name"]); k = aliases.get(k, k)
        b = run_base(tr["name"]); b = aliases.get(b, b)
        listed.add(k); run_base_of[k] = b
        groom_nights.setdefault(k, 0); base_nights.setdefault(b, 0)
        if tr["groomed"]:
            groom_nights[k] += 1; base_nights[b] += 1
if reports:
    reported = {k for k, c in groom_nights.items() if c > 0}
    matched = set()
    for r in runs:
        k, b = run_key(r["name"]), run_base(r["name"])
        if not k:
            continue
        if k in listed:                       # the report names this exact run or section
            nights = groom_nights.get(k, 0)
            if nights:
                matched.add(k)
        else:                                 # match on the run, any section
            nights = base_nights.get(b, 0)
            if nights:
                matched.update(x for x in reported if run_base_of.get(x) == b)
        if nights:
            r["groomed"] = True
            r["groomNights"] = nights
    log(f"  grooming reports {len(reports)}: {len(reported)} trails groomed on some night, "
        f"{len(matched)} matched to OSM runs; groomed runs now {sum(1 for r in runs if r['groomed'])}")
    missing = sorted(reported - matched)
    if missing:
        log(f"  groomed in reports but no OSM run of that name: {', '.join(missing[:40])}{' ...' if len(missing) > 40 else ''}")
else:
    log("  no grooming reports (raw/<slug>/grooming/*.json); groomed = OSM piste:grooming tags only")

# lifts: aerialway ways + pylon/station nodes
nodes_by_id = {el["id"]: el for el in ski["elements"] if el.get("type") == "node"}
lifts = []
for el in ski["elements"]:
    if el.get("type") != "way":
        continue
    t = el.get("tags", {})
    aw = t.get("aerialway")
    if not aw or aw in ("goods", "zip_line", "station", "pylon"):
        continue
    pts = way_points(el)
    if len(pts) < 2:
        continue
    towers = []
    for nid, p in zip(el.get("nodes", []), pts):
        nt = nodes_by_id.get(nid, {}).get("tags", {})
        if nt.get("aerialway") == "pylon":
            z = ground(*p)
            towers.append([p[0], p[1], z, 11.0 if aw in ("chair_lift", "gondola", "mixed_lift", "cable_car") else 7.0])
    lifts.append({"name": t.get("name"), "type": aw, "capacity": int(t["aerialway:capacity"]) if t.get("aerialway:capacity", "").isdigit() else None,
                  "stations": [[pts[0][0], pts[0][1], ground(*pts[0])], [pts[-1][0], pts[-1][1], ground(*pts[-1])]],
                  "towers": towers, "cable": [], "osmId": el["id"]})
log(f"  lifts {len(lifts)}")

buildings, roads, water = [], [], []
BIG_LODGE_M2 = 1500  # BUG-024: named buildings bigger than this get a lodge height when OSM has none


def polygon_area(pts):
    """Shoelace area of a closed ring of (x, y) metres."""
    return abs(sum(pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1] for i in range(len(pts) - 1))) / 2

for el in built["elements"]:
    if el.get("type") != "way":
        continue
    t = el.get("tags", {})
    pts = way_points(el)
    if "building" in t and len(pts) >= 4:
        zs = [ground(x, y) for x, y in pts]
        h = None
        h_default = False
        try:
            if "height" in t: h = float(t["height"].split()[0])
            elif "building:levels" in t: h = 3.2 * float(t["building:levels"])
        except ValueError:
            h = None
        if h is None:
            h = 9.0 if t.get("building") in ("hotel", "apartments", "commercial", "retail") else 5.5
            h_default = True
            # BUG-024: a big named lodge with no height or levels in OSM (Eagle's Nest) is 3 to 4 storeys
            if t.get("name") and polygon_area(pts) > BIG_LODGE_M2:
                h = 12.0
                h_default = False
        # BUG-024: the highest ground under the footprint too (corners and centre), so the client can put
        # the roof above the uphill side before any height tiles have loaded
        cx_, cy_ = sum(p[0] for p in pts[:-1]) / (len(pts) - 1), sum(p[1] for p in pts[:-1]) / (len(pts) - 1)
        z_hi = max(zs + [ground(cx_, cy_)])
        buildings.append({"name": t.get("name"), "points": [[x, y] for x, y in pts[:-1]], "zBase": float(min(zs)), "zMax": float(z_hi), "height": h, "heightDefault": h_default, "kind": t.get("building")})
    elif "highway" in t and len(pts) >= 2:
        kind = t["highway"]
        width = {"motorway": 24, "trunk": 14, "primary": 10, "secondary": 8, "tertiary": 7, "residential": 6, "service": 4, "track": 3, "path": 1.5, "footway": 1.5}.get(kind, 4)
        rec = {"name": t.get("name"), "kind": kind, "width": width, "points": [[x, y, ground(x, y)] for x, y in pts]}
        if t.get("bridge", "no") != "no":
            rec["bridge"] = True
        roads.append(rec)
for el in natural["elements"]:
    if el.get("type") == "way" and el.get("tags", {}).get("natural") == "water":
        pts = way_points(el)
        if len(pts) >= 4:
            water.append({"name": el["tags"].get("name"), "points": [[x, y] for x, y in pts[:-1]], "z": float(min(ground(x, y) for x, y in pts))})
# streams and rivers (DATA-020): fir and willow sit near water; not written to features.json
streams = [way_points(el) for el in natural["elements"]
           if el.get("type") == "way" and el.get("tags", {}).get("waterway") in ("stream", "river", "brook", "canal", "ditch")]
peaks = []
for el in peaks_far["elements"] + natural["elements"]:
    if el.get("type") == "node" and el.get("tags", {}).get("natural") == "peak" and el["tags"].get("name"):
        x, y = to_local(el["lon"], el["lat"])
        try:
            z = float(el["tags"].get("ele", "nan").split()[0].replace("m", ""))
        except ValueError:
            z = float("nan")
        if not math.isfinite(z):
            z = ground(x, y)
        peaks.append({"name": el["tags"]["name"], "x": x, "y": y, "z": z})
seen = set(); uniq = []
for p in peaks:
    k = (p["name"], round(p["x"] / 50), round(p["y"] / 50))
    if k not in seen:
        seen.add(k); uniq.append(p)
peaks = uniq
labels = [{"name": el["tags"]["name"], "kind": el["tags"].get("place", "place"), "x": to_local(el["lon"], el["lat"])[0], "y": to_local(el["lon"], el["lat"])[1], "z": 0}
          for el in places_far["elements"] if el.get("type") == "node" and el.get("tags", {}).get("place") and el["tags"].get("name")]
for l in labels:
    l["z"] = ground(l["x"], l["y"])
log(f"  buildings {len(buildings)} roads {len(roads)} water {len(water)} peaks {len(peaks)} labels {len(labels)}")
def line_cells(pts):
    """distinct 2 m grid cells along a polyline, as (rows, cols) index arrays, clipped to the grid"""
    cells = set()
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        steps = max(1, int(math.hypot(bx - ax, by - ay) / (R2 * 0.7)))
        for s_ in range(steps + 1):
            t = s_ / steps
            c = int((ax + (bx - ax) * t + OX - X0) / R2); r = int((Y1 - (ay + (by - ay) * t + OY)) / R2)
            if 0 <= r < H2 and 0 <= c < W2:
                cells.add((r, c))
    if not cells:
        return np.array([], int), np.array([], int)
    rc = np.array(sorted(cells))
    return rc[:, 0], rc[:, 1]


# ------------------------------------------------------------------ 6b. mogul score per run (FEAT-059)
# Grooming reports, difficulty, slope and aspect along the centre line, and lift-top traffic; see moguls.py.
report_nights = len(reports)
lift_tops = [(s[0], s[1]) for l in lifts for s in l["stations"]]
for r in runs:
    tag = r.pop("mogulTag", False)
    pts = [(p[0], p[1]) for p in r["points"]]
    rows, cols = line_cells(pts) if len(pts) >= 2 else (np.array([], int), np.array([], int))
    if len(rows):
        slope_med = float(np.percentile(slope2[rows, cols], 75))   # the steep pitch, not the run-out
        dx, dy = float(np.mean(-gx[rows, cols])), float(np.mean(gy[rows, cols]))   # downhill (row 0 = north)
        aspect = math.degrees(math.atan2(dx, dy)) % 360.0 if math.hypot(dx, dy) > 1e-4 else None
    else:
        slope_med, aspect = 0.0, None
    if report_nights:
        groom_frac = r.get("groomNights", 0) / report_nights
    else:
        groom_frac = None
    top = max(r["points"], key=lambda p: p[2])
    near_top = any(math.hypot(top[0] - lx, top[1] - ly) < 150.0 for lx, ly in lift_tops)
    r["mogulScore"] = round(run_mogul_score(r, slope_med, aspect, groom_frac, tag, near_top), 2)
del gx, gy
scored = sorted((r for r in runs if r["mogulScore"] > 0), key=lambda r: -r["mogulScore"])
log(f"  mogul runs: {sum(1 for r in runs if r['mogulScore'] >= 0.3)} of {len(runs)} score 0.3 or more; top: "
    + ", ".join(f"{r['name'] or 'unnamed'} {r['mogulScore']:.2f}" for r in scored[:15]))
write_features(out, {"lifts": lifts, "runs": runs, "buildings": buildings, "roads": roads, "water": water, "peaks": peaks, "labels": labels})
Z_MIN, Z_MAX = float(np.nanmin(dem)), float(np.nanmax(dem))
del dem   # 540 MB; everything from here works on the 2 m grid

# ------------------------------------------------------------------ 7. masks at 2 m
log("masks")
groomed = np.zeros((H2, W2), np.float32)
piste_any = np.zeros((H2, W2), bool)
def rasterize_corridor(target, pts, half_width, value=1.0):
    """paint a corridor along a polyline into a 2 m raster (row 0 = north)"""
    hw = max(1, int(half_width / R2))
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        length = math.hypot(bx - ax, by - ay)
        steps = max(1, int(length / (R2 * 0.7)))
        for s in range(steps + 1):
            t = s / steps
            x = ax + (bx - ax) * t; y = ay + (by - ay) * t
            c = int((x + OX - X0) / R2); r = int((Y1 - (y + OY)) / R2)
            r0, r1 = max(0, r - hw), min(H2, r + hw + 1); c0, c1 = max(0, c - hw), min(W2, c + hw + 1)
            if r1 <= r0 or c1 <= c0:
                continue
            rr, cc = np.ogrid[r0:r1, c0:c1]
            d2 = (rr - r) ** 2 + (cc - c) ** 2
            target[r0:r1, c0:c1] = np.maximum(target[r0:r1, c0:c1], np.where(d2 <= hw * hw, value, 0))


def centerlines(run_list):
    """1-pixel-wide centre lines of the given runs on the 2 m grid"""
    m = np.zeros((H2, W2), bool)
    for r in run_list:
        rows, cols = line_cells([(p[0], p[1]) for p in r["points"]])
        m[rows, cols] = True
    return m


def yield_to_ungroomed(groomed, run_list):
    """BUG-030: a groomed corridor only keeps the cells that are nearer a groomed run's centre line than
    a never-groomed run's, so the corridor painted around a groomer no longer spills corduroy onto the
    ungroomed run beside it. Logs the groomed share along each never-groomed run."""
    lines = [r for r in run_list if not r.get("area") and len(r["points"]) >= 2]
    never = [r for r in lines if not r["groomed"]]
    if not never or not any(r["groomed"] for r in lines):
        return groomed
    d_g = ndimage.distance_transform_edt(~centerlines([r for r in lines if r["groomed"]])).astype(np.float32)
    d_u = ndimage.distance_transform_edt(~centerlines(never)).astype(np.float32)
    before = never_groomed_share(groomed, never)
    cells_before = int((groomed > 0.5).sum())
    groomed = groomed * (d_g <= d_u)
    del d_g, d_u
    after = never_groomed_share(groomed, never)
    cells_after = int((groomed > 0.5).sum())
    log(f"  groomed area {cells_before * R2 * R2 / 1e4:.1f} ha -> {cells_after * R2 * R2 / 1e4:.1f} ha "
        f"({(cells_before - cells_after) / max(1, cells_before) * 100:.1f}% handed to never-groomed runs)")
    if after:
        log(f"  never-groomed runs: mean groomed share along the line {np.mean(list(before.values()))*100:.1f}% -> {np.mean(list(after.values()))*100:.1f}% ({len(after)} runs)")
        worst = sorted(after.items(), key=lambda kv: -kv[1])[:8]
        log("  most groomed never-groomed runs: " + ", ".join(f"{k} {v*100:.0f}%" for k, v in worst))
    return groomed


def never_groomed_share(groomed, never):
    """share of each never-groomed run's centre-line cells that are groomed (> 0.5), by run name"""
    out = {}
    for i, r in enumerate(never):
        rows, cols = line_cells([(p[0], p[1]) for p in r["points"]])
        if len(rows):
            out[r.get("name") or f"unnamed {i}"] = float((groomed[rows, cols] > 0.5).mean())
    return out




piste_f = np.zeros((H2, W2), np.float32)
for run in runs:
    if run.get("area"):
        continue
    pts = [(p[0], p[1]) for p in run["points"]]
    hw = {"novice": 22, "easy": 20, "intermediate": 18, "advanced": 14, "expert": 10}.get(run["difficulty"] or "", 12)
    rasterize_corridor(piste_f, pts, hw)
    if run["groomed"]:
        rasterize_corridor(groomed, pts, hw)
groomed = yield_to_ungroomed(groomed, runs)
piste_any = piste_f > 0
del piste_f
# built-up: roads and building footprints are grey in NAIP and were classified as rock (I-70, the villages)
built_f = np.zeros((H2, W2), np.float32)
for rd in roads:
    rasterize_corridor(built_f, [(p[0], p[1]) for p in rd["points"]], 8 if rd.get("kind") in ("motorway", "trunk", "primary") else 4)
for b in buildings:
    rasterize_corridor(built_f, [(p[0], p[1]) for p in b["points"]], 6)
built_any = built_f > 0
del built_f
rock_w = rock_w * (~built_any).astype(np.float32)
scree_w = scree_w * (~built_any).astype(np.float32)
log(f"  built-up {built_any.mean()*100:.1f}% removed from rock/scree")
# a groomed corridor is only groomed where there is no canopy (the actual cleared trail)
groomed *= (~canopy).astype(np.float32)
groomed = ndimage.gaussian_filter(groomed, 1.0)
canopy_cover = ndimage.uniform_filter(canopy.astype(np.float32), 5)
rgba = np.stack([rock_w * 255, scree_w * 255, np.clip(groomed, 0, 1) * 255, canopy_cover * 255], axis=-1).astype(np.uint8)
mask_meta = write_mask_set(out, rgba, R2, X0 - OX, Y0 - OY)
del rgba
# piste direction (DATA-002): the groomed runs' axis per cell, for corduroy that follows the run
dir_meta = write_mask_set(out, piste_direction(runs, groomed, R2, X0 - OX, Y1 - OY, log=log), R2, X0 - OX, Y0 - OY, kind="dir", pad=0)
# baked sky visibility (FEAT-047): gullies, couloirs, cirques and cliff feet darken; same grid as the mask.
# A light blur first so 1 m DEM noise does not speckle the tangent plane.
log("  terrain AO")
ao = sky_visibility(ndimage.gaussian_filter(dem2, 1.0), R2, log=log)
log(f"  ao mean {ao.mean():.3f}, p5 {np.percentile(ao, 5):.3f}")
ao_meta = write_mask_set(out, (np.clip(ao, 0, 1) * 255 + 0.5).astype(np.uint8), R2, X0 - OX, Y0 - OY, kind="ao")
del ao

# mogul amplitude (FEAT-059): each scoring run's corridor, fading over the outer 3 m, times the slope
# window; none under canopy, on groomed corduroy, built-up ground or rock. 0..1 m in the greyscale set.
log("  moguls")
mog = np.zeros((H2, W2), np.float32)
for run in runs:
    sc = run.get("mogulScore", 0.0)
    if sc <= 0.05 or len(run["points"]) < 2:
        continue
    pts = [(p[0], p[1]) for p in run["points"]]
    if run.get("area"):
        paint_polygon(mog, pts, sc, R2, X0 - OX, Y1 - OY)
    else:
        hw = {"novice": 22, "easy": 20, "intermediate": 18, "advanced": 14, "expert": 10}.get(run["difficulty"] or "", 12)
        paint_field(mog, pts, hw - 2, sc, R2, X0 - OX, Y1 - OY)
mog *= slope_window(slope2) * (~canopy).astype(np.float32) * (1 - np.clip(groomed, 0, 1)) * (~built_any).astype(np.float32) * (1 - rock_w) * (1 - scree_w)
mog = np.clip(mog, 0, 1)
cells = mog > 0.05
log(f"  mogul fields {cells.sum() * R2 * R2 / 1e4:.1f} ha, mean amplitude {mog[cells].mean() if cells.any() else 0:.2f} m")
mog_meta = write_mask_set(out, (mog * 255 + 0.5).astype(np.uint8), R2, X0 - OX, Y0 - OY, kind="moguls", pad=0)
del mog, cells

# ------------------------------------------------------------------ 8. trees and rocks
log("trees")
# crown detection: local maxima of the smoothed CHM, window scaled with height
chm_s = ndimage.gaussian_filter(chm, 0.8)
maxf = ndimage.maximum_filter(chm_s, size=3)
peaks_mask = (chm_s == maxf) & (chm_s > 2.5) & canopy
pr, pc = np.nonzero(peaks_mask)
# thin: keep one per 2 cells where crowns are dense
tree_rows, tree_cols, tree_h = [pr], [pc], [chm_s[pr, pc]]
# fill: under continuous canopy the lidar subsample under-detects individual stems, so add jittered
# fill trees where canopy is present but no detected crown within 4 m
rng = np.random.default_rng(3)
occupied = np.zeros((H2, W2), bool); occupied[pr, pc] = True
occupied = ndimage.binary_dilation(occupied, iterations=2)
# fill density is the main lever on tree count: 0.33 gave 5.26 M trees at Vail (realistic stems, too many to render)
fill = canopy & ~occupied & (rng.uniform(0, 1, (H2, W2)) < 0.10)
if evt is not None:
    # BUG-027: no synthetic fill trees on truly open LANDFIRE classes (meadow, grassland, shrubland, rock, water).
    # Forest, urban forest and developed ground keep them where the canopy says so: Vail's in-resort stands are
    # mapped Urban Evergreen Forest and Developed-Low / Medium. Lidar-detected crowns stay everywhere.
    fill &= ~lf_open2
    del lf_open2
fr, fc = np.nonzero(fill)
tree_rows.append(fr); tree_cols.append(fc); tree_h.append(np.maximum(chm_s[fr, fc], 3.0) * rng.uniform(0.75, 1.0, len(fr)))
rows = np.concatenate(tree_rows); cols = np.concatenate(tree_cols); hgt = np.concatenate(tree_h).astype(np.float32)
# snags (DATA-020, species 7): grey standing dead crowns. Live canopy needs NDVI > 0.30, so the crowns above
# never include them: local CHM maxima over 6 m with NDVI < 0.15 inside forest, off buildings, lifts and cliffs,
# the greyest kept up to 3 % of all trees.
lift_f = np.zeros((H2, W2), np.float32)
for l in lifts:
    (ax_, ay_, _), (bx_, by_, _) = l["stations"]
    rasterize_corridor(lift_f, [(ax_, ay_), (bx_, by_)], 8)            # towers and chairs read as tall grey points
    for sx_, sy_ in ((ax_, ay_), (bx_, by_)):
        rasterize_corridor(lift_f, [(sx_, sy_), (sx_, sy_)], 25)       # terminals
forest_here = lf_forest2 if evt is not None else ndimage.binary_dilation(canopy, iterations=5)
snag_c = ((chm_s == maxf) & (chm_s > 6.0) & (ndvi2 < 0.15) & have2 & forest_here & (slope2 < 40)
          & ~built_any & ~rock_steep & (lift_f == 0))
del lift_f, forest_here
sr, sc = np.nonzero(snag_c)
del snag_c
keep = spc.cap_snags(ndvi2[sr, sc], len(rows))
log(f"  snag candidates {len(sr)}, kept {len(keep)}")
sr, sc = sr[keep], sc[keep]
is_snag = np.concatenate([np.zeros(len(rows), bool), np.ones(len(sr), bool)])
rows = np.concatenate([rows, sr]); cols = np.concatenate([cols, sc]); hgt = np.concatenate([hgt, chm_s[sr, sc]]).astype(np.float32)
jx = rng.uniform(-0.9, 0.9, len(rows)); jy = rng.uniform(-0.9, 0.9, len(rows))
tx = X0 + (cols + 0.5) * R2 + jx - OX
ty = Y1 - (rows + 0.5) * R2 + jy - OY
tz = dem2[rows, cols].astype(np.float32)
elev = tz
chm_at = chm_s[rows, cols]        # measured canopy height (0 in lidar gaps), before the fill-tree floor
# terrain for the species rules: aspect, crests and valleys, distance to OSM streams
north2, east2, tpi_s2, tpi_l2 = spc.terrain_fields(dem2, R2)
sdist2 = spc.stream_distance(streams, R2, X0 - OX, Y1 - OY, H2, W2)
log(f"  streams {len(streams)}, cells within 25 m {np.mean(sdist2 < 25) * 100:.1f}%")
northeast = (north2[rows, cols] + east2[rows, cols]) / math.sqrt(2)
wet = np.clip(1 - (sdist2[rows, cols] - 30) / 70, 0, 1)
ridge = (tpi_s2[rows, cols] > 1.5) & (tpi_l2[rows, cols] > 15)
n_t = len(rows)
if evt is not None:
    # sample the class 0..15 m off each tree so 30 m pixel edges become ragged stand boundaries
    ang = rng.uniform(0, 2 * np.pi, n_t); rad = rng.uniform(0, 15, n_t)
    v = np.clip(evt(tx + OX + np.cos(ang) * rad, ty + OY + np.sin(ang) * rad), 0, lut_n - 1)
    group, a_frac, alpine = group_lut[v], aspen_lut[v], alpine_lut[v]
    wet = np.maximum(wet, lut["riparian"][v].astype(np.float64))
    # inside aspen classes: aspen with that probability; elsewhere keep small NAIP-detected groves at 50 %
    roll = rng.uniform(0, 1, n_t)
    del v, ang, rad
else:
    group = np.zeros(n_t, np.int8); a_frac = np.zeros(n_t, np.float32); alpine = np.zeros(n_t, bool); roll = np.ones(n_t)
# krummholz (BUG-025) stays: only a tree the lidar measured as short (1 to 4 m) near treeline or in an alpine
# LANDFIRE class. Colorado treeline is about 3,500 to 3,600 m; subalpine spruce-fir at Vail is tall right
# up to the summits, so elevation alone never makes a tree krummholz, and no lidar height is capped.
species = spc.assign_species(tx, ty, elev, chm_at, group, a_frac, alpine, aspen_like[rows, cols], northeast, wet, ridge, roll, evt is not None)
species[is_snag] = spc.SNAG
crown = spc.crown_radius(species, hgt)
trees = np.stack([tx, ty, tz, hgt, crown, species.astype(np.float32)], axis=1).astype(np.float32)
CELL = 1000.0
cells_x = int(math.ceil(W / CELL)); cells_y = int(math.ceil(H / CELL))
inst = {"cellSize": CELL, "minX": X0 - OX, "minY": Y0 - OY, "cellsX": cells_x, "cellsY": cells_y}
inst["treeCount"] = write_instances(out, "trees", trees, CELL, X0 - OX, Y0 - OY, cells_x, cells_y)
cnt = np.bincount(species.astype(np.int64), minlength=8)
log(f"  trees {inst['treeCount']}: " + ", ".join(f"{spc.SPECIES_NAMES[i]} {cnt[i]} ({cnt[i] / n_t * 100:.1f}%)" for i in range(8)))
lp = species == spc.LODGEPOLE
log(f"  spruce + fir {(cnt[spc.SPRUCE] + cnt[spc.FIR]) / n_t * 100:.1f}%, lodgepole below 3,100 m {np.mean(elev[lp] < 3100) * 100 if lp.any() else 0:.0f}%, "
    f"krummholz above 3,350 m {np.mean(elev[species == spc.KRUMMHOLZ] > 3350) * 100 if cnt[spc.KRUMMHOLZ] else 0:.0f}%, snags {cnt[spc.SNAG] / n_t * 100:.1f}%, "
    f"median height above 3,350 m {np.median(hgt[elev > 3350]) if (elev > 3350).any() else 0:.1f} m")
for line in spc.band_report(species, elev):
    log("   ", line)
os.makedirs(os.path.join(out, "debug"), exist_ok=True)
spc.debug_png(os.path.join(out, "debug", "species.png"), tx, ty, species, group_lut[evt2] if evt is not None else None, X0 - OX, Y1 - OY, W, H)
log("  debug/species.png: species per 10 m (left), LANDFIRE group (right)")
del northeast, wet, ridge, group, a_frac, alpine, roll, trees, crown, is_snag

# shrubs (DATA-020): willow on creek bottoms, juniper in spruce-fir gaps and on open south crests, sagebrush and
# Gambel oak in their LANDFIRE classes, young conifers along forest edges; density from NAIP NDVI where there is
# no canopy, at most 200 per hectare. Records x, y, z, height, radius, kind.
log("shrubs")
base_ok = have2 & ~built_any & (rock_w < 0.3) & (groomed < 0.3) & (ndvi2 > 0.05) & (slope2 < 40)
open_ = base_ok & ~canopy
low = base_ok & (chm < 4.0)                   # willow carr is short canopy, so it may read as canopy
near_stream = sdist2 < 25
valley = (tpi_l2 < -3) & (slope2 < 20)
south_ridge = (north2 < -0.5) & (tpi_s2 > 0.5) & (dem2 > 2700) & (dem2 < 3600)
del sdist2, tpi_l2, north2, east2, tpi_s2
gap_edge = ndimage.binary_dilation(canopy, iterations=6)            # within 12 m of canopy
edge_band = ndimage.binary_dilation(canopy, iterations=3) & (chm < 6.0)
if evt is not None:
    g2 = group_lut[evt2]
    riparian = lut["riparian"][evt2]; sage = lut["sage"][evt2]; oak = lut["oak"][evt2]
    spruce_fir = g2 == spc.G_SPRUCE_FIR
    conifer = lf_forest2 & (g2 != spc.G_ASPEN)
    del g2
else:
    riparian = sage = oak = np.zeros((H2, W2), bool)
    spruce_fir = dem2 > 2900
    conifer = dem2 > 2700
p_sh = spc.shrub_probabilities(R2, open_, ndvi2, near_stream, valley, riparian, spruce_fir, gap_edge, south_ridge, sage, oak,
                               edge_band & conifer, low=low)
del base_ok, open_, low, near_stream, valley, south_ridge, gap_edge, edge_band, riparian, sage, oak, spruce_fir, conifer
shrubs = spc.sample_shrubs(p_sh, R2, X0 - OX, Y1 - OY, dem2, np.random.default_rng(20))
del p_sh
inst["shrubCount"] = write_instances(out, "shrubs", shrubs, CELL, X0 - OX, Y0 - OY, cells_x, cells_y)
kc = np.bincount(shrubs[:, 5].astype(np.int64), minlength=len(spc.SHRUB_NAMES))
log(f"  shrubs {inst['shrubCount']}: " + ", ".join(f"{spc.SHRUB_NAMES[i]} {kc[i]}" for i in range(len(kc)))
    + f"; densest 100 m cell {spc.peak_density(shrubs, 100.0):.0f} / ha")
del shrubs

log("rocks")
rr, rc = np.nonzero(rock_steep | (rock & (slope2 > 20)))
pick = rng.uniform(0, 1, len(rr)) < 0.06
rr, rc = rr[pick], rc[pick]
rx = X0 + (rc + rng.uniform(0, 1, len(rc))) * R2 - OX; ry = Y1 - (rr + rng.uniform(0, 1, len(rr))) * R2 - OY
rz = dem2[rr, rc]
size = (rng.gamma(2.5, 0.9, len(rr)) + 0.6).astype(np.float32)
rtype = np.where(slope2[rr, rc] > 35, 0, rng.integers(1, 3, len(rr))).astype(np.float32)
rocks = np.stack([rx, ry, rz, size, rng.uniform(0, 6.283, len(rr)), rtype], axis=1).astype(np.float32)
inst["rockCount"] = write_instances(out, "rocks", rocks, CELL, X0 - OX, Y0 - OY, cells_x, cells_y)
log(f"  rocks {inst['rockCount']}")

# ------------------------------------------------------------------ 9. meta
lon_c, lat_c = to_ll.transform(OX, OY)
# start: on a named groomed run (cfg["start_run"], default: the longest groomed intermediate), 15 m below
# its highest point and facing down the run. A lift top station lands the rider in the trees.
def run_length(r):
    pts = r["points"]
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1))
# spawn choice only (not surface data): any green or blue run, groomed or not
cands = [r for r in runs if not r.get("area") and (r["groomed"] or r["difficulty"] in ("novice", "easy", "intermediate")) and len(r["points"]) >= 2]
want = cfg.get("start_run")
named = [r for r in cands if want and r["name"] == want]
if named:
    seg = max(named, key=lambda r: max(p[2] for p in r["points"]))
else:
    inter = [r for r in cands if r["difficulty"] == "intermediate" and r["name"]] or cands
    seg = max(inter, key=run_length) if inter else None
start = {"x": 0.0, "y": 0.0, "heading": 0.0}
if seg is not None:
    pts = seg["points"]
    if pts[0][2] < pts[-1][2]:
        pts = pts[::-1]            # make it run downhill
    (x0, y0, _), (x1, y1, _) = pts[0], pts[1]
    dx, dy = x1 - x0, y1 - y0
    d = math.hypot(dx, dy) or 1.0
    ux, uy = dx / d, dy / d
    start = {"x": x0 + ux * 15.0, "y": y0 + uy * 15.0, "heading": math.atan2(ux, uy), "run": seg["name"]}
    log(f"  start on {seg['name']} ({seg['difficulty']}) at {start['x']:.0f}, {start['y']:.0f}")
meta = {"version": 1, "slug": slug, "name": cfg["name"], "crs": crs, "origin": [OX, OY], "lonlat": [lon_c, lat_c],
        "bounds": {"minX": X0 - OX, "minY": Y0 - OY, "maxX": X1 - OX, "maxY": Y1 - OY},
        "zRange": [float(np.floor(Z_MIN / 100) * 100 - 100), float(np.ceil(Z_MAX / 100) * 100 + 100)],
        "terrain": {"fine": fine_meta, "mid": mid_meta, "far": far_meta}, "mask": mask_meta, "ao": ao_meta, "dir": dir_meta, "moguls": mog_meta, "instances": inst, "treeSpecies": spc.TREE_SPECIES_VERSION,
        "start": start, "sun": {"azimuth": 160, "elevation": 30}, "attribution": cfg["attribution"]}
write_meta(out, meta)

# ------------------------------------------------------------------ 10. forest cover levels for the far terrain (FEAT-153)
log("cover")
from cover import build_cover
meta["cover"] = build_cover(out, raw, cfg, log=log)
if any(lv["name"] in ("mid", "far") for lv in meta["cover"]["levels"]):   # DATA-019 land cover
    from cover import ATTRIBUTION as COVER_ATTRIBUTION
    meta["attribution"] = meta["attribution"] + [a for a in COVER_ATTRIBUTION if a not in meta["attribution"]]
write_meta(out, meta)
log("done")
