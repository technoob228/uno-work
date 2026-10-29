#!/usr/bin/env bash
# Sidebar speed before / after the server read state (cloud only, never on
# the Mac). One throwaway daemon on its own port and folders, one account with
# CHATS chats (TURNS of them with a finished turn, unread):
#
#   A  BASE_REF  web + daemon (before)
#   B  WORK_REF  web + daemon, no phone connected
#   C  WORK_REF  web + daemon, a v2 phone subscribed to the shell and a chat
#   B2 WORK_REF  again without the phone (noise check)
#
#   ROOT=~/t3v2 BASE_REF=v0.0.162 WORK_REF=origin/feat/t3-v2-compat-1029 \
#     bash v2-sidebar-bench.sh
#
# Needs the work checkout the smoke made (ROOT/work, node-pty in place) and
# Chromium + playwright-core from the machine's Work (/opt/uno-work).
set -euo pipefail

ROOT=${ROOT:-$HOME/t3v2}
PORT=${PORT:-13792}
BASE_REF=${BASE_REF:-v0.0.162}
WORK_REF=${WORK_REF:-origin/feat/t3-v2-compat-1029}
CHATS=${CHATS:-320}
TURNS=${TURNS:-20}
NODE=${NODE:-node}
W=$ROOT/work
B=$ROOT/bench
BASEURL="http://127.0.0.1:$PORT"

mkdir -p "$B"
exec > >(tee "$B/bench.log") 2>&1
[ -f "$HOME/.toolsrc" ] && . "$HOME/.toolsrc"
echo "== $(date -u +%FT%TZ) sidebar bench on $(hostname): $CHATS chats, $TURNS unread with a turn"

git -C "$W" fetch -q origin --tags
# The bench scripts come from WORK_REF whatever is checked out.
mkdir -p "$B/scripts"
for f in v2-sidebar-bench.mjs v2-fake-acp-agent.mjs; do
  git -C "$W" show "$WORK_REF:apps/server/scripts/mobile-compat/$f" > "$B/scripts/$f"
done

checkout_and_build() {
  git -C "$W" checkout -q --detach "$1"
  (cd "$W" && nice -n 10 bun install --frozen-lockfile --ignore-scripts >/dev/null)
  (cd "$W/apps/web" && T3CODE_WEB_SOURCEMAP=false NODE_OPTIONS=--max-old-space-size=1536 \
    nice -n 10 bun run build >/dev/null 2>"$B/build.err" || { tail -20 "$B/build.err"; exit 3; })
  find "$W/apps/web/dist" -name '*.map' -delete
  echo "== built $(git -C "$W" rev-parse --short=10 HEAD) ($1)"
}

DAEMON=
start_daemon() {
  cd "$B/project"
  HOME="$B/userhome" PATH="$B/stubbin:$PATH" UNO_WORK_HARNESSES_DIR="$B/harnesses" \
    UNO_WORK_ASSISTANT_PREWARM=0 UNO_WORK_ASSISTANTS_DIR="$B/userhome/assistants" \
    nice -n 10 "$NODE" "$W/apps/server/src/bin.ts" serve --mode web --host 127.0.0.1 --port "$PORT" \
    --base-dir "$B/home" --no-browser "$B/project" >> "$B/daemon.log" 2>&1 &
  DAEMON=$!
  for _ in $(seq 1 120); do
    curl -sf "$BASEURL/.well-known/t3/environment" >/dev/null && break
    kill -0 $DAEMON 2>/dev/null || { echo "daemon exited:"; tail -30 "$B/daemon.log"; exit 2; }
    sleep 1
  done
  sleep 5
}
stop_daemon() {
  [ -n "$DAEMON" ] && { kill $DAEMON 2>/dev/null || true; wait $DAEMON 2>/dev/null || true; }
  DAEMON=
}
PHONE=
trap 'stop_daemon; [ -n "$PHONE" ] && kill $PHONE 2>/dev/null; rm -rf "$B/userhome"' EXIT

pair() {
  HOME="$B/userhome" "$NODE" "$W/apps/server/src/bin.ts" auth pairing create --json \
    --base-dir "$B/home" --role owner \
    | "$NODE" -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).credential))'
}
bench() { "$NODE" "$B/scripts/v2-sidebar-bench.mjs" "$@"; }

# --- A: before ---------------------------------------------------------------
checkout_and_build "$BASE_REF"
rm -rf "$B/home" "$B/harnesses" "$B/project" "$B/userhome" "$B/stubbin" "$B/daemon.log"
mkdir -p "$B/home" "$B/harnesses" "$B/project" "$B/userhome" "$B/stubbin"
printf '#!/bin/sh\necho "Hermes Agent v0.0.0-bench"\n' > "$B/stubbin/hermes" && chmod +x "$B/stubbin/hermes"
git -C "$B/project" init -q && git -C "$B/project" -c user.email=bench@uno -c user.name=bench \
  commit -q --allow-empty -m init
cat > "$B/harnesses/fake.json" <<EOF
{"name":"Fake","command":"$(command -v "$NODE")","args":["$B/scripts/v2-fake-acp-agent.mjs"],"models":[{"id":"fake-1","name":"Fake 1"}]}
EOF
HOME="$B/userhome" "$NODE" "$W/apps/server/src/bin.ts" project add --base-dir "$B/home" \
  --title "T3 smoke" "$B/project" >/dev/null 2>&1
start_daemon
bench seed "$BASEURL" "$(pair)" "$CHATS" "$TURNS" "$B/turn-ids.json"
bench measure "$BASEURL" "$(pair)" "A before ($BASE_REF)" "$B/turn-ids.json" "$B/A.json"
stop_daemon

# --- B / C / B2: after -------------------------------------------------------
checkout_and_build "$WORK_REF"
start_daemon
bench unread "$BASEURL" "$(pair)" "$B/turn-ids.json"
bench measure "$BASEURL" "$(pair)" "B after, no phone" "$B/turn-ids.json" "$B/B.json"

bench unread "$BASEURL" "$(pair)" "$B/turn-ids.json"
NEWEST=$("$NODE" -e 'const a=require(process.argv[1]);console.log(a[a.length-1])' "$B/turn-ids.json")
bench phone "$BASEURL" "$(pair)" "$NEWEST" > "$B/phone.log" 2>&1 &
PHONE=$!
sleep 5
bench measure "$BASEURL" "$(pair)" "C after, v2 phone subscribed" "$B/turn-ids.json" "$B/C.json"
kill -TERM $PHONE 2>/dev/null || true
wait $PHONE 2>/dev/null || true
PHONE=
tail -2 "$B/phone.log"

bench unread "$BASEURL" "$(pair)" "$B/turn-ids.json"
bench measure "$BASEURL" "$(pair)" "B2 after, no phone (repeat)" "$B/turn-ids.json" "$B/B2.json"
stop_daemon

"$NODE" -e '
const rows = ["A","B","C","B2"].map((k) => require(`${process.argv[1]}/${k}.json`).summary);
const f = (v) => (v === null || v === undefined ? "–" : Number(v).toFixed(1));
console.log("| run | rows | clicks | click→DOM med / p95, ms | click→paint med / p95, ms | commits ≤300 ms | commits ≤2.5 s | sidebar mutations ≤300 ms / ≤2.5 s | idle commits 5 s |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.label} | ${r.rows} | ${r.measured}/${r.clicks} | ${f(r.domMedianMs)} / ${f(r.domP95Ms)} | ${f(r.paintMedianMs)} / ${f(r.paintP95Ms)} | ${f(r.commitsEarlyMean)} | ${f(r.commitsTotalMean)} | ${f(r.sidebarMutationsEarlyMean)} / ${f(r.sidebarMutationsTotalMean)} | ${r.idleCommits5s} |`);
' "$B"
echo "== base $(git -C "$W" rev-parse --short=10 "$BASE_REF") · work $(git -C "$W" rev-parse --short=10 "$WORK_REF")"
