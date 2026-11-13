"""Card ids for the board: print the next free FEAT / BUG / DATA id and any id used by two issues.

Reads every issue (open and closed, all pages) in every repo the board pulls from (EPIC-15:
this repo and MapPacker-SnowboardAnywhere) through the GitHub REST API with `gh`. Twin cards (the same title in
both repos, one card copied across) share an id on purpose and are not reported. Ids are one
sequence across both repos, so a repo `gh` cannot read (on any page) is a failure: the script
warns, prints no id and exits 2, since the result could miss ids and hand out a duplicate.
Pull requests are skipped: a PR titled with its card id is not a second card.

BUG-122: the list is read a page at a time, so an issue filed (or deleted, or transferred) while the pages are
read moves every later issue across a page boundary: one comes back on two pages, or none returns one. Pages are
read oldest first (a new issue lands at the end, after the pages already read), an issue served twice counts once,
and each repo is read again until two full reads in a row list the same issues, so a shift that skipped one is
caught. A list still changing after MAX_READS reads gives a warning, and every issue any read saw counts.

    python tools/card_id.py          # next ids, then duplicates (exit 1 if any)
    python tools/card_id.py FEAT     # just the next FEAT id, for scripts
    python tools/card_id.py --allow-partial [FEAT]   # report from the repos it could read anyway
    python -m unittest discover -s tools -p "test_*.py"   # its tests (tools/test_card_id.py, a fake gh)

Run it right before creating a card, and again after, since another session may have taken
the same id in between (wait about 20 s: the issue list lags a new issue). On a clash the newer
issue gets a new id.
"""
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

REPOS = ("drewkeriazes/SnowboardAnywhere", "drewkeriazes/MapPacker-SnowboardAnywhere")
TYPES = ("FEAT", "BUG", "DATA")
ID = re.compile(r"^(FEAT|BUG|DATA)-(\d+)")
PER_PAGE = 100
MAX_READS = 4  # full reads of a repo while waiting for two in a row that agree (BUG-122)


class ReadError(Exception):
    pass


def read_once(repo):
    """One pass over every page of the repo's issues, oldest first: {number: issue}, pull requests left out.
    Raises ReadError on a page gh cannot read."""
    found, page = {}, 1
    while True:
        res = subprocess.run(
            ["gh", "api", f"repos/{repo}/issues?state=all&sort=created&direction=asc&per_page={PER_PAGE}&page={page}"],
            capture_output=True, text=True, encoding="utf-8",  # BUG-073: not the cp1252 locale
        )
        if res.returncode != 0:
            raise ReadError(f"page {page}: {res.stderr.strip()[:200]}")
        batch = json.loads(res.stdout)
        for i in batch:
            if "pull_request" not in i:
                found[i["number"]] = i  # BUG-122: keyed by number, so an issue served on two pages counts once
        if len(batch) < PER_PAGE:
            return found
        page += 1


def issues(repo):
    """(the repo's issues, oldest first, each with its `ref`; a warning or None). Reads the repo until two full
    reads in a row hold the same issue numbers; if it never settles, every issue any read saw. Raises ReadError."""
    reads, warning = [], None
    while True:
        reads.append(read_once(repo))
        if len(reads) >= 2 and reads[-1].keys() == reads[-2].keys():
            found = reads[-1]
            break
        if len(reads) == MAX_READS:
            found = {}
            for r in reads:
                found.update(r)  # the newest read's title and state win
            warning = (f"warning: the {repo} issue list kept changing over {MAX_READS} reads (issues being filed?), "
                       "so ids come from every issue any read saw; run it again in a minute to check")
            break
    out = [found[n] for n in sorted(found)]
    for i in out:
        i["ref"] = f"#{i['number']}" if repo == REPOS[0] else f"{repo.split('/')[1]}#{i['number']}"
    return out, warning


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # titles can hold characters the console code page lacks
    args = [a for a in sys.argv[1:] if a != "--allow-partial"]
    allow_partial = len(args) < len(sys.argv) - 1
    seen, failed = {}, []
    with ThreadPoolExecutor(len(REPOS)) as pool:  # both repos at once: each is read at least twice
        reads = [pool.submit(issues, repo) for repo in REPOS]
    for repo, read in zip(REPOS, reads):
        try:
            found, warning = read.result()
        except ReadError as e:
            print(f"warning: could not read {repo} issues ({e}), ids from it are missing", file=sys.stderr)
            failed.append(repo)
            continue
        if warning:
            print(warning, file=sys.stderr)
        for i in found:
            m = ID.match(i["title"])
            if m:
                seen.setdefault((m[1], int(m[2])), []).append(i)
    if failed and not allow_partial:
        print(f"error: could not read {', '.join(failed)}, so the next id may already be taken there. "
              "Fix gh access, or pass --allow-partial to accept that.", file=sys.stderr)
        return 2
    nxt = {t: max([n for (k, n) in seen if k == t], default=0) + 1 for t in TYPES}
    if args:
        print(f"{args[0].upper()}-{nxt[args[0].upper()]:03d}")
        return 0
    print("next: " + ", ".join(f"{t}-{n:03d}" for t, n in nxt.items()))
    # BUG-097: a twin pair (the same card copied into each repo with the same title, like FEAT-222 to FEAT-225 when
    # the pipeline moved to MapPacker) is one card, not a clash. Only a pair with one card in each repo and the same
    # title is skipped; two cards in the same repo sharing an id are still reported.
    def is_twin(v):
        return (len(v) == 2
                and v[0]["ref"].startswith("#") != v[1]["ref"].startswith("#")
                and v[0]["title"].strip() == v[1]["title"].strip())
    dups = {k: v for k, v in seen.items() if len(v) > 1 and not is_twin(v)}
    for (t, n), v in sorted(dups.items()):
        print(f"duplicate {t}-{n:03d}: " + ", ".join(f"{i['ref']} ({i['state']}) {i['title'][:60]}" for i in v))
    return 1 if dups else 0


if __name__ == "__main__":
    sys.exit(main())
