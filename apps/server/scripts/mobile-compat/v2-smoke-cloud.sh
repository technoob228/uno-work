#!/usr/bin/env bash
# T3 v2 contract smoke on a cloud machine (never on the Mac).
#
# Starts a throwaway Uno Work daemon from WORK_REF on its own port and folders,
# registers the fake ACP agent, pairs, and runs v2-contract-smoke.ts from an
# upstream t3code checkout at UPSTREAM_REF with upstream's own client stack.
#
#   ROOT=~/t3v2 WORK_REF=origin/feat/t3-v2-compat-1029 UPSTREAM_REF=origin/main \
#     bash v2-smoke-cloud.sh
#
# Daily (06:00 UTC) and before each Work release — see SPEC «Этап 1 — сделано».
# Exit 0 = GREEN. On RED the last lines name the first failing step and both
# commits; ALERT_CMD (optional) gets that text on stdin, e.g. a Telegram post.
set -euo pipefail

ROOT=${ROOT:-$HOME/t3v2}
PORT=${PORT:-13791}
WORK_REPO=${WORK_REPO:-https://github.com/technoob228/uno-work.git}
WORK_REF=${WORK_REF:-origin/main}
UPSTREAM_REPO=${UPSTREAM_REPO:-https://github.com/pingdotgg/t3code.git}
UPSTREAM_REF=${UPSTREAM_REF:-origin/main}
NODE=${NODE:-node}
LOG=$ROOT/smoke.log

mkdir -p "$ROOT"
exec > >(tee "$LOG") 2>&1
[ -f "$HOME/.toolsrc" ] && . "$HOME/.toolsrc"

echo "== $(date -u +%FT%TZ) T3 v2 smoke on $(hostname), port $PORT, root $ROOT"

# --- Work daemon from WORK_REF ------------------------------------------------
if [ ! -d "$ROOT/work/.git" ] && [ ! -f "$ROOT/work/.git" ]; then
  git clone -q --filter=blob:none "$WORK_REPO" "$ROOT/work"
fi
git -C "$ROOT/work" fetch -q origin
git -C "$ROOT/work" checkout -q --detach "$WORK_REF"
WORK_SHA=$(git -C "$ROOT/work" rev-parse --short=10 HEAD)
(cd "$ROOT/work" && nice -n 10 bun install --frozen-lockfile --ignore-scripts >/dev/null)
# node-pty ships no linux prebuild and install scripts are off: reuse the
# machine's Work build when there is one (N-API, ABI-stable), else compile.
for PTY_DIR in "$ROOT"/work/node_modules/.bun/node-pty@*/node_modules/node-pty; do
  [ -f "$PTY_DIR/build/Release/pty.node" ] && continue
  PTY_NODE=${PTY_NODE:-/opt/uno-work/app/node_modules/node-pty/build/Release/pty.node}
  if [ -f "$PTY_NODE" ]; then
    mkdir -p "$PTY_DIR/build/Release" && cp "$PTY_NODE" "$PTY_DIR/build/Release/pty.node"
  else
    (cd "$PTY_DIR" && nice -n 10 npx -y node-gyp rebuild >/dev/null)
  fi
done

# --- upstream client from UPSTREAM_REF ---------------------------------------
if [ ! -d "$ROOT/upstream/.git" ]; then
  git clone -q --filter=blob:none "$UPSTREAM_REPO" "$ROOT/upstream"
fi
git -C "$ROOT/upstream" fetch -q origin
git -C "$ROOT/upstream" checkout -q --detach "$UPSTREAM_REF"
UPSTREAM_SHA=$(git -C "$ROOT/upstream" rev-parse --short=10 HEAD)
PNPM_VERSION=$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$ROOT/upstream/package.json")
# Caches stay under ROOT: nothing lands in the machine owner's home.
(cd "$ROOT/upstream" && npm_config_cache="$ROOT/.npm-cache" nice -n 10 \
  npx -y "pnpm@${PNPM_VERSION:-latest}" install --frozen-lockfile --ignore-scripts \
  --store-dir "$ROOT/.pnpm-store" --filter "@t3tools/client-runtime..." >/dev/null)
cp "$ROOT/work/apps/server/scripts/mobile-compat/v2-contract-smoke.ts" \
  "$ROOT/upstream/packages/client-runtime/t3v2-contract-smoke.ts"

# --- throwaway daemon ---------------------------------------------------------
rm -rf "$ROOT/home" "$ROOT/harnesses" "$ROOT/project" "$ROOT/userhome" "$ROOT/stubbin"
mkdir -p "$ROOT/home" "$ROOT/harnesses" "$ROOT/project" "$ROOT/userhome" "$ROOT/stubbin"
# The daemon gets its own HOME (assistants, harness installs, caches land in
# ROOT and are wiped) and a stub `hermes`, so its first-start Hermes install
# (~1.4 GB of uv caches) never runs on the machine.
printf '#!/bin/sh\necho "Hermes Agent v0.0.0-smoke"\n' > "$ROOT/stubbin/hermes"
chmod +x "$ROOT/stubbin/hermes"
git -C "$ROOT/project" init -q && git -C "$ROOT/project" commit -q --allow-empty -m init \
  -c user.email=smoke@uno -c user.name=smoke 2>/dev/null || true
cat > "$ROOT/harnesses/fake.json" <<EOF
{"name":"Fake","command":"$(command -v "$NODE")","args":["$ROOT/work/apps/server/scripts/mobile-compat/v2-fake-acp-agent.mjs"],"models":[{"id":"fake-1","name":"Fake 1"}]}
EOF

BIN="$ROOT/work/apps/server/src/bin.ts"
# A project for the phone to start chats in (before the daemon owns the DB).
HOME="$ROOT/userhome" "$NODE" "$BIN" project add --base-dir "$ROOT/home" --title "T3 smoke" \
  "$ROOT/project" >/dev/null 2>&1
cd "$ROOT/project"
HOME="$ROOT/userhome" PATH="$ROOT/stubbin:$PATH" UNO_WORK_HARNESSES_DIR="$ROOT/harnesses" \
  UNO_WORK_ASSISTANT_PREWARM=0 UNO_WORK_ASSISTANTS_DIR="$ROOT/userhome/assistants" \
  nice -n 10 "$NODE" "$BIN" serve --mode web --host 127.0.0.1 --port "$PORT" \
  --base-dir "$ROOT/home" --no-browser "$ROOT/project" > "$ROOT/daemon.log" 2>&1 &
DAEMON=$!
trap 'kill $DAEMON 2>/dev/null || true; wait $DAEMON 2>/dev/null || true; rm -rf "$ROOT/userhome"' EXIT

for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/.well-known/t3/environment" >/dev/null && break
  kill -0 $DAEMON 2>/dev/null || { echo "daemon exited:"; tail -30 "$ROOT/daemon.log"; exit 2; }
  sleep 1
done
# The file harness is polled; give it a moment to appear.
sleep 5

PAIR=$(HOME="$ROOT/userhome" "$NODE" "$BIN" auth pairing create --json --base-dir "$ROOT/home" --role owner \
  | "$NODE" -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).credential))')

set +e
(cd "$ROOT/upstream/packages/client-runtime" && \
  SMOKE_PAIR_URL="http://127.0.0.1:$PORT/pair#token=$PAIR" "$NODE" t3v2-contract-smoke.ts)
RC=$?
set -e

echo "== work $WORK_SHA · upstream $UPSTREAM_SHA · rc=$RC"
echo "== methods the client asked for that Work does not serve:"
grep -A2 "phone asked for a method" "$ROOT/daemon.log" | grep -o "method: [^ ]*" | sort -u || true
if [ $RC -ne 0 ] && [ -n "${ALERT_CMD:-}" ]; then
  { echo "T3 v2 smoke RED on $(hostname): work $WORK_SHA, upstream $UPSTREAM_SHA"; grep -m1 '^FAIL' "$LOG"; } \
    | bash -c "$ALERT_CMD" || true
fi
exit $RC
