#!/usr/bin/env bash
# Builds the Loom Work demo (VITE_DEMO=loom) and publishes it on Uno Sites
# under a password:
#   demo-e2e/publish-demo.sh            → https://misha-loom-work-1028.uno4.me
#   SLUG=... PASSWORD=... demo-e2e/publish-demo.sh
#
# Why not site_publish (uno-work MCP): on Work before 0.0.156 it gave up on a
# build this size (~28 MB). This uploads the zip to the console's deploy API
# with the account's key, the password in the same request (applied before the
# site is served — never open, not even for a moment), and async=1: the console
# answers 202 at once and publishes in the background (fishcode 36da295f,
# 28.10); the script polls GET /api/v1/deploy/{id} until done or failed.
# The key: $UNO_DEPLOY_KEY, else read from the prod DB over SSH (account 85,
# never printed).
set -euo pipefail
slug="${SLUG:-misha-loom-work-1028}"
password="${PASSWORD:?set PASSWORD=… (not stored in the repo)}"
web="$(cd "$(dirname "$0")/../.." && pwd)"
out="$web/dist-demo"
console="${UNO_CONSOLE:-https://console.uno4.dev}"

"$web/demo-e2e/loom/build-demo.sh" "$out"

key="${UNO_DEPLOY_KEY:-}"
if [ -z "$key" ]; then
  key="$(ssh -o BatchMode=yes fish@84.247.162.151 \
    "cd ~/fishcode && docker compose exec -T db psql -U fishcode -tAc 'SELECT api_key FROM users WHERE id=85'" | tr -d '[:space:]')"
fi
[ -n "$key" ] || { echo "no deploy key" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/site.zip"
(cd "$out" && zip -qr "$zip" .)
echo "uploading $(du -h "$zip" | cut -f1) as $slug…"
code="$(curl -sS -o "$tmp/deploy.json" -w '%{http_code}' --max-time 300 \
  -H "Authorization: Bearer $key" -F "file=@$zip" -F "slug=$slug" \
  -F "password=$password" -F "async=1" "$console/api/v1/deploy")"
echo "deploy: HTTP $code"

json() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get(sys.argv[2]) or "")' "$@"; }

case "$code" in
  201) ;;
  202)
    status_url="$(json "$tmp/deploy.json" status_url)"
    [ -n "$status_url" ] || { echo "202 without status_url" >&2; cat "$tmp/deploy.json" >&2; exit 1; }
    # Up to ~15 min: the console gives a background publish 15 minutes.
    status=processing
    for _ in $(seq 1 300); do
      sleep 3
      curl -sS -o "$tmp/status.json" --max-time 20 \
        -H "Authorization: Bearer $key" "$console$status_url" || continue
      status="$(json "$tmp/status.json" status)"
      [ "$status" = "processing" ] || break
    done
    case "$status" in
      done) echo "publish: done" ;;
      failed)
        echo "publish failed: $(json "$tmp/status.json" error) — $(json "$tmp/status.json" message)" >&2
        exit 1 ;;
      *) echo "still publishing after 15 min — check $console/sites/$slug later" >&2; exit 1 ;;
    esac ;;
  *) echo "deploy failed:" >&2; cat "$tmp/deploy.json" >&2; echo >&2; exit 1 ;;
esac

if curl -s "https://$slug.uno4.me/" | grep -qi "protected\|password"; then
  echo "✓ https://$slug.uno4.me — password: $password"
else
  echo "⚠ https://$slug.uno4.me is up but does not ask for a password — set it with site_set_password ($slug)" >&2
  exit 2
fi
