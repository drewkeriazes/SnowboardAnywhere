"""Card ids for the board: print the next free FEAT / BUG / DATA id and any id used by two issues.

Reads every issue (open and closed, all pages) in every repo the board pulls from (EPIC-15:
this repo and MapPacker-SnowboardAnywhere) through the GitHub REST API with `gh`. Ids are one
sequence across both repos, so a repo `gh` cannot read (on any page) is a failure: the script
warns, prints no id and exits 2, since the result could miss ids and hand out a duplicate.
Pull requests are skipped: a PR titled with its card id is not a second card.

    python tools/card_id.py          # next ids, then duplicates (exit 1 if any)
    python tools/card_id.py FEAT     # just the next FEAT id, for scripts
    python tools/card_id.py --allow-partial [FEAT]   # report from the repos it could read anyway

Run it right before creating a card, and again after, since another session may have taken
the same id in between (wait about 20 s: the issue list lags a new issue). On a clash the newer
issue gets a new id.
"""
import json
import re
import subprocess
import sys

REPOS = ("drewkeriazes/SnowboardAnywhere", "drewkeriazes/MapPacker-SnowboardAnywhere")
TYPES = ("FEAT", "BUG", "DATA")
ID = re.compile(r"^(FEAT|BUG|DATA)-(\d+)")


def issues(repo, failed):
    """Yield the repo's issues. On a read error (any page) add the repo to `failed` and stop."""
    page = 1
    while True:
        res = subprocess.run(
            ["gh", "api", f"repos/{repo}/issues?state=all&per_page=100&page={page}"],
            capture_output=True, text=True, encoding="utf-8",  # BUG-073: not the cp1252 locale
        )
        if res.returncode != 0:
            print(f"warning: could not read {repo} issues (page {page}), ids from it are missing: {res.stderr.strip()[:200]}", file=sys.stderr)
            failed.append(repo)
            return
        batch = json.loads(res.stdout)
        if not batch:
            return
        for i in batch:
            if "pull_request" not in i:
                i["ref"] = f"#{i['number']}" if repo == REPOS[0] else f"{repo.split('/')[1]}#{i['number']}"
                yield i
        page += 1


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # titles can hold characters the console code page lacks
    args = [a for a in sys.argv[1:] if a != "--allow-partial"]
    allow_partial = len(args) < len(sys.argv) - 1
    seen, failed = {}, []
    for repo in REPOS:
        for i in issues(repo, failed):
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
    dups = {k: v for k, v in seen.items() if len(v) > 1}
    for (t, n), v in sorted(dups.items()):
        print(f"duplicate {t}-{n:03d}: " + ", ".join(f"{i['ref']} ({i['state']}) {i['title'][:60]}" for i in v))
    return 1 if dups else 0


if __name__ == "__main__":
    sys.exit(main())
