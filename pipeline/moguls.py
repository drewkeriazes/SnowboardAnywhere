"""FEAT-059: where moguls form.

Moguls come from skier and rider traffic on ungroomed snow, so a run gets a score from how often the
resort grooms it (the nightly reports), its difficulty, the slope along it, its aspect and how close it
is to a lift top. Cat tracks, roads, glades and anything flatter than about 12 degrees never score.
The pack build paints each run's score along its corridor (fading at the edges, where bumps shrink)
and multiplies by the per-cell slope window; the client turns that amplitude into bumps.

Research in GitHub issue #92: bumps about 5.7 m apart, fields on north-facing and never-groomed
steeps, groomed blues flat. OSM `piste:grooming=mogul` is a definite yes.
"""
from __future__ import annotations

import math
import re

import numpy as np

NO_MOGUL_NAME = re.compile(r"road|catwalk|cat track|traverse|cutoff|access|skiway", re.I)

DIFFICULTY_TERM = {"expert": 1.0, "advanced": 0.9, "freeride": 0.8, "extreme": 0.6}


def _smoothstep(e0: float, e1: float, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def slope_window(slope_deg):
    """0..1 weight for bump formation by slope: none below 15 deg (no forced turns), full 20 to 35,
    none above 40 (chutes and rock). Works on arrays and scalars."""
    s = np.asarray(slope_deg, dtype=np.float32)
    w = _smoothstep(15.0, 20.0, s) * (1.0 - _smoothstep(35.0, 40.0, s))
    return float(w) if np.ndim(slope_deg) == 0 else w.astype(np.float32)


def run_mogul_score(run: dict, slope_hi: float, aspect_mean: float | None, groom_frac: float | None,
                    mogul_tag: bool, near_lift_top: bool) -> float:
    """How likely this run carries a mogul field, 0..1.

    slope_hi: the 75th percentile slope (deg) along the centre line (a run's steep pitch, not its
    run-out: Highline averages 15 deg end to end). The per-cell slope window then places the bumps on
    the pitch itself. aspect_mean: downhill direction in degrees
    clockwise from north, None when flat. groom_frac: nights groomed / nights reported, None when the
    resort has no grooming reports. mogul_tag: OSM piste:grooming=mogul. near_lift_top: the run starts
    within 150 m of a lift station (short laps, heavy traffic)."""
    if mogul_tag:
        return 1.0
    if run.get("gladed") or run.get("difficulty") in ("novice", "easy", None):
        return 0.0
    if NO_MOGUL_NAME.search(run.get("name") or ""):
        return 0.0
    if slope_hi < 12.0:
        return 0.0
    # grooming: never groomed in the reports is a bump run; a few nights a season (Blue Ox, 3 of 42)
    # knocks the field back; a regular groomer has none
    if groom_frac is None:
        g = 0.7
    elif groom_frac <= 0:
        g = 1.0
    elif groom_frac <= 0.1:
        g = 0.6
    elif groom_frac <= 0.3:
        g = 0.3
    else:
        g = 0.0
    diff = run.get("difficulty")
    if diff == "intermediate":
        d = 0.5 if (groom_frac is None or groom_frac <= 0.1) else 0.0   # a blue left ungroomed (Whistle Pig)
    else:
        d = DIFFICULTY_TERM.get(diff, 0.0)
    s = float(_smoothstep(12.0, 18.0, slope_hi) * (1.0 - _smoothstep(38.0, 45.0, slope_hi)))
    if aspect_mean is None:
        a = 0.85
    else:
        off_north = abs((aspect_mean + 180.0) % 360.0 - 180.0)
        a = 1.0 if off_north <= 60.0 else (0.7 if off_north >= 120.0 else 0.85)
    t = 1.0 if near_lift_top else 0.8
    return float(min(1.0, max(0.0, g * d * s * a * t)))


def paint_field(target: np.ndarray, pts, half_width: float, value: float, res: float, x0: float, y1: float,
                edge: float = 3.0) -> None:
    """Paint `value` along a polyline corridor into a raster (row 0 = north, x0 west edge, y1 north edge),
    fading to 0 over the outer `edge` metres, keeping the max with what is already there."""
    H, W = target.shape
    hw = max(1, int(math.ceil(half_width / res)))
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        length = math.hypot(bx - ax, by - ay)
        steps = max(1, int(length / (res * 0.7)))
        for s in range(steps + 1):
            t = s / steps
            x = ax + (bx - ax) * t
            y = ay + (by - ay) * t
            c = (x - x0) / res
            r = (y1 - y) / res
            ci, ri = int(c), int(r)
            r0, r1 = max(0, ri - hw), min(H, ri + hw + 1)
            c0, c1 = max(0, ci - hw), min(W, ci + hw + 1)
            if r1 <= r0 or c1 <= c0:
                continue
            rr, cc = np.ogrid[r0:r1, c0:c1]
            dist = np.hypot((rr + 0.5 - r) * res, (cc + 0.5 - c) * res)
            w = np.clip((half_width - dist) / max(edge, 1e-6), 0.0, 1.0) * value
            target[r0:r1, c0:c1] = np.maximum(target[r0:r1, c0:c1], w.astype(target.dtype))


def paint_polygon(target: np.ndarray, pts, value: float, res: float, x0: float, y1: float) -> None:
    """Fill a closed polygon (an OSM area run, a bowl) with `value`, keeping the max."""
    from PIL import Image, ImageDraw
    H, W = target.shape
    poly = [((x - x0) / res, (y1 - y) / res) for x, y in pts]
    if len(poly) < 3:
        return
    img = Image.new("L", (W, H), 0)
    ImageDraw.Draw(img).polygon(poly, fill=255)
    m = np.asarray(img, dtype=np.float32) / 255.0 * value
    np.maximum(target, m.astype(target.dtype), out=target)
