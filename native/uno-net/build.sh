#!/usr/bin/env bash
# Builds uno-net for the desktop: dist/<os>-<arch>/uno-net, and on macOS a
# universal binary dist/darwin-universal/uno-net (lipo). Static, no cgo.
#   ./build.sh [version]            darwin arm64 + amd64 (+ universal on macOS)
#   TARGETS="linux/amd64" ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
version="${1:-$(git describe --always --dirty 2>/dev/null || echo dev)}"
targets="${TARGETS:-darwin/arm64 darwin/amd64}"
rm -rf dist
for t in $targets; do
  os="${t%/*}" arch="${t#*/}"
  out="dist/$os-$arch/uno-net"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X main.version=$version" -o "$out" ./cmd/uno-net
  echo "$out"
done
if [[ "$(uname)" == "Darwin" && -f dist/darwin-arm64/uno-net && -f dist/darwin-amd64/uno-net ]]; then
  mkdir -p dist/darwin-universal
  lipo -create -output dist/darwin-universal/uno-net dist/darwin-arm64/uno-net dist/darwin-amd64/uno-net
  echo dist/darwin-universal/uno-net
fi
