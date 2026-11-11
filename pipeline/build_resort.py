#!/usr/bin/env python3
"""FEAT-175 step 3: one command builds a resort, from its config to a scored pack.

    python pipeline/build_resort.py <slug> [<raw_dir>] [<out_dir>] [--from <stage>] [--stop-after <stage>]
                                    [--force <stage>]... [--email <address>] [--dry-run]

`raw_dir` is the resort's raw folder (default raw/<slug>; its last folder must be the slug, as fetch.ps1 writes
<RawDir>/<slug>), `out_dir` the pack (default packs/<slug>). Stages, in order:

  nodes     ept_select.py: the EPT node lists (resort.py plan writes them too)
  manifest  gen_manifest.py: the download list
  fetch     fetch.ps1: everything in the manifest (resumable; stops when an item failed)
  landfire  fetch_landfire.mjs EVT, EVC, EVH (US only; the LFPS service wants an email: --email or LANDFIRE_EMAIL)
  grooming  fetch_grooming.py, when the config has a terrain_status_url
  build     build_pack.py (DEM, lidar, NAIP, masks, moguls, piste directions, AO, trees, far trees, cover)
  index     packs/index.json lists the pack
  report    pack_report.py: the DATA-022 scorecard (report.json, report.md in the pack)

A stage is skipped when its inputs have not changed since it last ran: each stage's input fingerprint is kept in
<raw_dir>/build_resort.json. The first run trusts outputs already on disk (node lists, manifest, LANDFIRE clips,
grooming reports, a pack built by a pipeline whose code matches this one) and records them, so an existing resort
is not walked, fetched or built again. A fetch from an older manifest (a new layer, a bigger box, MANIFEST_VERSION)
changes the manifest's fingerprint, so the fetch runs again and downloads only what is missing (DATA-022 item 3).
After the fetch and the build come the pack-build skill's checks: every raw layer present, the OSM files real
JSON and not an Overpass error page, the pack's meta.json in this pipeline's format.

`--from` and `--stop-after` limit the run to a range of stages, `--force` runs a stage even when it looks done
(`--force all` runs every one), `--dry-run` prints what would run and why. Exit status: 0 done, 1 a stage failed
(the message says which and what to do), 2 bad arguments. `build_resort.cmd` is the launcher on Drew's PC.
"""
import argparse, glob, hashlib, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

STAGES = ["nodes", "manifest", "fetch", "landfire", "grooming", "build", "index", "report"]
STATE = "build_resort.json"
LANDFIRE = (("EVT", "landfire"), ("EVC", os.path.join("landfire", "evc")), ("EVH", os.path.join("landfire", "evh")))
# raw layers build_pack.py needs (pack_report.py line 2): folder, and a file that must be in it
RAW_NEED = {"1 m DEM": ("dem1m", None), "10 m DEM": ("dem10m", None), "lidar (EPT)": ("ept", "ept.json"),
            "NAIP": ("naip1m", None), "Mapterhorn": ("mapterhorn", None)}
OSM_NEED = ("ski", "built", "natural", "peaks_far")


class Failed(Exception):
    """a stage failed; the message says what to do"""


def sha(*parts) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else json.dumps(p, sort_keys=True).encode())
    return h.hexdigest()[:16]


def file_sha(path) -> str | None:
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return sha(f.read())


# pipeline/ paths that do not shape the pack: inputs of their own, or tools around the build
NOT_BUILD = ("pipeline/tests", "pipeline/resorts", "pipeline/manifests", "pipeline/build_resort.py",
             "pipeline/resort.py", "pipeline/publish_pack.py", "pipeline/pack_report.py")
NOT_BUILD_SPEC = [f":!{p}" for p in NOT_BUILD]


def pipeline_code(repo=REPO) -> str | None:
    """a fingerprint of the code that builds the pack: the git tree of pipeline/ without NOT_BUILD, plus the
    contents of any uncommitted change to it (an edited build script builds again); None outside git"""
    try:
        tree = subprocess.run(["git", "ls-tree", "-r", "HEAD", "pipeline/"], cwd=repo, capture_output=True,
                              text=True, check=True).stdout
        dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all", "--", "pipeline"]
                               + NOT_BUILD_SPEC, cwd=repo, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    keep = [l for l in tree.splitlines() if not l.split("\t")[-1].startswith(NOT_BUILD)]
    changed = sorted(l[3:].strip().strip('"') for l in dirty.splitlines() if l.strip())
    blobs = [(p, file_sha(os.path.join(repo, p))) for p in changed]
    return sha("\n".join(keep), blobs) + ("+dirty" if changed else "")


def same_code(commit, repo=REPO) -> bool:
    """True when the pipeline code at `commit` (a pack's meta.json `pipeline`) is this checkout's"""
    if not commit or commit.endswith("+dirty"):
        return False
    r = subprocess.run(["git", "diff", "--quiet", commit, "HEAD", "--", "pipeline"] + NOT_BUILD_SPEC, cwd=repo,
                       capture_output=True)
    return r.returncode == 0 and not (pipeline_code(repo) or "").endswith("+dirty")


def run(cmd, cwd=REPO):
    """run a stage's command with its output on the console; -> exit code"""
    print("  $ " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=cwd).returncode


class Resort:
    """the paths and config one run works on"""

    def __init__(self, slug, raw_dir, out_dir, resorts_dir=None, manifests_dir=None):
        self.slug, self.raw, self.out = slug, os.path.abspath(raw_dir), os.path.abspath(out_dir)
        self.resorts = resorts_dir or os.path.join(HERE, "resorts")
        self.manifests = manifests_dir or os.path.join(HERE, "manifests")
        self.cfg_path = os.path.join(self.resorts, f"{slug}.json")
        self.man_path = os.path.join(self.manifests, f"{slug}.json")
        with open(self.cfg_path, encoding="utf-8") as f:
            self.cfg = json.load(f)
        self.state_path = os.path.join(self.raw, STATE)
        try:
            with open(self.state_path, encoding="utf-8") as f:
                self.state = json.load(f)
        except (OSError, ValueError):
            self.state = {}

    def save(self):
        os.makedirs(self.raw, exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(self.state, f, indent=1, sort_keys=True)
            f.write("\n")

    def node_files(self):
        L = self.cfg.get("lidar") or {}
        files = [s["nodes_file"] for s in [L] + list(L.get("extra", [])) if s.get("nodes_file")]
        if L.get("far"):
            files.append(L["far"]["nodes_file"])
        return [os.path.join(self.resorts, f) for f in files]


# ------------------------------------------------------------------------------------------------ stages
# Each stage: inputs(r) -> fingerprint, present(r) -> outputs on disk, run(r, ctx) -> None or raises Failed.

def nodes_inputs(r):
    L = {k: v for k, v in (r.cfg.get("lidar") or {}).items()}
    return sha(r.cfg.get("crs"), r.cfg.get("utm_bbox"), r.cfg.get("lonlat_bbox"), L)


def nodes_present(r):
    return all(os.path.isfile(p) for p in r.node_files())


def nodes_run(r, ctx):
    if not r.cfg.get("lidar"):
        print("  no lidar in the config: nothing to select")
        return
    if ctx.run([sys.executable, os.path.join(HERE, "ept_select.py"), r.slug]):
        raise Failed("ept_select.py failed (the EPT hierarchy is on the usgs-lidar-public bucket: Drew's PC only)")


def manifest_inputs(r):
    import gen_manifest
    return sha(file_sha(r.cfg_path), [file_sha(p) for p in r.node_files()], gen_manifest.MANIFEST_VERSION)


def manifest_present(r):
    return os.path.isfile(r.man_path)


def manifest_run(r, ctx):
    if ctx.run([sys.executable, os.path.join(HERE, "gen_manifest.py"), r.slug]):
        raise Failed("gen_manifest.py failed")


def fetch_inputs(r):
    return file_sha(r.man_path)


def fetch_present(r):
    return os.path.isfile(os.path.join(r.raw, "FETCH_COMPLETE.txt"))


def fetch_run(r, ctx):
    if os.path.basename(os.path.normpath(r.raw)) != r.slug:
        raise Failed(f"fetch.ps1 writes <RawDir>\\{r.slug}; the raw folder {r.raw} is not named {r.slug}")
    code = ctx.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(HERE, "fetch.ps1"),
                    "-Slug", r.slug, "-RawDir", os.path.dirname(os.path.normpath(r.raw))])
    if code == 2:
        raise Failed(f"some downloads failed ({os.path.join(r.raw, 'fetch_log.txt')} lists them): run again, "
                     "it resumes")
    if code:
        raise Failed(f"fetch.ps1 exited {code}")
    check_raw(r)


def check_raw(r):
    """the pack-build skill's raw checks: every layer there, the OSM files real JSON (an Overpass error page is
    HTML or a JSON "remark" with no elements)"""
    miss = []
    for name, (d, f) in RAW_NEED.items():
        p = os.path.join(r.raw, d)
        if not os.path.isdir(p) or not os.listdir(p) or (f and not os.path.isfile(os.path.join(p, f))):
            miss.append(name)
    for q in OSM_NEED:
        p = os.path.join(r.raw, "osm", f"{q}.json")
        try:
            with open(p, encoding="utf-8") as fh:
                d = json.load(fh)
            if not d.get("elements"):
                miss.append(f"OSM {q} (no elements{': ' + d['remark'][:80] if d.get('remark') else ''})")
        except (OSError, ValueError):
            miss.append(f"OSM {q} (missing or not JSON)")
    if miss:
        raise Failed(f"raw data incomplete in {r.raw}: {', '.join(miss)}. Delete the bad files and fetch again")


def landfire_needed(r):
    return r.cfg.get("country", "US") == "US"


def landfire_inputs(r):
    return sha(r.cfg.get("lonlat_bbox"), r.cfg.get("crs"))


def landfire_present(r):
    return all(glob.glob(os.path.join(r.raw, d, "*.tif")) for _, d in LANDFIRE)


def landfire_run(r, ctx):
    if not landfire_needed(r):
        print("  outside the US: no LANDFIRE")
        return
    email = ctx.email or os.environ.get("LANDFIRE_EMAIL")
    if not email and ctx.interactive:
        email = input("Email address for the LANDFIRE service (LFPS asks for one for its statistics): ").strip()
    if not email:
        raise Failed("LANDFIRE needs an email address for the LFPS service: --email <address> or set LANDFIRE_EMAIL")
    force = ctx.forced("landfire") or (r.state.get("landfire") not in (None, landfire_inputs(r)))
    for prod, _ in LANDFIRE:
        cmd = ["node", os.path.join(HERE, "fetch_landfire.mjs"), r.slug, email, prod,
               "--raw", os.path.dirname(os.path.normpath(r.raw))] + (["--force"] if force else [])
        if ctx.run(cmd):
            raise Failed(f"fetch_landfire.mjs {prod} failed (LFPS jobs queue; run again later)")


def grooming_inputs(r):
    return sha(r.cfg.get("terrain_status_url"))


def grooming_present(r):
    return not r.cfg.get("terrain_status_url") or bool(glob.glob(os.path.join(r.raw, "grooming", "*.json")))


def grooming_run(r, ctx):
    if not r.cfg.get("terrain_status_url"):
        print("  no terrain_status_url: groomed runs come from OSM tags only")
        return
    if ctx.run([sys.executable, os.path.join(HERE, "fetch_grooming.py"), r.slug, r.raw]):
        raise Failed("fetch_grooming.py failed (the Internet Archive is slow at times; run again, it resumes)")


def build_inputs(r):
    groom = sorted(os.path.basename(p) for p in glob.glob(os.path.join(r.raw, "grooming", "*.json")))
    return sha(file_sha(r.cfg_path), file_sha(r.man_path), r.state.get("fetch"), r.state.get("landfire"), groom,
               pipeline_code(), r.out)


def meta(r):
    try:
        with open(os.path.join(r.out, "meta.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def build_present(r):
    """the pack is there, in this pipeline's format"""
    from packwriter import FORMAT_VERSION
    m = meta(r)
    return bool(m) and m.get("formatVersion") == FORMAT_VERSION


def build_adoptable(r):
    """a pack with no recorded build counts as built only when its pipeline commit has this pipeline's code"""
    return build_present(r) and same_code(meta(r).get("pipeline"))


def build_run(r, ctx):
    from packwriter import FORMAT_VERSION
    t = time.time()
    if ctx.run([sys.executable, os.path.join(HERE, "build_pack.py"), r.slug, r.raw, r.out]):
        raise Failed("build_pack.py failed: the log above names the stage (pack-build skill, Common failures)")
    m = meta(r)
    if not m:
        raise Failed(f"build_pack.py wrote no {os.path.join(r.out, 'meta.json')}")
    if m.get("formatVersion") != FORMAT_VERSION:
        raise Failed(f"meta.json is format {m.get('formatVersion')}, this pipeline writes {FORMAT_VERSION}")
    print(f"  built in {time.time() - t:.0f} s, build {m.get('build')}")


def index_inputs(r):
    return None      # always: cheap, and another pack may have changed the index


def index_present(r):
    return False


def index_run(r, ctx):
    from packwriter import index_packs
    packs = os.path.dirname(os.path.normpath(r.out))
    index_packs(packs)
    with open(os.path.join(packs, "index.json"), encoding="utf-8") as f:
        if r.slug not in json.load(f)["packs"]:
            raise Failed(f"{r.slug} is not in {os.path.join(packs, 'index.json')}: is {r.out} named {r.slug}?")


def report_inputs(r):
    return None      # always: 15 s, and the summary is what the run is for


def report_present(r):
    return False


def report_run(r, ctx):
    cmd = [sys.executable, os.path.join(HERE, "pack_report.py"), r.out, "--raw", r.raw, "--config", r.cfg_path]
    code = ctx.run(cmd + (["--gate"] if ctx.gate else []))
    if code and ctx.gate:
        raise Failed("the DATA-022 report has MVP lines that do not pass (report.md in the pack): the pack is preview")
    if code:
        raise Failed(f"pack_report.py exited {code}")


STAGE_FN = {s: (globals()[f"{s}_inputs"], globals()[f"{s}_present"], globals()[f"{s}_run"]) for s in STAGES}
ADOPT = {"build": build_adoptable}     # stricter than "present" for outputs this tool did not record


# ------------------------------------------------------------------------------------------------ runner

class Context:
    def __init__(self, force=(), email=None, interactive=False, gate=False, runner=run):
        self.force, self.email, self.interactive, self.gate, self.run = set(force), email, interactive, gate, runner

    def forced(self, stage):
        return "all" in self.force or stage in self.force


def decide(r, stage, ctx):
    """(run?, why) for one stage"""
    inputs, present, _ = STAGE_FN[stage]
    if ctx.forced(stage):
        return True, "forced"
    fp = inputs(r)
    if fp is None:
        return True, "always runs"
    if stage == "landfire" and not landfire_needed(r):
        return False, "outside the US"
    if stage == "grooming" and not r.cfg.get("terrain_status_url"):
        return False, "no terrain_status_url"
    seen = r.state.get(stage)
    if seen == fp and present(r):
        return False, "inputs unchanged"
    if seen is None and ADOPT.get(stage, present)(r):
        return False, "already on disk (adopted)"
    if seen is None:
        return True, "not done yet"
    return True, "inputs changed" if present(r) else "output missing"


def build(r, ctx, first=None, last=None, dry=False, out=print):
    """run the stages from `first` to `last`; -> 0, or raises Failed"""
    a = STAGES.index(first) if first else 0
    b = STAGES.index(last) if last else len(STAGES) - 1
    for stage in STAGES[a:b + 1]:
        go, why = decide(r, stage, ctx)
        out(f"[{stage}] {'run' if go else 'skip'}: {why}")
        if dry:
            continue
        inputs, present, fn = STAGE_FN[stage]
        if go:
            t = time.time()
            fn(r, ctx)
            out(f"[{stage}] done in {time.time() - t:.0f} s")
        elif stage == "fetch":
            check_raw(r)             # data fetched earlier gets the same checks before it is built
        if stage in ("nodes", "manifest", "fetch", "build"):
            r.cfg = json.load(open(r.cfg_path, encoding="utf-8"))
        fp = inputs(r)
        if fp is not None and (go or r.state.get(stage) is None):
            r.state[stage] = fp
            r.save()
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("slug")
    ap.add_argument("raw_dir", nargs="?", help="the resort's raw folder (default raw/<slug>)")
    ap.add_argument("out_dir", nargs="?", help="the pack folder (default packs/<slug>)")
    ap.add_argument("--from", dest="first", choices=STAGES, help="start at this stage")
    ap.add_argument("--stop-after", dest="last", choices=STAGES, help="stop after this stage")
    ap.add_argument("--force", action="append", default=[], choices=STAGES + ["all"], help="run a stage even if done")
    ap.add_argument("--email", help="email for the LANDFIRE service (or LANDFIRE_EMAIL)")
    ap.add_argument("--gate", action="store_true", help="fail unless every DATA-022 MVP line passes")
    ap.add_argument("--dry-run", action="store_true", help="print what would run and why")
    a = ap.parse_args(argv)
    if not os.path.isfile(os.path.join(HERE, "resorts", f"{a.slug}.json")):
        print(f"no pipeline/resorts/{a.slug}.json: `python pipeline/resort.py resolve \"<name>\"` and `plan` make one")
        return 2
    if a.first and a.last and STAGES.index(a.first) > STAGES.index(a.last):
        print("--from comes after --stop-after")
        return 2
    raw = a.raw_dir or os.path.join(REPO, "raw", a.slug)
    out = a.out_dir or os.path.join(REPO, "packs", a.slug)
    r = Resort(a.slug, raw, out)
    print(f"{r.cfg.get('name', a.slug)}: raw {r.raw}, pack {r.out}")
    ctx = Context(a.force, a.email, sys.stdin.isatty(), a.gate)
    t = time.time()
    try:
        build(r, ctx, a.first, a.last, a.dry_run)
    except Failed as e:
        print(f"\nstopped: {e}")
        return 1
    print(f"\n{a.slug}: {'checked' if a.dry_run else 'done'} in {time.time() - t:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
