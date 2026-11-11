"""FEAT-222: publish a built pack as a release of the resorts repo, so `npm run get <slug>` can download it.

    python pipeline/publish_pack.py packs/vail [--status preview|playable] [--tier gold] [--report report.md]
                                               [--repo-dir <clone>] [--dry-run]

Runs on Drew's PC (needs `gh` signed in with push access to the resorts repo). Steps:
  1. refuse a pack whose meta.json `formatVersion` is not this pipeline's FORMAT_VERSION (rebuild it on main)
  2. zip the pack, stored (PNG tiles do not compress), fixed timestamps so the same pack gives the same sha256;
     refuse a zip over 1.9 GiB (GitHub's limit per release asset is 2 GiB)
  3. `gh release create <slug>-v<N>` in the resorts repo with the zip, meta.json and the report if there is one
  4. update catalog.json, copy the resort's config, EPT node lists and manifest into the clone, commit and push

The resorts repo is cloned next to this checkout (../MapPacker-SnowboardAnywhere) the first time. Layout and
catalog schema: docs/research/resort-auto-pipeline.md section 2; download side: game/tools/get_pack.mjs.
A pack is `playable` only when every DATA-022 MVP line passes in its report (EPIC-15 rule 2): the status comes
from `<pack_dir>/report.json` (`pack_report.py`, FEAT-175) when it was made for this build, `preview` without one,
and `--status playable` is refused unless the report passes.
"""
import argparse, glob, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time, zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from packwriter import FORMAT_VERSION  # noqa: E402

RESORTS_REPO = "drewkeriazes/MapPacker-SnowboardAnywhere"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_ZIP = int(1.9 * 1024 ** 3)
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
SKIP_DIRS = {"debug"}        # pipeline diagnostics (debug/species.png), not read by the game


def pack_files(pack_dir: str) -> list:
    """Every file the zip carries, as forward-slash paths relative to the pack, sorted. Leaves out debug/ and
    dot files (get_pack's .catalog.json marker)."""
    out = []
    for root, dirs, files in os.walk(pack_dir):
        rel_root = os.path.relpath(root, pack_dir)
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not (rel_root == "." and d in SKIP_DIRS))
        for f in files:
            if f.startswith("."):
                continue
            out.append(os.path.normpath(os.path.join(rel_root, f)).replace(os.sep, "/"))
    return sorted(out)


def zip_pack(pack_dir: str, zip_path: str) -> tuple:
    """Stored zip of the pack (entries relative to the pack folder). Returns (bytes, sha256 hex)."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as z:
        for rel in pack_files(pack_dir):
            info = zipfile.ZipInfo(rel, ZIP_TIME)
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            with open(os.path.join(pack_dir, rel), "rb") as src, z.open(info, "w") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
    h = hashlib.sha256()
    with open(zip_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return os.path.getsize(zip_path), h.hexdigest()


def next_version(slug: str, tags: list, catalog: dict) -> int:
    """One past the highest <slug>-v<N> release or catalog version, so a deleted release's number is not reused."""
    pat = re.compile(rf"^{re.escape(slug)}-v(\d+)$")
    nums = [int(m.group(1)) for t in tags if (m := pat.match(t))]
    nums += [r["pack"]["version"] for r in catalog.get("resorts", []) if r.get("slug") == slug and r.get("pack")]
    return max(nums, default=0) + 1


def report_status(pack_dir: str, meta: dict, requested: str | None) -> tuple:
    """(status, why) from the pack's report.json (EPIC-15 rule 2). A report made for another build counts as none.
    Raises SystemExit when `playable` is asked for and the report does not pass."""
    path = os.path.join(pack_dir, "report.json")
    rep = json.load(open(path, encoding="utf-8")) if os.path.isfile(path) else None
    if rep and rep.get("build") != meta.get("build"):
        why, rep = f"report.json is for build {rep.get('build')}, the pack is {meta.get('build')}: re-run pack_report.py", None
    elif rep:
        why = "report passes" if rep.get("playable") else f"report: MVP lines {', '.join(rep.get('failing', []))} hold it back"
    else:
        why = "no report.json (python pipeline/pack_report.py <pack_dir>)"
    passes = bool(rep and rep.get("playable"))
    if requested == "playable" and not passes:
        raise SystemExit(f"refusing --status playable: {why}")
    return requested or ("playable" if passes else "preview"), why


def asset_url(slug: str, version: int, repo: str = RESORTS_REPO) -> str:
    return f"https://github.com/{repo}/releases/download/{slug}-v{version}/{slug}.zip"


def catalog_entry(meta: dict, cfg: dict, *, version: int, size: int, sha256: str, pipeline: str, tier: str,
                  status: str, report: str | None, repo: str = RESORTS_REPO) -> dict:
    slug = meta["slug"]
    return {
        "slug": slug, "name": meta["name"],
        "region": cfg.get("region", ""), "country": cfg.get("country", ""),
        "lonlat": meta.get("lonlat"),
        "tier": tier, "status": status,
        "pack": {"version": version, "formatVersion": meta.get("formatVersion", 0), "build": meta.get("build"),
                 "built": time.strftime("%Y-%m-%d"), "pipeline": pipeline,
                 "bytes": size, "sha256": sha256, "url": asset_url(slug, version, repo)},
        "report": report,
    }


def update_catalog(catalog: dict, entry: dict) -> dict:
    """Replace the resort's entry (or add it), resorts sorted by name; `formatVersion` is the newest format any
    pack in the catalog uses."""
    resorts = [r for r in catalog.get("resorts", []) if r.get("slug") != entry["slug"]] + [entry]
    resorts.sort(key=lambda r: (r.get("name") or r["slug"]).lower())
    fmt = max([r["pack"].get("formatVersion", 0) for r in resorts if r.get("pack")], default=FORMAT_VERSION)
    return {"formatVersion": fmt, "resorts": resorts}


def run(cmd: list, cwd: str | None = None, capture: bool = True) -> str:
    r = subprocess.run(cmd, cwd=cwd, capture_output=capture, text=True, encoding="utf-8")
    if r.returncode:
        raise SystemExit(f"{' '.join(cmd)} failed ({r.returncode}):\n{(r.stderr or '') + (r.stdout or '')}".rstrip())
    return (r.stdout or "").strip()


def resorts_clone(repo_dir: str, repo: str) -> str:
    if not os.path.isdir(os.path.join(repo_dir, ".git")):
        print(f"cloning {repo} into {repo_dir}")
        run(["gh", "repo", "clone", repo, repo_dir], capture=False)
    if run(["git", "status", "--porcelain"], cwd=repo_dir):
        raise SystemExit(f"{repo_dir} has uncommitted changes; commit or discard them first")
    run(["git", "pull", "--ff-only", "--quiet"], cwd=repo_dir)
    return repo_dir


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pack_dir")
    ap.add_argument("--status", choices=["preview", "playable"],
                    help="default from report.json; playable only when the DATA-022 report passes (EPIC-15 rule 2)")
    ap.add_argument("--tier", choices=["gold", "silver", "bronze"], default="gold")
    ap.add_argument("--report", help="report markdown to attach and commit (default <pack_dir>/report.md if present)")
    ap.add_argument("--repo", default=RESORTS_REPO)
    ap.add_argument("--repo-dir", default=os.path.join(os.path.dirname(REPO), "MapPacker-SnowboardAnywhere"))
    ap.add_argument("--dry-run", action="store_true", help="zip and print the catalog entry; no release, no commit")
    a = ap.parse_args(argv)

    pack_dir = os.path.abspath(a.pack_dir)
    with open(os.path.join(pack_dir, "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    slug = meta["slug"]
    fmt = meta.get("formatVersion", 0)
    if fmt != FORMAT_VERSION:
        raise SystemExit(f"{pack_dir} is pack format {fmt}, this pipeline writes {FORMAT_VERSION}: rebuild it on main "
                         f"(python pipeline/build_pack.py {slug} <raw_dir> <out_dir>) before publishing")
    a.status, why = report_status(pack_dir, meta, a.status)
    print(f"status {a.status} ({why})")
    cfg_path = os.path.join(REPO, "pipeline", "resorts", f"{slug}.json")
    cfg = json.load(open(cfg_path, encoding="utf-8")) if os.path.isfile(cfg_path) else {}
    report = a.report or (os.path.join(pack_dir, "report.md") if os.path.isfile(os.path.join(pack_dir, "report.md")) else None)
    pipeline = run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO)
    if run(["git", "status", "--porcelain", "--", "pipeline"], cwd=REPO):
        print("warning: pipeline/ has uncommitted changes; the catalog records the commit, not them")

    repo_dir = None if a.dry_run else resorts_clone(os.path.abspath(a.repo_dir), a.repo)
    cat_path = os.path.join(repo_dir, "catalog.json") if repo_dir else None
    catalog = json.load(open(cat_path, encoding="utf-8")) if cat_path and os.path.isfile(cat_path) else {"resorts": []}
    tags = [] if a.dry_run else [r["tagName"] for r in json.loads(run(
        ["gh", "release", "list", "-R", a.repo, "--limit", "1000", "--json", "tagName"]) or "[]")]
    version = next_version(slug, tags, catalog)
    tag = f"{slug}-v{version}"

    tmp = tempfile.mkdtemp(prefix=f"publish-{slug}-")
    try:
        zip_path = os.path.join(tmp, f"{slug}.zip")
        t0 = time.time()
        size, sha = zip_pack(pack_dir, zip_path)
        print(f"{slug}.zip: {size / 1e6:.0f} MB, sha256 {sha} ({time.time() - t0:.0f} s)")
        if size > MAX_ZIP:
            raise SystemExit(f"{slug}.zip is {size / 1024 ** 3:.2f} GiB, over the 1.9 GiB limit for a release asset")
        report_rel = f"reports/{slug}.md" if report else None
        entry = catalog_entry(meta, cfg, version=version, size=size, sha256=sha, pipeline=pipeline,
                              tier=a.tier, status=a.status, report=report_rel, repo=a.repo)
        if a.dry_run:
            print(json.dumps(entry, indent=1))
            return

        notes = (f"{meta['name']} pack v{version} ({a.status}, {a.tier} tier). Pack format {fmt}, build {meta.get('build')}, "
                 f"pipeline {pipeline}. {size / 1e6:.0f} MB, sha256 `{sha}`.\n\n"
                 f"Get it: `cd game && npm run get {slug}` in SnowboardAnywhere.")
        assets = [zip_path, os.path.join(pack_dir, "meta.json")] + ([report] if report else [])
        print(f"creating release {tag} in {a.repo}")
        run(["gh", "release", "create", tag, *assets, "-R", a.repo, "--title", f"{meta['name']} v{version}",
             "--notes", notes], capture=False)

        with open(cat_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(update_catalog(catalog, entry), f, indent=1)
            f.write("\n")
        # the recipe that built it, versioned beside the catalog (copies for now: the pipeline still reads its own)
        os.makedirs(os.path.join(repo_dir, "resorts"), exist_ok=True)
        os.makedirs(os.path.join(repo_dir, "manifests"), exist_ok=True)
        for src in [cfg_path] + glob.glob(os.path.join(REPO, "pipeline", "resorts", f"{slug}_ept_nodes*.txt")):
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(repo_dir, "resorts", os.path.basename(src)))
        man = os.path.join(REPO, "pipeline", "manifests", f"{slug}.json")
        if os.path.isfile(man):
            shutil.copy2(man, os.path.join(repo_dir, "manifests", f"{slug}.json"))
        if report:
            os.makedirs(os.path.join(repo_dir, "reports"), exist_ok=True)
            shutil.copy2(report, os.path.join(repo_dir, report_rel))
        run(["git", "add", "-A"], cwd=repo_dir)
        run(["git", "commit", "-q", "-m", f"{slug} v{version}: {a.status}, {size / 1e6:.0f} MB, pipeline {pipeline}"], cwd=repo_dir)
        try:
            run(["git", "push", "-q"], cwd=repo_dir)
        except SystemExit as e:
            raise SystemExit(f"{e}\nThe release {tag} exists; push the catalog commit by hand from {repo_dir}")
        print(f"published {tag}: {entry['pack']['url']}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
