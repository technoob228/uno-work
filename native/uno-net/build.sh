#!/usr/bin/env bash
# Builds the Network binaries into dist/<platform>-<arch>/ with Node's names
# (darwin-arm64, darwin-x64, linux-x64), the folder the Work daemon looks in
# (apps/server/dist/native/…, copied there by the server build):
#   uno-net  — the tunnel engine (every platform)
#   uno-gw   — the exit side (Linux only)
# Static, no cgo.
#   ./build.sh [version]                 darwin arm64 + amd64, linux amd64
#   TARGETS="linux/amd64" ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
version="${1:-$(git describe --always --dirty 2>/dev/null || echo dev)}"
targets="${TARGETS:-darwin/arm64 darwin/amd64 linux/amd64}"
rm -rf dist
for t in $targets; do
  os="${t%/*}" arch="${t#*/}"
  node_arch="$arch"
  [[ "$arch" == "amd64" ]] && node_arch="x64"
  out="dist/$os-$node_arch"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X main.version=$version" -o "$out/uno-net" ./cmd/uno-net
  echo "$out/uno-net"
  if [[ "$os" == "linux" ]]; then
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
      -ldflags "-s -w -X main.version=$version" -o "$out/uno-gw" ./cmd/uno-gw
    echo "$out/uno-gw"
  fi
done
