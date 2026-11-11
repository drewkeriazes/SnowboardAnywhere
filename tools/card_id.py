"""Card ids for the board: print the next free FEAT / BUG / DATA id and any id used by two issues.

Reads every issue (open and closed, all pages) in every repo the board pulls from (EPIC-15:
this repo and MapPacker-SnowboardAnywhere) through the GitHub REST API with `gh`. Ids are one
sequence across both repos. A repo `gh` cannot read is skipped with a warning, since the result
could then miss ids. Pull requests are skipped: a PR titled with its card id is not a second card.

    python tools/card_id.py          # next ids, then duplicates (exit 1 if any)
    python tools/card_id.py FEAT     # just the next FEAT id, for scripts

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


def issues(repo):
    page = 1
    while True:
        res = subprocess.run(
            ["gh", "api", f"repos/{repo}/issues?state=all&per_page=100&page={page}"],
            capture_output=True, text=True, encoding="utf-8",  # BUG-073: not the cp1252 locale
        )
        if res.returncode != 0:
            print(f"warning: could not read {repo} issues, ids from it are missing: {res.stderr.strip()[:200]}", file=sys.stderr)
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
    seen = {}
    for repo in REPOS:
        for i in issues(repo):
            m = ID.match(i["title"])
            if m:
                seen.setdefault((m[1], int(m[2])), []).append(i)
    nxt = {t: max([n for (k, n) in seen if k == t], default=0) + 1 for t in TYPES}
    if len(sys.argv) > 1:
        print(f"{sys.argv[1].upper()}-{nxt[sys.argv[1].upper()]:03d}")
        return 0
    print("next: " + ", ".join(f"{t}-{n:03d}" for t, n in nxt.items()))
    dups = {k: v for k, v in seen.items() if len(v) > 1}
    for (t, n), v in sorted(dups.items()):
        print(f"duplicate {t}-{n:03d}: " + ", ".join(f"{i['ref']} ({i['state']}) {i['title'][:60]}" for i in v))
    return 1 if dups else 0


if __name__ == "__main__":
    sys.exit(main())
