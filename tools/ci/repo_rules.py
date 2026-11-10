#!/usr/bin/env python3
"""FEAT-172 repo rules from CLAUDE.md that sessions keep forgetting, checked on a PR's own changes.

python tools/ci/repo_rules.py --base <ref> [--head <ref>]

Fails (exit 1) on:
  - an em dash in a line the PR adds to a Markdown file ("No em dashes in prose");
  - a commit in the PR with a Co-Authored-By or session-link trailer ("Commit messages: plain").
Warns only (exit 0), as a GitHub annotation, when the PR adds a URL parameter (game/src/core/params.ts),
changes a key binding (the key tables in game/src/ui/Settings.ts) or adds a game/tools script, and
touches neither README.md nor docs/developer-guide.md ("Docs travel with the change").
Only the PR's diff and commits are read, so older text on main never fails a PR. Standard library only.
"""
import argparse
import re
import subprocess
import sys

EM_DASH = "—"
TRAILERS = [
    re.compile(r"^\s*co-authored-by:", re.I | re.M),
    re.compile(r"claude\.ai/code/session", re.I),
    re.compile(r"^\s*(session|claude-session):\s*https?://", re.I | re.M),
]
PARAM_READ = re.compile(r"""\bp\.(get|has)\(\s*['"]([a-z0-9_]+)['"]""")
KEY_CODE = re.compile(r"""['"](Key[A-Z]|Digit\d|Arrow(Up|Down|Left|Right)|Space|Backspace|Enter|Escape|Shift(Left|Right)|Alt(Left|Right)|Control(Left|Right)|Tab)['"]""")
DOCS = {"README.md", "docs/developer-guide.md"}


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True, encoding="utf-8").stdout


def added_lines(base, head, *paths):
    """(path, new line number, text) for every line the PR adds, from base...head"""
    out = git("diff", "--unified=0", "--no-color", "--no-ext-diff", f"{base}...{head}", "--", *paths)
    path, line, res = None, 0, []
    for raw in out.splitlines():
        if raw.startswith("+++ "):
            path = raw[6:] if raw.startswith("+++ b/") else None
        elif raw.startswith("@@"):
            m = re.search(r"\+(\d+)", raw)
            line = int(m.group(1)) if m else 0
        elif raw.startswith("+") and path:
            res.append((path, line, raw[1:]))
            line += 1
    return res


def annotate(kind, msg, path=None, line=None):
    loc = f" file={path},line={line}" if path else ""
    print(f"::{kind}{loc}::{msg}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", default="HEAD")
    a = ap.parse_args()
    fails = 0

    # 1. em dashes in added Markdown lines
    for path, line, text in added_lines(a.base, a.head, "*.md"):
        if EM_DASH in text:
            fails += 1
            annotate("error", "Em dash in prose (CLAUDE.md: no em dashes). Use a comma, colon, parentheses or a new sentence.", path, line)

    # 2. commit trailers
    log = git("log", "--format=%H%x00%s%x00%B%x1e", f"{a.base}..{a.head}")
    for entry in filter(None, (e.strip("\n") for e in log.split("\x1e"))):
        sha, subject, body = entry.split("\x00", 2)
        for pat in TRAILERS:
            if pat.search(body):
                fails += 1
                annotate("error", f"Commit {sha[:8]} ({subject[:60]}) has a Co-Authored-By or session trailer. "
                         "CLAUDE.md: plain commit messages. Reword it (git rebase, then push with --force-with-lease).")
                break

    # 3. docs heuristic (warning only)
    changed = set(git("diff", "--name-only", f"{a.base}...{a.head}").split())
    added_files = set(git("diff", "--name-only", "--diff-filter=A", f"{a.base}...{a.head}").split())
    if not (changed & DOCS):
        reasons = []
        new_tools = sorted(f for f in added_files if re.fullmatch(r"game/tools/[^/]+\.(mjs|js|ps1)", f))
        if new_tools:
            reasons.append(f"adds {', '.join(new_tools)}")
        params = sorted({m.group(2) for _, _, t in added_lines(a.base, a.head, "game/src/core/params.ts") for m in PARAM_READ.finditer(t)})
        if params:
            reasons.append("reads URL parameter(s) " + ", ".join(f"?{p}" for p in params))
        keys = [(p, n) for p, n, t in added_lines(a.base, a.head, "game/src/ui/Settings.ts") if KEY_CODE.search(t)]
        if keys:
            reasons.append(f"changes key bindings (game/src/ui/Settings.ts line {keys[0][1]})")
        for r in reasons:
            annotate("warning", f"This PR {r} but touches neither README.md nor docs/developer-guide.md "
                     "(CLAUDE.md: docs travel with the change). Ignore if nothing user-facing changed.")

    print(f"repo rules: {fails} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
