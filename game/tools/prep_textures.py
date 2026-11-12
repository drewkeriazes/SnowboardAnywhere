"""Fetch the CC0 rock and talus PBR sets (ambientCG) and write the game's surface textures.

    python game/tools/prep_textures.py [work_dir]

Outputs in game/public/textures/ (1024 px, tileable). These are the game's own textures, not a pack's, so this
script stayed in the game when EPIC-16 moved the pipeline to MapPacker-SnowboardAnywhere (FEAT-242). It needs
numpy and Pillow.
  <name>_albedo.jpg   sRGB colour, desaturated toward cool grey and normalised to a mean linear
                      luminance of ALBEDO_MEAN, so the shader sets the final tone with one tint
  <name>_nrm.jpg      R, G = OpenGL tangent-space normal x, y (z is rebuilt in the shader);
                      B = roughness

The sets are CC0 (https://docs.ambientcg.com/license/): no attribution is legally required; the
credits list them anyway. See DATA-005 (#18) for why these sets and not imagery.
"""
import io
import os
import sys
import urllib.request
import zipfile

import numpy as np
from PIL import Image

SETS = {
    # name in the game -> (ambientCG asset, saturation kept)
    "rock": ("Rock030", 0.30),   # grey cliff face, granite-like, little moss
    "scree": ("Gravel040", 0.30),  # angular grey gravel; tiled at a few metres it reads as talus
}
ALBEDO_MEAN = 0.35  # linear luminance after normalisation
SIZE = 1024
UA = "SnowboardAnywhere-texture-prep/1.0"

GAME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(GAME)
OUT = os.path.join(GAME, "public", "textures")


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def fetch(asset, work):
    zpath = os.path.join(work, f"{asset}_1K-JPG.zip")
    if not os.path.exists(zpath):
        url = f"https://ambientcg.com/get?file={asset}_1K-JPG.zip"
        print("download", url)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r, open(zpath, "wb") as f:
            f.write(r.read())
    z = zipfile.ZipFile(zpath)

    def load(suffix):
        name = next(n for n in z.namelist() if n.endswith(suffix))
        return Image.open(io.BytesIO(z.read(name)))
    return load


def main():
    work = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "raw", "textures")
    os.makedirs(work, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    for name, (asset, keep_sat) in SETS.items():
        load = fetch(asset, work)
        col = np.asarray(load("_Color.jpg").convert("RGB").resize((SIZE, SIZE), Image.LANCZOS), np.float32) / 255
        lin = srgb_to_linear(col)
        lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        # keep a little of the original colour (lichen, iron staining), then cool it slightly
        lin = lum[..., None] + (lin - lum[..., None]) * keep_sat
        lin *= np.array([0.97, 1.0, 1.04], np.float32)
        lin *= ALBEDO_MEAN / float(lum.mean())
        Image.fromarray((linear_to_srgb(lin) * 255 + 0.5).astype(np.uint8)).save(
            os.path.join(OUT, f"{name}_albedo.jpg"), quality=88)
        nrm = np.asarray(load("_NormalGL.jpg").convert("RGB").resize((SIZE, SIZE), Image.LANCZOS), np.uint8)
        rough = np.asarray(load("_Roughness.jpg").convert("L").resize((SIZE, SIZE), Image.LANCZOS), np.uint8)
        packed = np.dstack([nrm[..., 0], nrm[..., 1], rough])
        Image.fromarray(packed).save(os.path.join(OUT, f"{name}_nrm.jpg"), quality=92)
        print(f"{name}: {asset}  mean lum {lum.mean():.3f} -> {ALBEDO_MEAN}  roughness mean {rough.mean() / 255:.2f}")


if __name__ == "__main__":
    main()
