"""Keep private ski areas out of a pack (DATA-021).

Big Sky's neighbours, the Yellowstone Club and Spanish Peaks Mountain Club, are members-only, but OSM maps their
runs and lifts like the resort's own, interleaved with Big Sky's Andesite terrain. `build_pack.py` drops a run or
lift way when:
  - its tags say private (`access`, `aerialway:access` or `piste:access` = private / no / members), or
  - most of its points lie inside one of the resort config's `exclude` areas: `{"name", "osm_way": <id>}` (a closed
    way in osm/ski.json, e.g. the club's landuse=winter_sports polygon) or `{"name", "lonlat": [[lon, lat], ...]}`
    (a ring drawn by hand where OSM has neither tags nor a polygon).
Buildings, roads and the terrain stay: the slopes and their clearings are real, only the in-game runs and lifts go.
Pure helpers, tested in tests/test_osm_filter.py."""

PRIVATE = ("private", "no", "members")
ACCESS_KEYS = ("access", "aerialway:access", "piste:access")
SKI_KEYS = ("piste:type", "aerialway")


def is_private(tags):
    return any(tags.get(k) in PRIVATE for k in ACCESS_KEYS)


def inside(x, y, ring):
    """Even-odd point in polygon; ring is [[x, y], ...], closed or not."""
    hit = False
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]; x1, y1 = ring[(i + 1) % n]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


def exclude_areas(entries, ski, warn=print):
    """Config `exclude` entries -> [{"name", "ring": [[lon, lat], ...]}]; an osm_way missing from ski.json is warned."""
    ways = {el["id"]: el for el in ski.get("elements", []) if el.get("type") == "way"}
    areas = []
    for e in entries or []:
        if "lonlat" in e:
            areas.append({"name": e["name"], "ring": [list(map(float, p)) for p in e["lonlat"]]})
        elif "osm_way" in e:
            el = ways.get(e["osm_way"])
            if el is None or len(el.get("geometry", [])) < 4:
                warn(f"exclude area {e['name']}: OSM way {e['osm_way']} not in osm/ski.json")
                continue
            areas.append({"name": e["name"], "ring": [[p["lon"], p["lat"]] for p in el["geometry"]]})
    return areas


def excluded(el, areas):
    """Why a run or lift way is dropped ("access" or the area's name), or None to keep it."""
    if is_private(el.get("tags", {})):
        return "access"
    pts = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
    if not pts:
        return None
    for a in areas:
        if sum(inside(x, y, a["ring"]) for x, y in pts) * 2 > len(pts):
            return a["name"]
    return None


def filter_ski(ski, areas):
    """ski.json minus the excluded run and lift ways; returns (filtered copy, {reason: count})."""
    kept, dropped = [], {}
    for el in ski.get("elements", []):
        t = el.get("tags", {})
        if el.get("type") == "way" and any(k in t for k in SKI_KEYS):
            why = excluded(el, areas)
            if why:
                dropped[why] = dropped.get(why, 0) + 1
                continue
        kept.append(el)
    return {**ski, "elements": kept}, dropped
