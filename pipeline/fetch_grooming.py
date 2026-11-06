"""
Fetch a resort's real grooming history into raw/<slug>/grooming/.

Vail Resorts' terrain status page embeds `FR.TerrainStatusFeed`: every trail with Name, Difficulty,
IsOpen and IsGroomed, as published by the resort that night. This script saves that feed from:
  - every winter (Dec..Apr) snapshot of the page in the Internet Archive, and
  - the live page (useful once the season is open; pre-season it lists no ski trails).
build_pack.py then marks a run groomed when the resort groomed it on any saved night.

Usage:  python pipeline/fetch_grooming.py <slug> <raw_dir>
        (the URL comes from pipeline/resorts/<slug>.json "terrain_status_url")
Stdlib only. Resumable: snapshots already saved are skipped. Runs on Drew's PC (needs web access).
"""
import json, os, re, subprocess, sys, time

UA = "SnowboardAnywhere-pipeline/1.0"


def get(url, tries=3):
    """Download with curl (ships with Windows; uses the OS TLS stack and certificate store)."""
    for i in range(tries):
        r = subprocess.run(["curl", "-sS", "--compressed", "-L", "--max-time", "90", "-A", UA, "--fail", url],
                           capture_output=True)
        if r.returncode == 0:
            return r.stdout.decode("utf-8", "replace")
        if i == tries - 1:
            raise RuntimeError(f"curl {r.returncode}: {r.stderr.decode('utf-8', 'replace').strip()}")
        time.sleep(5 * (i + 1))


def parse_feed(html):
    """The feed as {date, trails: [{name, area, difficulty, open, groomed}]}, or None."""
    m = re.search(r"FR\.TerrainStatusFeed\s*=\s*(\{.*?\});\s*\n", html, re.S)
    if not m:
        return None
    f = json.loads(m.group(1))
    trails = []
    for a in f.get("GroomingAreas") or []:
        for t in a.get("Trails") or []:
            trails.append({"name": t.get("Name"), "area": a.get("Name"), "difficulty": t.get("Difficulty"),
                           "type": t.get("TrailType"), "open": bool(t.get("IsOpen")), "groomed": bool(t.get("IsGroomed"))})
    return {"date": f.get("Date"), "trails": trails}


def main():
    slug, raw_dir = sys.argv[1], sys.argv[2]
    here = os.path.dirname(os.path.abspath(__file__))
    cfg = json.load(open(os.path.join(here, "resorts", f"{slug}.json"), encoding="utf-8"))
    url = cfg.get("terrain_status_url")
    if not url:
        sys.exit(f"no terrain_status_url in resorts/{slug}.json")
    out = os.path.join(raw_dir, "grooming")
    os.makedirs(out, exist_ok=True)

    bare = re.sub(r"^https?://(www\.)?", "", url)
    cdx = json.loads(get(f"https://web.archive.org/cdx/search/cdx?url={bare}&output=json&filter=statuscode:200&collapse=timestamp:8"))[1:]
    stamps = [r[1] for r in cdx if int(r[1][4:6]) in (12, 1, 2, 3, 4)]
    print(f"{len(cdx)} archived snapshots, {len(stamps)} in Dec..Apr")
    saved = skipped = empty = 0
    for ts in stamps:
        path = os.path.join(out, f"{ts}.json")
        if os.path.exists(path):
            skipped += 1
            continue
        try:
            feed = parse_feed(get(f"https://web.archive.org/web/{ts}id_/{url}"))
        except Exception as e:
            print(f"  {ts}: fetch failed ({e})")
            continue
        if not feed or not feed["trails"]:
            empty += 1
            print(f"  {ts}: no trail data")
            continue
        feed["source"] = f"https://web.archive.org/web/{ts}/{url}"
        json.dump(feed, open(path, "w", encoding="utf-8"), indent=1)
        saved += 1
        print(f"  {ts}: {len(feed['trails'])} trails, {sum(t['groomed'] for t in feed['trails'])} groomed")
        time.sleep(1.5)  # be polite to the archive

    try:
        live = parse_feed(get(url))
    except RuntimeError as e:
        # vail.com answers scripted requests with 403; the archive snapshots above are the data
        print(f"  live page not fetched ({e}); save it from a browser into grooming/ if needed")
        live = None
    if live and live["trails"]:
        live["source"] = url
        stamp = time.strftime("%Y%m%d%H%M%S")
        json.dump(live, open(os.path.join(out, f"live-{stamp}.json"), "w", encoding="utf-8"), indent=1)
        print(f"  live: {len(live['trails'])} trails, {sum(t['groomed'] for t in live['trails'])} groomed")
    else:
        print("  live: no ski trails listed yet (pre-season)")
    print(f"saved {saved}, already had {skipped}, empty {empty} -> {out}")


if __name__ == "__main__":
    main()
