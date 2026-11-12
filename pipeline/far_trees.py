"""BUG-081: the trees on the ridges round the resort, from the same lidar as the pack's own.

Usage: python pipeline/far_trees.py <slug> <raw_dir> <pack_dir>

A pack's trees stop at its bounds, so the ridges one or two over were drawn by the terrain shader alone, from a
land cover share that reads as camo from the lifts. This finds the crowns in the far tree ring the way stage 8 of
build_pack.py does in the pack (local maxima of a 2 m canopy height model from the 3DEP lidar) and writes them as
`farTrees/<cx>_<cy>.bin` (the pack's tree record, on the pack's 1 km tree grid, cells running `treeRing` cells past
it on every side), only outside the pack bounds. The client draws them with the pack's trees.

Inputs: `raw/<slug>/ept/*.laz` and `raw/<slug>/ept_far/*.laz` (the ring's nodes, `lidar.far` in the resort config,
selected by ept_select.py) and the pack's `mid` height set (the ground the client draws out there). There is no
NAIP or LANDFIRE beyond the pack, so canopy is lidar height alone, there are no snags and species follow
species.py's no-LANDFIRE rules (elevation, aspect, crests). Run it on a built pack, then cover.py (its mid level
takes the ring's forest from these trees). Takes a few minutes and about 3 GB of memory for Vail's 5 km ring."""
import glob, json, math, os, sys, time
import numpy as np
from scipy import ndimage
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import species as spc                       # noqa: E402
from ept_select import node_box, far_box    # noqa: E402

R2 = 2.0            # canopy height model cell (m), as the pack
RG = 4.0            # ground cell (m)
CELL = 1000.0       # tree cell (m), as the pack
PEAK_MIN = 2.5      # m: the pack's crown threshold
CHM_MAX = 60.0
CLIFF_SLOPE = 45.0  # deg: no crowns on cliffs (a cliff top over its foot reads as canopy)
GROUND_SIGMA = 3.0  # ground cells: how far a lidar ground offset spreads into the gaps under closed canopy
# classes that are never canopy: building, low and high noise, water, wires and towers, bridge deck
DROP_CLASSES = (6, 7, 9, 13, 14, 15, 16, 17, 18)
DM = 10.0           # the binned heights are stored in decimetres over z0 (uint16: 6.5 km of range)
Z0_BELOW = 1000.0   # z0 sits this far under the pack's lowest ground, for the ring's valleys


def z0_for(meta):
    """the floor of the binned heights: 1 km under the pack's lowest ground, to 100 m. DATA-023: a fixed 1,000 m
    clipped every return of Boston Mills (200 to 370 m) to 1,000 m, so the ring's ground read 700 m too high"""
    lo = float((meta.get("zRange") or [1000.0 + Z0_BELOW])[0])
    return math.floor((lo - Z0_BELOW) / 100.0) * 100.0
BLOCK = 1000        # CHM cells per detection block side
MARGIN = 8          # cells of overlap round a block


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def ring_grid(inst, bounds, box_local):
    """the tree grid with the ring: (ring cells per side, grid min x, min y, cells x, cells y)"""
    cs = inst["cellSize"]
    pad = max(inst["minX"] - box_local[0], inst["minY"] - box_local[1],
              box_local[2] - (inst["minX"] + inst["cellsX"] * cs), box_local[3] - (inst["minY"] + inst["cellsY"] * cs))
    ring = max(0, int(math.ceil(pad / cs)))
    return ring, inst["minX"] - ring * cs, inst["minY"] - ring * cs, inst["cellsX"] + 2 * ring, inst["cellsY"] + 2 * ring


def write_far_cells(out_dir, recs, inst, ring):
    """recs (n, 6) float32 local metres into farTrees/<cx>_<cy>.bin keyed on the pack's tree grid (cx, cy may be
    negative or past cellsX / cellsY); returns the cell names written"""
    d = os.path.join(out_dir, "farTrees")
    os.makedirs(d, exist_ok=True)
    for f in glob.glob(os.path.join(d, "*.bin")):
        os.remove(f)
    if len(recs) == 0:
        return []
    cs = inst["cellSize"]
    cx = np.floor((recs[:, 0] - inst["minX"]) / cs).astype(np.int64)
    cy = np.floor((recs[:, 1] - inst["minY"]) / cs).astype(np.int64)
    ok = (cx >= -ring) & (cx < inst["cellsX"] + ring) & (cy >= -ring) & (cy < inst["cellsY"] + ring)
    recs, cx, cy = recs[ok], cx[ok], cy[ok]
    key = (cy + ring) * (inst["cellsX"] + 2 * ring) + (cx + ring)
    order = np.argsort(key, kind="stable")
    recs, cx, cy, key = recs[order], cx[order], cy[order], key[order]
    cut = np.flatnonzero(np.diff(key)) + 1
    names = []
    for s, e in zip(np.concatenate([[0], cut]), np.concatenate([cut, [len(key)]])):
        nm = f"{cx[s]}_{cy[s]}"
        recs[s:e].astype("<f4").tofile(os.path.join(d, f"{nm}.bin"))
        names.append(nm)
    return sorted(names)


def detect(chm, has_pts, slope):
    """crowns in one block of the canopy height model: (rows, cols, height), as build_pack.py stage 8"""
    canopy = (chm > PEAK_MIN) & has_pts & (slope < CLIFF_SLOPE)
    chm_s = ndimage.gaussian_filter(chm, 0.8)
    peaks = (chm_s == ndimage.maximum_filter(chm_s, size=3)) & (chm_s > PEAK_MIN) & canopy
    r, c = np.nonzero(peaks)
    # BUG-023: a crown's height is the tallest return within one cell of its peak
    return r, c, ndimage.maximum_filter(chm, size=3)[r, c]


def fill_ground(lidar_g, base):
    """the ground: the drawn terrain `base` moved by the lidar ground's offset from it, spread into the gaps
    (normalised Gaussian), so it follows the lidar where it saw the ground and the drawn terrain elsewhere"""
    have = np.isfinite(lidar_g) & np.isfinite(base)
    off = np.where(have, lidar_g - base, 0).astype(np.float32)
    num = ndimage.gaussian_filter(off, GROUND_SIGMA); den = ndimage.gaussian_filter(have.astype(np.float32), GROUND_SIGMA)
    off = np.where(have, off, np.where(den > 1e-3, num / np.maximum(den, 1e-3), 0))
    return np.where(np.isfinite(base), base + off, np.nan).astype(np.float32)


def main(argv):
    if len(argv) < 3:
        print(__doc__); return 2
    slug, raw, pack = argv[0], argv[1], argv[2]
    cfg = json.load(open(os.path.join(HERE, "resorts", f"{slug}.json"), encoding="utf-8"))
    if not cfg["lidar"].get("far"):
        log("no lidar.far in the resort config: no far tree ring"); return 1
    meta_p = os.path.join(pack, "meta.json")
    meta = json.load(open(meta_p, encoding="utf-8"))
    inst, b = meta["instances"], meta["bounds"]
    ox, oy = cfg["origin"]
    box = far_box(cfg)
    box_l = (box[0] - ox, box[1] - oy, box[2] - ox, box[3] - oy)
    ring, gx0, gy0, gcx, gcy = ring_grid(inst, b, box_l)
    # the working grid: the ring box, snapped to whole metres of R2 and RG
    X0, Y0 = math.floor(box_l[0] / RG) * RG, math.floor(box_l[1] / RG) * RG
    X1, Y1 = math.ceil(box_l[2] / RG) * RG, math.ceil(box_l[3] / RG) * RG
    W2, H2 = int((X1 - X0) / R2), int((Y1 - Y0) / R2)
    WG, HG = W2 // 2, H2 // 2
    log(f"far tree ring {cfg['lidar']['far']['pad_m']:g} m: box {X0:.0f}..{X1:.0f} x {Y0:.0f}..{Y1:.0f}, "
        f"{ring} cells past the pack's tree grid, CHM {W2} x {H2}")

    # ---------------------------------------------------------------- lidar into the grids
    to_utm = Transformer.from_crs("EPSG:3857", cfg["crs"], always_xy=True)
    from_utm = Transformer.from_crs(cfg["crs"], "EPSG:3857", always_xy=True)
    xs_m, ys_m = from_utm.transform([X0 + ox, X1 + ox, X0 + ox, X1 + ox], [Y0 + oy, Y0 + oy, Y1 + oy, Y1 + oy])
    box_m = (min(xs_m), min(ys_m), max(xs_m), max(ys_m))
    # the pack's interior, less 100 m: a main node wholly inside it only holds points the ring never uses
    pin = from_utm.transform([b["minX"] + 100 + ox, b["maxX"] - 100 + ox], [b["minY"] + 100 + oy, b["maxY"] - 100 + oy])
    pin_m = (pin[0][0], pin[1][0], pin[0][1], pin[1][1])
    ept = json.load(open(os.path.join(raw, "ept", "ept.json"), encoding="utf-8"))
    eb = ept["bounds"]
    z0 = z0_for(meta)
    files = []
    for p in sorted(glob.glob(os.path.join(raw, "ept", "*.laz")) + glob.glob(os.path.join(raw, "ept_far", "*.laz"))):
        k = os.path.basename(p)[:-4]
        try:
            nb = node_box(eb, k)
        except ValueError:
            continue
        if nb[2] <= box_m[0] or nb[0] >= box_m[2] or nb[3] <= box_m[1] or nb[1] >= box_m[3]:
            continue
        if nb[0] >= pin_m[0] and nb[2] <= pin_m[2] and nb[1] >= pin_m[1] and nb[3] <= pin_m[3]:
            continue
        files.append(p)
    if not glob.glob(os.path.join(raw, "ept_far", "*.laz")):
        log("no raw/<slug>/ept_far/*.laz: run ept_select.py, gen_manifest.py and fetch.ps1 first"); return 1
    log(f"  {len(files)} lidar nodes over the ring")
    import laspy
    dsm = np.zeros((H2, W2), np.uint16)                # 0 = no return
    gnd = np.full((HG, WG), np.iinfo(np.uint16).max, np.uint16)
    n_pts = 0
    for i, p in enumerate(files):
        try:
            las = laspy.read(p)
        except Exception as e:
            log("  bad laz", p, e); continue
        cls = np.asarray(las.classification)
        keep = ~np.isin(cls, DROP_CLASSES)
        ux, uy = to_utm.transform(np.asarray(las.x)[keep], np.asarray(las.y)[keep])
        z = np.asarray(las.z)[keep]; cls = cls[keep]
        col = np.floor((ux - ox - X0) / R2).astype(np.int64); row = np.floor((Y1 - (uy - oy)) / R2).astype(np.int64)
        ok = (col >= 0) & (col < W2) & (row >= 0) & (row < H2)
        col, row, z, cls = col[ok], row[ok], z[ok], cls[ok]
        zq = np.clip(np.round((z - z0) * DM), 1, 65534).astype(np.uint16)
        np.maximum.at(dsm.ravel(), row * W2 + col, zq)
        g = cls == 2
        if g.any():
            np.minimum.at(gnd.ravel(), (row[g] // 2) * WG + (col[g] // 2), zq[g])
        n_pts += len(z)
        if (i + 1) % 200 == 0:
            log(f"  {i + 1} / {len(files)} nodes, {n_pts / 1e6:.0f} M points")
    log(f"  {n_pts / 1e6:.0f} M points, CHM cells with a return {np.mean(dsm > 0) * 100:.1f}%")

    # ---------------------------------------------------------------- ground
    sys.path.insert(0, HERE)
    from cover import read_height_set
    hs = read_height_set(pack, meta, "mid")
    if hs is None:
        log("the pack has no mid height set"); return 1
    big, hres, hx0, hy1 = hs
    gx = X0 + (np.arange(WG) + 0.5) * RG; gy = Y1 - (np.arange(HG) + 0.5) * RG
    # bilinear in the drawn mid heights (cell centres)
    fc = (gx - hx0) / hres - 0.5; fr = (hy1 - gy) / hres - 0.5
    base = ndimage.map_coordinates(big, np.meshgrid(fr, fc, indexing="ij"), order=1, mode="nearest").astype(np.float32)
    del big
    lg = np.where(gnd < 65535, gnd.astype(np.float32) / DM + z0, np.nan).astype(np.float32)
    log(f"  ground cells with a lidar return {np.isfinite(lg).mean() * 100:.1f}%, "
        f"median lidar - drawn ground {np.nanmedian(lg - base):+.2f} m")
    ground = fill_ground(lg, base)
    del lg, gnd
    gyy, gxx = np.gradient(np.nan_to_num(ground, nan=0.0), RG)
    slope_g = np.degrees(np.arctan(np.hypot(gxx, gyy))).astype(np.float32)
    del gyy, gxx

    # ---------------------------------------------------------------- crowns, block by block
    rows, cols, hgt = [], [], []
    for r0 in range(0, H2, BLOCK):
        for c0 in range(0, W2, BLOCK):
            r1, c1 = min(H2, r0 + BLOCK), min(W2, c0 + BLOCK)
            # skip blocks wholly inside the pack (less a crown's reach)
            bx0, bx1 = X0 + c0 * R2, X0 + c1 * R2; by1, by0 = Y1 - r0 * R2, Y1 - r1 * R2
            if bx0 >= b["minX"] + 20 and bx1 <= b["maxX"] - 20 and by0 >= b["minY"] + 20 and by1 <= b["maxY"] - 20:
                continue
            a0, a1, e0, e1 = max(0, r0 - MARGIN), min(H2, r1 + MARGIN), max(0, c0 - MARGIN), min(W2, c1 + MARGIN)
            d = dsm[a0:a1, e0:e1]
            g2 = np.repeat(np.repeat(ground[a0 // 2:(a1 + 1) // 2, e0 // 2:(e1 + 1) // 2], 2, 0), 2, 1)
            g2 = g2[a0 % 2:a0 % 2 + (a1 - a0), e0 % 2:e0 % 2 + (e1 - e0)]
            s2 = np.repeat(np.repeat(slope_g[a0 // 2:(a1 + 1) // 2, e0 // 2:(e1 + 1) // 2], 2, 0), 2, 1)
            s2 = s2[a0 % 2:a0 % 2 + (a1 - a0), e0 % 2:e0 % 2 + (e1 - e0)]
            has = d > 0
            chm = np.where(has & np.isfinite(g2), d.astype(np.float32) / DM + z0 - g2, 0)
            chm = ndimage.grey_closing(np.clip(chm, 0, CHM_MAX).astype(np.float32), size=3)
            r, c, h = detect(chm, ndimage.binary_dilation(has, iterations=1), s2)
            r, c = r + a0, c + e0
            inb = (r >= r0) & (r < r1) & (c >= c0) & (c < c1)
            rows.append(r[inb]); cols.append(c[inb]); hgt.append(h[inb])
    rows = np.concatenate(rows); cols = np.concatenate(cols); hgt = np.concatenate(hgt).astype(np.float32)
    del dsm
    rng = np.random.default_rng(3)
    tx = X0 + (cols + 0.5) * R2 + rng.uniform(-0.9, 0.9, len(rows))
    ty = Y1 - (rows + 0.5) * R2 + rng.uniform(-0.9, 0.9, len(rows))
    outside = (tx < b["minX"]) | (tx >= b["maxX"]) | (ty < b["minY"]) | (ty >= b["maxY"])
    tx, ty, hgt, rows, cols = tx[outside], ty[outside], hgt[outside], rows[outside], cols[outside]
    tz = ground[rows // 2, cols // 2]
    good = np.isfinite(tz)
    tx, ty, hgt, rows, cols, tz = tx[good], ty[good], hgt[good], rows[good], cols[good], tz[good]
    log(f"  crowns outside the pack {len(tx)} ({len(tx) / max(1e-9, ((X1 - X0) * (Y1 - Y0) - (b['maxX'] - b['minX']) * (b['maxY'] - b['minY'])) / 1e6):.0f} per km2), "
        f"median height {np.median(hgt) if len(hgt) else 0:.1f} m")

    # ---------------------------------------------------------------- species (no LANDFIRE, no NAIP out here)
    north, east, tpi_s, tpi_l = spc.terrain_fields(np.nan_to_num(ground, nan=float(np.nanmean(ground))), RG)
    gr, gc = rows // 2, cols // 2
    northeast = (north[gr, gc] + east[gr, gc]) / math.sqrt(2)
    ridge = (tpi_s[gr, gc] > 1.5) & (tpi_l[gr, gc] > 15)
    del north, east, tpi_s, tpi_l
    n = len(tx)
    sp = spc.assign_species(tx, ty, tz, hgt, np.zeros(n, np.int8), np.zeros(n, np.float32), np.zeros(n, bool),
                            np.zeros(n, bool), northeast, np.zeros(n, np.float32), ridge, np.ones(n), False)
    crown = spc.crown_radius(sp, hgt)
    recs = np.stack([tx, ty, tz, hgt, crown, sp.astype(np.float32)], axis=1).astype(np.float32)
    cnt = np.bincount(sp.astype(np.int64), minlength=8)
    log("  species " + ", ".join(f"{spc.SPECIES_NAMES[i]} {cnt[i] / max(n, 1) * 100:.0f}%" for i in range(8) if cnt[i]))

    # ---------------------------------------------------------------- write
    names = write_far_cells(pack, recs, inst, ring)
    inst["treeRing"] = ring
    inst["farTreeCount"] = int(len(recs))
    inst["farTreeCells"] = names
    inst["farTreeBox"] = [float(v) for v in box_l]   # the ring's outer edge (local metres), for cover.py
    from packwriter import write_meta
    write_meta(pack, meta)
    sz = sum(os.path.getsize(os.path.join(pack, "farTrees", f"{nm}.bin")) for nm in names)
    log(f"farTrees/: {len(names)} cells, {len(recs)} trees, {sz / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
