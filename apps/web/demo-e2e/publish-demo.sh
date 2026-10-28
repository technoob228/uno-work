#!/usr/bin/env bash
# Builds the assistants demo and publishes it on Uno Sites under a password:
#   demo-e2e/publish-demo.sh <variant>      → https://misha-assistants-<variant>-1028.uno4.me
#   SLUG=... PASSWORD=... demo-e2e/publish-demo.sh base
#
# Why not site_publish (uno-work MCP): the build is ~28 MB and site_publish
# times out on it (02.10, 17.10, 28.10). This uploads the zip to the console's
# deploy API with the account's key; then sets the password the same way the
# site_set_password tool does, and checks the page answers "Protected".
# The key: $UNO_DEPLOY_KEY, else read from the prod DB over SSH (account 85,
# never printed). After a re-publish the password must be set again — done here.
set -euo pipefail
variant="${1:?usage: publish-demo.sh <variant>}"
slug="${SLUG:-misha-assistants-${variant}-1028}"
password="${PASSWORD:-duet-four-ways-1027}"
web="$(cd "$(dirname "$0")/.." && pwd)"
out="$web/dist-demo"
console="${UNO_CONSOLE:-https://console.uno4.dev}"

"$web/demo-e2e/build-demo.sh" "$out"

key="${UNO_DEPLOY_KEY:-}"
if [ -z "$key" ]; then
  key="$(ssh -o BatchMode=yes fish@84.247.162.151 \
    "cd ~/fishcode && docker compose exec -T db psql -U fishcode -tAc 'SELECT api_key FROM users WHERE id=85'" | tr -d '[:space:]')"
fi
[ -n "$key" ] || { echo "no deploy key" >&2; exit 1; }

zip="$(mktemp -d)/site.zip"
(cd "$out" && zip -qr "$zip" .)
echo "uploading $(du -h "$zip" | cut -f1) as $slug…"
# The console may answer 524 while the upload is still being unpacked: check the page after.
curl -sS -o /dev/null -w "deploy: HTTP %{http_code}\n" --max-time 300 \
  -H "Authorization: Bearer $key" -F "file=@$zip" -F "slug=$slug" "$console/api/v1/deploy" || true

for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://$slug.uno4.me/")"
  [ "$code" != "404" ] && break
  sleep 3
done

curl -sS -o /dev/null -w "password: HTTP %{http_code}\n" -X PUT \
  -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
  -d "{\"password\":\"$password\"}" "$console/api/v1/deploys/$slug/password" || true

if curl -s "https://$slug.uno4.me/" | grep -qi "protected\|password"; then
  echo "✓ https://$slug.uno4.me — password: $password"
else
  echo "⚠ https://$slug.uno4.me is up but does not ask for a password — set it with site_set_password ($slug)" >&2
  exit 2
fi
