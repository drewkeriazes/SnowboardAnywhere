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
        alpine=False, aspen_like=False, have_evt=True, naip=None):
    rng = np.random.default_rng(1)
    x, y = rng.uniform(0, 3000, n), rng.uniform(0, 3000, n)
    f = lambda v, dt=np.float64: np.full(n, v, dt)
    return spc.assign_species(x, y, f(elev), f(chm), f(group, np.int8), f(aspen_frac), f(alpine, bool), f(aspen_like, bool),
                              f(northeast), f(wet), f(ridge, bool), rng.uniform(0, 1, n), have_evt,
                              None if naip is None else f(naip, bool))


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


def test_lf_cover_and_height_from_class_names():
    """DATA-010: LANDFIRE EVC and EVH values come from the class names (LF 2024 has 1 % and 1 m classes)."""
    assert abs(spc.lf_tree_cover("Tree Cover = 45%") - 0.45) < 1e-6
    assert abs(spc.lf_tree_cover("Tree Cover >= 10 and < 20%") - 0.15) < 1e-6     # older range classes: the midpoint
    for nm in ("Shrub Cover = 40%", "Herb Cover = 20%", "Developed-Upland Evergreen Forest", "Open Water", "Sparse Vegetation Canopy"):
        assert np.isnan(spc.lf_tree_cover(nm)), nm
    assert spc.lf_tree_height("Tree Height = 17 meters") == 17
    assert spc.lf_tree_height("Tree Height = 1 meter") == 1
    assert spc.lf_tree_height("Tree Height >= 25 meters") == 25
    assert np.isnan(spc.lf_tree_height("Shrub Height = 1.5 meters"))
    table = [{"VALUE": "145", "CLASSNAMES": "Tree Cover = 45%"}, {"VALUE": "14", "CLASSNAMES": "Developed-Upland Evergreen Forest"},
             {"VALUE": "999", "CLASSNAMES": "Tree Cover = 99%"}]          # out of range: ignored
    lut = spc.lf_value_lut(table, 200, spc.lf_tree_cover)
    assert lut.dtype == np.float32 and abs(lut[145] - 0.45) < 1e-6 and np.isnan(lut[14]) and np.isnan(lut[0])


def test_classify_montana_classes():
    """DATA-021: Big Sky's Northern and Middle Rocky Mountain classes"""
    c = spc.classify_evt
    park = c("Northern Rocky Mountain Subalpine Woodland and Parkland", "Tree")   # whitebark pine and subalpine fir at treeline
    assert park["group"] == spc.G_LIMBER and park["forest"]
    assert c("Northern Rocky Mountain Whitebark Pine Woodland", "Tree")["group"] == spc.G_LIMBER
    assert c("Middle Rocky Mountain Montane Douglas-fir Forest and Woodland", "Tree")["group"] == spc.G_DOUGLAS
    assert c("Northern Rocky Mountain Dry-Mesic Montane Mixed Conifer Forest", "Tree")["group"] == spc.G_DOUGLAS
    assert c("Rocky Mountain Subalpine Mesic-Wet Spruce-Fir Forest and Woodland", "Tree")["group"] == spc.G_SPRUCE_FIR
    assert c("Rocky Mountain Poor-Site Lodgepole Pine Forest", "Tree")["group"] == spc.G_LODGEPOLE
    assert c("Northern Rocky Mountain Avalanche Chute Shrubland", "Shrub")["open"]


# ------------------------------------------------------------------ DATA-015: built classes and the NAIP aspen fit
TABLE = [{"VALUE": "1", "EVT_NAME": "Rocky Mountain Lodgepole Pine Forest", "EVT_LF": "Tree"},
         {"VALUE": "2", "EVT_NAME": "Rocky Mountain Subalpine Dry-Mesic Spruce-Fir Forest and Woodland", "EVT_LF": "Tree"},
         {"VALUE": "3", "EVT_NAME": "Western Cool Temperate Urban Evergreen Forest", "EVT_LF": "Tree"},
         {"VALUE": "4", "EVT_NAME": "Developed-Low Intensity", "EVT_LF": "Developed"},
         {"VALUE": "5", "EVT_NAME": "Western Cool Temperate Urban Deciduous Forest", "EVT_LF": "Tree"},
         {"VALUE": "6", "EVT_NAME": "Rocky Mountain Subalpine-Montane Mesic Meadow", "EVT_LF": "Herb"}]


def test_built_flag():
    c = spc.classify_evt
    assert c("Western Cool Temperate Urban Evergreen Forest", "Tree")["built"]
    assert c("Developed-Roads", "Developed")["built"] and c("Western Cool Temperate Urban Herbaceous", "Herb")["built"]
    assert not c("Western Cool Temperate Urban Deciduous Forest", "Tree")["built"]      # deciduous: aspen already
    assert not c("Rocky Mountain Lodgepole Pine Forest", "Tree")["built"]
    assert not c("Rocky Mountain Subalpine-Montane Mesic Meadow", "Herb")["built"]


def test_natural_evt_fills_built_from_the_stands_around():
    lut = spc.evt_luts(TABLE, 7)
    img = np.full((60, 60), 6, np.int32)                  # meadow
    img[:, :30] = 1                                       # lodgepole west
    img[:, 30:] = 2                                       # spruce-fir east
    img[20:40, 5:15] = 3                                  # urban evergreen inside the lodgepole
    img[20:40, 45:55] = 4                                 # developed inside the spruce-fir
    img[0:4, 28:32] = 5                                   # urban deciduous stays
    out, filled, lp_share = spc.natural_evt(img, lut)
    assert (out[20:40, 5:15] == 1).mean() > 0.95 and (out[20:40, 45:55] == 2).mean() > 0.95
    assert filled[20:40, 5:15].all() and not filled[0:4, 28:32].any()
    assert (out[0:4, 28:32] == 5).all() and (out[img < 3] == img[img < 3]).all()
    assert lp_share[30, 10] > 0.95 and lp_share[30, 50] < 0.05 and 0.3 < lp_share[30, 30] < 0.7
    assert np.array_equal(out, spc.natural_evt(img, lut)[0])                     # stable between builds
    # on the boundary the draw is a mix of both sides
    img2 = img.copy(); img2[:, 27:33] = 3
    mid = spc.natural_evt(img2, lut)[0][:, 27:33]
    assert 0.2 < (mid == 1).mean() < 0.8 and set(np.unique(mid)) <= {1, 2}
    # no natural forest near: the built class stays
    far = np.full((80, 80), 6, np.int32); far[:, :3] = 1; far[30:50, 60:75] = 4
    o, f, _ = spc.natural_evt(far, lut)
    assert (o[30:50, 60:75] == 4).all() and not f[30:50, 60:75].any()


def test_fit_aspen_and_canopy_mean():
    rng = np.random.default_rng(2)
    canopy = np.ones((200, 200), bool); canopy[::3] = False
    a = np.where(canopy, 100.0, 0.0)
    assert np.allclose(spc.canopy_mean(a, canopy)[5:-5, 5:-5], 100.0, atol=0.5)   # gaps don't darken the stand
    asp = np.zeros((300, 300), bool); asp[:, :150] = True
    con = ~asp
    bright = np.where(asp, rng.normal(70, 5, asp.shape), rng.normal(50, 5, asp.shape)).astype(np.float32)
    nir = np.where(asp, rng.normal(157, 15, asp.shape), rng.normal(110, 15, asp.shape)).astype(np.float32)
    tb, tn, info = spc.fit_aspen(bright, nir, asp, con)
    assert info["fitted"] and 55 < tb < 65 and 120 < tn < 145
    assert info["hit"] > 0.8 and info["false"] < 0.05
    tb, tn, info = spc.fit_aspen(bright, nir, asp & (np.arange(300) < 10)[:, None] & (np.arange(300) < 10)[None], con)
    assert not info["fitted"] and (tb, tn) == spc.ASPEN_DEFAULT


def test_naip_decides_aspen_on_built_classes():
    # a built pixel in an aspen-class neighbourhood: NAIP says no aspen canopy -> conifer
    assert share(run(elev=2900, group=spc.G_ASPEN, aspen_frac=0.85, naip=True), spc.ASPEN) == 0.0
    # NAIP sees aspen canopy -> the aspen class's share, whatever the filled group
    s = run(elev=2900, group=spc.G_LODGEPOLE, aspen_like=True, naip=True)
    assert abs(share(s, spc.ASPEN) - spc.NAIP_ASPEN_SHARE) < 0.02 and share(s, spc.LODGEPOLE) > 0.1
    assert share(run(elev=3350, aspen_like=True, naip=True), spc.ASPEN) == 0.0   # not above the aspen line
    # natural classes keep the LANDFIRE share
    assert abs(share(run(elev=2900, group=spc.G_ASPEN, aspen_frac=0.85, naip=False), spc.ASPEN) - 0.85) < 0.02


def test_naip_conifer_group():
    g = np.array([spc.G_SPRUCE_FIR, spc.G_LODGEPOLE, spc.G_SPRUCE_FIR, spc.G_SPRUCE_FIR, spc.G_ASPEN, spc.G_LODGEPOLE])
    lp = np.array([0.5, 0.5, 0.5, 0.02, 0.5, 0.5])
    like = np.array([True, False, True, True, True, True])
    nd = np.array([True, True, False, True, True, True])
    out = spc.naip_conifer_group(g, lp, like, nd)
    # NAIP picks on built classes with lodgepole around; natural classes, no lodgepole nearby and aspen keep theirs
    assert list(out) == [spc.G_LODGEPOLE, spc.G_SPRUCE_FIR, spc.G_SPRUCE_FIR, spc.G_SPRUCE_FIR, spc.G_ASPEN, spc.G_LODGEPOLE]
    rng = np.random.default_rng(3)
    lpc = np.zeros((300, 300), bool); lpc[:, :150] = True
    ndvi = np.where(lpc, rng.normal(0.44, 0.03, lpc.shape), rng.normal(0.53, 0.03, lpc.shape)).astype(np.float32)
    t, info = spc.fit_lodgepole(ndvi, lpc, ~lpc)
    assert info["fitted"] and 0.46 < t < 0.51 and info["hit"] > 0.8
    assert spc.fit_lodgepole(ndvi, lpc & False, ~lpc)[0] is None
    # imagery with no NDVI split (Big Sky): no threshold, and the groups stay as drawn
    flat = rng.normal(0.5, 0.03, lpc.shape).astype(np.float32)
    t, info = spc.fit_lodgepole(flat, lpc, ~lpc)
    assert t is None and info["weak"]
    assert list(spc.naip_conifer_group(g, lp, None, nd)) == list(g)
    # the same guard on the aspen fit falls back to Vail's thresholds
    tb, tn, info = spc.fit_aspen(flat * 100, flat * 200, lpc, ~lpc)
    assert (tb, tn) == spc.ASPEN_DEFAULT and info["weak"] and not info["fitted"]
