#!/usr/bin/env python3
"""FEAT-172 CI report: compares two runs of game/tools/cishot.mjs (main and the PR).

python tools/ci/render_report.py <before_dir> <after_dir> <out_dir> [--stills] [--run-url URL]
    [--before-dist DIR --after-dist DIR]

Writes <out_dir>/report.md (the PR comment body, starting with the marker the workflow looks for to
update its own comment) and <out_dir>/summary.json: the shader compile result, the scene budget counts
against main and the gzipped JS size. With --stills (asked for with the `stills` label or a manual run)
also a pixel difference per still and <out_dir>/img/<view>.jpg (before | after | changed pixels, side by
side), shipped in the run's artifact. Exit code 1 when a scene budget count grew by more than BUDGET_JUMP
over main (with a small absolute floor so a count of 14 textures going to 16 is not a fail), or the PR
run had shader messages or page errors. Needs numpy and Pillow.
"""
import argparse
import gzip
import json
import os
import sys

import numpy as np
from PIL import Image

MARKER = "<!-- ci-stills -->"
BUDGET_JUMP = 0.10
# per-count floor: a rise must also be at least this big to fail. Geometries is a running total of what
# is in GPU memory, so it depends on how the tiles streamed in before the view; it gets a wide floor.
FLOORS = {"calls": 10, "triangles": 20000, "geometries": 50, "textures": 2, "programs": 2}
HEAP_FLOOR_MB = 16
CHANGED = 16  # a pixel counts as changed when a channel moved by more than this (of 255)
THUMB_W = 320


def load_stats(d):
    p = os.path.join(d, "stats.json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def bundle_gzip_kb(dist):
    """gzipped size of the JS the game loads (dist/assets/*.js), in KB; None when there is no build"""
    if not dist:
        return None
    assets = os.path.join(dist, "assets")
    if not os.path.isdir(assets):
        return None
    total = 0
    for n in sorted(os.listdir(assets)):
        if n.endswith(".js"):
            with open(os.path.join(assets, n), "rb") as f:
                total += len(gzip.compress(f.read(), 9))
    return total / 1024


def pixel_diff(a_path, b_path, out_jpg):
    """mean absolute difference (% of full scale) and share of changed pixels (%), plus a thumbnail strip"""
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        b = b.resize(a.size)
    A = np.asarray(a, dtype=np.int16)
    B = np.asarray(b, dtype=np.int16)
    d = np.abs(A - B)
    mean = float(d.mean()) / 255 * 100
    changed = float((d.max(axis=2) > CHANGED).mean()) * 100
    # difference image: changed pixels in magenta over a dimmed grey copy of the PR still
    grey = np.asarray(b.convert("L"), dtype=np.float32)[..., None] * 0.35
    heat = np.repeat(grey, 3, axis=2)
    m = d.max(axis=2) > CHANGED
    heat[m] = [255, 0, 200]
    h = round(a.size[1] * THUMB_W / a.size[0])
    strip = Image.new("RGB", (THUMB_W * 3 + 8, h), (255, 255, 255))
    for i, im in enumerate([a, b, Image.fromarray(heat.astype(np.uint8))]):
        strip.paste(im.resize((THUMB_W, h), Image.LANCZOS), (i * (THUMB_W + 4), 0))
    strip.save(out_jpg, quality=80)
    return mean, changed


def budget_rows(before, after):
    """per view and count: (view, key, before, after, change %, failed)"""
    rows = []
    bviews = {v["name"]: v for v in (before or {}).get("views", [])}
    # the compile pass adds programs; a side without it (a build before __sim.scene) is not comparable on them
    both_compiled = all((s or {}).get("compile", {}).get("compiled", False) for s in (before, after))
    for v in (after or {}).get("views", []):
        bv = bviews.get(v["name"])
        for k, floor in FLOORS.items():
            if k == "programs" and not both_compiled:
                continue
            a = v.get(k)
            b = bv.get(k) if bv else None
            if a is None:
                continue
            pct = (a - b) / b * 100 if b else None
            failed = b is not None and a > b * (1 + BUDGET_JUMP) and a - b >= floor
            rows.append((v["name"], k, b, a, pct, failed))
    return rows


def fmt(n):
    if n is None:
        return "n/a"
    if isinstance(n, float) and not n.is_integer():
        return f"{n:,.1f}"
    return f"{int(n):,}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("before")
    ap.add_argument("after")
    ap.add_argument("out")
    ap.add_argument("--stills", action="store_true", help="compare the stills too (pixel difference, side-by-side JPEGs)")
    ap.add_argument("--run-url", default="")
    ap.add_argument("--before-dist", default="")
    ap.add_argument("--after-dist", default="")
    args = ap.parse_args()

    os.makedirs(os.path.join(args.out, "img"), exist_ok=True)
    before, after = load_stats(args.before), load_stats(args.after)
    fails = []
    lines = [MARKER, "## Shader compile and scene budgets (synthetic pack)", ""]
    if after is None:
        lines.append("The PR's run of `cishot.mjs` did not finish, so there is nothing to compare. See the `render-budgets` job log.")
        fails.append("no stats from the PR run")
    else:
        lines.append(f"Rendered on `{after.get('gpu', '?')}`, `lowgfx`, clear sky, noon. "
                     "Before is `main`, after is this PR, both on the same synthetic pack build.")
        if before is None:
            lines.append("")
            lines.append("`main` did not produce a run (it may predate this check), so only the PR's numbers are shown.")

    # stills (only when asked for)
    shots = []
    if after is not None and args.stills:
        names = sorted(n for n in os.listdir(args.after) if n.endswith((".png", ".jpg")))
        for n in names:
            stem = os.path.splitext(n)[0]
            b_path = os.path.join(args.before, n)
            if before is None or not os.path.exists(b_path):
                shots.append((stem, None, None))
                continue
            mean, changed = pixel_diff(b_path, os.path.join(args.after, n), os.path.join(args.out, "img", f"{stem}.jpg"))
            shots.append((stem, mean, changed))
        lines += ["", "### Stills", "", "| view | mean difference | pixels changed |", "|---|---:|---:|"]
        for stem, mean, changed in shots:
            lines.append(f"| `{stem}` | {'n/a' if mean is None else f'{mean:.2f} %'} | {'n/a' if changed is None else f'{changed:.1f} %'} |")
        lines += ["", "A percent or two on `01_spawn_chase` is run-to-run noise. Side-by-side JPEGs (before | after | "
                  "changed pixels in magenta) and the full stills are in the run's `ci-stills` artifact."]

    # shader compile
    if after is not None:
        msgs = after.get("shaderMessages", []) + after.get("pageErrors", [])
        comp = after.get("compile", {})
        lines += ["", "### Shader compile", ""]
        if msgs:
            fails.append(f"{len(msgs)} shader message(s) or page error(s)")
            lines.append(f"**Failed:** {len(msgs)} shader message(s) or page error(s):")
            lines += ["", "```", *[m[:600] for m in msgs[:8]], "```"]
        else:
            passes = ", ".join(f"{p['weather']} {p['ms']} ms" for p in comp.get("passes", []))
            lines.append(f"Clean: {comp.get('programs', '?')} programs compiled ({passes}), no GLSL errors or warnings.")

    # budgets
    if after is not None:
        rows = budget_rows(before, after)
        bad = [r for r in rows if r[5]]
        lines += ["", "### Scene budgets", "",
                  f"`renderer.info` for the whole frame at each view. A count more than {BUDGET_JUMP:.0%} over `main` fails the check."]
        lines += ["", "| view | count | main | PR | change |", "|---|---|---:|---:|---:|"]
        for view, k, b, a, pct, failed in rows:
            if b is not None and a == b and not failed:
                continue  # unchanged counts stay out of the table
            ch = "new" if b is None else f"{pct:+.1f} %" if pct is not None else "n/a"
            lines.append(f"| `{view}` | {k} | {fmt(b)} | {fmt(a)} | {'**' + ch + '**' if failed else ch} |")
        if all(r[2] is not None and r[2] == r[3] for r in rows) and before is not None:
            lines.append("| all views | all counts | | | unchanged |")
        hb, ha = (before or {}).get("heapMB"), after.get("heapMB")
        heap_fail = hb is not None and ha is not None and ha > hb * (1 + BUDGET_JUMP) and ha - hb >= HEAP_FLOOR_MB
        lines.append(f"| end | JS heap (MB) | {fmt(hb)} | {fmt(ha)} | "
                     f"{'n/a' if not hb else ('**' if heap_fail else '') + f'{(ha - hb) / hb * 100:+.1f} %' + ('**' if heap_fail else '')} |")
        for view, k, b, a, pct, _ in bad:
            fails.append(f"{view} {k} {fmt(b)} -> {fmt(a)} ({pct:+.1f} %)")
        if heap_fail:
            fails.append(f"JS heap {hb} -> {ha} MB")
        if before is not None and not before.get("compile", {}).get("compiled", False):
            lines += ["", "Programs not compared: `main`'s build predates the compile pass (`__sim.scene`)."]
        unsettled = [v["name"] for v in after.get("views", []) if not v.get("settled", True)]
        if unsettled:
            lines.append("")
            lines.append(f"Still streaming when shot (counts may be low): {', '.join(unsettled)}.")

    # bundle size (report only)
    kb_b, kb_a = bundle_gzip_kb(args.before_dist), bundle_gzip_kb(args.after_dist)
    if kb_a is not None:
        lines += ["", "### Bundle", "",
                  f"JS gzipped: {fmt(kb_b)} KB on `main`, {fmt(kb_a)} KB here"
                  + (f" ({kb_a - kb_b:+.1f} KB)." if kb_b is not None else ".")]

    lines += [""]
    if fails:
        lines.append("**Check failed:** " + "; ".join(fails))
    else:
        lines.append("**Check passed.**")
    if not args.stills:
        lines.append("Before / after stills: add the `stills` label and push, or Actions > Checks > Run workflow with the PR number and stills ticked.")
    if args.run_url:
        lines.append(f"Stills and `stats.json`: the `ci-stills` artifact on [this run]({args.run_url}).")

    with open(os.path.join(args.out, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump({"fails": fails, "shots": shots}, f, indent=2)
    print("\n".join(lines))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
