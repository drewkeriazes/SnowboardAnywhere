#!/usr/bin/env python3
"""Extract the resort's OSM features from a Geofabrik .osm.pbf and GNIS names file,
writing Overpass-compatible `out geom` JSON so the processing side is unchanged.

Outputs (into <out>/osm and <out>/names):
  osm/ski.json, osm/built.json, osm/natural.json, osm/peaks_far.json, osm/places_far.json
  names/gnis.json  (GNIS features in the far box, Summit + Populated Place everywhere, all classes near)

Usage: python extract_osm.py colorado-latest.osm.pbf DomesticNames_CO.txt out_dir \
         --near lat0,lon0,lat1,lon1 --far lat0,lon0,lat1,lon1
"""
import argparse, csv, json, os, sys, time
import osmium

ap = argparse.ArgumentParser()
ap.add_argument("pbf"); ap.add_argument("gnis"); ap.add_argument("out")
ap.add_argument("--near", required=True); ap.add_argument("--far", required=True)
a = ap.parse_args()
NEAR = tuple(float(x) for x in a.near.split(","))  # lat0, lon0, lat1, lon1
FAR = tuple(float(x) for x in a.far.split(","))

def inside(bb, lat, lon): return bb[0] <= lat <= bb[2] and bb[1] <= lon <= bb[3]
def bounds_intersect(bb, b): return not (b["maxlat"] < bb[0] or b["minlat"] > bb[2] or b["maxlon"] < bb[1] or b["minlon"] > bb[3])

# ---- query definitions mirror gen_manifest.py's Overpass queries
def q_ski_way(t): return "piste:type" in t or "aerialway" in t or t.get("landuse") == "winter_sports"
def q_ski_rel(t): return "piste:type" in t
def q_ski_node(t): return "aerialway" in t
def q_built_way(t): return any(k in t for k in ("building", "highway", "man_made", "amenity", "tourism", "parking"))
def q_built_rel(t): return "building" in t
def q_built_node(t): return any(k in t for k in ("man_made", "amenity", "tourism"))
def q_nat_way(t): return any(k in t for k in ("natural", "landuse", "waterway"))
def q_nat_rel(t): return any(k in t for k in ("natural", "landuse", "waterway"))
def q_nat_node(t): return t.get("natural") in ("peak", "saddle")
def q_peaks_far(t): return t.get("natural") == "peak" and "ele" in t
def q_places_far(t): return t.get("place") in ("town", "city", "village")

OUT = {k: [] for k in ("ski", "built", "natural", "peaks_far", "places_far")}
near_ways = {}        # id -> element dict (every tagged-or-not way touching the near box, for relation members)
rel_pending = []      # (bucket, relation element, member refs)

class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__(); self.n = 0; self.t0 = time.time()
    def node(self, n):
        if not n.location.valid(): return
        lat, lon = n.location.lat, n.location.lon
        if not inside(FAR, lat, lon) or len(n.tags) == 0: return
        t = dict(n.tags)
        el = {"type": "node", "id": n.id, "lat": lat, "lon": lon, "tags": t}
        if q_peaks_far(t): OUT["peaks_far"].append(el)
        if q_places_far(t): OUT["places_far"].append(el)
        if inside(NEAR, lat, lon):
            if q_ski_node(t): OUT["ski"].append(el)
            if q_built_node(t): OUT["built"].append(el)
            if q_nat_node(t): OUT["natural"].append(el)
    def way(self, w):
        geom = []; refs = []; hit = False
        for nd in w.nodes:
            if not nd.location.valid(): continue
            lat, lon = nd.location.lat, nd.location.lon
            geom.append({"lat": lat, "lon": lon}); refs.append(nd.ref)
            if not hit and inside(NEAR, lat, lon): hit = True
        if not geom: return
        b = {"minlat": min(g["lat"] for g in geom), "minlon": min(g["lon"] for g in geom),
             "maxlat": max(g["lat"] for g in geom), "maxlon": max(g["lon"] for g in geom)}
        if not hit and not bounds_intersect(NEAR, b): return
        t = dict(w.tags)
        el = {"type": "way", "id": w.id, "bounds": b, "nodes": refs, "geometry": geom, "tags": t}
        near_ways[w.id] = el
        if q_ski_way(t): OUT["ski"].append(el)
        if q_built_way(t): OUT["built"].append(el)
        if q_nat_way(t): OUT["natural"].append(el)
    def relation(self, r):
        t = dict(r.tags)
        buckets = [k for k, f in (("ski", q_ski_rel), ("built", q_built_rel), ("natural", q_nat_rel)) if f(t)]
        if not buckets: return
        members = [(m.type, m.ref, m.role) for m in r.members]
        if not any(mt == "w" and ref in near_ways for mt, ref, _ in members): return
        rel_pending.append((buckets, {"type": "relation", "id": r.id, "tags": t}, members))

t0 = time.time()
h = H(); h.apply_file(a.pbf, locations=True, idx="flex_mem")
print(f"pass done in {time.time()-t0:.0f}s; near ways cached: {len(near_ways)}", file=sys.stderr)

for buckets, el, members in rel_pending:
    mem = []
    for mt, ref, role in members:
        if mt == "w" and ref in near_ways:
            w = near_ways[ref]
            mem.append({"type": "way", "ref": ref, "role": role, "geometry": w["geometry"]})
        else:
            mem.append({"type": {"n": "node", "w": "way", "r": "relation"}[mt], "ref": ref, "role": role})
    geos = [g for m in mem for g in m.get("geometry", [])]
    if geos:
        el["bounds"] = {"minlat": min(g["lat"] for g in geos), "minlon": min(g["lon"] for g in geos),
                        "maxlat": max(g["lat"] for g in geos), "maxlon": max(g["lon"] for g in geos)}
    el["members"] = mem
    for b in buckets: OUT[b].append(el)

os.makedirs(os.path.join(a.out, "osm"), exist_ok=True)
for name, els in OUT.items():
    doc = {"version": 0.6, "generator": "extract_osm.py (Geofabrik colorado-latest)",
           "osm3s": {"copyright": "OpenStreetMap contributors, ODbL"}, "elements": els}
    p = os.path.join(a.out, "osm", f"{name}.json")
    json.dump(doc, open(p, "w"))
    from collections import Counter
    print(f"{name}.json: {len(els)} elements {dict(Counter(e['type'] for e in els))}", file=sys.stderr)

# ---- GNIS
os.makedirs(os.path.join(a.out, "names"), exist_ok=True)
feats = []
with open(a.gnis, encoding="utf-8-sig") as f:
    for row in csv.DictReader(f, delimiter="|"):
        try: lat, lon = float(row["prim_lat_dec"]), float(row["prim_long_dec"])
        except ValueError: continue
        if not inside(FAR, lat, lon): continue
        near = inside(NEAR, lat, lon)
        cls = row["feature_class"]
        if not near and cls not in ("Summit", "Populated Place", "Range", "Ridge"): continue
        feats.append({"id": int(row["feature_id"]), "name": row["feature_name"], "class": cls,
                      "lat": lat, "lon": lon, "county": row["county_name"], "near": near})
json.dump({"source": "USGS GNIS DomesticNames_CO", "features": feats}, open(os.path.join(a.out, "names", "gnis.json"), "w"))
from collections import Counter
print(f"gnis.json: {len(feats)} features, near={sum(f['near'] for f in feats)}; {dict(Counter(f['class'] for f in feats).most_common(8))}", file=sys.stderr)
