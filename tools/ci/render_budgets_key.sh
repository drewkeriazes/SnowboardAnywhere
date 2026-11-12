#!/usr/bin/env bash
# FEAT-176: hash of the render-budgets tools at a commit, so a local pass (tools/ci/local_render_budgets.mjs)
# only counts in CI when CI would have run the same tools. Built from git blob ids, which do not depend on
# how the checkout converts line endings, so Drew's Windows checkout and the Linux runner agree.
# bash tools/ci/render_budgets_key.sh <rev>   (prints 12 hex characters)
set -euo pipefail
rev=${1:-HEAD}
files="game/tools/cishot.mjs game/tools/browser.mjs game/tools/paths.mjs
game/tools/get_pack.mjs tools/ci/render_report.py tools/ci/render_budgets_key.sh tools/ci/local_render_budgets.mjs tools/ci/render_budgets_lib.mjs
.github/workflows/checks.yml game/package-lock.json"
for f in $files; do
  echo "$f $(git rev-parse --verify -q "$rev:$f" || echo missing)"
done | sha256sum | cut -c1-12
