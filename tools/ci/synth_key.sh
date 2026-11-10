#!/usr/bin/env bash
# FEAT-172: cache key for the synthetic pack built from a pipeline folder: a hash of its Python sources
# (tests excluded) and requirements, so the same pipeline gives the same key wherever it is checked out.
# bash tools/ci/synth_key.sh <pipeline_dir>
set -euo pipefail
cd "$1"
h=$( { find . -name '*.py' -not -path './tests/*' | LC_ALL=C sort | xargs cat; cat requirements.txt; } | sha256sum | cut -c1-16)
echo "synth-$h"
