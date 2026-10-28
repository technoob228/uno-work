#!/usr/bin/env bash
# Builds the demo of the real Work web client (`VITE_DEMO=loom`) into
# apps/web/dist-demo: the fake daemons answer inside the page, nothing
# leaves the browser. ~30 s. Usage: demo-e2e/build-demo.sh [out-dir]
set -euo pipefail
web="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$web/dist-demo}"
export PATH="$web/node_modules/.bin:$web/../../node_modules/.bin:$PATH"
cd "$web"
VITE_DEMO=loom T3CODE_WEB_SOURCEMAP=false vite build --outDir "$out" --emptyOutDir --logLevel warn
# Sourcemaps and the big onboarding videos make the upload slow; the demo doesn't need them.
find "$out" -name '*.map' -delete
du -sh "$out" | awk '{print "demo build: " $1 " in '"$out"'"}'
