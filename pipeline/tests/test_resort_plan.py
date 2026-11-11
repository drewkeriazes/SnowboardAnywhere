"""FEAT-223: resort.py resolve and plan. Offline: the pure rules on small fixtures and a whole `plan` against fake
hosts. On Drew's PC, `SBA_NETWORK=1 python -m pytest tests/test_resort_plan.py` also plans Vail, Breckenridge and
Big Sky from their names against the real hosts and checks them against the hand-written configs, and resolves and
plans Boston Mills (the hosts are not reachable from CI or the cloud sandbox)."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import resort as R  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RESORTS = os.path.join(HERE, "..", "resorts")
NETWORK = os.environ.get("SBA_NETWORK") == "1"


# ------------------------------------------------------------------------------------------------ fixtures

def area(i, name, geom, lifts=1, site=None, iso="US-OH", region="Ohio", way=None):
    return {"type": "Feature", "geometry": geom, "properties": {
        "id": i, "name": name, "type": "skiArea", "status": "operating",
        "sources": [{"type": "openstreetmap", "id": f"way/{way}"}] if way else [],
        "websites": [site] if site else [],
        "places": [{"iso3166_2": iso, "iso3166_1Alpha2": iso[:2], "localized": {"en": {"region": region}}}],
        "statistics": {"lifts": {"byType": {"chair_lift": {"count": lifts}}},
                       "runs": {"byActivity": {"downhill": {"byDifficulty": {"easy": {"count": 2}}}}}}}}


def poly(x0, y0, x1, y1):
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def point(x, y):
    return {"type": "Point", "coordinates": [x, y]}


def member(area_id, coords, way):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {"id": f"m{way}", "sources": [{"type": "openstreetmap", "id": f"way/{way}"}],
                           "skiAreas": [{"type": "Feature", "properties": {"id": area_id}}]}}


def write_lines(path, feats):
    """OpenSkiData's layout: one feature per line inside a FeatureCollection"""
    with open(path, "w", encoding="utf-8") as f:
        f.write('{"type": "FeatureCollection", "features":[\n')
        f.write(",\n".join(json.dumps(x, separators=(",", ":")) for x in feats))
        f.write("\n]}\n")
    return str(path)


@pytest.fixture
def ohio(tmp_path):
    """Boston Mills and Brandywine (one website, 1.5 km apart), a far resort with the same name word, a lift-less
    cross-country centre next door, and a private club inside the box"""
    feats = [
        area("bm", "Boston Mills Ski Resort", poly(-81.5696, 41.2609, -81.5617, 41.2675), lifts=7,
             site="https://www.bmbw.com/", way=452323654),
        area("bw", "Brandywine Ski Resort", poly(-81.5629, 41.2811, -81.5482, 41.2881), lifts=9,
             site="https://www.bmbw.com/", way=391698033),
        area("xc", "Boston Nordic", point(-81.575, 41.262), lifts=0),
        area("far", "Mills Peak", point(-80.9, 41.9), lifts=3),
        area("club", "Peninsula Club", point(-81.560, 41.270), lifts=2, site="https://club.example"),
        area("copper", "Copperish", point(-81.52, 41.26), lifts=4, site="https://copperish.example"),
    ]
    lifts = [member("bm", [[-81.5687, 41.2615], [-81.5628, 41.2656]], 1),
             member("bw", [[-81.5572, 41.2819], [-81.5501, 41.2856]], 2),
             member("club", [[-81.5605, 41.2690], [-81.5598, 41.2702]], 3),
             member("copper", [[-81.522, 41.260], [-81.518, 41.262]], 4)]
    runs = [member("bm", [[-81.5690, 41.2610], [-81.5640, 41.2660]], 11),
            member("bw", [[-81.5571, 41.2816], [-81.5497, 41.2856]], 12),
            member("club", [[-81.5610, 41.2695], [-81.5600, 41.2700]], 13),
            member("xc", [[-81.5750, 41.2620], [-81.5740, 41.2630]], 14)]
    return feats, write_lines(tmp_path / "lifts.geojson", lifts), write_lines(tmp_path / "runs.geojson", runs)


# ------------------------------------------------------------------------------------------------ names, resolve

def test_names_and_slugs():
    assert R.norm("Les Arcs – Bourg-Saint-Maurice") == "les arcs bourg saint maurice"
    assert R.norm("Sölden") == "solden"
    assert R.short_name("Big Sky Resort") == "Big Sky"
    assert R.short_name("Boston Mills Ski Resort") == "Boston Mills"
    assert R.short_name("Copper Mountain") == "Copper Mountain"      # "Mountain" is part of the name
    assert R.slugify("Breckenridge Ski Resort") == "breckenridge"
    assert R.slugify("Boston Mills Ski Resort") == "boston-mills"


def test_search_prefers_exact_then_words_then_substrings(ohio):
    feats = ohio[0]
    assert [f["properties"]["id"] for f in R.search(feats, "boston mills")] == ["bm"]
    assert [f["properties"]["id"] for f in R.search(feats, "Boston Mills Ski Resort")] == ["bm"]
    assert sorted(f["properties"]["id"] for f in R.search(feats, "mills")) == ["bm", "far"]
    assert [f["properties"]["id"] for f in R.search(feats, "brandy")] == ["bw"]
    assert R.search(feats, "zermatt") == []
    assert "Boston Mills Ski Resort" in R.closest_names(feats, "Bostn Mils Ski Resort")


def test_resolve_asks_about_a_neighbour_sold_with_it(ohio):
    feats, lifts, runs = ohio
    st, r = R.resolve("Boston Mills", feats, lifts, runs)
    assert st == "neighbours"
    names = [f["properties"]["name"] for f, _ in r["near"]]
    # Brandywine: same website, 1.5 km. The club: inside the box. Not the lift-less XC centre, not Copperish
    # (2.3 km, its own website, outside the 500 m buffer + 500 m)
    assert names == ["Peninsula Club", "Brandywine Ski Resort"]


def test_resolve_with_merges_and_alone_excludes(ohio):
    feats, lifts, runs = ohio
    st, r = R.resolve("Boston Mills", feats, lifts, runs, with_=["Brandywine"], alone=True)
    assert st == "ok"
    assert r["name"] == "Boston Mills / Brandywine" and r["slug"] == "boston-mills"
    assert r["openskidata"]["ids"] == ["bm", "bw"] and r["osm_ski_area_way"] == 452323654
    assert r["lonlat_bbox"] == [-81.5696, 41.2609, -81.5482, 41.2881]      # both polygons and their members
    assert r["region"] == "Ohio" and r["country"] == "US" and r["openskidata"]["iso3166_2"] == "US-OH"
    assert r["exclude"] == [{"name": "Peninsula Club", "openskidata_id": "club", "osm_ways": [3, 13]}]
    st, r = R.resolve("Boston Mills", feats, lifts, runs, with_=["Brandywine"])
    assert st == "neighbours"                                               # the club is still unanswered


def test_resolve_none_many_and_bad_with(ohio):
    feats, lifts, runs = ohio
    assert R.resolve("Bostn Mils", feats, lifts, runs)[0] == "none"
    st, r = R.resolve("mills", feats, lifts, runs)
    assert st == "many" and len(r["matches"]) == 2
    assert R.resolve("x", feats, lifts, runs, pick_id="bm", with_=["Mills Peak"])[0] == "none"   # not a neighbour
    st, r = R.resolve("x", feats, lifts, runs, pick_id="far")
    assert st == "ok" and r["name"] == "Mills Peak"


def test_a_lifted_area_wins_over_an_abandoned_one_of_the_same_name(tmp_path):
    feats = [area("a", "Whistler Blackcomb", point(-122.9, 50.1), lifts=36),
             area("b", "Whistler's", point(-118.1, 52.9), lifts=0)]
    lifts = write_lines(tmp_path / "l.geojson", [])
    st, r = R.resolve("Whistler", feats, lifts, lifts)
    assert st == "ok" and r["openskidata"]["ids"] == ["a"]


def test_stream_members_reads_only_matching_lines(ohio):
    _, lifts, runs = ohio
    m = R.stream_members(runs, ["bw", "nobody"])
    assert m["bw"]["n"] == 1 and m["bw"]["osm"] == [12] and m["bw"]["bounds"] == [-81.5571, 41.2816, -81.5497, 41.2856]
    assert m["nobody"] == {"bounds": None, "osm": [], "n": 0}


# ------------------------------------------------------------------------------------------------ plan rules

def test_utm_zone_and_datum():
    assert R.utm_for(-106.35, 39.6, "US") == ("EPSG:26913", "13N")     # Vail
    assert R.utm_for(-111.41, 45.28, "US") == ("EPSG:26912", "12N")    # Big Sky
    assert R.utm_for(-81.56, 41.27, "US") == ("EPSG:26917", "17N")     # Boston Mills
    assert R.utm_for(-122.93, 50.08, "CA") == ("EPSG:32610", "10N")    # outside the US: WGS84
    assert R.utm_for(148.4, -36.4, "AU") == ("EPSG:32755", "55S")


def test_buffer_scales_with_the_area_and_is_capped():
    assert R.buffer_for(13500) == 1000       # Vail: 0.3 x 13.5 km is 4 km, capped at every hand config's 1 km
    assert R.buffer_for(1000) == 500         # Boston Mills alone
    assert R.buffer_for(2400) == 700


def test_buffered_box_and_origin():
    box, origin = R.buffered([378560.2, 4379420.0, 389040.0, 4389055.0], 1000)
    assert box == [377500, 4378400, 390100, 4390100]
    assert origin == [383800, 4384250]
    assert R.elevation_range(2408.2, 3603.1) == [2400, 3650]


def test_dataset_year_and_dem_project():
    assert R.dataset_year("USGS_LPC_CO_Central_Western_2016_LAS_2018") == 2016
    assert R.dataset_year("MT_StatewideP4_5_B22") == 2022
    assert R.dataset_year("OH_Statewide_Phase1_1_2019") == 2019
    assert R.dem_project("USGS 1 Meter 17 x45y457 OH_Statewide_Phase1_2019_B19") == "OH_Statewide_Phase1_2019_B19"
    assert R.dem_project("USGS one meter x37y438 CO Central Western 2016") == "CO_Central_Western_2016"


def test_dem_cover_joins_abutting_tiles_but_not_a_missing_one():
    box = [0.0, 0.0, 0.2, 0.2]
    tile = lambda x0, y0, x1, y1: {"boundingBox": {"minX": x0, "minY": y0, "maxX": x1, "maxY": y1}}
    slivers = [tile(0, 0, 0.1, 0.099), tile(0, 0.1015, 0.1, 0.2), tile(0.1, 0, 0.2, 0.099), tile(0.1, 0.1015, 0.2, 0.2)]
    assert R.dem_cover(slivers, box) == pytest.approx(1.0)
    assert R.dem_cover(slivers[:3], box) < 0.8


def test_pick_lidar_main_then_the_strip_it_misses():
    from shapely.geometry import box as sbox
    box = [0.0, 0.0, 1.0, 1.0]
    main = {"name": "MT_P4", "geometry": sbox(-1, -1, 0.86, 2), "density": 4.0, "year": 2022}
    east = {"name": "MT_P3", "geometry": sbox(0.7, -1, 3, 2), "density": 2.0, "year": 2021}
    old = {"name": "OLD_2006", "geometry": sbox(-1, -1, 0.5, 2), "density": 1.0, "year": 2006}
    got = R.pick_lidar([east, old, main], box)
    assert [c["name"] for c, _, _ in got] == ["MT_P4", "MT_P3"]
    assert got[0][1] == pytest.approx(0.86) and got[1][1] == pytest.approx(0.14)
    assert got[1][2].bounds == pytest.approx((0.86, 0.0, 1.0, 1.0))      # the extra fills only the missing strip
    # near-equal cover: the newer dataset wins
    new = {"name": "NEW_2020", "geometry": sbox(-1, -1, 2, 2), "density": 2.0, "year": 2020}
    older = {"name": "OLD_2012", "geometry": sbox(-1, -1, 2, 2), "density": 9.0, "year": 2012}
    assert [c["name"] for c, _, _ in R.pick_lidar([older, new], box)] == ["NEW_2020"]
    assert R.pick_lidar([], box) == []


def test_ept_depth_from_node_spacing():
    co = {"bounds": [-11953276, 4118406, -100, -11464468, 4607214, 0], "span": 256, "srs": {"horizontal": "3857"}}
    p3 = {"bounds": [0, 0, 0, 410438, 410438, 0], "span": 128, "srs": {"horizontal": "3857"}}
    oh = {"bounds": [0, 0, 0, 383906, 383906, 0], "span": 128, "srs": {"horizontal": "3857"}}
    assert R.ept_depth(co, 39.6)[0] == 9                     # Vail's validated depth, 2.9 m
    assert R.ept_depth(co, 39.6)[1] == pytest.approx(2.87, abs=0.01)
    assert R.ept_depth(p3, 45.3)[0] == 10                    # 4.4 m at depth 9 is coarser than Vail's
    assert R.ept_depth(oh, 41.3, R.FAR_SPACING_M)[0] == 9    # the far ring takes 4.4 m
    utm = {"bounds": [0, 0, 0, 1000, 1000, 0], "span": 128, "srs": {"horizontal": "26913"}}
    assert R.ept_depth(utm, 39.6)[0] == 2                    # metres already on the ground: no cos(lat)


def test_flight_season():
    ms = lambda *d: __import__("datetime").datetime(*d, tzinfo=__import__("datetime").timezone.utc).timestamp() * 1000
    assert R.season(ms(2019, 11, 9), ms(2020, 5, 2)) == {"from": "2019-11", "to": "2020-05", "leaf": "leaf-off"}
    assert R.season(ms(2016, 5, 28), ms(2016, 10, 7))["leaf"] == "leaf-on"
    assert R.season(ms(2021, 9, 1), ms(2022, 8, 30))["leaf"] == "mixed"
    assert R.season(None, None) is None


def test_match_workunit():
    units = [{"workunit": "CO_Central_Western_2016"}, {"workunit": "OH_Statewide_Phase1_1_2019"}]
    assert R.match_workunit("USGS_LPC_CO_Central_Western_2016_LAS_2018", units)["workunit"] == "CO_Central_Western_2016"
    assert R.match_workunit("OH_Statewide_Phase1_1_2019", units)["workunit"] == "OH_Statewide_Phase1_1_2019"
    assert R.match_workunit("MT_StatewideP4_5_B22", units) is None


def naip_item(i, bbox, year, gsd=0.6):
    return {"id": i, "bbox": bbox, "properties": {"datetime": f"{year}-09-21T16:00:00Z", "naip:year": year, "gsd": gsd}}


def test_pick_naip_newest_per_quarter_quad():
    # a 2 x 1 quarter quad box near Big Sky; the east one has no 2021 image
    w, e = [-111.44, 45.25, -111.37, 45.31], [-111.38, 45.25, -111.31, 45.31]
    items = [naip_item("mt_m_4511145_se_12_060_20210921", w, 2021), naip_item("mt_m_4511145_se_12_060_20190720", w, 2019),
             naip_item("mt_m_4511146_sw_12_060_20190720_20200107", e, 2019),
             naip_item("mt_m_4511146_sw_12_1_20150910", e, 2015, 1.0),
             naip_item("mt_m_4511199_nw_12_060_20210921", [-111.0, 46.0, -110.9, 46.1], 2021)]   # off the box
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", "EPSG:26912", always_xy=True)
    (x0, y0), (x1, y1) = tr.transform(-111.43, 45.26), tr.transform(-111.32, 45.30)
    got = R.pick_naip(items, [x0, y0, x1, y1], "EPSG:26912")
    assert [t[0] for t in got] == ["mt_m_4511145_se_12_060_20210921", "mt_m_4511146_sw_12_060_20190720_20200107"]
    assert got[0][1] == [-111.44, 45.25, -111.37, 45.31]
    src, year = R.naip_source(got + [("mt_m_x_ne_12_060_20210921", w, 2021, 0.6)])
    assert year == 2021
    assert src == "Planetary Computer naip 2021 60cm (1 quarter quad from 2019 where 2021 has none)"


def test_geofabrik_terrain_status_attribution_tier():
    idx = {"features": [{"properties": {"id": "us", "iso3166-1:alpha2": ["US"], "urls": {"pbf": "u/us.pbf"}}},
                        {"properties": {"id": "us/ohio", "iso3166-2": ["US-OH"], "urls": {"pbf": "u/ohio.pbf"}}}]}
    assert R.geofabrik_for("US-OH", "US", idx) == ("us/ohio", "u/ohio.pbf")
    assert R.geofabrik_for("US-ZZ", "US", idx) == ("us", "u/us.pbf")
    assert R.geofabrik_for(None, "FR", idx) == (None, None)
    assert R.terrain_status_url("https://www.vail.com") == \
        "https://www.vail.com/the-mountain/mountain-conditions/terrain-and-lift-status.aspx"
    assert R.terrain_status_url("https://bmbw.com/").startswith("https://www.bmbw.com/the-mountain/")
    a = R.attribution(["CO_Central_Western_2016"], ["A", "B"], [2021, 2021, 2019])
    assert a[0] == "Elevation: USGS 3DEP 1 m lidar DEM (CO_Central_Western_2016), public domain"
    assert "point clouds A and B" in a[1] and "NAIP 2021 (2019 where 2021 has none)" in a[2]
    assert R.tier_of({"terrain": "gold", "trees": "gold", "surface": "gold"}) == ("gold", [])
    assert R.tier_of({"terrain": "gold", "trees": "silver", "surface": "gold"}) == ("silver", ["trees"])


def test_compare_lists_differences():
    hand = json.load(open(os.path.join(RESORTS, "vail.json"), encoding="utf-8"))
    assert R.compare(hand, hand) == []
    d = json.loads(json.dumps(hand))
    d["crs"] = "EPSG:26912"
    d["utm_bbox"] = [v + (1500 if k == 0 else 0) for k, v in enumerate(d["utm_bbox"])]
    d["lidar"]["dataset"] = "OTHER"
    out = R.compare(d, hand)
    assert any(x.startswith("crs:") for x in out)
    assert any("MORE than one buffer step" in x for x in out if x.startswith("utm_bbox"))
    assert any(x.startswith("lidar datasets") for x in out)


def test_keep_hand_fields():
    new = {"slug": "vail", "start_run": None, "exclude": [{"name": "Club", "osm_ways": [1]}]}
    old = {"start_run": "Born Free", "grooming_aliases": {"a": "b"}, "exclude": [{"name": "Drawn", "lonlat": []}]}
    got = R.keep_hand_fields(new, old)
    assert got["start_run"] == "Born Free" and got["grooming_aliases"] == {"a": "b"}
    assert [e["name"] for e in got["exclude"]] == ["Club", "Drawn"]


# ------------------------------------------------------------------------------------------------ plan, fake hosts

class FakeHosts:
    """Boston Mills-like answers: one EPT dataset over the box, 1 m DEM, NAIP 2023 with one 2021 quarter quad"""

    def __init__(self, tmp):
        self.tmp = tmp
        ent = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "geometry": poly(-82.0, 41.0, -81.0, 41.6),
             "properties": {"name": "OH_Statewide_Phase1_1_2019", "count": 10 ** 9,
                            "url": "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/OH_Statewide_Phase1_1_2019/ept.json"}},
            {"type": "Feature", "geometry": poly(10.0, 60.0, 11.0, 61.0),
             "properties": {"name": "FAR_AWAY", "count": 1, "url": "https://x/FAR_AWAY/ept.json"}}]}
        geo = {"features": [{"properties": {"id": "us/ohio", "iso3166-2": ["US-OH"], "urls": {"pbf": "https://g/ohio.pbf"}}}]}
        self.files = {"entwine_resources.geojson": ent, "geofabrik_index.json": geo}

    def index(self, name):
        p = os.path.join(self.tmp, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(self.files[name], f)
        return p

    def elevation(self, box_ll, z=12):
        return 193.0, 311.6

    def dem_1m(self, box_ll):
        x0, y0, x1, y1 = box_ll
        return [{"title": "USGS 1 Meter 17 x45y457 OH_Statewide_Phase1_2019_B19",
                 "boundingBox": {"minX": x0 - 0.1, "minY": y0 - 0.1, "maxX": x1 + 0.1, "maxY": y1 + 0.1}}]

    def workunits(self, box_ll):
        return [{"workunit": "OH_Statewide_Phase1_1_2019", "ql": "QL 1",
                 "collect_start": 1573257600000, "collect_end": 1588377600000}]

    def ept(self, url):
        return {"bounds": [0, 0, 0, 383906, 383906, 0], "span": 128, "srs": {"horizontal": "3857"}}

    def naip(self, box_ll):
        x0, y0, x1, y1 = box_ll
        xm = (x0 + x1) / 2
        return [naip_item("oh_m_4108117_ne_17_030_20230801", [x0 - 0.01, y0 - 0.01, xm, y1 + 0.01], 2023, 0.3),
                naip_item("oh_m_4108118_nw_17_060_20210801", [xm, y0 - 0.01, x1 + 0.01, y1 + 0.01], 2021),
                naip_item("oh_m_4108118_nw_17_060_20190801", [xm, y0 - 0.01, x1 + 0.01, y1 + 0.01], 2019)]

    def archived(self, url):
        return False

    def nodes(self, cfg, src, far=False, have=()):
        return (["9-1-1-0", "9-1-2-0"], 2_000_000) if far else (["0-0-0-0", "10-5-5-0"], 1_000_000)


def test_plan_against_fake_hosts(tmp_path):
    stub = {"slug": "boston-mills", "name": "Boston Mills / Brandywine", "country": "US", "region": "Ohio",
            "osm_ski_area_way": 452323654, "lonlat_bbox": [-81.5696, 41.2609, -81.5482, 41.2881],
            "openskidata": {"ids": ["bm", "bw"], "iso3166_2": "US-OH", "websites": ["https://www.bmbw.com/"]},
            "exclude": [{"name": "Club", "osm_ways": [3]}]}
    logs = []
    cfg, facts, nodes = R.plan(stub, FakeHosts(str(tmp_path)), log=logs.append)
    assert cfg["crs"] == "EPSG:26917" and cfg["utm_zone"] == "17N"
    assert cfg["buffer_m"] == 1000                           # 3.5 km across: 0.3 x 3.5 km
    x0, y0, x1, y1 = cfg["utm_bbox"]
    assert all(v % 100 == 0 for v in cfg["utm_bbox"]) and 3800 < x1 - x0 < 4100 and 4900 < y1 - y0 < 5300
    assert cfg["origin"] == [round((x0 + x1) / 100) * 50, round((y0 + y1) / 100) * 50]
    assert cfg["elevation_range_m"] == [150, 350]
    assert cfg["dem"] == R.DEM and facts["dem"]["projects"] == ["OH_Statewide_Phase1_2019_B19"]
    L = cfg["lidar"]
    assert L["dataset"] == "OH_Statewide_Phase1_1_2019"
    assert L["ept"] == "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/OH_Statewide_Phase1_1_2019/"
    assert (L["max_depth_resort"], L["max_depth_outside"]) == (10, 9)
    assert L["far"] == {"pad_m": 5000, "max_depth": 9, "nodes_file": "boston-mills_ept_far_nodes.txt"}
    assert "extra" not in L
    assert facts["lidar"][0]["season"]["leaf"] == "leaf-off" and facts["lidar"][0]["ql"] == "QL 1"
    assert cfg["naip"]["items"] == ["oh_m_4108117_ne_17_030_20230801", "oh_m_4108118_nw_17_060_20210801"]
    assert cfg["naip"]["source"].startswith("Planetary Computer naip 2023 30cm (1 quarter quad from 2021")
    assert cfg["osm"] == {"geofabrik": "us/ohio", "pbf": "https://g/ohio.pbf"}
    assert "terrain_status_url" not in cfg and cfg["start_run"] is None
    assert cfg["exclude"] == stub["exclude"] and cfg["openskidata"] == stub["openskidata"]
    assert cfg["tier"] == "gold" and facts["tier_why"] == []
    assert nodes == {"boston-mills_ept_nodes.txt": ["0-0-0-0", "10-5-5-0"],
                     "boston-mills_ept_far_nodes.txt": ["9-1-1-0", "9-1-2-0"]}
    m = facts["manifest"]
    assert m["ept"] == (3, 1_000_000 * R.BYTES["ept_pt"])     # ept.json + 2 nodes, sized by points
    assert m["ept_far"] == (2, 2_000_000 * R.BYTES["ept_pt"])
    assert m["dem1m"][0] == 12 and m["dem10m"][0] == 4 and m["naip1m"][0] >= 2 and m["osm"][0] == 5
    assert any("leaf-off" in n for n in facts["notes"]) and any("no archived" in n for n in facts["notes"])
    md = R.plan_md(cfg, facts)
    assert "**Tier: gold**" in md and "| Lidar | EPT OH_Statewide_Phase1_1_2019 (100% of the box, QL 1" in md
    assert "2019-11 to 2020-05, leaf-off" in md and "Club: 1 run and lift ways by OSM id" in md
    # the config is one gen_manifest.py can read
    import gen_manifest
    d = tmp_path / "resorts"
    d.mkdir()
    for k, v in nodes.items():
        (d / k).write_text(" ".join(v))
    items = gen_manifest.manifest_items(cfg, str(d))
    assert sum(1 for i in items if i["path"].startswith("ept_far/")) == 2


def test_plan_without_lidar_is_silver(tmp_path):
    h = FakeHosts(str(tmp_path))
    h.files["entwine_resources.geojson"]["features"] = []
    stub = {"slug": "x", "name": "X", "country": "US", "lonlat_bbox": [-81.5696, 41.2609, -81.5482, 41.2881],
            "openskidata": {"iso3166_2": "US-OH", "websites": []}}
    cfg, facts, nodes = R.plan(stub, h, log=lambda *a: None)
    assert "lidar" not in cfg and nodes == {}
    assert cfg["tier"] == "silver" and facts["tier_why"] == ["trees"]
    assert "ept" not in facts["manifest"]


# ------------------------------------------------------------------------------------------------ real hosts

@pytest.fixture(scope="module")
def hosts():
    cache = os.environ.get("SBA_INDEX_DIR", os.path.join(HERE, "..", "..", "raw", "_index"))
    return R.Hosts(cache)


@pytest.mark.skipif(not NETWORK, reason="needs the data hosts (Drew's PC): SBA_NETWORK=1")
@pytest.mark.parametrize("slug", ["vail", "breckenridge", "bigsky"])
def test_plan_reproduces_the_hand_configs(slug, hosts):
    hand = json.load(open(os.path.join(RESORTS, f"{slug}.json"), encoding="utf-8"))
    stub = R.resolve_hand(hand, hosts, log=lambda *a: None)
    cfg, facts, _ = R.plan(stub, hosts, walk_nodes=False, log=lambda *a: None)
    print(f"\n{slug}:", *R.compare(cfg, hand), sep="\n  ")
    assert cfg["crs"] == hand["crs"] and cfg["utm_zone"] == hand["utm_zone"]
    lid = lambda c: [c["lidar"]["dataset"]] + [e["dataset"] for e in c["lidar"].get("extra", [])]
    assert lid(cfg) == lid(hand)
    assert R.naip_years(cfg) == R.naip_years(hand)
    # every edge within one buffer step of the hand box, or inside it (Breckenridge's hand box was drawn 1.6 km
    # wider than its runs and lifts on three sides)
    b, h = cfg["utm_bbox"], hand["utm_bbox"]
    step = max(cfg["buffer_m"], hand["buffer_m"])
    for i in range(4):
        inside = b[i] >= h[i] if i < 2 else b[i] <= h[i]
        assert abs(b[i] - h[i]) <= step or inside, (i, b, h)
    assert cfg["tier"] == "gold"


@pytest.mark.skipif(not NETWORK, reason="needs the data hosts (Drew's PC): SBA_NETWORK=1")
def test_boston_mills(hosts):
    feats = R.load_json(hosts.index("ski_areas.geojson"))["features"]
    lifts, runs = hosts.index("lifts.geojson"), hosts.index("runs.geojson")
    st, r = R.resolve("Boston Mills", feats, lifts, runs)
    assert st == "neighbours" and [f["properties"]["name"] for f, _ in r["near"]] == ["Brandywine Ski Resort"]
    st, stub = R.resolve("Boston Mills", feats, lifts, runs, with_=["Brandywine"])
    assert st == "ok" and stub["name"] == "Boston Mills / Brandywine"
    cfg, facts, _ = R.plan(stub, hosts, walk_nodes=False, log=lambda *a: None)
    assert cfg["crs"] == "EPSG:26917" and cfg["utm_zone"] == "17N"
    assert any(p.startswith("OH_Statewide_Phase1_2019") for p in facts["dem"]["projects"])
    assert facts["dem"]["cover"] >= R.COVERED and cfg["tier"] == "gold"
    assert cfg["lidar"]["dataset"].startswith("OH_Statewide_Phase1")
