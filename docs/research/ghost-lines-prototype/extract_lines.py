"""Ghost lines prototype, step 1: pull the coloured lines Drew drew on a menu screenshot into pixel polylines.

python docs/research/ghost-lines-prototype/extract_lines.py <screenshot> <spec.json> <out.lines.json>

spec.json: {"lines": {"<name>": {"hue": [lo, hi], "box": [x0, y0, x1, y1]}, "<name>": {"black": true, "box": [...]}},
            "sat": 0.45}
  hue in degrees (lo > hi wraps through 0), box in screenshot pixels. A colour used twice gets two names with
  different boxes. Keep UI out of the boxes (the taskbar's yellow sun icon read as a line once).
Each line becomes cells of 6 px (centroid), walked greedily from one end (the cell farthest from the mean).
The order (which end is first) doesn't matter: the ride step rides from the high end.
"""
import json
import sys

import numpy as np
from PIL import Image


def main(img_path, spec_path, out_path):
    spec = json.load(open(spec_path, encoding="utf-8"))
    im = np.asarray(Image.open(img_path).convert("RGB")).astype(int)
    H, W, _ = im.shape
    mx, mn = im.max(-1), im.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1)
    r, g, b = (im[..., i] / 255 for i in range(3))
    d, m = np.maximum(mx - mn, 1) / 255, mx / 255
    hue = np.where(m == r, ((g - b) / d) % 6, np.where(m == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    ys, xs = np.mgrid[0:H, 0:W]
    S = (sat > spec.get("sat", 0.45)) & (mx > 90)  # a pure (255,128,255) pink sits at 0.498
    out = {}
    for name, c in spec["lines"].items():
        x0, y0, x1, y1 = c["box"]
        box = (xs >= x0) & (xs < x1) & (ys >= y0) & (ys < y1)
        if c.get("black"):
            mask = box & (mx < 6)  # drawn black is (0,0,0); shaded trees are not
        else:
            lo, hi = c["hue"]
            hr = (hue >= lo) & (hue < hi) if lo < hi else (hue >= lo) | (hue < hi)
            mask = S & box & hr
        pts = np.argwhere(mask)[:, ::-1].astype(float)
        cells = {}
        for x, y in pts:
            cells.setdefault((int(x // 6), int(y // 6)), []).append((x, y))
        cc = np.array([np.mean(v, 0) for v in cells.values() if len(v) >= 2])
        if len(cc) < 5:
            print(f"{name}: too few pixels ({len(pts)}), check its hue / box")
            continue
        a = int(np.argmax(np.hypot(*(cc - cc.mean(0)).T)))
        order, left = [a], set(range(len(cc))) - {a}
        while left:
            cur = cc[order[-1]]
            j = min(left, key=lambda k: np.hypot(*(cc[k] - cur)))
            if np.hypot(*(cc[j] - cur)) > 30:
                break
            order.append(j)
            left.remove(j)
        p = cc[order]
        out[name] = [[round(float(x), 1), round(float(y), 1)] for x, y in p]
        print(f"{name:10s} {len(pts):5d} px, {len(cc):3d} cells, walked {len(order)}, left over {len(left)}")
    json.dump(out, open(out_path, "w"))


if __name__ == "__main__":
    main(*sys.argv[1:4])
