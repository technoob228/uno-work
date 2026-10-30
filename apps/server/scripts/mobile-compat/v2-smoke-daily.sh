#!/usr/bin/env bash
# Daily T3 v2 contract smoke on a machine of ours (395: systemd timer
# uno-t3v2-smoke.timer, see SPEC «Этап 1 — сделано»). Fetches the runner from
# the Work repo at RUNNER_REF each time, so fixes to it need no redeploy.
#   ROOT/smoke.env (optional): WORK_REF=…  UPSTREAM_REF=…  PORT=…  RUNNER_REF=…
# Red (smoke failed or could not even start) → Telegram via v2-smoke-alert.py.
set -uo pipefail
ROOT=${ROOT:-$HOME/t3v2-smoke}
mkdir -p "$ROOT/logs"
[ -f "$ROOT/smoke.env" ] && . "$ROOT/smoke.env"
WORK_REF=${WORK_REF:-origin/main}
RUNNER_REF=${RUNNER_REF:-$WORK_REF}
UPSTREAM_REF=${UPSTREAM_REF:-origin/main}
PORT=${PORT:-13797}
export ROOT WORK_REF UPSTREAM_REF PORT

alert() { python3 "$ROOT/alert.py" 2>&1 || true; }
if [ ! -d "$ROOT/work/.git" ]; then
  git clone -q --filter=blob:none https://github.com/technoob228/uno-work.git "$ROOT/work" </dev/null
fi
git -C "$ROOT/work" fetch -q origin --tags </dev/null
git -C "$ROOT/work" show "$RUNNER_REF:apps/server/scripts/mobile-compat/v2-smoke-cloud.sh" > "$ROOT/runner.sh"
git -C "$ROOT/work" show "$RUNNER_REF:apps/server/scripts/mobile-compat/v2-smoke-alert.py" > "$ROOT/alert.py"

ALERT_CMD="python3 $ROOT/alert.py" bash "$ROOT/runner.sh" </dev/null
RC=$?
STAMP=$(date -u +%Y%m%dT%H%MZ)
cp "$ROOT/smoke.log" "$ROOT/logs/$STAMP-rc$RC.log" 2>/dev/null || true
ls -1t "$ROOT"/logs/*.log 2>/dev/null | tail -n +31 | xargs -r rm -f
if [ $RC -ne 0 ] && ! grep -q '^RESULT' "$ROOT/smoke.log" 2>/dev/null; then
  { echo "T3 v2 smoke could not run on $(hostname) (rc=$RC, WORK_REF=$WORK_REF):"; tail -15 "$ROOT/smoke.log" 2>/dev/null; } | alert
fi
exit $RC
