"""DATA-020: tree species ids 0..7 and the shrub set."""
import os, sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import species as spc


def test_classify_vail_classes():
    c = spc.classify_evt
    assert c("Rocky Mountain Subalpine Dry-Mesic Spruce-Fir Forest and Woodland", "Tree")["group"] == spc.G_SPRUCE_FIR
    a = c("Rocky Mountain Aspen Forest and Woodland", "Tree")
    assert a["group"] == spc.G_ASPEN and a["aspen"] == 0.85
    assert c("Inter-Mountain Basins Aspen-Mixed Conifer Forest and Woodland", "Tree")["aspen"] == 0.5
    assert c("Rocky Mountain Lodgepole Pine Forest", "Tree")["group"] == spc.G_LODGEPOLE
    assert c("Southern Rocky Mountain Dry-Mesic Montane Mixed Conifer Forest and Woodland", "Tree")["group"] == spc.G_DOUGLAS
    assert c("Rocky Mountain Subalpine-Montane Limber-Bristlecone Pine Woodland", "Tree")["group"] == spc.G_LIMBER
    rip = c("Rocky Mountain Subalpine-Montane Riparian Woodland", "Tree")
    assert rip["group"] == spc.G_SPRUCE_FIR and rip["riparian"] and rip["forest"]
    urb = c("Western Cool Temperate Urban Evergreen Forest", "Tree")
    assert urb["group"] == spc.G_SPRUCE_FIR and urb["forest"] and not urb["open"]   # BUG-027: in-resort forest gets fill
    for nm, lf in (("Developed-Low Intensity", "Developed"), ("Developed-Medium Intensity", "Developed"), ("Developed-Roads", "Developed"),
                   ("Western Cool Temperate Urban Herbaceous", "Herb"), ("Western Cool Temperate Developed Shrubland", "Shrub")):
        d = c(nm, lf)
        assert not d["forest"] and not d["open"], nm        # unknown: the lidar canopy and NAIP decide
    for nm, lf in (("Rocky Mountain Subalpine-Montane Mesic Meadow", "Herb"), ("Inter-Mountain Basins Montane Sagebrush Steppe", "Shrub"),
                   ("Rocky Mountain Alpine Bedrock and Scree", "Sparse"), ("Open Water", "Water"),
                   ("Southern Rocky Mountain Montane-Subalpine Grassland", "Herb")):
        assert c(nm, lf)["open"], nm                         # truly open: no fill trees
    assert c("Inter-Mountain Basins Montane Sagebrush Steppe", "Shrub")["sage"]
    assert c("Rocky Mountain Gambel Oak-Mixed Montane Shrubland", "Shrub")["oak"]
    meadow = c("Rocky Mountain Subalpine-Montane Mesic Meadow", "Herb")
    assert meadow["group"] == spc.G_NONE and not meadow["forest"]
    assert c("Rocky Mountain Alpine Turf", "Herb")["alpine"]


def test_hash_is_stable_and_uniform():
    rng = np.random.default_rng(0)
    x, y = rng.uniform(-5000, 5000, 20000), rng.uniform(-5000, 5000, 20000)
    a, b = spc.hash01(x, y, 1), spc.hash01(x.copy(), y.copy(), 1)
    assert np.array_equal(a, b) and a.min() >= 0 and a.max() < 1
    assert abs(a.mean() - 0.5) < 0.01
    assert np.corrcoef(a, spc.hash01(x, y, 2))[0, 1] < 0.05       # salts are independent draws


def run(n=40000, elev=3000.0, group=spc.G_SPRUCE_FIR, chm=15.0, northeast=0.0, wet=0.0, ridge=False, aspen_frac=0.0,
        alpine=False, aspen_like=False, have_evt=True):
    rng = np.random.default_rng(1)
    x, y = rng.uniform(0, 3000, n), rng.uniform(0, 3000, n)
    f = lambda v, dt=np.float64: np.full(n, v, dt)
    return spc.assign_species(x, y, f(elev), f(chm), f(group, np.int8), f(aspen_frac), f(alpine, bool), f(aspen_like, bool),
                              f(northeast), f(wet), f(ridge, bool), rng.uniform(0, 1, n), have_evt)


def share(sp, k):
    return float(np.mean(sp == k))


def test_spruce_fir_split_by_elevation_and_moisture():
    hi = run(elev=3350)
    assert abs(share(hi, spc.SPRUCE) - 0.6) < 0.02 and abs(share(hi, spc.FIR) - 0.4) < 0.02
    lo = run(elev=2900)
    assert abs(share(lo, spc.FIR) - 0.5) < 0.02
    assert share(run(elev=2900, northeast=1.0, wet=1.0), spc.FIR) > 0.8
    assert share(run(elev=2900, northeast=-1.0), spc.FIR) < 0.4


def test_group_species():
    assert abs(share(run(group=spc.G_LODGEPOLE), spc.LODGEPOLE) - 0.85) < 0.02
    assert share(run(group=spc.G_DOUGLAS, elev=2700), spc.DOUGLAS) > 0.6
    assert share(run(group=spc.G_DOUGLAS, elev=3300), spc.DOUGLAS) == 0.0     # Douglas-fir only low
    assert abs(share(run(group=spc.G_ASPEN, aspen_frac=0.85, elev=2900), spc.ASPEN) - 0.85) < 0.02
    assert share(run(group=spc.G_ASPEN, aspen_frac=0.85, elev=3350), spc.ASPEN) == 0.0


def test_krummholz_and_limber():
    assert share(run(elev=3500, chm=3.0), spc.KRUMMHOLZ) == 1.0
    assert share(run(elev=3300, chm=3.0), spc.KRUMMHOLZ) == 0.0          # elevation alone (BUG-025)
    assert share(run(elev=3300, chm=3.0, alpine=True), spc.KRUMMHOLZ) == 1.0
    assert abs(share(run(elev=3300, chm=8.0, ridge=True), spc.LIMBER) - 0.5) < 0.02
    assert share(run(elev=3300, chm=14.0, ridge=True), spc.LIMBER) == 0.0
    assert share(run(elev=3100, chm=8.0, ridge=True), spc.LIMBER) == 0.0


def test_no_landfire_fallback():
    lo = run(elev=2900, have_evt=False)
    assert share(lo, spc.LODGEPOLE) > 0.5
    assert share(run(elev=3350, have_evt=False), spc.LODGEPOLE) == 0.0
    assert share(run(elev=2900, aspen_like=True, have_evt=False), spc.ASPEN) == 1.0


def test_crowns_and_snag_cap():
    assert np.allclose(spc.crown_radius([0, 1, 2, 3, 4, 5, 6, 7], [10] * 8), [1.3, 2.0, 5.0, 1.0, 0.9, 1.7, 3.5, 0.5])
    ndvi = np.linspace(0.14, -0.1, 1000)
    keep = spc.cap_snags(ndvi, 9700)
    assert len(keep) == 300 and keep.min() == 700                       # 300 / 10,000 = 3 %, the greyest
    assert len(spc.cap_snags(ndvi[:10], 9700)) == 10


def test_terrain_fields_aspect():
    # a plane falling to the north: row 0 is north and lowest
    h, w = 200, 200
    dem = np.tile((np.arange(h, dtype=np.float32) * 0.5)[:, None], (1, w))
    north, east, tpi_s, tpi_l = spc.terrain_fields(dem, 2.0)
    assert north[100, 100] > 0.99 and abs(east[100, 100]) < 0.01
    assert abs(tpi_l[100, 100]) < 0.5                                    # a plane has no ridge


def test_stream_distance():
    d = spc.stream_distance([[(0.0, 500.0), (1000.0, 500.0)]], 2.0, 0.0, 1000.0, 500, 500)
    assert d[250, 250] < 10 and 90 < d[200, 250] < 110                   # row 200 is 100 m north of the stream


def test_shrubs_cap_and_kinds():
    n = 200
    t = np.ones((n, n), bool); f = np.zeros((n, n), bool)
    ndvi = np.full((n, n), 0.6, np.float32)
    p = spc.shrub_probabilities(2.0, t, ndvi, t, t, t, t, t, t, t, f, t)
    tot = sum(p.values())
    assert np.all(tot <= 200 * 4e-4 + 1e-6)                             # 200 / ha cap
    dem = np.zeros((n, n), np.float32)
    recs = spc.sample_shrubs(p, 2.0, 0.0, 400.0, dem, np.random.default_rng(0))
    assert recs.shape[1] == 6 and set(np.unique(recs[:, 5]).astype(int)) <= {0, 1, 2, 3}
    ha = (n * 2.0) ** 2 / 1e4
    assert 150 < len(recs) / ha < 230
    w = recs[recs[:, 5] == spc.WILLOW]
    assert w[:, 3].min() >= 1.0 and w[:, 3].max() <= 3.0
    sage_only = spc.shrub_probabilities(2.0, t, np.full((n, n), 0.15, np.float32), f, f, f, f, f, f, t, f, f)
    assert sage_only[spc.SAGE].max() > 0 and sage_only[spc.JUNIPER].max() == 0
    # no canopy-free cells, no shrubs
    none = spc.shrub_probabilities(2.0, f, ndvi, t, t, t, t, t, t, t, t, t, low=f)
    assert sum(g.sum() for g in none.values()) == 0


def test_band_report_and_debug_png(tmp_path):
    sp = np.array([0, 0, 3, 4, 1, 7], np.int8); el = np.array([3000, 3050, 3100, 2900, 2950, 3250], np.float64)
    lines = spc.band_report(sp, el)
    assert lines[0].startswith("2800-3000 m") and "lodgepole 50.0%" in lines[0]
    p = tmp_path / "s.png"
    spc.debug_png(str(p), np.array([5.0, 95.0]), np.array([95.0, 5.0]), np.array([0, 4]), np.ones((50, 50), np.int8), 0.0, 100.0, 100, 100)
    assert p.exists()
