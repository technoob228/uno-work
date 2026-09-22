#!/usr/bin/env bash
# Ставит офисный движок (ONLYOFFICE-редакторы, собранные для работы целиком в
# браузере: web-apps + sdkjs + x2t WebAssembly) в <T3CODE_HOME>/office-engine.
# Демон отдаёт его по /office-engine/, экран /office?path=… его подхватывает.
#
# КОСТЫЛЬ: источник пока — чужой релиз sweetwisdom/onlyoffice-web-local
# (AGPL-3.0, ~305 МБ zip → ~680 МБ на диске). Перед продом — собрать свой
# пакет из исходников ONLYOFFICE (или CryptPad-форка), положить в наш S3 и
# зашить в golden-образ Work. См. docs/office-engine.md.
set -euo pipefail
VERSION="${OFFICE_ENGINE_RELEASE:-release-13}"
SHA256="${OFFICE_ENGINE_SHA256:-}"
HOME_DIR="${T3CODE_HOME:-$HOME/.t3}"
DEST="$HOME_DIR/office-engine"
URL="https://github.com/sweetwisdom/onlyoffice-web-local/releases/download/${VERSION}/html.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading office engine ${VERSION}…"
curl -fL --retry 3 -o "$TMP/engine.zip" "$URL"
if [ -n "$SHA256" ]; then
  echo "${SHA256}  $TMP/engine.zip" | shasum -a 256 -c -
fi
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
