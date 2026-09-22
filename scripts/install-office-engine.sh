#!/usr/bin/env bash
# Ставит офисный движок (ONLYOFFICE-редакторы, собранные для работы целиком в
# браузере: web-apps + sdkjs + x2t WebAssembly) в <T3CODE_HOME>/office-engine.
# Демон отдаёт его по /office-engine/, экран /office?path=… его подхватывает.
#
# Источник — наша копия (console.uno4.dev/cli/work/office-engine/), перезалитая
# без изменений из sweetwisdom/onlyoffice-web-local release-13 (AGPL-3.0,
# ~305 МБ zip → ~680 МБ на диске), sha256 зафиксирован. Своя сборка из
# исходников ONLYOFFICE — хвост, см. docs/office-engine.md.
set -euo pipefail
SHA256="${OFFICE_ENGINE_SHA256:-710153df78917879024201f40f9d4e266954c96567537b647510af276d3d49f3}"
HOME_DIR="${T3CODE_HOME:-$HOME/.t3}"
DEST="$HOME_DIR/office-engine"
URL="${OFFICE_ENGINE_URL:-https://console.uno4.dev/cli/work/office-engine/office-engine-oo13.zip}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading office engine…"
curl -fL --retry 3 -o "$TMP/engine.zip" "$URL"
echo "${SHA256}  $TMP/engine.zip" | shasum -a 256 -c -
unzip -q "$TMP/engine.zip" -d "$TMP/unpacked"
SRC="$(dirname "$(find "$TMP/unpacked" -path '*/vendor/web-apps/apps/api/documents/api.js' | head -1)")"
SRC="${SRC%/vendor/web-apps/apps/api/documents}"
[ -f "$SRC/vendor/web-apps/apps/api/documents/api.js" ] || { echo "engine layout not recognised" >&2; exit 1; }
rm -rf "$DEST.new"
mkdir -p "$DEST.new"
mv "$SRC/vendor" "$DEST.new/vendor"
[ -f "$SRC/LICENSE.txt" ] && cp "$SRC/LICENSE.txt" "$DEST.new/LICENSE.txt"
rm -rf "$DEST.old"; [ -d "$DEST" ] && mv "$DEST" "$DEST.old"
mv "$DEST.new" "$DEST" && rm -rf "$DEST.old"
echo "Office engine installed to $DEST ($(du -sh "$DEST" | cut -f1))"
