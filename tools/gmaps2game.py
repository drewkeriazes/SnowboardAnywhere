"""Turn a Google Maps / Street View URL into a game link at the same view (DATA-008).

    python tools/gmaps2game.py "<maps url>" [pack] [--spot SLUG/VIEW] [--add] [--name NAME] [--eye M]

Reads lat, lon, heading, tilt and FOV from the URL (`@lat,lon,3a,<fov>y,<heading>h,<tilt>t`),
projects to pack metres with the pack's `crs` and `origin` (packs/<pack>/meta.json) and prints
a link that opens the eye camera there:

    http://localhost:5173/?pack=vail&x=1421.5&y=289.6&h=217.2&pitch=-8.4&fov=63.5&cam=eye

- heading: Street View is from true north; the game is from grid north (UTM), so the grid
  convergence at the spot is added (about +0.85 degrees at Vail, west of the zone 13 meridian).
- pitch: Street View tilt 90 is level, so pitch = tilt - 90 (negative looks down).
- fov: the URL's `y` value, used as the vertical FOV.
- `--spot back-bowls-campbells/east` adds `&spot=...` so the game's P key saves
  docs/compare/<pack>/back-bowls-campbells/eye-east.jpg and records the pose.
- `--add` also writes the view into docs/compare/<pack>/<spot>/spot.json (creates it if new).
- `--offset DEG` corrects a panorama whose compass is wrong (common on contributor photospheres;
  Google's own imagery is calibrated). Find it by lining up a far landmark, then pass the same
  value for every view of that panorama; it is stored as `heading_offset` on the view.
- `--at X,Y` puts the eye at pack metres X, Y instead of the URL's lat/lon, for a panorama the
  contributor placed in the wrong spot (heading, pitch and FOV still come from the URL). It is
  stored as `position_override` on the view.
- Short links (maps.app.goo.gl) are expanded first, which needs the network.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from pyproj import Transformer

REPO = Path(__file__).resolve().parent.parent


def expand(url: str) -> str:
    host = urllib.parse.urlparse(url).netloc
    if host.endswith('goo.gl') or host.startswith('maps.app.'):
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.url
    return url


def parse(url: str) -> dict:
    """lat, lon and whatever of heading / tilt / fov the URL carries."""
    m = re.search(r'@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)((?:,[0-9.]+[a-z])*)', urllib.parse.unquote(url))
    if not m:
        raise SystemExit(f'no @lat,lon in the URL: {url}')
    out: dict = {'lat': float(m.group(1)), 'lon': float(m.group(2))}
    for tok in m.group(3).split(',')[1:]:
        val, key = float(tok[:-1]), tok[-1]
        if key == 'h':
            out['heading'] = val
        elif key == 't':
            out['tilt'] = val
        elif key == 'y':
            out['fov'] = val
    out['streetview'] = ',3a,' in url or out.get('tilt') is not None
    return out


def to_game(meta: dict, lat: float, lon: float, heading: float) -> tuple[float, float, float]:
    """Pack metres and the grid heading for a true heading at that spot."""
    t = Transformer.from_crs('EPSG:4326', meta['crs'], always_xy=True)
    ox, oy = meta['origin']
    e, n = t.transform(lon, lat)
    e2, n2 = t.transform(lon, lat + 1e-4)  # a step due north
    convergence = math.degrees(math.atan2(e2 - e, n2 - n))  # grid azimuth of true north
    return e - ox, n - oy, (heading + convergence) % 360


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('url')
    ap.add_argument('pack', nargs='?', default='vail')
    ap.add_argument('--spot', default='', help='SLUG or SLUG/VIEW under docs/compare/<pack>/')
    ap.add_argument('--add', action='store_true', help='write the view into the spot.json')
    ap.add_argument('--name', default='', help='spot name for a new spot.json')
    ap.add_argument('--eye', type=float, default=1.7, help='eye height above the ground (m)')
    ap.add_argument('--offset', type=float, default=0.0, help='degrees added to the Street View heading (bad panorama compass)')
    ap.add_argument('--at', default='', help='X,Y in pack metres: override a misplaced panorama position')
    ap.add_argument('--host', default='http://localhost:5173/')
    a = ap.parse_args()

    meta_file = REPO / 'packs' / a.pack / 'meta.json'
    if not meta_file.exists():
        raise SystemExit(f'no pack meta at {meta_file}')
    meta = json.loads(meta_file.read_text(encoding='utf-8'))
    url = expand(a.url)
    v = parse(url)
    heading = v.get('heading', 0.0)
    pitch = v['tilt'] - 90 if 'tilt' in v else 0.0
    fov = v.get('fov', 75.0)
    x, y, h = to_game(meta, v['lat'], v['lon'], heading + a.offset)
    if a.at:
        px, py = x, y
        x, y = (float(t) for t in a.at.split(','))
        print(f'  position override: {x:.0f}, {y:.0f} instead of the pin at {px:.0f}, {py:.0f} ({math.hypot(x - px, y - py):.0f} m)', file=sys.stderr)
    b = meta['bounds']
    if not (b['minX'] <= x <= b['maxX'] and b['minY'] <= y <= b['maxY']):
        print(f'warning: {x:.0f}, {y:.0f} is outside the {a.pack} pack bounds', file=sys.stderr)

    q = {'pack': a.pack, 'x': f'{x:.1f}', 'y': f'{y:.1f}', 'h': f'{h:.1f}', 'pitch': f'{pitch:.1f}', 'fov': f'{fov:.1f}', 'cam': 'eye'}
    if a.eye != 1.7:
        q['eye'] = f'{a.eye:g}'
    if a.spot:
        q['spot'] = a.spot
        # FEAT-093: carry the view's (else the spot's) weather, so the eye camera and P match shoot_spots.mjs
        slug0, _, view0 = a.spot.partition('/')
        spec0 = REPO / 'docs' / 'compare' / a.pack / slug0 / 'spot.json'
        if spec0.exists():
            s0 = json.loads(spec0.read_text(encoding='utf-8'))
            v0 = next((e for e in s0.get('views', []) if e.get('id') == (view0 or 'view')), {})
            w0 = v0.get('weather') or s0.get('weather')
            if w0:
                q['weather'] = w0
    link = a.host + '?' + urllib.parse.urlencode(q, safe='/')
    print(link)
    print(f'  lat {v["lat"]:.7f} lon {v["lon"]:.7f} -> x {x:.1f} y {y:.1f}; heading {heading:.1f} true = {h:.1f} grid; pitch {pitch:.1f}; fov {fov:.1f}'
          + (f'; compass offset {a.offset:+.1f} applied' if a.offset else '')
          + ('' if v['streetview'] else ' (not a Street View URL: heading and pitch defaulted)'), file=sys.stderr)

    if a.add:
        if not a.spot:
            raise SystemExit('--add needs --spot SLUG/VIEW')
        slug, _, view = a.spot.partition('/')
        view = view or 'view'
        spot_dir = REPO / 'docs' / 'compare' / a.pack / slug
        spot_dir.mkdir(parents=True, exist_ok=True)
        spec_file = spot_dir / 'spot.json'
        spec = json.loads(spec_file.read_text(encoding='utf-8')) if spec_file.exists() else {
            'name': a.name or slug, 'latlon': [v['lat'], v['lon']], 'game': {'x': round(x), 'y': round(y)}, 'views': [],
            'streetview_capture': 'TODO: month year, contributor (shown at the bottom of the Street View)'}
        views = spec.setdefault('views', [])
        entry = next((e for e in views if e.get('id') == view), None)
        if entry is None:
            entry = {'id': view}
            views.append(entry)
        entry.update({'heading': round(heading, 1), 'pitch': round(pitch, 1), 'fov': round(fov, 1), 'streetview': url,
                      'x': round(x, 1), 'y': round(y, 1), 'h': round(h, 1), 'game': link})
        if a.at:
            entry['position_override'] = True
        else:
            entry.pop('position_override', None)
        if a.offset:
            entry['heading_offset'] = a.offset
        else:
            entry.pop('heading_offset', None)
        spec_file.write_text(json.dumps(spec, indent=2) + '\n', encoding='utf-8')
        print(f'  wrote {spec_file.relative_to(REPO).as_posix()}', file=sys.stderr)


if __name__ == '__main__':
    main()
