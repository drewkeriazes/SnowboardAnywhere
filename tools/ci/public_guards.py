#!/usr/bin/env python3
"""FEAT-172 public repo guards: mistakes that cannot be undone once pushed to a public repo.

python tools/ci/public_guards.py --base <ref> [--head <ref>]

Fails (exit 1) on:
  - in-game Spotify code anywhere in the tree at <head> (FEAT-142 lives only on the local
    spotify-private branch; Spotify's Developer Policy rules it out of the public game): the Web Playback
    SDK script or its ready callback, the client id environment variable, Spotify's auth and Web API
    hosts, or a 32-hex-digit id on a line that mentions Spotify;
  - a tracked .env file (other than .env.example);
  - an image the PR adds or changes that is over 1 MB, or outside the folders images belong in.
Secrets in general are gitleaks' job (a separate step in .github/workflows/checks.yml).
Standard library only.
"""
import argparse
import re
import subprocess
import sys

# built from pieces so this file does not match itself
SPOTIFY = [re.compile(p, re.I) for p in (
    r"sdk\.scdn" + r"\.co",
    r"onSpotify" + r"WebPlaybackSDKReady",
    r"VITE_SPOTIFY" + r"_CLIENT_ID",
    r"accounts\.spotify" + r"\.com",
    r"api\.spotify" + r"\.com",
)]
HEX_ID = re.compile(r"\b[0-9a-f]{32}\b", re.I)
IMAGE = re.compile(r"\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$", re.I)
MAX_IMAGE = 1024 * 1024
# docs/screenshots and docs/compare per the card; game/public holds shipped textures and menu stills,
# docs/renders the older pipeline renders
IMAGE_DIRS = ("docs/screenshots/", "docs/compare/", "docs/renders/", "game/public/")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout


def annotate(kind, msg, path=None, line=None):
    loc = f" file={path}" + (f",line={line}" if line else "") if path else ""
    print(f"::{kind}{loc}::{msg}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", default="HEAD")
    a = ap.parse_args()
    fails = 0

    # 1. Spotify, across every tracked text file at head
    for path in git("ls-tree", "-r", "--name-only", a.head).splitlines():
        if IMAGE.search(path) or path.endswith((".mp3", ".ogg", ".bin", ".woff2", ".zip")):
            continue
        try:
            text = git("show", f"{a.head}:{path}")
        except subprocess.CalledProcessError:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            hit = next((p.pattern for p in SPOTIFY if p.search(line)), None)
            if not hit and "spotify" in line.lower() and HEX_ID.search(line):
                hit = "a 32-hex-digit id next to 'spotify'"
            if hit:
                fails += 1
                annotate("error", f"Spotify integration code ({hit}). It stays on the local spotify-private branch "
                         "(CLAUDE.md, FEAT-142): drop it from this branch.", path, n)
        name = path.rsplit("/", 1)[-1]
        if name.startswith(".env") and name != ".env.example":
            fails += 1
            annotate("error", "A .env file is tracked. Remove it from git (it may hold keys) and rotate anything in it.", path)

    # 2. images the PR adds or changes
    for path in git("diff", "--name-only", "--diff-filter=AM", f"{a.base}...{a.head}").splitlines():
        if not IMAGE.search(path):
            continue
        size = int(git("cat-file", "-s", f"{a.head}:{path}").strip())
        if size > MAX_IMAGE:
            fails += 1
            annotate("error", f"Image is {size / 1048576:.1f} MB, over the 1 MB limit. Save it as a JPEG or crop it.", path)
        if not path.startswith(IMAGE_DIRS):
            fails += 1
            annotate("error", f"Images go under {', '.join(IMAGE_DIRS)}; this one is elsewhere.", path)

    print(f"public repo guards: {fails} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
