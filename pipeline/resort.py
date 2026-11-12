#!/usr/bin/env python3
"""FEAT-223 (EPIC-15): a resort name in, a resort config and a data plan out. Nothing is fetched for the pack.

    python pipeline/resort.py resolve "<name>" [--id <id>] [--with <name or id>]... [--alone] [--slug <slug>]
    python pipeline/resort.py plan <slug> [--no-nodes] [--force]
    python pipeline/resort.py compare <slug>

resolve  Finds the ski area in OpenSkiData (`ski_areas.geojson`) by name, case and accent insensitive. Several
         matches: prints them and stops (`--id` picks one). A named neighbour within 3 km (Boston Mills and
         Brandywine): stops and asks for `--with <name>` (one pack over both) or `--alone` (the neighbour's runs
         and lifts are left out by OSM id, as Big Sky leaves out the Yellowstone Club). No match: prints the
         closest names. Writes `pipeline/resorts/<slug>.json` with the identity fields and `lonlat_bbox`, the
         extent of the area's polygon, lifts and runs.
plan     Derives every other field the hand-written configs have (docs/research/resort-auto-pipeline.md section 1)
         from the hosts below, walks the EPT hierarchy for the node lists (`--no-nodes` skips it), writes the config
         and `pipeline/resorts/<slug>-plan.md` (the data plan: layer, source, year, resolution, size, tier).
         `publish_pack.py` copies the plan into the resorts repo's `reports/` with the config.
compare  Resolves a hand-written config's resort by name, plans it in memory and lists how it differs from the
         hand values (FEAT-223 check: Vail, Breckenridge, Big Sky). Writes nothing.

Hosts (Drew's PC; not reachable from the cloud sandbox, which can use cached index files): OpenSkiData, Mapterhorn,
TNM Access, the 3DEP elevation index (lidar work units), usgs.entwine.io, the EPT bucket, Planetary Computer STAC,
Geofabrik and the Internet Archive. The big index files are cached in `raw/_index/` (`--cache`, `SBA_INDEX_DIR`)
and re-downloaded after 30 days or with `--refresh`. Pure helpers, tested offline in tests/test_resort_plan.py.
"""
import argparse, copy, datetime, difflib, io, json, math, os, re, subprocess, sys, tempfile, unicodedata
import urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

RESORTS_DIR = os.path.join(HERE, "resorts")
UA = "SnowboardAnywhere-pipeline/1.0"
OSD = "https://tiles.openskimap.org/geojson/"
INDEXES = {  # cached name: url
    "ski_areas.geojson": OSD + "ski_areas.geojson",
    "lifts.geojson": OSD + "lifts.geojson",
    "runs.geojson": OSD + "runs.geojson",
    "entwine_resources.geojson": "https://usgs.entwine.io/boundaries/resources.geojson",
    "geofabrik_index.json": "https://download.geofabrik.de/index-v1-nogeom.json",
}
MAX_AGE_DAYS = 30

NEIGHBOUR_M = 3000        # a named ski area closer than this to the resort's runs and lifts is asked about
CANDIDATE_DEG = 0.2       # ski areas this far (about 15 to 20 km) are checked for being a neighbour
SUFFIXES = ("ski resort", "ski area", "ski center", "ski centre", "ski hill", "resort")
MID_RING = {"size_m": 40000, "res_m": 10}
FAR_RING = {"size_m": 200000, "mapterhorn_zoom": 11}
DEM = {"source": "3DEP ImageServer", "res_m": 1, "chunk_px": 1500}
NAIP_RES = {"res_m": 1, "max_px": 4000}
FAR_PAD_M = 5000          # lidar.far: the far tree ring (BUG-081, DATA-022 row 8b), on every resort
SPACING_M = 3.2           # EPT depth: the shallowest whose node spacing on the ground is under this. Vail's validated
                          # depth 9 is 2.9 m on CO_Central_Western_2016 (DATA-011), Big Sky's 3.1 m on MT P4_5_B22
FAR_SPACING_M = 4.5       # the far tree ring's depth: coarser is fine at a distance (Vail's far ring is depth 9, 2.9 m;
                          # depth 10 on Ohio's dataset would be 4,700 nodes and 6 GB, depth 9 is 4.4 m)
COVERED = 0.98            # a layer covering this share of the box is complete
NAIP_MIN_OVERLAP_M = 50   # gen_manifest.py skips a NAIP item that overlaps the box by less
TEMPLATE = "/the-mountain/mountain-conditions/terrain-and-lift-status.aspx"   # Vail Resorts' terrain status page

# bytes per manifest item (or per pixel for the rasters), measured on Vail's raw data 2026-11-11
# (LAZ: 8.8 bytes per point in both ept/ and ept_far/; per node only when the hierarchy was not walked)
BYTES = {"dem1m_px": 4.22, "dem10m_px": 4.06, "naip1m_px": 1.97, "mapterhorn": 105e3, "ept_pt": 8.8,
         "ept_node": 1.16e6, "ept_far_node": 1.32e6, "osm": 3.8e6, "worldcover": 89e6, "eth_canopy": 284e6}
LANDFIRE_BYTES = 2e6


# ------------------------------------------------------------------------------------------------ names

def norm(s):
    """lower case, no accents, punctuation to spaces"""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


def short_name(name):
    """the name without "Ski Resort", "Resort" and the like: "Big Sky Resort" -> "Big Sky" """
    n = (name or "").strip()
    for suf in SUFFIXES:
        if norm(n).endswith(" " + suf):
            words = n.split()
            n = " ".join(words[:len(words) - len(suf.split())])
            break
    return n


def slugify(name):
    return "-".join(norm(short_name(name)).split())


def search(features, query):
    """Ski areas matching `query`: exact names (with or without "Resort") first, then every query word as a whole
    word, then substrings. Only the best class is returned."""
    q, qs = norm(query), norm(short_name(query))
    best = {3: [], 2: [], 1: []}
    for f in features:
        p = f.get("properties", {})
        if p.get("type") != "skiArea" or not p.get("name"):
            continue
        n, ns = norm(p["name"]), norm(short_name(p["name"]))
        if not q:
            continue
        if n == q or ns == qs:
            best[3].append(f)
        elif set(q.split()) <= set(n.split()):
            best[2].append(f)
        elif q in n:
            best[1].append(f)
    for k in (3, 2, 1):
        if best[k]:
            return best[k]
    return []


def closest_names(features, query, n=5):
    names = sorted({f["properties"]["name"] for f in features
                    if f.get("properties", {}).get("type") == "skiArea" and f["properties"].get("name")})
    by_norm = {}
    for x in names:
        by_norm.setdefault(norm(x), x)
    return [by_norm[m] for m in difflib.get_close_matches(norm(query), list(by_norm), n=n, cutoff=0.5)]


def counts(props):
    """(runs, lifts) from an OpenSkiData ski area's statistics"""
    st = props.get("statistics") or {}
    runs = sum(d.get("count", 0) for a in (st.get("runs", {}).get("byActivity") or {}).values()
               for d in (a.get("byDifficulty") or {}).values())
    lifts = sum(d.get("count", 0) for d in (st.get("lifts", {}).get("byType") or {}).values())
    return runs, lifts


def place(props):
    """(region, ISO 3166-2, country alpha-2) of the first place OpenSkiData gives"""
    for p in props.get("places") or []:
        loc = ((p.get("localized") or {}).get("en") or {})
        return loc.get("region"), p.get("iso3166_2"), p.get("iso3166_1Alpha2")
    return None, None, None


def osm_way(props):
    for s in props.get("sources") or []:
        if s.get("type") == "openstreetmap" and str(s.get("id", "")).startswith("way/"):
            return int(s["id"].split("/")[1])
    return None


def osm_ids(props):
    """OSM way ids a run or lift was built from"""
    return [int(s["id"].split("/")[1]) for s in props.get("sources") or []
            if s.get("type") == "openstreetmap" and str(s.get("id", "")).startswith("way/")]


# ------------------------------------------------------------------------------------------------ geometry

def geom_points(g):
    """every [lon, lat] of a GeoJSON geometry"""
    t, c = g["type"], g.get("coordinates")
    if t == "Point":
        return [c[:2]]
    if t in ("LineString", "MultiPoint"):
        return [p[:2] for p in c]
    if t in ("Polygon", "MultiLineString"):
        return [p[:2] for r in c for p in r]
    if t == "MultiPolygon":
        return [p[:2] for poly in c for r in poly for p in r]
    if t == "GeometryCollection":
        return [p for gg in g["geometries"] for p in geom_points(gg)]
    return []


def bounds(points):
    xs = [p[0] for p in points]; ys = [p[1] for p in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def union_bounds(bs):
    bs = [b for b in bs if b]
    return [min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs)] if bs else None


def gap_m(a, b):
    """distance in metres between two lon/lat boxes (0 when they touch or overlap)"""
    lat = math.radians((a[1] + a[3] + b[1] + b[3]) / 4)
    dx = max(0.0, b[0] - a[2], a[0] - b[2]) * 111320 * math.cos(lat)
    dy = max(0.0, b[1] - a[3], a[1] - b[3]) * 110540
    return math.hypot(dx, dy)


def stream_members(path, ids):
    """{ski area id: {"bounds": lon/lat box or None, "osm": [way ids], "n": count}} for the runs or lifts in one
    OpenSkiData file. The files hold one feature per line, so a line is parsed only when it names one of `ids`
    (runs.geojson is about 800 MB)."""
    ids = list(ids)
    out = {i: {"bounds": None, "osm": [], "n": 0} for i in ids}
    if not ids:
        return out
    pat = re.compile("|".join(map(re.escape, ids)))
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not pat.search(line):
                continue
            line = line.strip().rstrip(",")
            if not line.startswith('{"type":"Feature"') and not line.startswith('{"type": "Feature"'):
                continue
            ft = json.loads(line)
            areas = {(a.get("properties") or a).get("id") for a in ft["properties"].get("skiAreas") or []}
            for i in areas & set(ids):
                m = out[i]
                m["bounds"] = union_bounds([m["bounds"], bounds(geom_points(ft["geometry"]))])
                m["osm"] += osm_ids(ft["properties"])
                m["n"] += 1
    return out


# ------------------------------------------------------------------------------------------------ index cache

def fetch(url, data=None, headers=None, timeout=120):
    h = {"User-Agent": UA, **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def curl_json(url):
    """GET with curl (the OS TLS stack): Python's ssl rejects web.archive.org's chain ("Basic Constraints of CA
    cert not marked critical"), as fetch_grooming.py found"""
    r = subprocess.run(["curl", "-sS", "-L", "--max-time", "90", "-A", UA, "--fail", url], capture_output=True)
    if r.returncode:
        raise RuntimeError(f"curl {r.returncode}: {r.stderr.decode('utf-8', 'replace').strip()}")
    return json.loads(r.stdout.decode("utf-8") or "null")


def fetch_json(url, body=None):
    if body is None:
        return json.loads(fetch(url))
    return json.loads(fetch(url, json.dumps(body).encode(), {"Content-Type": "application/json"}))


def index_file(cache, name, refresh=False):
    """path of a cached index file, downloaded when missing, older than MAX_AGE_DAYS or `refresh`"""
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, name)
    stale = not os.path.isfile(path) or refresh or \
        (datetime.datetime.now().timestamp() - os.path.getmtime(path)) > MAX_AGE_DAYS * 86400
    if stale:
        print(f"downloading {INDEXES[name]} -> {path}")
        tmp = path + ".part"
        req = urllib.request.Request(INDEXES[name], headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
        os.replace(tmp, path)
    return path


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ------------------------------------------------------------------------------------------------ resolve

def describe(f, ref=None):
    p = f["properties"]
    runs, lifts = counts(p)
    region, _, cc = place(p)
    b = bounds(geom_points(f["geometry"]))
    lon, lat = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    far = f", {gap_m(ref, b) / 1000:.1f} km away" if ref else ""
    return (f"  {p['id']}  {p['name']}  ({region or '?'}, {cc or '?'}; {lat:.4f}, {lon:.4f}; "
            f"{runs} runs, {lifts} lifts, {p.get('status')}{far})")


def site(props):
    """the resort's web host without www ("https://www.bmbw.com/" -> "bmbw.com")"""
    for w in props.get("websites") or []:
        h = urllib.parse.urlparse(w if "://" in w else "https://" + w).netloc.lower()
        return h[4:] if h.startswith("www.") else h
    return None


def diag_m(b):
    lat = math.radians((b[1] + b[3]) / 2)
    return math.hypot((b[2] - b[0]) * 111320 * math.cos(lat), (b[3] - b[1]) * 110540)


def neighbours(main_id, extents, by_id, lift_counts):
    """[(id, gap m)] of the ski areas to ask about: named, with lifts, and either reaching into the box (closer than
    the buffer plus 500 m: Snowbird and Alta, Big Sky and the Yellowstone Club) or sold as one resort (the same
    website, within NEIGHBOUR_M: Boston Mills and Brandywine, bmbw.com). Copper, 2.3 km from Breckenridge's runs
    but outside its box, is not asked about."""
    ref = extents[main_id]
    reach = buffer_for(diag_m(ref)) + 500
    host = site(by_id[main_id]["properties"])
    out = []
    for i, b in extents.items():
        if i == main_id or b is None:
            continue
        p = by_id[i]["properties"]
        if not p.get("name") or not lift_counts.get(i):
            continue
        d = gap_m(ref, b)
        if d < reach or (host and site(p) == host and d < NEIGHBOUR_M):
            out.append((i, d))
    return sorted(out, key=lambda t: t[1])


def resolve(query, features, lifts_path, runs_path, pick_id=None, with_=(), alone=False, log=print):
    """-> (status, result). status "ok" with the stub config fields; "none", "many", "neighbours" with what to
    print. Pure apart from reading the two member files."""
    by_id = {f["properties"]["id"]: f for f in features if f.get("properties", {}).get("type") == "skiArea"}
    if pick_id:
        if pick_id not in by_id:
            return "none", {"closest": [], "why": f"no ski area with id {pick_id}"}
        main = by_id[pick_id]
    else:
        hits = search(features, query)
        if not hits:
            return "none", {"closest": closest_names(features, query)}
        lifted = [f for f in hits if counts(f["properties"])[1] > 0]
        if lifted and len(lifted) < len(hits):     # an abandoned or cross-country area of the same name
            hits = lifted
        if len(hits) > 1:
            return "many", {"matches": hits}
        main = hits[0]
    mid = main["properties"]["id"]
    mb = bounds(geom_points(main["geometry"]))

    def near(f):
        b = bounds(geom_points(f["geometry"]))
        return (b[0] < mb[2] + CANDIDATE_DEG and b[2] > mb[0] - CANDIDATE_DEG and
                b[1] < mb[3] + CANDIDATE_DEG and b[3] > mb[1] - CANDIDATE_DEG)
    cands = {i: f for i, f in by_id.items() if i == mid or (f["properties"].get("name") and near(f))}
    lifts = stream_members(lifts_path, cands)
    runs = stream_members(runs_path, cands)
    extents = {i: union_bounds([bounds(geom_points(f["geometry"])), lifts[i]["bounds"], runs[i]["bounds"]])
               for i, f in cands.items()}
    near_ = neighbours(mid, extents, by_id, {i: lifts[i]["n"] for i in cands})

    chosen = [mid]
    for w in with_:
        if w in by_id:
            chosen.append(w)
            continue
        hit = [i for i, _ in near_ if norm(short_name(by_id[i]["properties"]["name"])) == norm(short_name(w))] or \
              [i for i, _ in near_ if set(norm(w).split()) <= set(norm(by_id[i]["properties"]["name"]).split())]
        if len(hit) != 1:
            return "none", {"closest": [by_id[i]["properties"]["name"] for i, _ in near_],
                            "why": f"--with {w!r} is not one neighbour of {main['properties']['name']}"}
        chosen.append(hit[0])
    chosen = list(dict.fromkeys(chosen))
    if any(i not in extents for i in chosen):     # a --with id far away: measure it too
        far = [i for i in chosen if i not in extents]
        fl, fr = stream_members(lifts_path, far), stream_members(runs_path, far)
        for i in far:
            extents[i] = union_bounds([bounds(geom_points(by_id[i]["geometry"])), fl[i]["bounds"], fr[i]["bounds"]])
            lifts[i], runs[i] = fl[i], fr[i]
    open_ = [(i, d) for i, d in near_ if i not in chosen]
    if open_ and not alone:
        return "neighbours", {"main": main, "near": [(by_id[i], d) for i, d in open_], "ref": extents[mid]}

    props = [by_id[i]["properties"] for i in chosen]
    region, iso, cc = place(props[0])
    name = " / ".join(short_name(p["name"]) for p in props)
    exclude = [{"name": by_id[i]["properties"]["name"], "openskidata_id": i,
                "osm_ways": sorted(set(lifts[i]["osm"] + runs[i]["osm"]))} for i, _ in open_]
    exclude = [e for e in exclude if e["osm_ways"]]
    for i in chosen:
        if lifts[i]["n"] + runs[i]["n"] == 0:
            log(f"warning: {by_id[i]['properties']['name']} has no runs or lifts in OpenSkiData")
    bb = union_bounds([extents[i] for i in chosen])
    stub = {
        "slug": slugify(props[0]["name"]),
        "name": name,
        "country": cc,
        "region": region,
        "osm_ski_area_way": osm_way(props[0]),
        "lonlat_bbox": [round(v, 7) for v in bb],
        "openskidata": {"ids": chosen, "names": [p["name"] for p in props], "iso3166_2": iso,
                        "websites": [w for p in props for w in (p.get("websites") or [])],
                        "lifts": sum(lifts[i]["n"] for i in chosen), "runs": sum(runs[i]["n"] for i in chosen)},
    }
    if exclude:
        stub["exclude"] = exclude
    return "ok", stub


# ------------------------------------------------------------------------------------------------ plan: pure parts

def utm_for(lon, lat, country):
    """(crs, utm_zone): NAD83 UTM in the US (as every hand config), WGS84 UTM elsewhere"""
    zone = int((lon + 180) // 6) + 1
    north = lat >= 0
    epsg = (26900 + zone) if country == "US" and north and zone <= 23 else (32600 if north else 32700) + zone
    return f"EPSG:{epsg}", f"{zone}{'N' if north else 'S'}"


def buffer_for(diameter_m):
    """the buffer round the ski area: 30 % of its diagonal, at least 500 m, at most 1000 m (every hand config's;
    the design's uncapped 0.3 x diameter would give Vail about 4 km), to 100 m"""
    return int(round(min(1000.0, max(500.0, 0.3 * diameter_m)) / 100.0) * 100)


def utm_boxes(lonlat_bbox, crs):
    """(ski box in UTM, its diagonal m) from the lon/lat box; corners and edge midpoints are transformed"""
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    x0, y0, x1, y1 = lonlat_bbox
    pts = [tr.transform(x, y) for x in (x0, (x0 + x1) / 2, x1) for y in (y0, (y0 + y1) / 2, y1)]
    b = bounds(pts)
    return b, math.hypot(b[2] - b[0], b[3] - b[1])


def buffered(ski_utm, buffer_m):
    """utm_bbox (outward to 100 m) and origin (its centre, to 50 m)"""
    x0, y0, x1, y1 = ski_utm
    b = [math.floor((x0 - buffer_m) / 100) * 100, math.floor((y0 - buffer_m) / 100) * 100,
         math.ceil((x1 + buffer_m) / 100) * 100, math.ceil((y1 + buffer_m) / 100) * 100]
    return b, [round((b[0] + b[2]) / 100) * 50, round((b[1] + b[3]) / 100) * 50]


def lonlat_of(utm_bbox, crs):
    from pyproj import Transformer
    tr = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    x0, y0, x1, y1 = utm_bbox
    return bounds([tr.transform(x, y) for x in (x0, (x0 + x1) / 2, x1) for y in (y0, (y0 + y1) / 2, y1)])


def elevation_range(zmin, zmax):
    return [int(math.floor(zmin / 50) * 50), int(math.ceil(zmax / 50) * 50)]


def box_cover(box, rects):
    """share of `box` covered by the union of `rects` (all [x0, y0, x1, y1] in one plane)"""
    from shapely.geometry import box as sbox
    from shapely.ops import unary_union
    B = sbox(*box)
    if not rects:
        return 0.0
    return unary_union([sbox(*r) for r in rects]).intersection(B).area / B.area


DEM_TILE_GROW = 0.002     # deg (about 200 m): TNM's lon/lat boxes of neighbouring 1 m tiles leave 150 m slivers


def dem_project(title):
    """the 3DEP project from a TNM 1 m DEM tile title: "USGS 1 Meter 17 x45y457 OH_Statewide_Phase1_2019_B19" ->
    "OH_Statewide_Phase1_2019_B19", "USGS one meter x37y438 CO Central Western 2016" -> "CO_Central_Western_2016" """
    m = re.search(r"\bx\d+y\d+\s+(.+)$", title)
    return "_".join(m.group(1).split()) if m else title


def dem_cover(tiles, box_ll):
    """share of the box under 1 m DEM tiles (their boxes grown by DEM_TILE_GROW, so abutting tiles join)"""
    g = DEM_TILE_GROW
    return box_cover(box_ll, [[t["boundingBox"]["minX"] - g, t["boundingBox"]["minY"] - g,
                               t["boundingBox"]["maxX"] + g, t["boundingBox"]["maxY"] + g] for t in tiles])


def dataset_year(name):
    """collection year from an EPT dataset name: the first 4-digit year (CO_Central_Western_2016_LAS_2018 -> 2016),
    else a B<yy> batch (MT_StatewideP4_5_B22 -> 2022)"""
    m = re.search(r"(?<!\d)(19\d\d|20\d\d)(?!\d)", name)
    if m:
        return int(m.group(1))
    m = re.search(r"_B(\d\d)(?:$|_)", name)
    return 2000 + int(m.group(1)) if m else None


def pick_lidar(cands, box_ll):
    """EPT datasets for the box: the one covering most (newest, then densest among near-equal cover), then, while
    more than 2 % of the box is uncovered, whichever covers most of the rest. `cands`: [{"name", "geometry"
    (shapely, lon/lat), "density", "year"}]. -> [(cand, share of the box it is used for, uncovered part it fills)]"""
    from shapely.geometry import box as sbox
    B = sbox(*box_ll)
    pool = [dict(c, cover=c["geometry"].intersection(B).area / B.area) for c in cands]
    pool = [c for c in pool if c["cover"] > 0.001]
    if not pool:
        return []
    pool.sort(key=lambda c: (-round(c["cover"] / 0.02), -(c.get("year") or 0), -(c.get("density") or 0)))
    out = [(pool[0], pool[0]["cover"], None)]
    rest = B.difference(pool[0]["geometry"])
    left = pool[1:]
    while rest.area / B.area > 1 - COVERED and left:
        gain = [(c["geometry"].intersection(rest).area / B.area, c) for c in left]
        g, c = max(gain, key=lambda t: (t[0], t[1].get("year") or 0))
        if g < 0.005:
            break
        fill = c["geometry"].intersection(rest)
        out.append((c, g, fill))
        rest = rest.difference(c["geometry"])
        left = [x for x in left if x is not c]
    return out


def ept_depth(ept, lat, target=SPACING_M):
    """(depth, ground spacing m): the shallowest depth whose node spacing is under `target`"""
    b = ept["bounds"]
    w = (b[3] - b[0]) / ept["span"]
    if str(ept.get("srs", {}).get("horizontal", "3857")) == "3857":
        w *= math.cos(math.radians(lat))         # web mercator metres are 1 / cos(lat) ground metres
    d = 0
    while w / 2 ** d > target and d < 14:
        d += 1
    return d, w / 2 ** d


def season(start_ms, end_ms):
    """flight dates and leaf state from a lidar work unit's collect_start and collect_end (ms)"""
    if not start_ms or not end_ms:
        return None
    a = datetime.datetime.fromtimestamp(start_ms / 1000, datetime.timezone.utc)
    b = datetime.datetime.fromtimestamp(end_ms / 1000, datetime.timezone.utc)
    months, m = set(), datetime.date(a.year, a.month, 1)
    short = (b - a).days < 28
    while m <= datetime.date(b.year, b.month, 1) and len(months) < 12:
        nxt = datetime.date(m.year + (m.month == 12), m.month % 12 + 1, 1)
        days = (min(b.date(), nxt) - max(a.date(), m)).days
        if short or days >= 7:      # a flight that ends on 2 May is not a May flight
            months.add(m.month)
        m = nxt
    leaf = "leaf-off" if months <= {11, 12, 1, 2, 3, 4} else "leaf-on" if months <= {5, 6, 7, 8, 9, 10} else "mixed"
    return {"from": a.strftime("%Y-%m"), "to": b.strftime("%Y-%m"), "leaf": leaf}


def match_workunit(dataset, units):
    """the 3DEP work unit (WESM) a usgs-lidar-public dataset was made from, by name"""
    s = re.sub(r"^USGS_LPC_", "", dataset)
    s = re.sub(r"_LAS_\d{4}$", "", s)
    for u in units:
        if u.get("workunit") in (dataset, s):
            return u
    for u in units:
        w = u.get("workunit") or ""
        if w and (s.startswith(w) or w.startswith(s)):
            return u
    return None


def quarter_quad(item_id):
    """NAIP item id -> its quarter quad ("co_m_3910630_sw_13_030_20230907_20240104" -> "co_m_3910630_sw")"""
    return "_".join(item_id.split("_")[:4])


def pick_naip(items, utm_bbox, crs):
    """the newest NAIP item per quarter quad that overlaps the box by NAIP_MIN_OVERLAP_M (Big Sky: 2021 everywhere
    but one quarter quad, which is 2019). `items`: STAC features. -> [(id, bbox rounded to 3 decimals, year, gsd)]"""
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    x0, y0, x1, y1 = utm_bbox
    newest = {}
    for it in items:
        q = quarter_quad(it["id"])
        dt = it["properties"].get("datetime") or ""
        if q not in newest or dt > newest[q]["properties"].get("datetime", ""):
            newest[q] = it
    out = []
    for q, it in sorted(newest.items()):
        lo0, la0, lo1, la1 = it["bbox"][:4]
        cs = [tr.transform(lo, la) for lo, la in [(lo0, la0), (lo1, la0), (lo1, la1), (lo0, la1)]]
        xs = sorted(c[0] for c in cs); ys = sorted(c[1] for c in cs)
        ix0, ix1 = max(xs[1], x0), min(xs[2], x1); iy0, iy1 = max(ys[1], y0), min(ys[2], y1)
        if ix1 - ix0 < NAIP_MIN_OVERLAP_M or iy1 - iy0 < NAIP_MIN_OVERLAP_M:
            continue
        p = it["properties"]
        out.append((it["id"], [round(v, 3) for v in (lo0, la0, lo1, la1)], int(p.get("naip:year") or p["datetime"][:4]),
                    p.get("gsd")))
    # the newest year first (as the hand configs list them), then by id
    return sorted(out, key=lambda t: (-t[2], t[0]))


def naip_source(picked):
    years = [t[2] for t in picked]
    main = max(set(years), key=lambda y: (years.count(y), y))
    gsd = [t[3] for t in picked if t[2] == main][0]
    s = f"Planetary Computer naip {main} {int(round((gsd or 1) * 100))}cm"
    other = sorted({y for y in years if y != main}, reverse=True)
    if other:
        n = sum(1 for y in years if y != main)
        s += f" ({n} quarter quad{'s' if n > 1 else ''} from {', '.join(map(str, other))} where {main} has none)"
    return s, main


def geofabrik_for(iso3166_2, country, index):
    """the smallest Geofabrik extract for the state (ISO 3166-2), else the country"""
    feats = index.get("features", [])
    for f in feats:
        if iso3166_2 and iso3166_2 in (f["properties"].get("iso3166-2") or []):
            return f["properties"]["id"], f["properties"]["urls"]["pbf"]
    for f in feats:
        if country and country in (f["properties"].get("iso3166-1:alpha2") or []):
            return f["properties"]["id"], f["properties"]["urls"]["pbf"]
    return None, None


def terrain_status_url(website):
    """the Vail Resorts terrain status page on the resort's own site"""
    if not website:
        return None
    u = urllib.parse.urlparse(website if "://" in website else "https://" + website)
    host = u.netloc or u.path.split("/")[0]
    if not host.startswith("www.") and host.count(".") == 1:
        host = "www." + host
    return f"https://{host}{TEMPLATE}"


def attribution(dem_projects, lidar_names, naip_years):
    ys = sorted(set(naip_years), reverse=True)
    yrs = f"{ys[0]}" + (f" ({', '.join(map(str, ys[1:]))} where {ys[0]} has none)" if len(ys) > 1 else "")
    return [
        f"Elevation: USGS 3DEP 1 m lidar DEM ({', '.join(dem_projects)}), public domain" if dem_projects
        else "Elevation: USGS 3DEP 1/3 arc-second DEM, public domain",
        f"Canopy: USGS 3DEP lidar point cloud{'s' if len(lidar_names) > 1 else ''} {' and '.join(lidar_names)} "
        f"via AWS usgs-lidar-public, public domain",
        f"Imagery: USDA NAIP {yrs} via Microsoft Planetary Computer, public domain",
        "Background terrain: Mapterhorn (mapterhorn.com)",
        "Runs, lifts, buildings, roads, names: OpenStreetMap contributors (ODbL)",
    ]


def tier_of(layers):
    """the pack's tier is its weakest layer's (design section 4). `layers`: {layer: "gold"|"silver"|"bronze"}"""
    rank = {"gold": 0, "silver": 1, "bronze": 2}
    worst = max(layers.values(), key=lambda t: rank[t]) if layers else "bronze"
    return worst, sorted(k for k, t in layers.items() if t == worst and worst != "gold")


def estimate_bytes(items, ept_points=None):
    """{folder: bytes} for a manifest's items (BYTES, measured on Vail)"""
    out = {}
    for it in items:
        top = it["path"].split("/")[0]
        sz = (it.get("meta") or {}).get("size")
        if top in ("dem1m", "dem10m", "naip1m") and sz:
            b = sz[0] * sz[1] * BYTES[f"{top}_px"]
        elif top == "landcover":
            b = BYTES["worldcover"] if "/worldcover/" in it["path"] else BYTES["eth_canopy"]
        elif top == "ept":
            b = 0 if it["path"].endswith("ept.json") else BYTES["ept_node"]
        elif top == "ept_far":
            b = BYTES["ept_far_node"]
        else:
            b = BYTES.get(top, 0)
        out[top] = out.get(top, 0) + b
    return out


def mb(b):
    return f"{b / 1e6:,.0f} MB" if b >= 1e6 else f"{b / 1e3:,.0f} kB"


# ------------------------------------------------------------------------------------------------ plan: network

class Hosts:
    """the network calls plan makes; tests replace it"""

    def __init__(self, cache, refresh=False):
        self.cache, self.refresh = cache, refresh

    def index(self, name):
        return index_file(self.cache, name, self.refresh)

    def elevation(self, box_ll, z=12):
        """(min, max) metres from Mapterhorn terrarium tiles over a lon/lat box"""
        import numpy as np
        from PIL import Image

        def tile(lon, lat):
            n = 2 ** z
            return ((lon + 180) / 360 * n,
                    (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
        fx0, fy1 = tile(box_ll[0], box_ll[1]); fx1, fy0 = tile(box_ll[2], box_ll[3])
        lo, hi = float("inf"), float("-inf")
        for ty in range(int(fy0), int(fy1) + 1):
            for tx in range(int(fx0), int(fx1) + 1):
                im = Image.open(io.BytesIO(fetch(f"https://tiles.mapterhorn.com/{z}/{tx}/{ty}.webp"))).convert("RGB")
                a = np.asarray(im).astype(np.float64)
                h = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
                n = a.shape[0]
                c = (np.arange(n) + 0.5) / n
                X, Y = np.meshgrid(tx + c, ty + c)
                m = (X >= fx0) & (X <= fx1) & (Y >= fy0) & (Y <= fy1)
                if m.any():
                    lo, hi = min(lo, float(h[m].min())), max(hi, float(h[m].max()))
        return lo, hi

    def dem_1m(self, box_ll):
        """TNM Access 1 m DEM tiles over the box: [{title, boundingBox, sizeInBytes}]"""
        q = urllib.parse.urlencode({"datasets": "Digital Elevation Model (DEM) 1 meter",
                                    "bbox": ",".join(f"{v:.6f}" for v in box_ll), "max": 500})
        return fetch_json("https://tnmaccess.nationalmap.gov/api/v1/products?" + q).get("items", [])

    def workunits(self, box_ll):
        """3DEP lidar work units (WESM) over the box, with flight dates and quality level"""
        q = urllib.parse.urlencode({
            "geometry": ",".join(f"{v:.6f}" for v in box_ll), "geometryType": "esriGeometryEnvelope", "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects", "returnGeometry": "false", "f": "json",
            "outFields": "workunit,project,collect_start,collect_end,ql,lpc_category,onemeter_category"})
        d = fetch_json("https://index.nationalmap.gov/arcgis/rest/services/3DEPElevationIndex/MapServer/8/query?" + q)
        return [f["attributes"] for f in d.get("features", [])]

    def ept(self, url):
        return fetch_json(url)

    def naip(self, box_ll):
        body = {"collections": ["naip"], "bbox": box_ll, "limit": 250}
        out, url = [], "https://planetarycomputer.microsoft.com/api/stac/v1/search"
        while url:
            d = fetch_json(url, body)
            out += d.get("features", [])
            nxt = [l for l in d.get("links", []) if l.get("rel") == "next"]
            url, body = (nxt[0]["href"], nxt[0].get("body", body)) if nxt else (None, None)
        return out

    def archived(self, url):
        """True when the Internet Archive has a snapshot of the page (fetch_grooming.py reads them)"""
        bare = re.sub(r"^https?://(www\.)?", "", url)
        for u in (bare, "www." + bare):
            q = urllib.parse.urlencode({"url": u, "output": "json", "filter": "statuscode:200", "limit": 1})
            try:
                if len(curl_json("https://web.archive.org/cdx/search/cdx?" + q) or []) > 1:
                    return True
            except Exception:
                pass
        return False

    def nodes(self, cfg, src, far=False, have=()):
        import ept_select
        st = {}
        if far:
            sel = ept_select.select_far(cfg, have=have, stats=st)
        else:
            sel, _ = ept_select.select(cfg, src, stats=st)
        return sel, sum(st["points"].values())


# ------------------------------------------------------------------------------------------------ plan

def plan(stub, hosts, walk_nodes=True, log=print):
    """-> (config, plan facts, {nodes file: keys}). `stub`: what resolve wrote (slug, name, country, region,
    osm_ski_area_way, lonlat_bbox, openskidata, exclude)."""
    from shapely.geometry import shape
    from pyproj import Geod
    slug = stub["slug"]
    ll = stub["lonlat_bbox"]
    cx, cy = (ll[0] + ll[2]) / 2, (ll[1] + ll[3]) / 2
    country = stub.get("country")
    crs, zone = utm_for(cx, cy, country)
    ski_utm, diag = utm_boxes(ll, crs)
    buf = buffer_for(diag)
    utm_bbox, origin = buffered(ski_utm, buf)
    box_ll = lonlat_of(utm_bbox, crs)
    facts = {"diagonal_m": round(diag), "box_ll": box_ll, "layers": {}, "notes": []}
    log(f"{stub['name']}: {crs} ({zone}), ski box {diag / 1000:.1f} km across, buffer {buf} m")

    zmin, zmax = hosts.elevation(box_ll)
    erange = elevation_range(zmin, zmax)
    facts["elevation"] = [round(zmin), round(zmax)]

    # 1 m DEM: the ImageServer serves the best 3DEP has; TNM Access says whether that is 1 m everywhere
    tiles = hosts.dem_1m(box_ll)
    cover = dem_cover(tiles, box_ll)
    projects = sorted({dem_project(t["title"]) for t in tiles})
    facts["dem"] = {"projects": projects, "cover": cover, "tiles": len(tiles)}
    facts["layers"]["terrain"] = "gold" if cover >= COVERED else "silver"
    if cover < COVERED:
        facts["notes"].append(f"1 m DEM covers {cover:.0%} of the box; the rest is 3DEP 1/3 arc-second (10 m)")

    # lidar
    ent = load_json(hosts.index("entwine_resources.geojson"))
    geod = Geod(ellps="WGS84")
    from shapely.geometry import box as sbox
    B = sbox(*box_ll)
    cands = []
    for f in ent["features"]:
        g = shape(f["geometry"])
        if not g.intersects(B):
            continue
        area = abs(geod.geometry_area_perimeter(g)[0])
        cands.append({"name": f["properties"]["name"], "geometry": g, "url": f["properties"]["url"],
                      "count": f["properties"].get("count"), "density": (f["properties"].get("count") or 0) / max(area, 1),
                      "year": dataset_year(f["properties"]["name"])})
    picked = pick_lidar(cands, box_ll)
    units = hosts.workunits(box_ll) if picked else []
    lidar, lidar_facts, node_lists = None, [], {}
    from pyproj import Transformer
    to_utm = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    for k, (c, share, fill) in enumerate(picked):
        base = c["url"].rsplit("/", 1)[0] + "/"
        e = hosts.ept(base + "ept.json")
        depth, spacing = ept_depth(e, cy)
        u = match_workunit(c["name"], units)
        nodes_file = f"{slug}_ept_nodes.txt" if k == 0 else f"{slug}_ept_nodes_{c['name']}.txt"
        src = {"ept": base, "dataset": c["name"], "max_depth_resort": depth, "max_depth_outside": depth - 1,
               "nodes_file": nodes_file}
        if fill is not None:     # an extra source, clipped to the part the ones before it miss (plus 500 m)
            fb = bounds([to_utm.transform(x, y) for x, y in geom_points(fill.__geo_interface__)])
            src["utm_bbox"] = [max(utm_bbox[0], math.floor((fb[0] - 500) / 100) * 100),
                               max(utm_bbox[1], math.floor((fb[1] - 500) / 100) * 100),
                               min(utm_bbox[2], math.ceil((fb[2] + 500) / 100) * 100),
                               min(utm_bbox[3], math.ceil((fb[3] + 500) / 100) * 100)]
        when = season(u.get("collect_start"), u.get("collect_end")) if u else None
        lidar_facts.append({"dataset": c["name"], "share": share, "year": int(when["to"][:4]) if when else c["year"],
                            "density": c["density"], "depth": depth, "spacing": spacing, "ql": (u or {}).get("ql"),
                            "season": when, "src": src})
        if k == 0:
            lidar = dict(src)
        else:
            lidar.setdefault("extra", []).append(src)
    lidar_cover = min(1.0, sum(s for _, s, _ in picked)) if picked else 0.0
    facts["lidar"] = lidar_facts
    facts["layers"]["trees"] = "gold" if lidar_cover >= COVERED else "silver"
    if not picked:
        facts["notes"].append("no EPT lidar over the box: trees would come from ETH canopy height (Silver)")
    else:
        far_depth, far_spacing = ept_depth(hosts.ept(lidar["ept"] + "ept.json"), cy, FAR_SPACING_M)
        far_depth = min(far_depth, lidar["max_depth_resort"])
        lidar["far"] = {"pad_m": FAR_PAD_M, "max_depth": far_depth, "nodes_file": f"{slug}_ept_far_nodes.txt"}
        facts["far_spacing"] = far_spacing
        for lf in lidar_facts:
            s = lf["season"]
            if s and s["leaf"] == "leaf-off":
                facts["notes"].append(f"{lf['dataset']} was flown {s['from']} to {s['to']} (leaf-off): deciduous "
                                      "crowns read low and sparse; compare crown count against NAIP canopy")
            elif s and s["leaf"] == "mixed":
                facts["notes"].append(f"{lf['dataset']} was flown {s['from']} to {s['to']}, across seasons: "
                                      "deciduous crowns may read low where it was flown leaf-off")

    # NAIP
    items = hosts.naip(box_ll)
    naip_items = pick_naip(items, utm_bbox, crs)
    naip = None
    if naip_items:
        source, year = naip_source(naip_items)
        naip = {"source": source, **NAIP_RES, "items": [t[0] for t in naip_items],
                "item_bboxes_ll": {t[0]: t[1] for t in naip_items}}
        naip_cover = box_cover(box_ll, [t[1] for t in naip_items])
    else:
        naip_cover = 0.0
    facts["naip"] = {"items": len(naip_items), "years": sorted({t[2] for t in naip_items}, reverse=True), "cover": naip_cover}
    facts["layers"]["surface"] = "gold" if naip_cover >= COVERED else "bronze"
    if country != "US":
        facts["layers"]["data"] = "bronze"
        facts["notes"].append("outside the US: no 3DEP, NAIP or LANDFIRE (FEAT-225 Silver and Bronze tiers)")

    # OSM extract, grooming feed
    gf_id, gf_url = geofabrik_for((stub.get("openskidata") or {}).get("iso3166_2"), country,
                                  load_json(hosts.index("geofabrik_index.json")))
    status_url = None
    for w in (stub.get("openskidata") or {}).get("websites", []):
        u = terrain_status_url(w)
        if u and hosts.archived(u):
            status_url = u
            break
    facts["grooming"] = status_url
    if not status_url:
        facts["notes"].append("no archived Vail Resorts terrain status page: groomed runs come from OSM tags only")

    cfg = {k: stub[k] for k in ("slug", "name", "country", "region", "osm_ski_area_way") if k in stub}
    cfg.update({
        "crs": crs, "utm_zone": zone, "lonlat_bbox": ll, "buffer_m": buf, "utm_bbox": utm_bbox, "origin": origin,
        "elevation_range_m": erange, "mid_ring": dict(MID_RING), "far_ring": dict(FAR_RING), "dem": dict(DEM),
    })
    if naip:
        cfg["naip"] = naip
    if lidar:
        cfg["lidar"] = lidar
    cfg["attribution"] = attribution(projects, [lf["dataset"] for lf in lidar_facts], [t[2] for t in naip_items])
    cfg["start_run"] = None
    if status_url:
        cfg["terrain_status_url"] = status_url
    if gf_id:
        cfg["osm"] = {"geofabrik": gf_id, "pbf": gf_url}
    if stub.get("exclude"):
        cfg["exclude"] = stub["exclude"]
    cfg["openskidata"] = stub.get("openskidata")
    tier, why = tier_of(facts["layers"])
    cfg["tier"] = tier
    facts["tier"], facts["tier_why"] = tier, why

    # EPT nodes (the slow part: the hierarchy walk), then the manifest it implies for the sizes
    if lidar and walk_nodes:
        for lf in lidar_facts:
            src = lf["src"]
            log(f"walking {src['dataset']} hierarchy to depth {src['max_depth_resort']}")
            sel, pts = hosts.nodes(cfg, src)
            node_lists[src["nodes_file"]] = sel
            lf["nodes"], lf["points"] = len(sel), pts
        log(f"walking the far ring ({FAR_PAD_M} m) to depth {lidar['far']['max_depth']}")
        sel, pts = hosts.nodes(cfg, None, far=True, have=node_lists[lidar["nodes_file"]])
        node_lists[lidar["far"]["nodes_file"]] = sel
        facts["far_nodes"], facts["far_points"] = len(sel), pts
    facts["manifest"] = sizes(cfg, node_lists)
    if lidar and walk_nodes:     # lidar by points, not nodes: a span-128 dataset's nodes hold a quarter as many
        m = facts["manifest"]
        m["ept"] = (m["ept"][0], sum(lf["points"] for lf in lidar_facts) * BYTES["ept_pt"])
        if "ept_far" in m:
            m["ept_far"] = (m["ept_far"][0], facts["far_points"] * BYTES["ept_pt"])
    return cfg, facts, node_lists


def sizes(cfg, node_lists):
    """{folder: (items, bytes)} of the manifest this config makes (node lists from `node_lists`, empty if not walked)"""
    import gen_manifest
    with tempfile.TemporaryDirectory() as d:
        c = copy.deepcopy(cfg)
        for src in [c.get("lidar")] + list((c.get("lidar") or {}).get("extra", [])):
            if src:
                with open(os.path.join(d, src["nodes_file"]), "w") as f:
                    f.write(" ".join(node_lists.get(src["nodes_file"], [])))
        far = (c.get("lidar") or {}).get("far")
        if far and far["nodes_file"] in node_lists:
            with open(os.path.join(d, far["nodes_file"]), "w") as f:
                f.write(" ".join(node_lists[far["nodes_file"]]))
        if "lidar" not in c:
            c["lidar"] = {"ept": "", "dataset": "", "nodes_file": "none.txt"}
            open(os.path.join(d, "none.txt"), "w").close()
        items = gen_manifest.manifest_items(c, d)
    if "lidar" not in cfg:
        items = [i for i in items if not i["path"].startswith("ept")]
    est = estimate_bytes(items)
    n = {}
    for it in items:
        top = it["path"].split("/")[0]
        n[top] = n.get(top, 0) + 1
    return {k: (n[k], est.get(k, 0)) for k in n}


def plan_md(cfg, facts, walked=True):
    """the data plan Drew reads before the fetch"""
    m = facts["manifest"]
    L = [f"# {cfg['name']}: data plan", "",
         f"Planned {datetime.date.today().isoformat()} by `pipeline/resort.py plan {cfg['slug']}` (FEAT-223). "
         f"{cfg['crs']} ({cfg['utm_zone']}), origin {cfg['origin'][0]}, {cfg['origin'][1]}. Ski area "
         f"{facts['diagonal_m'] / 1000:.1f} km across, buffer {cfg['buffer_m']} m, box "
         f"{(cfg['utm_bbox'][2] - cfg['utm_bbox'][0]) / 1000:.1f} x {(cfg['utm_bbox'][3] - cfg['utm_bbox'][1]) / 1000:.1f} km, "
         f"elevation {facts['elevation'][0]} to {facts['elevation'][1]} m (Mapterhorn z12).", "",
         f"**Tier: {facts['tier']}**" + (f" (held there by: {', '.join(facts['tier_why'])})" if facts["tier_why"] else ""), "",
         "| Layer | Source | Year | Resolution | Items | Size | Tier |", "|---|---|---|---|---|---|---|"]

    def row(layer, source, year, res, key, tier):
        n, b = m.get(key, (0, 0))
        L.append(f"| {layer} | {source} | {year} | {res} | {n} | {mb(b)} | {tier} |")
    d = facts["dem"]
    row("Terrain, resort", f"3DEP ImageServer; 1 m tiles: {', '.join(d['projects']) or 'none'} ({d['cover']:.0%} of the box)",
        "", "1 m", "dem1m", facts["layers"]["terrain"])
    row("Terrain, mid ring", "3DEP ImageServer", "", "10 m", "dem10m", "")
    row("Terrain, far ring", "Mapterhorn", "", f"z{FAR_RING['mapterhorn_zoom']}", "mapterhorn", "")
    for k, lf in enumerate(facts["lidar"]):
        s = lf["season"]
        when = f"{s['from']} to {s['to']}, {s['leaf']}" if s else (lf["year"] or "")
        key = "ept"
        n = lf.get("nodes")
        pts = f", {lf['points'] / 1e6:,.0f} M points" if lf.get("points") else ""
        L.append(f"| Lidar{'' if k == 0 else ' (extra)'} | EPT {lf['dataset']} ({lf['share']:.0%} of the box"
                 f"{', ' + lf['ql'] if lf.get('ql') else ''}, {lf['density']:.1f} pts/m2) | {when} | depth "
                 f"{lf['depth']}: {lf['spacing']:.1f} m | {n if n is not None else '?'}{pts} | "
                 f"{mb(lf['points'] * BYTES['ept_pt']) if n is not None else '?'} | {facts['layers']['trees'] if k == 0 else ''} |")
    if cfg.get("lidar", {}).get("far"):
        fn = facts.get("far_nodes")
        L.append(f"| Lidar, far tree ring | same, {FAR_PAD_M} m round the box | | depth {cfg['lidar']['far']['max_depth']}: "
                 f"{facts.get('far_spacing', 0):.1f} m | {fn if fn is not None else '?'} | "
                 f"{mb(facts['far_points'] * BYTES['ept_pt']) if fn is not None else '?'} | |")
    nf = facts["naip"]
    row("Imagery", cfg.get("naip", {}).get("source", "none"), ", ".join(map(str, nf["years"])),
        f"{NAIP_RES['res_m']} m", "naip1m", facts["layers"]["surface"])
    row("Land cover, far terrain", "ESA WorldCover 2021 + ETH canopy height 2020 (3 degree tiles)", "2021, 2020", "10 m",
        "landcover", "")
    L.append(f"| Vegetation type | LANDFIRE EVT, EVC, EVH (`fetch_landfire.mjs`) | | 30 m | | {mb(LANDFIRE_BYTES)} | |")
    osm = cfg.get("osm", {})
    row("Runs, lifts, buildings", f"OSM via Overpass (Geofabrik extract: {osm.get('geofabrik', 'none')})", "", "", "osm", "")
    L.append(f"| Grooming | {cfg.get('terrain_status_url') or 'none'} | | | | | |")
    total = sum(b for _, b in m.values()) + LANDFIRE_BYTES
    L += ["", f"Total about **{mb(total)}**" + ("" if walked else " plus the lidar (node lists not walked: `--no-nodes`)") + ".",
          "", "Lidar size is points x 8.8 bytes (LAZ), raster sizes are pixels x bytes per pixel, both measured on "
          "Vail's raw data."]
    if facts["notes"]:
        L += ["", "## Notes", ""] + [f"- {n}" for n in facts["notes"]]
    if cfg.get("exclude"):
        L += ["", "## Left out", ""] + [f"- {e['name']}: {len(e.get('osm_ways', []))} run and lift ways by OSM id"
                                       for e in cfg["exclude"]]
    L += ["", "## Next", "", "- `start_run` is empty: FEAT-175 step 4 picks it after the build.",
          f"- `python pipeline/gen_manifest.py {cfg['slug']}`, then `pipeline/fetch.ps1 -Slug {cfg['slug']} -RawDir <dir>` "
          "on Drew's PC."]
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------------------------------------ compare

def naip_years(cfg):
    """the flight years of a config's NAIP items (the first 8-digit date in each id)"""
    return sorted({int(re.search(r"_(\d{4})\d{4}(?:_|$)", i).group(1)) for i in (cfg.get("naip") or {}).get("items", [])})


def compare(derived, hand):
    """differences between a planned config and a hand-written one, as lines (FEAT-223 check)"""
    out = []

    def same(k):
        return derived.get(k) == hand.get(k)
    for k in ("crs", "utm_zone", "country", "region", "osm_ski_area_way"):
        if not same(k):
            out.append(f"{k}: planned {derived.get(k)!r}, hand {hand.get(k)!r}")
    buf = max(derived.get("buffer_m", 0), hand.get("buffer_m", 0), 500)
    for k in ("utm_bbox", "lonlat_bbox"):
        a, b = derived.get(k), hand.get(k)
        if a and b:
            if k == "lonlat_bbox":
                lat = math.radians((b[1] + b[3]) / 2)
                d = max(abs(a[i] - b[i]) * (111320 * math.cos(lat) if i % 2 == 0 else 110540) for i in range(4))
            else:
                d = max(abs(a[i] - b[i]) for i in range(4))
            tag = "within one buffer step" if d <= buf else "MORE than one buffer step"
            if d > 0:
                out.append(f"{k}: edges up to {d:,.0f} m from the hand box ({tag}): planned {a}, hand {b}")
    if derived.get("buffer_m") != hand.get("buffer_m"):
        out.append(f"buffer_m: planned {derived.get('buffer_m')}, hand {hand.get('buffer_m')}")
    a, b = derived.get("elevation_range_m"), hand.get("elevation_range_m")
    if a != b:
        out.append(f"elevation_range_m: planned {a}, hand {b}")

    def datasets(c):
        L = c.get("lidar") or {}
        return [L.get("dataset")] + [e.get("dataset") for e in L.get("extra", [])] if L else []
    if datasets(derived) != datasets(hand):
        out.append(f"lidar datasets: planned {datasets(derived)}, hand {datasets(hand)}")
    for name, a, b in zip(datasets(derived), [derived.get("lidar", {})] + derived.get("lidar", {}).get("extra", []),
                          [hand.get("lidar", {})] + hand.get("lidar", {}).get("extra", [])):
        for k in ("max_depth_resort", "max_depth_outside", "utm_bbox"):
            if a.get(k) != b.get(k):
                out.append(f"lidar {name} {k}: planned {a.get(k)}, hand {b.get(k)}")
    if (derived.get("lidar") or {}).get("far") != (hand.get("lidar") or {}).get("far"):
        out.append(f"lidar.far: planned {(derived.get('lidar') or {}).get('far')}, hand {(hand.get('lidar') or {}).get('far')}")

    if naip_years(derived) != naip_years(hand):
        out.append(f"NAIP years: planned {naip_years(derived)}, hand {naip_years(hand)}")
    a, b = set((derived.get("naip") or {}).get("items", [])), set((hand.get("naip") or {}).get("items", []))
    if a != b:
        out.append(f"NAIP items: planned adds {sorted(a - b)}, drops {sorted(b - a)}")
    if derived.get("terrain_status_url") != hand.get("terrain_status_url"):
        out.append(f"terrain_status_url: planned {derived.get('terrain_status_url')}, hand {hand.get('terrain_status_url')}")
    ex_a = sorted(e["name"] for e in derived.get("exclude", []))
    ex_b = sorted(e["name"] for e in hand.get("exclude", []))
    if ex_a != ex_b:
        out.append(f"exclude: planned {ex_a}, hand {ex_b}")
    return out


# ------------------------------------------------------------------------------------------------ CLI

def keep_hand_fields(new, old):
    """fields a person set on the config (start_run, grooming aliases, notes, their own exclude entries) survive
    a re-plan"""
    for k in ("start_run", "grooming_aliases", "notes", "landcover"):
        if old.get(k) is not None:
            new[k] = old[k]
    mine = {e["name"] for e in new.get("exclude", [])}
    extra = [e for e in old.get("exclude", []) if e["name"] not in mine]
    if extra:
        new["exclude"] = new.get("exclude", []) + extra
    return new


def write_json(path, obj):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def cmd_resolve(a, hosts):
    return resolve_and_write(a, hosts)[0]


def resolve_and_write(a, hosts, keep_planned=False):
    """resolve and write resorts/<slug>.json -> (exit code, slug). `keep_planned` (resort.py add): a config already
    planned for the same ski areas is left as it is"""
    feats = load_json(hosts.index("ski_areas.geojson"))["features"]
    st, r = resolve(a.name, feats, hosts.index("lifts.geojson"), hosts.index("runs.geojson"),
                    pick_id=a.id, with_=a.with_ or (), alone=a.alone)
    if st == "none":
        print(r.get("why") or f"no ski area called {a.name!r} in OpenSkiData")
        if r["closest"]:
            print("closest names:\n" + "\n".join(f"  {n}" for n in r["closest"]))
        print("A ski area missing from OpenSkiData is a later 'any hill' pack (design section 5).")
        return 1, None
    if st == "many":
        print(f"{len(r['matches'])} ski areas match {a.name!r}; pick one with --id:")
        print("\n".join(describe(f) for f in r["matches"]))
        return 2, None
    if st == "neighbours":
        print(f"{r['main']['properties']['name']} has neighbours in its box or sold with it:")
        print("\n".join(describe(f, r["ref"]) for f, _ in r["near"]))
        print(f"Build them into one pack with --with \"<name>\" (for example --with \"{short_name(r['near'][0][0]['properties']['name'])}\"),"
              " or --alone to leave their runs and lifts out.")
        return 3, None
    stub = r
    slug = a.slug or stub["slug"]
    stub["slug"] = slug
    path = os.path.join(a.resorts_dir, f"{slug}.json")
    if os.path.isfile(path):
        old = load_json(path)
        if "openskidata" not in old and not a.force:
            print(f"{path} is a hand-written config; `resort.py compare {slug}` checks it, --force replaces it")
            return 4, None
        if keep_planned and same_areas(old, stub):
            print(f"{path}: already resolved and planned for the same ski areas")
            return 0, slug
        stub = keep_hand_fields({**old, **stub}, old)
    write_json(path, stub)
    o = stub["openskidata"]
    print(f"{stub['name']} ({stub['region']}, {stub['country']}): {o['runs']} runs, {o['lifts']} lifts, "
          f"box {stub['lonlat_bbox']}" + (f", leaving out {', '.join(e['name'] for e in stub['exclude'])}" if stub.get("exclude") else ""))
    print(f"wrote {path}\nnext: python pipeline/resort.py plan {slug}")
    return 0, slug


def same_areas(old, stub):
    """a planned config for the same ski areas and the same neighbours left out"""
    return ("crs" in old and (old.get("openskidata") or {}).get("ids") == stub["openskidata"]["ids"]
            and sorted(e["name"] for e in old.get("exclude", []) if "openskidata_id" in e)
            == sorted(e["name"] for e in stub.get("exclude", [])))


def cmd_plan(a, hosts):
    path = os.path.join(a.resorts_dir, f"{a.slug}.json")
    if not os.path.isfile(path):
        print(f"no {path}: run `resort.py resolve \"<name>\"` first")
        return 1
    old = load_json(path)
    if "openskidata" not in old and not a.force:
        print(f"{path} is a hand-written config; `resort.py compare {a.slug}` checks it, --force re-plans it")
        return 4
    stub = old if "openskidata" in old else resolve_hand(old, hosts)
    cfg, facts, nodes = plan(stub, hosts, walk_nodes=not a.no_nodes)
    cfg = keep_hand_fields(cfg, old)
    write_json(path, cfg)
    for name, keys in nodes.items():
        with open(os.path.join(a.resorts_dir, name), "w") as f:
            f.write(" ".join(keys))
    md = plan_md(cfg, facts, walked=not a.no_nodes)
    with open(os.path.join(a.resorts_dir, f"{a.slug}-plan.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(md)
    print(md)
    print(f"wrote {path}, {len(nodes)} node lists and {a.slug}-plan.md")
    return 0


def resolve_hand(hand, hosts, log=print):
    """the stub for a hand-written config: its OSM way's ski area, else its name; private neighbours excluded"""
    feats = load_json(hosts.index("ski_areas.geojson"))["features"]
    pick = None
    if hand.get("osm_ski_area_way"):
        for f in feats:
            if osm_way(f["properties"]) == hand["osm_ski_area_way"]:
                pick = f["properties"]["id"]
    st, r = resolve(hand["name"], feats, hosts.index("lifts.geojson"), hosts.index("runs.geojson"),
                    pick_id=pick, alone=True, log=log)
    if st != "ok":
        raise SystemExit(f"{hand['name']}: resolve says {st}: " + json.dumps(
            {k: [f['properties']['name'] for f in v] if k == "matches" else v for k, v in r.items() if k in ("matches", "closest")}))
    r["slug"] = hand["slug"]
    return r


def cmd_compare(a, hosts):
    path = os.path.join(a.resorts_dir, f"{a.slug}.json")
    hand = load_json(path)
    stub = resolve_hand(hand, hosts)
    cfg, facts, _ = plan(stub, hosts, walk_nodes=False)
    diffs = compare(cfg, hand)
    print(f"{a.slug}: {len(diffs)} difference(s) from the hand config, tier {facts['tier']}")
    for d in diffs:
        print("  - " + d)
    for n in facts["notes"]:
        print("  note: " + n)
    return 0


ADD_STAGES = ["resolve", "plan", "fetch", "build", "report", "ride", "publish"]
# resort.py add's fetch, build and report stages are these ranges of build_resort.py's stages
BUILD_RANGES = {"fetch": ("nodes", "grooming"), "build": ("build", "index"), "report": ("report", "report")}
MAPPACKER = os.path.join(os.path.dirname(REPO), "MapPacker-SnowboardAnywhere")
RESORTS_REPO = "drewkeriazes/MapPacker-SnowboardAnywhere"


def gate_lines(pack_dir):
    """(playable, [(id, item, detail)] of the MVP lines that hold it back) from the pack's report.json"""
    rep = load_json(os.path.join(pack_dir, "report.json"))
    bad = [(ln["id"], ln["item"], ln["detail"]) for ln in rep.get("lines", [])
           if ln.get("mvp") and ln["id"] in rep.get("failing", [])]
    return bool(rep.get("playable")), bad


def default_runner(cmd, cwd, env=None):
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")


def ride(slug, raw_dir, out_dir, runner=default_runner, log=print):
    """the headless ride from the pack's start (game/tools/shoot.mjs, on the real GPU on Drew's PC): the game must
    load the pack, ride and fly without a page error. Recorded per pack build in <raw_dir>/shots/ride.json, so a
    re-run of the same build skips it."""
    import shutil
    # absolute: shoot.mjs runs in game/, where a relative SHOT_PACKS finds no pack and the game never starts
    raw_dir, out_dir = os.path.abspath(raw_dir), os.path.abspath(out_dir)
    meta = load_json(os.path.join(out_dir, "meta.json"))
    shots = os.path.join(raw_dir, "shots")
    rec = os.path.join(shots, "ride.json")
    if os.path.isfile(rec) and load_json(rec).get("build") == meta.get("build"):
        log(f"  ride already passed for build {meta.get('build')}")
        return False
    game = os.path.join(REPO, "game")
    r = runner([shutil.which("npx") or "npx", "vite", "build"], game)
    if r.returncode:
        log((r.stdout or "")[-2000:] + (r.stderr or "")[-2000:])
        raise SystemExit("ride: the game did not build (cd game && npx vite build)")
    env = {**os.environ, "SHOT_PACKS": os.path.dirname(os.path.normpath(out_dir))}
    r = runner(["node", os.path.join("tools", "shoot.mjs"), slug, shots], game, env)
    out = (r.stdout or "") + (r.stderr or "")
    log("\n".join("  " + l for l in out.strip().splitlines()[-25:]))
    errors = [l.strip() for l in out.splitlines() if "pageerror" in l]
    if r.returncode or errors:
        raise SystemExit(f"ride: shoot.mjs {'exited ' + str(r.returncode) if r.returncode else 'saw page errors'}; "
                         f"stills in {shots}")
    os.makedirs(shots, exist_ok=True)
    write_json(rec, {"build": meta.get("build"), "at": datetime.datetime.now().isoformat(timespec="seconds")})
    return True


def published(slug, pack_dir, repo_dir=MAPPACKER):
    """True when the resorts repo's catalog already has this pack's build"""
    try:
        cat = load_json(os.path.join(repo_dir, "catalog.json"))
        build = load_json(os.path.join(pack_dir, "meta.json")).get("build")
    except (OSError, ValueError):
        return False
    return any(e.get("slug") == slug and (e.get("pack") or {}).get("build") == build for e in cat.get("resorts", []))


def cmd_add(a, hosts, publish=None, br=None):
    """FEAT-224: resolve, plan, fetch, build, report, ride and publish one resort, each stage skipped when done.
    `publish` and `br` (build_resort) are replaced in tests."""
    import build_resort
    br = br or build_resort
    first = ADD_STAGES.index(a.first) if a.first else 0
    last = ADD_STAGES.index(a.last) if a.last else len(ADD_STAGES) - 1
    if first > last:
        print("--from comes after --stop-after")
        return 2
    todo = ADD_STAGES[first:last + 1]
    forced = set(getattr(a, "force_list", None) or [])
    slug = a.slug or slugify(a.name)

    def head(stage, what):
        print(f"\n== {stage}: {what}", flush=True)

    if "resolve" in todo:
        head("resolve", a.name)
        code, slug = resolve_and_write(a, hosts, keep_planned=not forced & {"resolve", "all"})
        if code:
            return code
    path = os.path.join(a.resorts_dir, f"{slug}.json")
    if "plan" in todo:
        cfg = load_json(path) if os.path.isfile(path) else {}
        if "openskidata" not in cfg and "crs" in cfg:
            head("plan", f"skip: {slug}.json is hand-written (--force resolve replaces it with a resolved one)")
        elif "crs" in cfg and os.path.isfile(os.path.join(a.resorts_dir, f"{slug}-plan.md")) \
                and not forced & {"plan", "all"}:
            head("plan", f"skip: planned ({slug}-plan.md; --force plan re-plans)")
        else:
            head("plan", slug)
            code = cmd_plan(argparse.Namespace(slug=slug, resorts_dir=a.resorts_dir, no_nodes=False, force=False), hosts)
            if code:
                return code
            if getattr(a, "review_plan", False) and todo[-1] != "plan":
                print(f"\nRead {os.path.join(a.resorts_dir, slug + '-plan.md')} (above), then run the same command "
                      "again to fetch and build.")
                return 0
    if not os.path.isfile(path):
        print(f"no {path}: start from resolve")
        return 1
    cfg = load_json(path)
    if "crs" not in cfg:
        print(f"{path} is not planned yet: start from plan")
        return 1
    raw = os.path.abspath(os.path.join(a.raw_root or br.default_raw_root(), slug))
    out = os.path.abspath(a.out or os.path.join(REPO, "packs", slug))
    ctx = br.Context([s for s in br.STAGES if s in forced] + (["all"] if "all" in forced else []), a.email,
                     sys.stdin.isatty())
    for stage in ("fetch", "build", "report"):
        if stage not in todo:
            continue
        lo, hi = BUILD_RANGES[stage]
        head(stage, f"build_resort.py {lo} to {hi}" if lo != hi else f"build_resort.py {lo}")
        try:
            br.build(br.Resort(slug, raw, out), ctx, lo, hi)
        except br.Failed as e:
            print(f"\nstopped at {stage}: {e}")
            return 1
    need_report = [s for s in todo if s in ("ride", "publish")]
    if need_report and not os.path.isfile(os.path.join(out, "report.json")):
        print(f"no {os.path.join(out, 'report.json')}: run the report stage first")
        return 1
    if set(todo) & {"report", "ride", "publish"} and os.path.isfile(os.path.join(out, "report.json")):
        ok, bad = gate_lines(out)
        print("\nDATA-022 gate: " + ("every MVP line passes, playable" if ok else "preview, held back by:"))
        for i, item, detail in bad:
            print(f"  {i} {item}: {detail}")
    if "ride" in todo:
        head("ride", "game/tools/shoot.mjs from the start")
        try:
            ride(slug, raw, out)
        except SystemExit as e:
            print(f"\nstopped at ride: {e}")
            return 1
    if "publish" in todo:
        if a.no_publish:
            head("publish", "skip: --no-publish")
        elif published(slug, out) and not forced & {"publish", "all"}:
            head("publish", "skip: the catalog already has this build")
        else:
            head("publish", f"publish_pack.py {out} (a release in {RESORTS_REPO})")
            if publish is None:
                import publish_pack
                publish = publish_pack.main
            try:
                publish([out, "--tier", cfg.get("tier", "gold")])
            except SystemExit as e:
                if e.code not in (None, 0):
                    print(f"\nstopped at publish: {e}")
                    return 1
    print(f"\n{slug}: done ({', '.join(todo)})")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cache", default=os.environ.get("SBA_INDEX_DIR", os.path.join(REPO, "raw", "_index")),
                    help="folder for the cached index files (default raw/_index, or SBA_INDEX_DIR)")
    ap.add_argument("--refresh", action="store_true", help="download the index files again")
    ap.add_argument("--resorts-dir", default=RESORTS_DIR, help=argparse.SUPPRESS)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("resolve", help="name to OpenSkiData ski area(s) and pipeline/resorts/<slug>.json")
    r.add_argument("name")
    r.add_argument("--id", help="OpenSkiData ski area id, when several match")
    r.add_argument("--with", dest="with_", action="append", help="a neighbour to build into the same pack")
    r.add_argument("--alone", action="store_true", help="leave the neighbours' runs and lifts out")
    r.add_argument("--slug", help="slug to write (default from the name)")
    r.add_argument("--force", action="store_true", help="replace a hand-written config")
    p = sub.add_parser("plan", help="derive the rest of the config and the data plan")
    p.add_argument("slug")
    p.add_argument("--no-nodes", action="store_true", help="skip the EPT hierarchy walk (no node lists, no lidar size)")
    p.add_argument("--force", action="store_true", help="re-plan a hand-written config (its hand fields are kept)")
    c = sub.add_parser("compare", help="plan a hand-written config again and list the differences")
    c.add_argument("slug")
    import build_resort
    d = sub.add_parser("add", help="resolve, plan, fetch, build, report, ride and publish (FEAT-224)")
    d.add_argument("name")
    d.add_argument("--id", help="OpenSkiData ski area id, when several match")
    d.add_argument("--with", dest="with_", action="append", help="a neighbour to build into the same pack")
    d.add_argument("--alone", action="store_true", help="leave the neighbours' runs and lifts out")
    d.add_argument("--slug", help="slug (default from the name)")
    d.add_argument("--from", dest="first", choices=ADD_STAGES, help="start at this stage")
    d.add_argument("--stop-after", dest="last", choices=ADD_STAGES,
                   help="stop after this stage (plan: read the data plan before a 1+ GB fetch)")
    d.add_argument("--force", action="append", default=[], choices=list(dict.fromkeys(ADD_STAGES + build_resort.STAGES)) + ["all"],
                   help="run a stage even if done (add's or build_resort.py's stage names; resolve replaces a "
                        "hand-written config)")
    d.add_argument("--raw-root", help="folder that holds <slug>/ raw data (default raw/ in the main checkout, or "
                   "SBA_RAW_ROOT)")
    d.add_argument("--out", help="pack folder (default packs/<slug>)")
    d.add_argument("--email", help="email for the LANDFIRE service (or LANDFIRE_EMAIL)")
    d.add_argument("--no-publish", action="store_true", help="everything but the release")
    d.add_argument("--review-plan", action="store_true", help="stop after a plan that was just written, to read it "
                   "before the fetch (add_resort.cmd passes it)")
    a = ap.parse_args(argv)
    if a.cmd == "add":
        a.force_list = a.force                                  # the stages to run even when done
        a.force = bool({"resolve", "all"} & set(a.force))       # resolve's own flag: replace a hand config
    hosts = Hosts(a.cache, a.refresh)
    return {"resolve": cmd_resolve, "plan": cmd_plan, "compare": cmd_compare, "add": cmd_add}[a.cmd](a, hosts)


if __name__ == "__main__":
    sys.exit(main())
