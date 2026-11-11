"""FEAT-175 step 1: a scorecard per pack, line by line on the DATA-022 new-resort checklist (#439).

    python pipeline/pack_report.py packs/<slug> [--raw <raw_dir>] [--config <resorts/slug.json>] [--gate]

Writes `report.json` and `report.md` into the pack and prints the markdown. Each checklist line gets a status:
pass, warn (works, but worth a look), fail, or skip (cannot tell from what it was given; pass --raw for the
raw-data lines). The pack is **playable** when no MVP line (F and 1 to 14) is fail or skip (EPIC-15 rule 2);
`publish_pack.py` reads that. `--gate` exits 1 when it is not.

Reads only the pack, the resort config, the raw folder when given (file presence, no decoding), and the hand
content in this repo (`docs/compare/<slug>/`, `game/public/attract/<slug>/`, `game/src/world/Landmarks.ts`,
`game/src/resorts.ts`). About a minute on Vail. The numbers it measures, besides the checklist:
- surface: rock share (mask R at least half), canopy share, canopy left on run centre lines (trail cuts should
  be near 0), groomed share;
- trees: crowns + stems per km2 over the bounds and per 100 m elevation band, crowns and stems on lift lines,
  trees per hectare within 100 m of each compare spot (DATA-022 item 14's measure);
- runs: the steepest 30 m pitch of each run against its OSM difficulty (The Slot kind of outlier);
- the start: on snow, on a run, clear of trees.
"""
import argparse
import datetime
import glob
import json
import math
import os
import re
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canopy_spots import run_half_width  # noqa: E402
from packwriter import FORMAT_VERSION, decode_terrarium  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT_VERSION = 1
PASS, WARN, FAIL, SKIP = "pass", "warn", "fail", "skip"
ICON = {PASS: "✅", WARN: "⚠️", FAIL: "❌", SKIP: "➖"}

# Vail, the resort everything was tuned on, measured by this script on the published vail-v1 pack (build
# 20261111T145558Z-c2847e, main deee9a9). Other packs are compared against it; `--against <report.json>` swaps it.
REFERENCE = {
    "slug": "vail", "build": "20261111T145558Z-c2847e",
    "treesPerKm2": 39201, "rockShare": 0.0111, "canopyShare": 0.6633, "runCanopy": 0.0371,
}

HEIGHT_STEP = 8           # heights read every 8th sample (8 m) for band areas and the void count
BAND_M = 100.0            # elevation band for the tree density table
MIN_BAND_KM2 = 0.25       # smaller bands are left out of the table
SPOT_RADIUS = 100.0       # DATA-022 item 14: trees per hectare within 100 m of a compare spot
LIFT_CLEAR_M = 5.0        # a crown this close to a lift line is in the way
PITCH_M = 30.0            # run pitch window
START_CLEAR_M = 3.0       # a crown edge this close to the start is in the way
START_STAND_MAX = 0.25    # a stem chance over this round the start is in the way
TREE_RATIO_WARN = (0.5, 2.0)   # trees per km2 against the reference outside this: worth a look
ROCK_RATIO_WARN = 3.0          # rock share over this times the reference: worth a look
RUN_CANOPY_WARN = 0.15         # canopy left on run centre lines over this: trail cuts missing
AERIAL = {"chair_lift", "gondola", "cable_car", "mixed_lift", "drag_lift", "t-bar", "j-bar", "platter", "rope_tow"}
DIFFICULTY_EASY = {"novice", "easy"}
DIFFICULTY_HARD = {"advanced", "expert", "extreme", "freeride"}
EASY_PITCH_MAX = 30.0     # an easy run with a 30 m pitch steeper than this is mislabelled or mapped wrong
HARD_PITCH_MIN = 15.0     # an advanced or harder run never steeper than this likewise


# ------------------------------------------------------------------ reading the pack

def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def files_of(pack_dir, sub, pattern="*"):
    return sorted(glob.glob(os.path.join(pack_dir, sub, pattern)))


def grid_top(m):
    """y of the north edge of a tile set's padded row 0"""
    return m["minY"] + m["tilesY"] * m["tileSize"] * m["res"]


def read_heights(pack_dir, m, set_name="fine", step=HEIGHT_STEP):
    """every `step`th sample of a height set on its padded grid (NaN where void or missing), and the share of the
    full-resolution samples that are void, per tile, as {(tx, ty): share}"""
    n = m["tileSize"]
    k = n // step
    out = np.full((m["tilesY"] * k, m["tilesX"] * k), np.nan, np.float32)
    void = {}
    for ty in range(m["tilesY"]):
        for tx in range(m["tilesX"]):
            p = os.path.join(pack_dir, set_name, f"{tx}_{ty}.png")
            if not os.path.isfile(p):
                continue
            h = decode_terrarium(np.asarray(Image.open(p).convert("RGB")))
            void[(tx, ty)] = float(np.isnan(h).mean())
            r0 = (m["tilesY"] - 1 - ty) * k
            out[r0:r0 + k, tx * k:(tx + 1) * k] = h[::step, ::step]
    return out, void


def read_mask(pack_dir, m, kind="mask"):
    """an RGBA tile set as one uint8 array on its padded grid, row 0 = north; 0 where missing"""
    n = m["tileSize"]
    arr = None
    for ty in range(m["tilesY"]):
        for tx in range(m["tilesX"]):
            p = os.path.join(pack_dir, kind, f"{tx}_{ty}.png")
            if not os.path.isfile(p):
                continue
            px = np.asarray(Image.open(p).convert("RGBA"))
            if arr is None:
                arr = np.zeros((m["tilesY"] * n, m["tilesX"] * n) + px.shape[2:], np.uint8)
            r0 = (m["tilesY"] - 1 - ty) * n
            arr[r0:r0 + n, tx * n:(tx + 1) * n] = px
    return arr


def cell_centres(m, shape, step=1):
    """x of each column and y of each row of a padded grid read every `step` samples"""
    res = m["res"] * step
    xs = m["minX"] + (np.arange(shape[1]) + 0.5) * res
    ys = grid_top(m) - (np.arange(shape[0]) + 0.5) * res
    return xs, ys


def in_bounds(bounds, xs, ys):
    """(rows, cols) boolean window of a grid inside the pack bounds"""
    return ((ys >= bounds["minY"]) & (ys < bounds["maxY"]))[:, None] & ((xs >= bounds["minX"]) & (xs < bounds["maxX"]))[None, :]


def sample(arr, m, x, y):
    """the grid value at local (x, y), None off the grid; x, y may be arrays (then off-grid samples are 0)"""
    res = m["res"]
    c = np.floor((np.asarray(x) - m["minX"]) / res).astype(int)
    r = np.floor((grid_top(m) - np.asarray(y)) / res).astype(int)
    ok = (r >= 0) & (r < arr.shape[0]) & (c >= 0) & (c < arr.shape[1])
    if np.ndim(ok) == 0:
        return arr[r, c] if ok else None
    out = np.zeros(np.shape(ok) + arr.shape[2:], arr.dtype)
    out[ok] = arr[r[ok], c[ok]]
    return out


def read_instances(pack_dir, sub):
    fs = files_of(pack_dir, sub, "*.bin")
    if not fs:
        return np.zeros((0, 6), np.float32)
    return np.concatenate([np.fromfile(p, "<f4").reshape(-1, 6) for p in fs])


def read_stands(pack_dir, meta):
    """every stand cell with a stem chance as (x, y, z, chance) columns, or None without stands"""
    st = meta.get("stands")
    if not st:
        return None
    import stands
    inst, res = meta["instances"], st["res"]
    parts = []
    for cx, cy, p, _h, _sp, z in stands.read_all(pack_dir, meta):
        r, c = np.nonzero(p > 0)
        if not len(r):
            continue
        size = p.shape[0]
        x = inst["minX"] + cx * inst["cellSize"] + (c + 0.5) * res
        y = inst["minY"] + cy * inst["cellSize"] + (size - r - 0.5) * res
        parts.append(np.stack([x, y, z[r, c], p[r, c]], 1).astype(np.float32))
    return np.concatenate(parts) if parts else np.zeros((0, 4), np.float32)


# ------------------------------------------------------------------ measures (pure, tested)

def polyline_length(pts):
    p = np.asarray(pts, np.float64)
    return float(np.hypot(*np.diff(p[:, :2], axis=0).T).sum()) if len(p) > 1 else 0.0


def resample(pts, spacing):
    """points every `spacing` m along a polyline (x, y[, z]), both ends included"""
    p = np.asarray(pts, np.float64)
    if len(p) < 2:
        return p
    d = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p[:, :2], axis=0).T))])
    if d[-1] <= 0:
        return p[:1]
    s = np.append(np.arange(0, d[-1], spacing), d[-1])
    return np.stack([np.interp(s, d, p[:, i]) for i in range(p.shape[1])], 1)


def steepest_pitch(pts, window=PITCH_M):
    """steepest slope (degrees) over any `window` m of a run's centre line, from its point heights"""
    p = resample(pts, 2.0)
    if len(p) < 2 or p.shape[1] < 3:
        return 0.0
    d = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p[:, :2], axis=0).T))])
    if d[-1] < window:
        return math.degrees(math.atan2(abs(p[0, 2] - p[-1, 2]), max(d[-1], 1e-6)))
    j = np.searchsorted(d, d + window)
    ok = j < len(d)
    i = np.flatnonzero(ok)
    dz = np.abs(p[j[ok], 2] - p[i, 2])
    return float(np.degrees(np.arctan2(dz, d[j[ok]] - d[i])).max()) if len(i) else 0.0


def course_candidates(runs, min_length=300.0, min_drop=60.0):
    """named line runs long and steep enough for a time trial on their own (sim/Courses.ts MIN_LENGTH, MIN_DROP;
    the client also chains segments of one name, so this is a lower bound)"""
    out = []
    for r in runs:
        if not r.get("name") or r.get("area") or len(r["points"]) < 2:
            continue
        zs = [q[2] for q in r["points"]]
        if polyline_length(r["points"]) >= min_length and max(zs) - min(zs) >= min_drop:
            out.append(r["name"])
    return sorted(set(out))


def density_by_band(z_area, cell_km2, crowns_z, stems_z, stems_w, band=BAND_M, min_km2=MIN_BAND_KM2):
    """trees per km2 by elevation band: rows of (band floor, area km2, crowns, stems, per km2). `z_area` are the
    ground heights of equal cells of `cell_km2` each over the area, stems weighted by their chance"""
    z_area = z_area[np.isfinite(z_area)]
    if not len(z_area):
        return []
    lo = math.floor(z_area.min() / band) * band
    nb = int((z_area.max() - lo) // band) + 1
    idx = lambda z: np.clip(((np.asarray(z) - lo) // band).astype(int), 0, nb - 1)
    area = np.bincount(idx(z_area), minlength=nb) * cell_km2
    crowns = np.bincount(idx(crowns_z), minlength=nb) if len(crowns_z) else np.zeros(nb)
    stems = np.bincount(idx(stems_z), weights=stems_w, minlength=nb) if len(stems_z) else np.zeros(nb)
    rows = []
    for b in range(nb):
        if area[b] >= min_km2:
            rows.append({"z": lo + b * band, "areaKm2": round(float(area[b]), 2), "crowns": int(crowns[b]),
                         "stems": int(round(stems[b])), "perKm2": int(round((crowns[b] + stems[b]) / area[b]))})
    return rows


def trees_per_ha(trees, stand_pts, x, y, radius=SPOT_RADIUS):
    """crowns plus the summed stem chance within `radius` of (x, y), per hectare of the disc"""
    r2 = radius * radius
    n = float((((trees[:, 0] - x) ** 2 + (trees[:, 1] - y) ** 2) <= r2).sum()) if len(trees) else 0.0
    if stand_pts is not None and len(stand_pts):
        near = ((stand_pts[:, 0] - x) ** 2 + (stand_pts[:, 1] - y) ** 2) <= r2
        n += float(stand_pts[near, 3].sum())
    return n / (math.pi * r2 / 1e4)


def near_polyline(px, py, pts, dist):
    """boolean per point: within `dist` of the polyline (2D)"""
    p = np.asarray(pts, np.float64)[:, :2]
    hit = np.zeros(len(px), bool)
    for a, b in zip(p[:-1], p[1:]):
        lo, hi = np.minimum(a, b) - dist, np.maximum(a, b) + dist
        box = (px >= lo[0]) & (px <= hi[0]) & (py >= lo[1]) & (py <= hi[1])
        if not box.any():
            continue
        ab = b - a
        L2 = float(ab @ ab) or 1e-9
        qx, qy = px[box] - a[0], py[box] - a[1]
        t = np.clip((qx * ab[0] + qy * ab[1]) / L2, 0, 1)
        d2 = (qx - t * ab[0]) ** 2 + (qy - t * ab[1]) ** 2
        hit[np.flatnonzero(box)[d2 <= dist * dist]] = True
    return hit


def distance_to_polyline(x, y, pts):
    p = np.asarray(pts, np.float64)[:, :2]
    best = math.inf
    for a, b in zip(p[:-1], p[1:]):
        ab = b - a
        L2 = float(ab @ ab) or 1e-9
        t = min(1.0, max(0.0, ((x - a[0]) * ab[0] + (y - a[1]) * ab[1]) / L2))
        best = min(best, math.hypot(x - a[0] - t * ab[0], y - a[1] - t * ab[1]))
    return best


def point_in_polygon(x, y, pts):
    inside, p = False, [(q[0], q[1]) for q in pts]
    for (x1, y1), (x2, y2) in zip(p, p[1:] + p[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def gate(lines):
    """(playable, ids of the MVP lines that hold it back)"""
    bad = [ln["id"] for ln in lines if ln["mvp"] and ln["status"] in (FAIL, SKIP)]
    return not bad, bad


# ------------------------------------------------------------------ the report

class Report:
    def __init__(self, pack_dir, cfg, raw=None, repo=REPO, reference=None):
        self.pack = pack_dir
        self.meta = load_json(os.path.join(pack_dir, "meta.json"))
        fpath = os.path.join(pack_dir, "features.json")
        self.features = load_json(fpath) if os.path.isfile(fpath) else {}
        self.cfg, self.raw, self.repo = cfg, raw, repo
        self.ref = reference or REFERENCE
        self.slug = self.meta["slug"]
        self.lines, self.numbers = [], {}
        self.bands, self.spots, self.layers, self.outliers = [], [], [], {}

    def line(self, id_, item, status, detail, mvp=True):
        self.lines.append({"id": id_, "item": item, "status": status, "detail": detail, "mvp": mvp})

    def raw_has(self, *parts, pattern="*"):
        p = os.path.join(self.raw, *parts)
        return bool(glob.glob(os.path.join(p, pattern))) if os.path.isdir(p) else os.path.isfile(p)

    # -------------------------------------------------------------- measuring
    def measure(self):
        meta, b = self.meta, self.meta["bounds"]
        self.area_km2 = (b["maxX"] - b["minX"]) * (b["maxY"] - b["minY"]) / 1e6
        self.numbers["areaKm2"] = round(self.area_km2, 1)
        self.runs = self.features.get("runs", [])
        self.lifts = self.features.get("lifts", [])

        # heights
        fine = meta.get("terrain", {}).get("fine")
        self.heights, self.void = (None, {})
        if fine:
            self.heights, self.void = read_heights(self.pack, fine)
            xs, ys = cell_centres(fine, self.heights.shape, HEIGHT_STEP)
            inside = in_bounds(b, xs, ys)
            h = self.heights[inside]
            self.numbers["voidShare"] = round(float(np.isnan(h).mean()), 4) if h.size else 1.0
            ok = h[np.isfinite(h)]
            if len(ok):
                self.numbers["zMin"], self.numbers["zMax"] = round(float(ok.min())), round(float(ok.max()))
            self.z_area = h
            self.cell_km2 = (fine["res"] * HEIGHT_STEP) ** 2 / 1e6

        # surface
        self.mask = None
        if meta.get("mask"):
            m = meta["mask"]
            self.mask = read_mask(self.pack, m)
            if self.mask is not None:
                xs, ys = cell_centres(m, self.mask.shape)
                inside = in_bounds(b, xs, ys)
                cells = self.mask[inside]
                self.numbers["rockShare"] = round(float((cells[:, 0] >= 128).mean()), 4)
                self.numbers["screeShare"] = round(float((cells[:, 1] >= 128).mean()), 4)
                self.numbers["groomedShare"] = round(float((cells[:, 2] >= 128).mean()), 4)
                self.numbers["canopyShare"] = round(float(cells[:, 3].mean() / 255), 4)
                del cells
                pts = [resample(r["points"], 4.0) for r in self.runs
                       if not r.get("area") and not r.get("gladed") and len(r["points"]) > 1]
                if pts:
                    p = np.concatenate(pts)
                    a = sample(self.mask[..., 3], m, p[:, 0], p[:, 1])
                    self.numbers["runCanopy"] = round(float(a.mean() / 255), 4)

        # trees
        self.trees = read_instances(self.pack, "trees")
        self.stand_pts = read_stands(self.pack, meta)
        stems = int(meta.get("stands", {}).get("stems", 0))
        crowns = int(meta.get("instances", {}).get("treeCount", len(self.trees)))
        self.numbers["crowns"], self.numbers["stems"] = crowns, stems
        self.numbers["treesPerKm2"] = int(round((crowns + stems) / self.area_km2)) if self.area_km2 else 0
        self.numbers["shrubs"] = int(meta.get("instances", {}).get("shrubCount", 0))
        self.numbers["rocks"] = int(meta.get("instances", {}).get("rockCount", 0))
        self.numbers["farTrees"] = int(meta.get("instances", {}).get("farTreeCount", 0))
        if len(self.trees):
            sp = np.bincount(self.trees[:, 5].astype(int), minlength=8)
            self.numbers["speciesShare"] = {str(i): round(float(v / sp.sum()), 3) for i, v in enumerate(sp) if v}
        if self.heights is not None:
            sz = self.stand_pts[:, 2] if self.stand_pts is not None else np.zeros(0)
            sw = self.stand_pts[:, 3] if self.stand_pts is not None else np.zeros(0)
            self.bands = density_by_band(self.z_area, self.cell_km2, self.trees[:, 2] if len(self.trees) else np.zeros(0), sz, sw)

        # lift lines
        lines = [l for l in self.lifts if len(l.get("stations", [])) > 1 and (l.get("type") in AERIAL or not l.get("type"))]
        if lines and len(self.trees):
            per_lift = []
            total_km = 0.0
            hits = 0
            for l in lines:
                km = polyline_length(l["stations"]) / 1000
                n = int(near_polyline(self.trees[:, 0], self.trees[:, 1], l["stations"], LIFT_CLEAR_M).sum())
                total_km += km
                hits += n
                per_lift.append((n, l.get("name") or "unnamed"))
            self.numbers["liftLineKm"] = round(total_km, 1)
            self.numbers["liftLineCrownsPerKm"] = round(hits / total_km, 1) if total_km else 0
            self.outliers["liftsWithTrees"] = [f"{nm} ({n})" for n, nm in sorted(per_lift, reverse=True)[:5] if n]
            if self.stand_pts is not None and len(self.stand_pts):
                w = 0.0
                for l in lines:
                    near = near_polyline(self.stand_pts[:, 0], self.stand_pts[:, 1], l["stations"], LIFT_CLEAR_M)
                    w += float(self.stand_pts[near, 3].sum())
                self.numbers["liftLineStemsPerKm"] = round(w / total_km, 1) if total_km else 0

        # runs: pitch against difficulty, grooming, moguls
        easy_steep, hard_flat = [], []
        for r in self.runs:
            if r.get("area") or len(r["points"]) < 2 or len(r["points"][0]) < 3:
                continue
            pitch = steepest_pitch(r["points"])
            d = r.get("difficulty")
            if d in DIFFICULTY_EASY and pitch > EASY_PITCH_MAX:
                easy_steep.append((pitch, r.get("name") or "unnamed", d))
            elif d in DIFFICULTY_HARD and pitch < HARD_PITCH_MIN and polyline_length(r["points"]) > 150:
                hard_flat.append((pitch, r.get("name") or "unnamed", d))
        self.outliers["easyButSteep"] = [f"{nm} ({d}, {p:.0f} deg)" for p, nm, d in sorted(easy_steep, reverse=True)]
        self.outliers["hardButFlat"] = [f"{nm} ({d}, {p:.0f} deg)" for p, nm, d in sorted(hard_flat)]
        if self.runs:
            self.numbers["runs"] = len(self.runs)
            self.numbers["runsGroomReported"] = round(sum(1 for r in self.runs if r.get("groomNights")) / len(self.runs), 3)
            self.numbers["runsOsmGroomed"] = round(sum(1 for r in self.runs if r.get("groomed")) / len(self.runs), 3)
            mog = {}
            for r in self.runs:
                if "mogulScore" in r:
                    mog.setdefault(r.get("difficulty") or "none", []).append(r["mogulScore"])
            self.numbers["mogulScoreByDifficulty"] = {k: round(float(np.mean(v)), 2) for k, v in sorted(mog.items())}

        # compare spots
        for p in sorted(glob.glob(os.path.join(self.repo, "docs", "compare", self.slug, "*", "spot.json"))):
            g = load_json(p).get("game", {})
            if "x" in g:
                self.spots.append({"spot": os.path.basename(os.path.dirname(p)),
                                   "treesPerHa": round(trees_per_ha(self.trees, self.stand_pts, float(g["x"]), float(g["y"])))})

        # layers on disk
        for name, sub, key in [("fine heights", "fine", "terrain.fine"), ("mid heights", "mid", "terrain.mid"),
                               ("far heights", "far", "terrain.far"), ("mask", "mask", "mask"), ("AO", "ao", "ao"),
                               ("piste directions", "dir", "dir"), ("moguls", "moguls", "moguls"),
                               ("cover", "cover", "cover"), ("trees (crowns)", "trees", "instances.treeCells"),
                               ("stands (stems)", "stands", "stands"), ("far tree ring", "farTrees", "instances.farTreeCells"),
                               ("shrubs", "shrubs", "instances.shrubCells"), ("rocks", "rocks", "instances.rockCells")]:
            fs = files_of(self.pack, sub)
            v = meta
            for k in key.split("."):
                v = v.get(k) if isinstance(v, dict) else None
            newest = max((os.path.getmtime(f) for f in fs), default=0)
            self.layers.append({"layer": name, "inMeta": bool(v), "files": len(fs),
                                "mb": round(sum(os.path.getsize(f) for f in fs) / 1e6, 1),
                                # zips from publish_pack carry 1980 timestamps; those say nothing
                                "modified": (datetime.datetime.fromtimestamp(newest, datetime.timezone.utc).strftime("%Y-%m-%d")
                                             if newest > 631152000 else None)})

    # -------------------------------------------------------------- the checklist
    def check(self):
        meta, cfg, n, raw = self.meta, self.cfg, self.numbers, self.raw
        layer = {l["layer"]: l for l in self.layers}
        have = lambda name: layer[name]["inMeta"] and layer[name]["files"] > 0
        attribution = " ".join(meta.get("attribution", []))
        fmt = meta.get("formatVersion", 0)

        self.line("F", "Pack format current", PASS if fmt == FORMAT_VERSION else FAIL,
                  f"formatVersion {fmt}" + ("" if fmt == FORMAT_VERSION else f", the pipeline writes {FORMAT_VERSION}: rebuild"))

        # 1 config
        if not cfg:
            self.line("1", "Resort config", FAIL, f"no resorts/{self.slug}.json")
        else:
            need = ["crs", "utm_zone", "utm_bbox", "origin", "elevation_range_m", "naip", "lidar", "attribution"]
            missing = [k for k in need if k not in cfg]
            bad = []
            if cfg.get("crs") and cfg["crs"] != meta.get("crs"):
                bad.append(f"crs {cfg['crs']} vs pack {meta.get('crs')}")
            if cfg.get("origin") and list(cfg["origin"]) != list(meta.get("origin", [])):
                bad.append("origin differs from the pack's")
            st = FAIL if missing or bad else (PASS if cfg.get("start_run") else WARN)
            self.line("1", "Resort config", st, "; ".join(
                [f"missing {', '.join(missing)}" if missing else f"{cfg.get('crs')} ({cfg.get('utm_zone')})"] + bad +
                ([] if cfg.get("start_run") else ["no start_run"])))

        # 2 raw core data
        if raw:
            need = {"1 m DEM": ("dem1m",), "10 m DEM": ("dem10m",), "lidar (EPT)": ("ept", "ept.json"),
                    "NAIP": ("naip1m",), "Mapterhorn": ("mapterhorn",), "OSM ski": ("osm", "ski.json"),
                    "OSM built": ("osm", "built.json"), "OSM natural": ("osm", "natural.json"),
                    "OSM peaks_far": ("osm", "peaks_far.json")}
            missing = [k for k, parts in need.items() if not self.raw_has(*parts)]
            done = os.path.isfile(os.path.join(raw, "FETCH_COMPLETE.txt"))
            self.line("2", "Raw: DEMs, lidar, NAIP, Mapterhorn, OSM", FAIL if missing else (PASS if done else WARN),
                      f"missing {', '.join(missing)}" if missing else ("all present" + ("" if done else ", no FETCH_COMPLETE.txt")))
        else:
            ok = all(have(x) for x in ("fine heights", "mid heights", "far heights", "mask")) and len(self.trees) and self.runs
            self.line("2", "Raw: DEMs, lidar, NAIP, Mapterhorn, OSM", PASS if ok else FAIL,
                      "the pack has heights, mask, trees and runs built from them (pass --raw to check the files)")

        # 3 land cover and pistes_wide
        levels = {l["name"] for l in meta.get("cover", {}).get("levels", [])}
        if raw:
            missing = [k for k, parts in {"WorldCover": ("landcover", "worldcover"), "ETH canopy": ("landcover", "eth_canopy"),
                                          "osm/pistes_wide.json": ("osm", "pistes_wide.json")}.items() if not self.raw_has(*parts)]
            self.line("3", "Raw: land cover and pistes_wide", FAIL if missing else PASS,
                      f"missing {', '.join(missing)} (re-run gen_manifest.py and fetch)" if missing else "all present")
        else:
            ok = {"mid", "far"} <= levels
            self.line("3", "Raw: land cover and pistes_wide", PASS if ok else FAIL,
                      "mid and far cover levels built from them (pass --raw to check pistes_wide)" if ok else
                      "no mid / far cover levels, so the land cover was missing at build time")

        # 4 LANDFIRE
        if raw:
            evt = self.raw_has("landfire", pattern="*.tif")
            evc, evh = self.raw_has("landfire", "evc", pattern="*.tif"), self.raw_has("landfire", "evh", pattern="*.tif")
            self.line("4", "Raw: LANDFIRE", PASS if evt and evc and evh else (WARN if evt else FAIL),
                      "EVT, EVC and EVH" if evt and evc and evh else
                      (f"EVT only, no {' or '.join(x for x, h in (('EVC', evc), ('EVH', evh)) if not h)} (stand heights fall back "
                       "to the lidar)" if evt else "none: species from elevation and aspect only (fetch_landfire)"))
        elif "LANDFIRE" in attribution:
            self.line("4", "Raw: LANDFIRE", PASS, "LANDFIRE in the attribution")
        else:
            self.line("4", "Raw: LANDFIRE", SKIP, "no LANDFIRE line in the attribution; pass --raw to check")

        # 5 heights
        miss = [s for s in ("fine", "mid", "far") if not have(f"{s} heights")]
        if miss:
            self.line("5", "Heights fine, mid, far", FAIL, f"missing {', '.join(miss)}")
        else:
            v = n.get("voidShare", 1.0)
            detail = f"{n.get('zMin')} to {n.get('zMax')} m, void {v:.2%} inside the bounds"
            st = PASS if v < 0.001 else (WARN if v < 0.01 else FAIL)
            er = (cfg or {}).get("elevation_range_m")
            if er and "zMax" in n and (n["zMax"] < er[1] - 150 or n["zMin"] > er[0] + 150):
                st, detail = WARN if st == PASS else st, detail + f"; config range {er[0]} to {er[1]} m"
            self.line("5", "Heights fine, mid, far", st, detail)

        # 6 surface
        miss = [s for s in ("mask", "AO", "piste directions", "moguls", "rocks") if not have(s)]
        if miss:
            self.line("6", "Surface: mask, AO, directions, moguls, rocks", FAIL, f"missing {', '.join(miss)}")
        else:
            rs, ref = n.get("rockShare", 0), self.ref.get("rockShare")
            detail = f"rock {rs:.1%}" + (f" (reference {ref:.1%})" if ref else "") + f", canopy {n.get('canopyShare', 0):.0%}"
            st = WARN if ref and rs > ROCK_RATIO_WARN * ref else PASS
            self.line("6", "Surface: mask, AO, directions, moguls, rocks", st,
                      detail + (" : more rock than the reference by over 3x, check the thresholds (FEAT-175 step 2)"
                                if st == WARN else ""))

        # 7 trees and shrubs
        probs = []
        if not len(self.trees):
            probs.append("no tree instances")
        if not meta.get("stands"):
            probs.append("no stands/ (predates FEAT-074)")
        if meta.get("treeSpecies", 0) < 2:
            probs.append("species ids 0 to 2 only (predates DATA-020)")
        tk, ref = n.get("treesPerKm2", 0), self.ref.get("treesPerKm2")
        detail = f"{n['crowns'] / 1e6:.2f} M crowns + {n['stems'] / 1e6:.2f} M stems = {tk / 1000:.1f} k per km2"
        if ref:
            detail += f" ({tk / ref:.0%} of the reference)"
        if not n.get("shrubs"):
            detail += ", no shrubs"
        if probs:
            self.line("7", "Trees and shrubs with species", FAIL, "; ".join(probs) + "; " + detail)
        else:
            low = ref and not (TREE_RATIO_WARN[0] <= tk / ref <= TREE_RATIO_WARN[1])
            self.line("7", "Trees and shrubs with species", WARN if low or not n.get("shrubs") else PASS, detail)

        # 8 cover levels, 8b far tree ring
        miss = [x for x in ("pack", "mid", "far") if x not in levels]
        self.line("8", "Far terrain: cover levels pack, mid, far", FAIL if miss else PASS,
                  f"missing {', '.join(miss)}" if miss else "three levels")
        ft = n.get("farTrees", 0)
        self.line("8b", "Far tree ring (lidar crowns round the resort)", PASS if ft else FAIL,
                  f"{ft / 1e6:.2f} M crowns in {len(meta['instances'].get('farTreeCells', []))} cells" if ft else
                  "none: set lidar.far, ept_select.py, fetch, far_trees.py (BUG-081)")

        # 9 features
        f = self.features
        probs, notes = [], []
        if not f.get("lifts"):
            probs.append("no lifts")
        if not self.runs:
            probs.append("no runs")
        if self.runs and any("mogulScore" not in r for r in self.runs):
            probs.append("runs without mogulScore (predates FEAT-059)")
        no_diff = sum(1 for r in self.runs if not r.get("difficulty"))
        if self.runs and no_diff / len(self.runs) > 0.05:
            notes.append(f"{no_diff} runs without a difficulty")
        towers = [l for l in self.lifts if l.get("type") in ("chair_lift", "gondola", "cable_car", "mixed_lift")]
        bare = sum(1 for l in towers if not l.get("towers"))
        if bare:
            notes.append(f"{bare} of {len(towers)} chairs and gondolas without towers")
        for k in ("buildings", "roads"):
            if not f.get(k):
                notes.append(f"no {k}")
        counts = ", ".join(f"{len(f.get(k, []))} {k}" for k in ("lifts", "runs", "buildings", "roads", "water", "peaks", "labels"))
        self.line("9", "features.json", FAIL if probs else (WARN if notes else PASS), "; ".join(probs + notes + [counts]))

        # 10 start
        self.line("10", "Default start on a run, on snow, clear of trees", *self.check_start())

        # 11 picker: the menu lists every pack in packs/index.json (FEAT-175, #534); without an index next to the
        # pack (a pack outside packs/), the game's own list or the catalog
        idx = os.path.join(os.path.dirname(os.path.normpath(self.pack)), "index.json")
        listed = self.slug in load_json(idx).get("packs", []) if os.path.isfile(idx) else None
        resorts_ts = os.path.join(self.repo, "game", "src", "resorts.ts")
        in_ts = os.path.isfile(resorts_ts) and bool(re.search(rf"slug:\s*'{re.escape(self.slug)}'", open(resorts_ts, encoding="utf-8").read()))
        catalog = os.path.join(os.path.dirname(self.repo), "MapPacker-SnowboardAnywhere", "catalog.json")
        in_cat = os.path.isfile(catalog) and any(r.get("slug") == self.slug for r in load_json(catalog).get("resorts", []))
        where = [w for w, on in (("in packs/index.json", listed), ("in game/src/resorts.ts", in_ts), ("in the catalog", in_cat)) if on]
        if listed is False:
            st, where = FAIL, ["not in packs/index.json (python pipeline/packwriter.py <pack_dir> rewrites it)"] + where
        else:
            st = PASS if where else WARN
        self.line("11", "In the resort picker", st, ", ".join(where) or "no packs/index.json next to the pack, not in the catalog")

        # 12 courses
        c = course_candidates(self.runs)
        self.line("12", "Time trial courses", PASS if c else FAIL, f"{len(c)} runs of 300 m and 60 m drop or more")

        # 13 attribution
        want = []
        if have("fine heights"):
            want.append(("3DEP", "elevation"))
        if len(self.trees):
            want.append(("lidar", "lidar canopy"))
        if have("mask"):
            want.append(("NAIP", "imagery"))
        if have("far heights"):
            want.append(("Mapterhorn", "background terrain"))
        if self.runs:
            want.append(("OpenStreetMap", "OSM"))
        if {"mid", "far"} & levels:
            want += [("WorldCover", "land cover"), ("Canopy height", "ETH canopy height")]
        if (raw and self.raw_has("landfire", pattern="*.tif")) or "LANDFIRE" in attribution:
            want.append(("LANDFIRE", "LANDFIRE"))
        missing = [what for key, what in want if key.lower() not in attribution.lower()]
        self.line("13", "Attribution for every data set", FAIL if missing else PASS,
                  f"missing {', '.join(missing)}" if missing else f"{len(meta.get('attribution', []))} lines")

        # 14 validated: the numbers
        probs, notes = [], []
        rc, ref = n.get("runCanopy"), self.ref.get("runCanopy")
        if rc is not None and rc > RUN_CANOPY_WARN:
            notes.append(f"canopy {rc:.0%} on run centre lines (trail cuts missing?)")
        if self.outliers.get("easyButSteep"):
            notes.append(f"{len(self.outliers['easyButSteep'])} easy runs with a {EASY_PITCH_MAX:.0f}+ deg pitch")
        if self.outliers.get("hardButFlat"):
            notes.append(f"{len(self.outliers['hardButFlat'])} advanced+ runs never over {HARD_PITCH_MIN:.0f} deg")
        if n.get("liftLineCrownsPerKm", 0) > 20:
            notes.append(f"{n['liftLineCrownsPerKm']:.0f} crowns per km within {LIFT_CLEAR_M:.0f} m of lift lines")
        if self.spots:
            notes.append(f"{len(self.spots)} compare spots measured")
        notes.append("ride from the start and views from the top not checked here (shoot.mjs)")
        self.line("14", "Validated", FAIL if probs else WARN, "; ".join(probs + notes))

        # polish
        g = n.get("runsGroomReported", 0)
        graw = len(glob.glob(os.path.join(raw, "grooming", "*.json"))) if raw else None
        self.line("15", "Grooming history", PASS if g else FAIL,
                  f"{g:.0%} of runs with a grooming record" + ("" if graw is None else f", {graw} reports in raw"), mvp=False)
        if raw:
            self.line("16", "Place names", PASS if self.raw_has("names") else FAIL,
                      "raw/names present" if self.raw_has("names") else "no raw/names", mvp=False)
        else:
            self.line("16", "Place names", SKIP, "pass --raw", mvp=False)
        shots = os.path.join(self.repo, "game", "public", "attract", self.slug, "shots.json")
        self.line("17", "Main menu shot and ghosts", PASS if os.path.isfile(shots) else FAIL,
                  f"game/public/attract/{self.slug}/shots.json" + ("" if os.path.isfile(shots) else " missing"), mvp=False)
        lm = os.path.join(self.repo, "game", "src", "world", "Landmarks.ts")
        has_lm = os.path.isfile(lm) and bool(re.search(rf"^\s*'?{re.escape(self.slug)}'?\s*:\s*\[", open(lm, encoding="utf-8").read(), re.M))
        self.line("18", "Landmark", PASS if has_lm else FAIL, "in Landmarks.ts" if has_lm else "none (optional)", mvp=False)
        self.line("19", "Compare spots against photos", PASS if self.spots else FAIL,
                  f"{len(self.spots)} spots in docs/compare/{self.slug}", mvp=False)
        derived = meta.get("derived") or {}
        tl = meta.get("treeline")
        parts = [f"treeline {tl:.0f} m measured" if tl else "no measured treeline (client uses Colorado's 3,480 m)"]
        parts += [f"{k} {v}" for k, v in sorted(derived.items())]
        tuned = bool(tl) and {"rock", "canopy"} <= {k.split(".")[0] for k in derived}
        self.line("20", "Values derived for the resort, not copied from Vail", PASS if tuned else FAIL,
                  "; ".join(parts) + ("" if tuned else "; rock and canopy thresholds are Vail's (FEAT-175 step 2)"), mvp=False)

    def check_start(self):
        s = self.meta.get("start")
        if not s:
            return FAIL, "no start in meta.json"
        x, y = float(s["x"]), float(s["y"])
        b = self.meta["bounds"]
        where = f"on {s['run']}" if s.get("run") else "start"
        if not (b["minX"] <= x < b["maxX"] and b["minY"] <= y < b["maxY"]):
            return FAIL, f"{where} is outside the bounds"
        probs = []
        if self.mask is not None:
            px = sample(self.mask, self.meta["mask"], x, y)
            if px is not None and (px[0] >= 128 or px[1] >= 128):
                probs.append("on rock or scree")
        best, name = math.inf, None
        for r in self.runs:
            if len(r["points"]) < 2:
                continue
            if r.get("area"):
                if point_in_polygon(x, y, r["points"]):
                    best, name = 0.0, r.get("name")
                continue
            d = distance_to_polyline(x, y, r["points"]) - run_half_width(r)
            if d < best:
                best, name = d, r.get("name")
        if best > 0:
            probs.append(f"{best:.0f} m off the nearest run" + (f" ({name})" if name else ""))
        if len(self.trees):
            d = np.hypot(self.trees[:, 0] - x, self.trees[:, 1] - y) - self.trees[:, 4]
            if (d < START_CLEAR_M).any():
                probs.append(f"{int((d < START_CLEAR_M).sum())} crowns within {START_CLEAR_M:.0f} m")
        if self.stand_pts is not None and len(self.stand_pts):
            near = np.hypot(self.stand_pts[:, 0] - x, self.stand_pts[:, 1] - y) < 6
            if near.any() and self.stand_pts[near, 3].max() > START_STAND_MAX:
                probs.append(f"in a stand (stem chance {self.stand_pts[near, 3].max():.2f})")
        return (FAIL if probs else PASS), "; ".join([where + (f", on {name}" if name and name != s.get("run") and best <= 0 else "")] + probs)

    # -------------------------------------------------------------- output
    def to_json(self):
        playable, failing = gate(self.lines)
        return {"reportVersion": REPORT_VERSION, "slug": self.slug, "name": self.meta.get("name"),
                "build": self.meta.get("build"), "pipeline": self.meta.get("pipeline"),
                "formatVersion": self.meta.get("formatVersion", 0),
                "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "reference": self.ref, "playable": playable, "failing": failing, "lines": self.lines,
                "numbers": self.numbers, "outliers": self.outliers, "bands": self.bands, "spots": self.spots,
                "layers": self.layers}

    def to_markdown(self):
        j = self.to_json()
        out = [f"# Pack report: {j['name']} (`{j['slug']}`)", "",
               f"Build `{j['build']}`" + (f", pipeline `{j['pipeline']}`" if j["pipeline"] else "") +
               f", format {j['formatVersion']}. Report {j['generated']} by `pipeline/pack_report.py` (FEAT-175).", "",
               f"**{'Playable' if j['playable'] else 'Preview'}**: " +
               ("every DATA-022 MVP line passes." if j["playable"] else f"MVP lines {', '.join(j['failing'])} hold it back."),
               "", "| # | Item | | Detail |", "|---|---|---|---|"]
        for ln in self.lines:
            if ln["id"] == "15":
                out += ["| | **Polish (not gated)** | | |"]
            out.append(f"| {ln['id']} | {ln['item']} | {ICON[ln['status']]} | {ln['detail']} |")
        n, ref = self.numbers, self.ref
        out += ["", f"## Numbers (reference: {ref.get('slug')} `{ref.get('build')}`)", "", "| Measure | This pack | Reference |",
                "|---|---:|---:|"]
        rows = [("Area, km2", n.get("areaKm2"), None, "{}"),
                ("Trees (crowns + stems) per km2", n.get("treesPerKm2"), ref.get("treesPerKm2"), "{:,}"),
                ("Rock share", n.get("rockShare"), ref.get("rockShare"), "{:.1%}"),
                ("Canopy share", n.get("canopyShare"), ref.get("canopyShare"), "{:.0%}"),
                ("Canopy on run centre lines", n.get("runCanopy"), ref.get("runCanopy"), "{:.1%}"),
                ("Groomed share", n.get("groomedShare"), None, "{:.1%}"),
                ("Crowns per km within 5 m of lift lines", n.get("liftLineCrownsPerKm"), None, "{}"),
                ("Stems per km within 5 m of lift lines", n.get("liftLineStemsPerKm"), None, "{}"),
                ("Runs with a grooming record", n.get("runsGroomReported"), None, "{:.0%}"),
                ("Runs groomed in OSM", n.get("runsOsmGroomed"), None, "{:.0%}"),
                ("Far ring crowns", n.get("farTrees"), None, "{:,}")]
        for label, v, r, fmt in rows:
            if v is not None:
                out.append(f"| {label} | {fmt.format(v)} | {fmt.format(r) if r is not None else ''} |")
        if n.get("mogulScoreByDifficulty"):
            out.append("| Mean mogulScore by difficulty | " + ", ".join(f"{k} {v}" for k, v in n["mogulScoreByDifficulty"].items()) + " | |")
        for key, label in (("easyButSteep", f"Easy runs with a {EASY_PITCH_MAX:.0f}+ deg pitch over {PITCH_M:.0f} m"),
                           ("hardButFlat", f"Advanced or harder runs never over {HARD_PITCH_MIN:.0f} deg"),
                           ("liftsWithTrees", "Lifts with the most crowns on the line")):
            if self.outliers.get(key):
                more = len(self.outliers[key]) - 8
                out += ["", f"**{label}:** " + ", ".join(self.outliers[key][:8]) + (f", and {more} more" if more > 0 else "")]
        if self.bands:
            out += ["", "## Trees by elevation band", "", "| Band, m | Area, km2 | Crowns | Stems | Per km2 |", "|---|---:|---:|---:|---:|"]
            out += [f"| {b['z']:.0f} | {b['areaKm2']} | {b['crowns']:,} | {b['stems']:,} | {b['perKm2']:,} |" for b in self.bands]
        if self.spots:
            out += ["", f"## Compare spots: trees per hectare within {SPOT_RADIUS:.0f} m", "", "| Spot | Trees per ha |", "|---|---:|"]
            out += [f"| {s['spot']} | {s['treesPerHa']} |" for s in self.spots]
        out += ["", "## Layers", "", "| Layer | In meta | Files | MB | Modified |", "|---|---|---:|---:|---|"]
        out += [f"| {l['layer']} | {'yes' if l['inMeta'] else 'no'} | {l['files']} | {l['mb']} | {l['modified'] or ''} |" for l in self.layers]
        return "\n".join(out) + "\n"


def find_config(slug, repo=REPO):
    for p in (os.path.join(repo, "pipeline", "resorts", f"{slug}.json"),
              os.path.join(os.path.dirname(repo), "MapPacker-SnowboardAnywhere", "resorts", f"{slug}.json")):
        if os.path.isfile(p):
            return p
    return None


def build_report(pack_dir, raw=None, config=None, against=None, repo=REPO):
    meta = load_json(os.path.join(pack_dir, "meta.json"))
    cfg_path = config or find_config(meta["slug"], repo)
    cfg = load_json(cfg_path) if cfg_path else None
    ref = None
    if against:
        a = load_json(against)
        ref = {"slug": a["slug"], "build": a.get("build"), **{k: a["numbers"].get(k) for k in ("treesPerKm2", "rockShare", "canopyShare", "runCanopy")}}
    r = Report(pack_dir, cfg, raw=raw, repo=repo, reference=ref)
    r.measure()
    r.check()
    return r


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pack_dir")
    ap.add_argument("--raw", help="the resort's raw folder (the one holding dem1m/, ept/, osm/), for lines 2 to 4 and 16")
    ap.add_argument("--config", help="resort config (default pipeline/resorts/<slug>.json, then the resorts repo's)")
    ap.add_argument("--against", help="another pack's report.json to compare with, instead of the built-in Vail numbers")
    ap.add_argument("--out", help="folder for report.json and report.md (default the pack)")
    ap.add_argument("--gate", action="store_true", help="exit 1 unless every MVP line passes")
    a = ap.parse_args(argv)
    r = build_report(a.pack_dir, raw=a.raw, config=a.config, against=a.against)
    out = a.out or a.pack_dir
    os.makedirs(out, exist_ok=True)
    j = r.to_json()
    with open(os.path.join(out, "report.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(j, f, indent=1, ensure_ascii=False)
        f.write("\n")
    md = r.to_markdown()
    with open(os.path.join(out, "report.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(md)
    sys.stdout.reconfigure(encoding="utf-8")
    print(md)
    if a.gate and not j["playable"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
