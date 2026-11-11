"""Tree species ids 0..7 and the shrub set (DATA-020).

Pure helpers for `build_pack.py` stage 8, kept here so they can be tested without a pack build.

Species ids (Float32 field 5 of `trees/<tx>_<ty>.bin`, `meta.treeSpecies` = 2):
  0 Engelmann spruce, 1 aspen, 2 krummholz, 3 subalpine fir, 4 lodgepole pine, 5 Douglas-fir,
  6 limber pine, 7 snag (standing dead). Packs before DATA-020 use only 0..2 with the same meaning
  (0 = any conifer), so a reader keyed on these ids loads both.

Shrub kinds (field 5 of `shrubs/<tx>_<ty>.bin`, records x, y, z, height, radius, kind):
  0 willow, 1 juniper, 2 sagebrush, 3 young conifer, 4 Gambel oak.
"""
import re
import numpy as np
from scipy import ndimage
from PIL import Image

SPRUCE, ASPEN, KRUMMHOLZ, FIR, LODGEPOLE, DOUGLAS, LIMBER, SNAG = range(8)
# the treeline (m) the elevation bands below were tuned for (Vail; game/src/pack/treeline.ts DEFAULT_TREELINE);
# build_pack.py passes elevations relative to a resort's own treeline (DATA-021)
COLORADO_TREELINE = 3480.0
SPECIES_NAMES = ["spruce", "aspen", "krummholz", "fir", "lodgepole", "douglas-fir", "limber", "snag"]
TREE_SPECIES_VERSION = 2
# crown radius / height per species (the card's table); lodgepole carries its crown in the top third
CROWN_K = np.array([0.13, 0.20, 0.50, 0.10, 0.09, 0.17, 0.35, 0.05], np.float32)

WILLOW, JUNIPER, SAGE, YOUNG_CONIFER, OAK = range(5)
SHRUB_NAMES = ["willow", "juniper", "sagebrush", "young conifer", "gambel oak"]

# LANDFIRE EVT groups, matched by name (LF 2.4 / 2.5 renumbered the codes)
G_NONE, G_SPRUCE_FIR, G_ASPEN, G_LODGEPOLE, G_DOUGLAS, G_LIMBER = range(6)
GROUP_NAMES = ["none", "spruce-fir", "aspen", "lodgepole", "douglas-fir", "limber"]


def classify_evt(name, lifeform):
    """One LANDFIRE EVT class -> tree group, aspen share, and the flags the shrubs and fill trees use.

    `forest`: any Tree life form, the urban and developed forest classes included (BUG-027: LANDFIRE maps
    Vail's in-resort spruce-fir and lodgepole as `Western Cool Temperate Urban Evergreen Forest`).
    `open`: truly open ground (meadow, grassland, shrubland, sagebrush, bedrock and scree, water, snow),
    the only classes the fill trees are kept out of. The `Developed-*` life form (low to high intensity,
    roads) and the urban or developed herb and shrub classes are neither: unknown, so the lidar canopy and
    NAIP decide there. Developed tree classes still get a group, so a lidar tree in a village keeps a
    plausible species.
    `built` (DATA-015): the class names no species (urban evergreen forest, developed, urban herb and shrub), so
    natural_evt() takes the tree group from the natural forest around it and NAIP alone decides aspen. Urban
    deciduous forest is not `built`: "deciduous" already is the aspen answer."""
    tree = lifeform == "Tree"
    built = lifeform == "Developed" or "Urban" in name or "Developed" in name
    c = {"group": G_NONE, "aspen": 0.0, "forest": tree, "open": not tree and not built and lifeform != "",
         "alpine": "Alpine" in name, "riparian": "Riparian" in name, "sage": "Sagebrush" in name, "oak": "Gambel Oak" in name,
         "built": built and not (tree and "Deciduous" in name)}
    if not tree:
        return c
    if "Aspen-Mixed" in name:
        c["group"], c["aspen"] = G_SPRUCE_FIR, 0.5
    elif "Aspen" in name:
        c["group"], c["aspen"] = G_ASPEN, 0.85            # stands are mostly aspen with some conifer
    elif "Lodgepole" in name or "Ponderosa" in name:      # no ponderosa model: the nearest pine
        c["group"] = G_LODGEPOLE
    elif ("Limber" in name or "Bristlecone" in name or "Pinyon" in name or "Juniper" in name
          or "Whitebark" in name or "Woodland and Parkland" in name):   # DATA-021: Montana's whitebark pine at treeline
        c["group"] = G_LIMBER
    elif "Douglas-fir" in name or "Mixed Conifer" in name:   # southern Rockies montane mixed conifer is Douglas-fir led
        c["group"] = G_DOUGLAS
    elif "Riparian" in name:
        # subalpine riparian woodland is spruce-fir along creeks; lower montane is cottonwood and alder
        c["group"], c["aspen"] = G_SPRUCE_FIR, (0.0 if "Subalpine" in name else 0.6)
    elif "Deciduous" in name:
        c["group"], c["aspen"] = G_SPRUCE_FIR, 1.0
    elif "Mixed" in name:
        c["group"], c["aspen"] = G_SPRUCE_FIR, 0.5
    else:                                                 # spruce-fir, urban and developed evergreen
        c["group"] = G_SPRUCE_FIR
    return c


def evt_luts(table, n):
    """per-value lookup arrays (length n) from the .vat.dbf rows"""
    lut = {k: np.zeros(n, dt) for k, dt in (("group", np.int8), ("aspen", np.float32), ("forest", bool), ("open", bool), ("alpine", bool),
                                            ("riparian", bool), ("sage", bool), ("oak", bool), ("built", bool))}
    for r in table:
        v = int(float(r.get("VALUE", "0") or 0))
        if 0 <= v < n:
            c = classify_evt(r.get("EVT_NAME", ""), r.get("EVT_LF", ""))
            for k in lut:
                lut[k][v] = c[k]
    return lut


# natural_evt: the neighbourhood (Gaussian sigma, 30 m pixels) a built pixel takes its class mix from, and the
# least natural forest weight there (a share of the neighbourhood) to take one at all
NATURAL_SIGMA_PX = 5.0
NATURAL_MIN_WEIGHT = 0.02


def natural_evt(img, lut, sigma=NATURAL_SIGMA_PX, min_weight=NATURAL_MIN_WEIGHT):
    """DATA-015: the EVT raster with every `built` pixel replaced by a natural forest class, drawn from the mix
    of natural forest classes around it (Gaussian weights, `sigma` pixels), so Vail's in-resort `Urban Evergreen
    Forest` and `Developed-*` ground get the lodgepole, spruce-fir or aspen stands they sit in. The draw is a
    hash of the pixel, so rebuilds agree. A built pixel with less than `min_weight` of natural forest nearby (a
    town centre) keeps its class and the no-group fallback. Returns the new raster, the filled mask and the
    lodgepole share of the natural forest around each pixel (for naip_conifer_group)."""
    img = np.asarray(img)
    v = np.clip(img, 0, len(lut["built"]) - 1)
    built = lut["built"][v]
    natural = lut["forest"][v] & ~built & (lut["group"][v] != G_NONE)
    out = img.copy()
    if not built.any() or not natural.any():
        return out, np.zeros(img.shape, bool), np.zeros(img.shape, np.float32)
    classes = np.unique(img[natural])
    w = np.stack([ndimage.gaussian_filter((img == c).astype(np.float32) * natural, sigma, mode="constant") for c in classes])
    total = w.sum(0)
    lp = np.isin(classes, np.flatnonzero(lut["group"] == G_LODGEPOLE))
    lp_share = np.where(total > 0, w[lp].sum(0) / np.maximum(total, 1e-9), 0).astype(np.float32)
    fill = built & (total >= min_weight)
    r, c = np.nonzero(fill)
    u = hash01(c.astype(np.float64), r.astype(np.float64), 11) * total[r, c]
    pick = (np.cumsum(w[:, r, c], axis=0) < u[None]).sum(0)
    out[r, c] = classes[np.minimum(pick, len(classes) - 1)]
    return out, fill, lp_share


# NAIP aspen (DATA-015): canopy brightness and NIR averaged over this Gaussian sigma (2 m cells), so a stand
# reads as one colour through its crown shadows; the Vail 2023 fit, used when a pack has too few labelled cells
ASPEN_SIGMA = 4.0
# the canopy cells the colours are averaged over: leafy crowns, not the cured grass between them (NDVI < 0.30)
LEAF_NDVI = 0.35
ASPEN_DEFAULT = (60.0, 134.0)
ASPEN_MIN_LABELS = 20000
# a fit is used only when it separates the two classes: hit rate minus false rate at least this (balanced
# accuracy 0.65); otherwise another resort's imagery has no such split (Big Sky's lodgepole is not lower in NDVI)
MIN_SEPARATION = 0.3
# aspen share where NAIP sees aspen canopy on a built class: the aspen class's own share (classify_evt)
NAIP_ASPEN_SHARE = 0.85


def canopy_mean(a, canopy, sigma=ASPEN_SIGMA):
    """`a` averaged over the canopy cells within `sigma` cells (float32; 0 where no canopy is near)"""
    m = canopy.astype(np.float32)
    w = ndimage.gaussian_filter(m, sigma)
    s = ndimage.gaussian_filter(np.asarray(a, np.float32) * m, sigma)
    return np.where(w > 1e-3, s / np.maximum(w, 1e-3), 0).astype(np.float32)


def best_threshold(pos, neg):
    """the threshold t (over the pooled 2nd..98th percentiles) for `x > t` with the best balanced accuracy on
    positives `pos` and negatives `neg`; returns t, hit rate on pos, false rate on neg"""
    ts = np.percentile(np.concatenate([pos, neg]), np.arange(2, 99))
    hit = (pos[None, :] > ts[:, None]).mean(1); false = (neg[None, :] > ts[:, None]).mean(1)
    i = int(np.argmax(hit - false))
    return float(ts[i]), float(hit[i]), float(false[i])


def fit_aspen(bright_s, nir_s, aspen_cells, conifer_cells, rng=None, n=200000):
    """DATA-015: fit the NAIP aspen thresholds on a pack's own imagery: canopy-mean brightness and NIR under the
    natural aspen class against natural spruce-fir and lodgepole. Leaf-on aspen is brighter in both (and lower
    in NDVI, which is why the old NDVI > 0.5 rule found 7 % of Vail's aspen). Returns (bright_t, nir_t, info);
    the Vail defaults when either side has fewer than ASPEN_MIN_LABELS cells or the fit doesn't separate them
    (info["weak"])."""
    ia, ic = np.flatnonzero(aspen_cells), np.flatnonzero(conifer_cells)
    if min(len(ia), len(ic)) < ASPEN_MIN_LABELS:
        return ASPEN_DEFAULT + ({"fitted": False, "aspen": len(ia), "conifer": len(ic)},)
    rng = rng or np.random.default_rng(5)
    ia = rng.choice(ia, min(n, len(ia)), replace=False); ic = rng.choice(ic, min(n, len(ic)), replace=False)
    b, nr = bright_s.ravel(), nir_s.ravel()
    tb = best_threshold(b[ia], b[ic])[0]
    tn = best_threshold(nr[ia], nr[ic])[0]
    hit = float(np.mean((b[ia] > tb) & (nr[ia] > tn))); false = float(np.mean((b[ic] > tb) & (nr[ic] > tn)))
    info = {"aspen": int(aspen_cells.sum()), "conifer": int(conifer_cells.sum()), "hit": hit, "false": false}
    if hit - false < MIN_SEPARATION:
        return ASPEN_DEFAULT + (dict(info, fitted=False, weak=True),)
    return tb, tn, dict(info, fitted=True)


# NAIP lodgepole (DATA-015): lodgepole canopy reads lower in NDVI than spruce-fir (Vail 2023 cores: median 0.44
# against 0.53, about 75 % right on Vail), weaker than the aspen split, so it only breaks the tie on a built
# class where the natural forest around has at least LODGEPOLE_MIN_SHARE lodgepole. No default: an NDVI split
# doesn't carry from one resort's imagery to another's, so without a usable fit there is no tie-breaker.
LODGEPOLE_MIN_SHARE = 0.1


def fit_lodgepole(ndvi_s, lodgepole_cells, spruce_fir_cells, rng=None, n=200000):
    """the canopy-mean NDVI under which a conifer reads as lodgepole, fitted on the natural lodgepole and
    spruce-fir classes; returns (t, info), t None when either side has too few cells or the fit doesn't
    separate them (info["weak"])"""
    il, isf = np.flatnonzero(lodgepole_cells), np.flatnonzero(spruce_fir_cells)
    if min(len(il), len(isf)) < ASPEN_MIN_LABELS:
        return None, {"fitted": False, "lodgepole": len(il), "spruce_fir": len(isf)}
    rng = rng or np.random.default_rng(6)
    il = rng.choice(il, min(n, len(il)), replace=False); isf = rng.choice(isf, min(n, len(isf)), replace=False)
    x = ndvi_s.ravel()
    t, hit, false = best_threshold(-x[il], -x[isf])
    info = {"lodgepole": int(lodgepole_cells.sum()), "spruce_fir": int(spruce_fir_cells.sum()), "hit": hit, "false": false}
    if hit - false < MIN_SEPARATION:
        return None, dict(info, fitted=False, weak=True)
    return -t, dict(info, fitted=True)


def naip_conifer_group(group, lp_share, lodgepole_like, naip_decides, min_share=LODGEPOLE_MIN_SHARE):
    """DATA-015: on a built class (`naip_decides`) whose filled group is spruce-fir or lodgepole and whose natural
    forest around holds at least `min_share` lodgepole, NAIP picks between the two: lodgepole where the canopy
    reads lodgepole (`lodgepole_like`), spruce-fir elsewhere. Other trees keep their group, and all do when
    `lodgepole_like` is None (no usable fit)."""
    g = np.asarray(group).copy()
    if lodgepole_like is None:
        return g
    m = (np.asarray(naip_decides, bool) & np.isin(g, (G_SPRUCE_FIR, G_LODGEPOLE)) & (np.asarray(lp_share) >= min_share))
    g[m] = np.where(np.asarray(lodgepole_like, bool)[m], G_LODGEPOLE, G_SPRUCE_FIR)
    return g


_LF_NUM = re.compile(r"(\d+(?:\.\d+)?)")


def _lf_value(name, prefix):
    """the number in a LANDFIRE EVC / EVH class name that starts with `prefix`: "Tree Cover = 45%" -> 45,
    "Tree Height >= 25 meters" -> 25, a range ("Tree Cover >= 10 and < 20%") -> its midpoint. NaN otherwise."""
    if not name.startswith(prefix):
        return float("nan")
    v = [float(m) for m in _LF_NUM.findall(name[len(prefix):])]
    return sum(v) / len(v) if v else float("nan")


def lf_tree_cover(name):
    """EVC class name -> tree canopy cover 0..1 (DATA-010). NaN for shrub, herb, developed, water and barren
    classes: the developed forest classes carry no cover, so the lidar and NAIP decide there."""
    return _lf_value(name, "Tree Cover") / 100.0


def lf_tree_height(name):
    """EVH class name -> tree height in metres (DATA-010), NaN for every non-tree class."""
    return _lf_value(name, "Tree Height")


def lf_value_lut(table, n, fn):
    """per-value float32 lookup (length n, NaN where the class has no value) from an EVC / EVH .vat.dbf"""
    lut = np.full(n, np.nan, np.float32)
    for r in table:
        v = int(float(r.get("VALUE", "0") or 0))
        if 0 <= v < n:
            lut[v] = fn(r.get("CLASSNAMES", ""))
    return lut


def hash01(x, y, salt=0):
    """deterministic 0..1 from a position (0.1 m grid), so rebuilds give every tree the same draw"""
    xi = np.round(np.asarray(x, np.float64) * 10).astype(np.int64).view(np.uint64)
    yi = np.round(np.asarray(y, np.float64) * 10).astype(np.int64).view(np.uint64)
    with np.errstate(over="ignore"):
        h = xi * np.uint64(0x9E3779B97F4A7C15) ^ (yi + np.uint64(salt * 0x632BE59B + 0x7F4A7C15)) * np.uint64(0xBF58476D1CE4E5B9)
        h ^= h >> np.uint64(31); h *= np.uint64(0x94D049BB133111EB); h ^= h >> np.uint64(29)
    return (h >> np.uint64(11)).astype(np.float64) / float(1 << 53)


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, np.float64) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def fir_share(elev, northeast, wet):
    """P(subalpine fir) for a spruce-fir tree: about 40 % above 3,200 m, 50 % below, more on north and
    east aspects (northeast -1..1) and near water (wet 0..1)"""
    base = 0.50 - 0.10 * smoothstep(3100, 3300, elev)
    return np.clip(base + 0.15 * np.asarray(northeast) + 0.20 * np.asarray(wet), 0.10, 0.85)


def lodgepole_share_no_evt(elev, dry):
    """no LANDFIRE: lodgepole is the lower-slope pine of Colorado's resorts, drier (south, west) aspects more"""
    return np.clip(0.65 * smoothstep(3250, 2950, elev) * (1 + 0.3 * np.asarray(dry)), 0, 0.9)


def assign_species(x, y, elev, chm_at, group, aspen_frac, alpine, aspen_like, northeast, wet, ridge, aspen_roll, have_evt,
                   naip_decides=None):
    """species id per tree (int8 array). Inputs are per-tree arrays:
    x, y        local metres (hash seed)
    elev        ground height (m); chm_at measured lidar canopy height (0 in gaps)
    group       LANDFIRE group (G_*); aspen_frac the class's aspen share; alpine an alpine class
    aspen_like  NAIP aspen canopy (fit_aspen); northeast -1..1 (north + east aspect); wet 0..1 near water
    ridge       exposed crest; aspen_roll uniform 0..1 (the existing seeded draw); have_evt False = no LANDFIRE
    naip_decides  (DATA-015) the tree stands on a `built` class: its group came from natural_evt and NAIP alone
                decides aspen, at the aspen class's share where NAIP sees aspen canopy and never elsewhere
    """
    n = len(x)
    u = hash01(x, y, 1)       # spruce / fir
    v = hash01(x, y, 2)       # group's own species vs spruce-fir understory
    w = hash01(x, y, 3)       # ridge limber pine
    sp = np.where(u < fir_share(elev, northeast, wet), FIR, SPRUCE).astype(np.int8)
    if have_evt:
        sp[(group == G_LODGEPOLE) & (v < 0.85)] = LODGEPOLE
        sp[(group == G_DOUGLAS) & (v < 0.65 * smoothstep(3250, 3000, elev))] = DOUGLAS
        sp[(group == G_LIMBER) & (v < 0.8)] = LIMBER
        none = group == G_NONE
        sp[none & (v < lodgepole_share_no_evt(elev, -northeast))] = LODGEPOLE
        is_aspen = ((aspen_roll < aspen_frac) | (aspen_like & (aspen_roll < 0.5))) & (elev < 3300)
        if naip_decides is not None:
            nd = np.asarray(naip_decides, bool)
            al, ar, el = np.asarray(aspen_like, bool), np.asarray(aspen_roll), np.asarray(elev)
            is_aspen[nd] = al[nd] & (ar[nd] < NAIP_ASPEN_SHARE) & (el[nd] < 3300)
    else:
        sp[v < lodgepole_share_no_evt(elev, -northeast)] = LODGEPOLE
        is_aspen = aspen_like & (elev < 3150)
    # limber pine on exposed crests above 3,200 m where the lidar says short (< 10 m)
    sp[ridge & (elev > 3200) & (chm_at < 10) & (w < 0.5) & (sp != LODGEPOLE)] = LIMBER
    # krummholz (BUG-025): measured short (1 to 4 m) near treeline or in an alpine class, never by elevation alone
    is_krumm = (chm_at > 1.0) & (chm_at < 4.0) & ((elev > 3450) | alpine)
    sp[is_aspen & ~is_krumm] = ASPEN
    sp[is_krumm] = KRUMMHOLZ
    assert len(sp) == n
    return sp


def crown_radius(species, height):
    return (CROWN_K[np.asarray(species, np.int64)] * np.asarray(height, np.float32)).astype(np.float32)


def cap_snags(ndvi, n_trees, cap=0.03):
    """indices of the snag candidates to keep: the greyest first, at most `cap` of the final tree count"""
    keep = int(cap * n_trees / (1 - cap))
    order = np.argsort(ndvi, kind="stable")
    return np.sort(order[:keep])


def terrain_fields(dem2, res):
    """smoothed aspect (northness, eastness, -1..1) and topographic position (m above the local mean) at two
    scales, on the 2 m grid. Row 0 = north."""
    ds = ndimage.gaussian_filter(dem2, 5.0)          # ~10 m: aspect of the slope, not of the lidar noise
    gy, gx = np.gradient(ds, res)
    g = np.maximum(np.hypot(gx, gy), 1e-3)
    # downhill direction: -grad; row index grows southward, so north = +gy in array terms
    north = (gy / g).astype(np.float32); east = (-gx / g).astype(np.float32)
    flat = np.hypot(gx, gy) < 0.05                   # < 3 deg: no aspect
    north[flat] = 0; east[flat] = 0
    del gx, gy, g, flat
    tpi_s = (dem2 - ndimage.uniform_filter(ds, int(40 / res) | 1)).astype(np.float32)    # 40 m crest
    tpi_l = (dem2 - ndimage.uniform_filter(ds, int(300 / res) | 1)).astype(np.float32)   # 300 m ridge or valley
    return north, east, tpi_s, tpi_l


def poly_cells(pts, res, x0, y1, h, w, step=0.7):
    """2 m grid cells along a local-metre polyline, (rows, cols); x0, y1 = local west and north edges"""
    rows, cols = [], []
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        k = max(1, int(np.hypot(bx - ax, by - ay) / (res * step)))
        t = np.linspace(0, 1, k + 1)
        rows.append(((y1 - (ay + (by - ay) * t)) / res).astype(np.int64))
        cols.append(((ax + (bx - ax) * t - x0) / res).astype(np.int64))
    if not rows:
        return np.array([], np.int64), np.array([], np.int64)
    r = np.concatenate(rows); c = np.concatenate(cols)
    ok = (r >= 0) & (r < h) & (c >= 0) & (c < w)
    return r[ok], c[ok]


def stream_distance(lines, res, x0, y1, h, w, coarse=10.0):
    """distance (m) to the nearest stream line per 2 m cell, computed on a `coarse` m grid and repeated up"""
    k = int(round(coarse / res))
    hc, wc = -(-h // k), -(-w // k)
    hit = np.zeros((hc, wc), bool)
    for pts in lines:
        if len(pts) >= 2:
            r, c = poly_cells(pts, coarse, x0, y1, hc, wc)
            hit[r, c] = True
    if not hit.any():
        return np.full((h, w), 1e4, np.float32)
    d = ndimage.distance_transform_edt(~hit).astype(np.float32) * coarse
    return np.repeat(np.repeat(d, k, 0), k, 1)[:h, :w]


# shrub densities per hectare at full NAIP greenness (before the 200 / ha cap), heights and radii (m)
SHRUB_RULES = {
    WILLOW: {"per_ha": 160, "h": (1.0, 3.0), "r": (0.6, 1.5), "ndvi0": 0.20},
    JUNIPER: {"per_ha": 60, "h": (0.3, 1.0), "r": (0.5, 1.4), "ndvi0": 0.15},
    SAGE: {"per_ha": 150, "h": (0.5, 1.2), "r": (0.3, 0.7), "ndvi0": 0.08},
    YOUNG_CONIFER: {"per_ha": 15, "h": (1.0, 4.0), "r": (0.3, 1.0), "ndvi0": None},   # per ha of forest edge
    OAK: {"per_ha": 150, "h": (1.0, 3.0), "r": (0.8, 2.0), "ndvi0": 0.15},
}
CAP_PER_HA = 200.0


def shrub_probabilities(res, open_, ndvi, near_stream, valley, riparian, spruce_fir, gap_edge, south_ridge, sage, oak, edge, low=None):
    """expected shrubs per 2 m cell for each kind (dict kind -> float32 grid), capped at 200 / ha in total.

    open_       no CHM canopy, not built, rock, water or groomed
    low         like open_ but allowing canopy under 4 m (willow carr reads as short canopy); default open_
    near_stream within 25 m of an OSM stream; valley: valley bottom (below the 300 m mean, gentle)
    spruce_fir  spruce-fir (or fir-friendly) forest class; gap_edge: an open cell within 12 m of canopy
    south_ridge open south-facing crest; sage / oak: sagebrush / Gambel oak class
    edge        open cell at a conifer forest edge or in a canopy gap under 6 m
    """
    cell_ha = res * res / 1e4
    def green(k):
        n0 = SHRUB_RULES[k]["ndvi0"]
        return np.clip((ndvi - n0) / 0.30, 0, 1).astype(np.float32)
    p = {}
    if low is None:
        low = open_
    p[WILLOW] = (low & near_stream & (valley | riparian)) * green(WILLOW) * (1.0 + 0.5 * riparian) * SHRUB_RULES[WILLOW]["per_ha"] * cell_ha
    p[JUNIPER] = (open_ & ((spruce_fir & gap_edge) | south_ridge)) * green(JUNIPER) * SHRUB_RULES[JUNIPER]["per_ha"] * cell_ha
    p[SAGE] = (open_ & sage) * green(SAGE) * SHRUB_RULES[SAGE]["per_ha"] * cell_ha
    p[OAK] = (open_ & oak & ~sage) * green(OAK) * SHRUB_RULES[OAK]["per_ha"] * cell_ha
    p[YOUNG_CONIFER] = (open_ & edge).astype(np.float32) * SHRUB_RULES[YOUNG_CONIFER]["per_ha"] * cell_ha
    tot = sum(p.values())
    k = np.minimum(1.0, CAP_PER_HA * cell_ha / np.maximum(tot, 1e-9)).astype(np.float32)
    return {kind: (g * k).astype(np.float32) for kind, g in p.items()}


def sample_shrubs(p, res, x0, y1, dem2, rng):
    """draw shrub records (N, 6) float32 [x, y, z, height, radius, kind] from the per-cell expectations.
    Willow comes in clumps of 3 to 8 stems within 3 m of a clump centre."""
    out = []
    h, w = dem2.shape
    for kind, g in p.items():
        rule = SHRUB_RULES[kind]
        if kind == WILLOW:
            lam = g / 5.5                       # clump centres; 5.5 stems per clump on average
        else:
            lam = g
        r, c = np.nonzero(rng.uniform(0, 1, g.shape).astype(np.float32) < lam)
        if kind == WILLOW and len(r):
            m = rng.integers(3, 9, len(r))
            r = np.repeat(r, m); c = np.repeat(c, m)
            ang = rng.uniform(0, 2 * np.pi, len(r)); rad = 3.0 * np.sqrt(rng.uniform(0, 1, len(r)))
            ox, oy = np.cos(ang) * rad, np.sin(ang) * rad
        else:
            ox = rng.uniform(-res / 2, res / 2, len(r)); oy = rng.uniform(-res / 2, res / 2, len(r))
        x = x0 + (c + 0.5) * res + ox
        y = y1 - (r + 0.5) * res + oy
        rr = np.clip(((y1 - y) / res).astype(np.int64), 0, h - 1); cc = np.clip(((x - x0) / res).astype(np.int64), 0, w - 1)
        z = dem2[rr, cc]
        hgt = rng.uniform(*rule["h"], len(r)); rad_ = rng.uniform(*rule["r"], len(r))
        out.append(np.stack([x, y, z, hgt, rad_, np.full(len(r), kind)], axis=1).astype(np.float32))
    return np.concatenate(out) if out else np.zeros((0, 6), np.float32)


def peak_density(recs, cell=100.0):
    """highest count per hectare in any `cell` m square (the cap check)"""
    if len(recs) == 0:
        return 0.0
    k = np.floor(recs[:, 0] / cell).astype(np.int64) * 1000003 + np.floor(recs[:, 1] / cell).astype(np.int64)
    _, c = np.unique(k, return_counts=True)
    return float(c.max()) / (cell * cell / 1e4)


def band_report(species, elev, band=200):
    """per elevation band: tree count and share of each species, as log lines"""
    lines = []
    lo = int(np.floor(elev.min() / band) * band) if len(elev) else 0
    hi = int(np.ceil(elev.max() / band) * band) if len(elev) else 0
    for b0 in range(lo, hi, band):
        m = (elev >= b0) & (elev < b0 + band)
        n = int(m.sum())
        if n == 0:
            continue
        cnt = np.bincount(species[m].astype(np.int64), minlength=8)
        lines.append(f"{b0}-{b0 + band} m: {n:8d}  " + "  ".join(f"{SPECIES_NAMES[i]} {cnt[i] / n * 100:4.1f}%" for i in range(8) if cnt[i]))
    return lines


SPECIES_RGB = np.array([[30, 90, 40], [235, 225, 120], [150, 60, 160], [60, 170, 90], [210, 120, 40],
                        [40, 90, 200], [230, 60, 60], [110, 110, 110]], np.uint8)
GROUP_RGB = np.array([[245, 245, 245], [45, 130, 65], [235, 225, 120], [210, 120, 40], [40, 90, 200], [230, 60, 60]], np.uint8)


def debug_png(path, tx, ty, species, group2, min_x, max_y, w_m, h_m, res=10.0):
    """species map (most common id per `res` m cell) left, LANDFIRE group map right, same scale"""
    wc, hc = int(np.ceil(w_m / res)), int(np.ceil(h_m / res))
    c = np.clip(((tx - min_x) / res).astype(np.int64), 0, wc - 1); r = np.clip(((max_y - ty) / res).astype(np.int64), 0, hc - 1)
    votes = np.zeros((8, hc * wc), np.int32)
    np.add.at(votes, (species.astype(np.int64), r * wc + c), 1)
    has = votes.sum(0) > 0
    left = np.full((hc * wc, 3), 245, np.uint8)
    left[has] = SPECIES_RGB[votes[:, has].argmax(0)]
    left = left.reshape(hc, wc, 3)
    if group2 is not None:
        k = max(1, int(round(group2.shape[0] / hc)))
        right = GROUP_RGB[np.clip(group2[::k, ::k][:hc, :wc], 0, len(GROUP_RGB) - 1)]
        pad = np.full((hc, wc, 3), 245, np.uint8); pad[:right.shape[0], :right.shape[1]] = right
        img = np.concatenate([left, np.full((hc, 8, 3), 0, np.uint8), pad], axis=1)
    else:
        img = left
    Image.fromarray(img).save(path, optimize=True)
