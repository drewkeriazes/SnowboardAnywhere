"""Card ids for the board: print the next free FEAT / BUG / DATA id and any id used by two issues.

Reads every issue (open and closed, all pages) through the GitHub REST API with `gh`. Pull
requests are skipped: a PR titled with its card id is not a second card.

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

REPO = "drewkeriazes/SnowboardAnywhere"
TYPES = ("FEAT", "BUG", "DATA")
ID = re.compile(r"^(FEAT|BUG|DATA)-(\d+)")


def issues():
    page = 1
    while True:
        out = subprocess.run(
            ["gh", "api", f"repos/{REPO}/issues?state=all&per_page=100&page={page}"],
            check=True, capture_output=True, text=True,
        ).stdout
        batch = json.loads(out)
        if not batch:
            return
        for i in batch:
            if "pull_request" not in i:
                yield i
        page += 1


def main():
    seen = {}
    for i in issues():
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
        print(f"duplicate {t}-{n:03d}: " + ", ".join(f"#{i['number']} ({i['state']}) {i['title'][:60]}" for i in sorted(v, key=lambda i: i["number"])))
    return 1 if dups else 0


if __name__ == "__main__":
    sys.exit(main())
