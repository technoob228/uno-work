#!/usr/bin/env bash
#
# Installs the Uno Work daemon on a Debian/Ubuntu machine — the same script for
# a managed Uno box and for a VM the user brings themselves.
#
#   curl -fsSL https://console.uno4.dev/cli/work/install.sh | sudo bash
#
# Environment:
#   UNO_WORK_TARBALL_URL  where to fetch the server bundle (default: uno4.dev)
#   UNO_WORK_HOST         bind address  (default: 0.0.0.0)
#   UNO_WORK_PORT         bind port     (default: 80 — the port our edge proxies)
#   UNO_WORK_API_KEY      Uno gateway key; enables the bundled harnesses
#   UNO_WORK_HERMES_VERSION  pin the Hermes Agent release (recommended for images)
#   UNO_WORK_SKIP_HARNESSES=1  install only the daemon
#   UNO_WORK_INSTALL_OFFICE=1  also install the Office engine (~680 MB; golden images)
#   UNO_WORK_SKIP_BROWSER=0    also install the machine's browser now (Chromium + Xvfb +
#                              libs, ~0.7-1.1 GB). Default 1: the browser is NOT put in the
#                              image; the machine sets it up on first use (~30-60 s).
#
set -euo pipefail

TARBALL_URL="${UNO_WORK_TARBALL_URL:-https://console.uno4.dev/cli/work/uno-work-server-latest.tar.gz}"
HOST="${UNO_WORK_HOST:-0.0.0.0}"
PORT="${UNO_WORK_PORT:-80}"
API_KEY="${UNO_WORK_API_KEY:-}"
SERVICE_USER="unowork"
INSTALL_DIR="/opt/uno-work"
STATE_DIR="/var/lib/uno-work"
CONFIG_DIR="/etc/uno-work"
WORKSPACE_DIR="/home/${SERVICE_USER}/projects"
BROWSERS_DIR="${INSTALL_DIR}/browsers"
NODE_MAJOR=22

log() { printf '\033[1;35m[uno-work]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[uno-work]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."
command -v apt-get >/dev/null 2>&1 || die "This installer supports Debian/Ubuntu."

log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# build-essential нужен не «на всякий случай»: у node-pty нет prebuild под
# linux-x64 в нашей версии, и без make/g++ установка падает на node-gyp —
# а без node-pty нет терминала в боксе.
apt-get install -y -qq curl ca-certificates git ripgrep python3 tar build-essential >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "${NODE_MAJOR}" ]; then
  log "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  log "Creating service user ${SERVICE_USER}"
  useradd --create-home --shell /bin/bash "${SERVICE_USER}"
fi

log "Fetching the daemon bundle"
install -d -m 0755 "${INSTALL_DIR}"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT
curl -fsSL "${TARBALL_URL}" -o "${tmp}/uno-work.tar.gz" || die "Download failed: ${TARBALL_URL}"
tar -xzf "${tmp}/uno-work.tar.gz" -C "${tmp}"
# npm-style tarballs unpack into package/
bundle_root="${tmp}/package"
[ -d "${bundle_root}" ] || bundle_root="${tmp}"
[ -f "${bundle_root}/dist/bin.mjs" ] || die "Bundle has no dist/bin.mjs"

rm -rf "${INSTALL_DIR}/app"
install -d -m 0755 "${INSTALL_DIR}/app" "${INSTALL_DIR}/bin"
cp -R "${bundle_root}/." "${INSTALL_DIR}/app/"

if [ -f "${INSTALL_DIR}/app/package.json" ]; then
  log "Installing runtime dependencies"
  (cd "${INSTALL_DIR}/app" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
fi

cat > "${INSTALL_DIR}/bin/uno-work" <<'LAUNCHER'
#!/usr/bin/env bash
exec node /opt/uno-work/app/dist/bin.mjs "$@"
LAUNCHER
chmod 0755 "${INSTALL_DIR}/bin/uno-work"
ln -sf "${INSTALL_DIR}/bin/uno-work" /usr/local/bin/uno-work

install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${STATE_DIR}" "${WORKSPACE_DIR}"
# Scratch dir the unit points TMPDIR at (see uno-work.service): /tmp on a box is
# a 1 GB tmpfs and checkpoints of a large project overflow it.
install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${STATE_DIR}/tmp"
install -d -m 0755 "${CONFIG_DIR}"

if [ ! -f "${CONFIG_DIR}/uno-work.env" ]; then
  cat > "${CONFIG_DIR}/uno-work.env" <<ENVFILE
UNO_WORK_HOST=${HOST}
UNO_WORK_PORT=${PORT}
UNO_WORK_STATE_DIR=${STATE_DIR}
UNO_WORK_WORKSPACE=${WORKSPACE_DIR}
ENVFILE
  chmod 0640 "${CONFIG_DIR}/uno-work.env"
fi

# --- The machine's browser (set up on first use) ------------------------------
# On a machine in the cloud the agent's browser lives here, not on the person's
# laptop: it keeps working with the app closed, and the app shows it live.
#
# It is NOT installed by default: Chromium with its system libraries adds
# ~1.1 GB to every machine made from the Work image, and not everyone uses it.
# The daemon sets it up the first time an agent or the person opens it. The
# daemon runs unprivileged (NoNewPrivileges, no sudo), so it only drops a
# request file; uno-work-browser-setup.path sees it and starts the root oneshot
# uno-work-browser-setup, which installs Xvfb + Chromium (the build must match
# the bundled playwright-core, so it comes from the bundle's own CLI) and
# writes its progress to ${BROWSER_STATUS_DIR}/status.json for the daemon.
# A separate unit keeps going across daemon restarts; a repeat request on a
# machine that has the browser finishes in a second.
BROWSER_REQUEST_DIR="${STATE_DIR}/browser-setup"
BROWSER_STATUS_DIR="/var/lib/uno-work-browser"
install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${BROWSER_REQUEST_DIR}"
install -d -m 0755 "${BROWSER_STATUS_DIR}" "${BROWSERS_DIR}"

cat > "${INSTALL_DIR}/bin/uno-work-browser-setup" <<'SETUP'
#!/usr/bin/env bash
# Written by install.sh — sets up the machine's browser (Xvfb + Chromium from the
# bundle's playwright-core). Runs as root from uno-work-browser-setup.service.
# Idempotent: exits at once when the browser is already there.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
INSTALL_DIR=/opt/uno-work
BROWSERS_DIR="${INSTALL_DIR}/browsers"
REQUEST_FILE=/var/lib/uno-work/browser-setup/request
STATUS_DIR=/var/lib/uno-work-browser
STATUS_FILE="${STATUS_DIR}/status.json"
LOG_FILE="${STATUS_DIR}/setup.log"
PW_DIR="${INSTALL_DIR}/app/node_modules/playwright-core"
MIN_FREE_KB=$((2 * 1024 * 1024))
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STEP=""

# The request lives in the daemon's directory: never follow a link it planted.
[ -L "$(dirname "${REQUEST_FILE}")" ] || rm -f -- "${REQUEST_FILE}"
install -d -m 0755 "${STATUS_DIR}" "${BROWSERS_DIR}"

write_status() { # state error
  local tmp="${STATUS_FILE}.tmp.$$"
  node -e 'const [state, step, error, startedAt] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ state, step: step || null, error: error || null,
  startedAt: startedAt || null, updatedAt: new Date().toISOString() }) + "\n");' \
    "$1" "${STEP}" "${2:-}" "${STARTED_AT}" >"${tmp}" && chmod 0644 "${tmp}" && mv -f "${tmp}" "${STATUS_FILE}"
}
fail() {
  local detail
  detail="$(grep -v '^\s*$' "${LOG_FILE}" 2>/dev/null | tail -n 1 | tr -cd '[:print:]' | cut -c1-200)"
  write_status failed "$1${detail:+ (${detail})}"
  echo "uno-work-browser-setup: failed at '${STEP}': $1" >&2
  exit 1
}
trap 'fail "Setup was interrupted."' TERM INT
step() { STEP="$1"; write_status installing; echo "uno-work-browser-setup: ${STEP}"; }

browser_ready() {
  [ -f "${PW_DIR}/cli.js" ] || return 1
  command -v Xvfb >/dev/null 2>&1 || return 1
  # Chromium is complete when playwright wrote INSTALLATION_COMPLETE next to it.
  PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_DIR}" node -e '
const path = require("path"), fs = require("fs");
const exe = require(process.argv[1]).chromium.executablePath();
const dir = path.relative(process.argv[2], exe).split(path.sep)[0];
process.exit(fs.existsSync(exe) && fs.existsSync(path.join(process.argv[2], dir, "INSTALLATION_COMPLETE")) ? 0 : 1);' \
    "${PW_DIR}" "${BROWSERS_DIR}" 2>/dev/null
}

if browser_ready; then
  STEP="Ready"; write_status ready
  exit 0
fi
[ -f "${PW_DIR}/cli.js" ] || fail "This Uno Work build has no browser engine. Update Uno Work."

free_kb="$(df -Pk "${BROWSERS_DIR}" | awk 'NR==2 {print $4}')"
if [ -n "${free_kb}" ] && [ "${free_kb}" -lt "${MIN_FREE_KB}" ]; then
  free_gb="$(awk -v k="${free_kb}" 'BEGIN {printf "%.1f", k / 1048576}')"
  : >"${LOG_FILE}"
  fail "Not enough disk space to set up the browser: ${free_gb} GB free, it needs 2.0 GB. Free up space on this computer or give it a bigger disk, then try again."
fi

: >"${LOG_FILE}"
chmod 0644 "${LOG_FILE}"
# apt may be busy (unattended upgrades): wait for the lock instead of failing.
# playwright's install-deps runs apt-get itself, so the setting goes via APT_CONFIG.
apt_conf="$(mktemp)"
echo 'DPkg::Lock::Timeout "300";' >"${apt_conf}"
export APT_CONFIG="${apt_conf}"
trap 'rm -f "${apt_conf}"' EXIT

step "Installing system libraries"
PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_DIR}" node "${PW_DIR}/cli.js" install-deps chromium >>"${LOG_FILE}" 2>&1 \
  || fail "Couldn't install the browser's system libraries."
step "Installing the virtual display"
apt-get install -y -qq --no-install-recommends xvfb >>"${LOG_FILE}" 2>&1 \
  || fail "Couldn't install the virtual display (Xvfb)."
step "Downloading the browser"
# --no-shell: the full Chromium runs both headful and in the new headless mode;
# the separate headless shell would only add ~100 MB.
PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_DIR}" node "${PW_DIR}/cli.js" install --no-shell chromium >>"${LOG_FILE}" 2>&1 \
  || fail "Couldn't download the browser."
step "Finishing"
chmod -R a+rX "${BROWSERS_DIR}"
apt-get clean >/dev/null 2>&1 || true
browser_ready || fail "The browser was installed but can't be found."
STEP="Ready"; write_status ready
echo "uno-work-browser-setup: ready"
SETUP
chmod 0755 "${INSTALL_DIR}/bin/uno-work-browser-setup"

cat > /etc/systemd/system/uno-work-browser-setup.service <<'UNIT'
[Unit]
Description=Set up the Uno Work machine's browser (first use)
Documentation=https://uno4.dev/docs/work
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/uno-work/bin/uno-work-browser-setup
TimeoutStartSec=20min
# The person keeps working while it installs: stay behind their processes.
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
UNIT

cat > /etc/systemd/system/uno-work-browser-setup.path <<UNIT
[Unit]
Description=Watch for the Uno Work daemon asking to set up the browser
Documentation=https://uno4.dev/docs/work

[Path]
PathExists=${BROWSER_REQUEST_DIR}/request
Unit=uno-work-browser-setup.service

[Install]
WantedBy=paths.target
UNIT

# --- Bundled harnesses ------------------------------------------------------
# All three authenticate through the Uno gateway, so the user never pastes a
# provider key. The key itself is written to the daemon's settings, not here.
if [ "${UNO_WORK_SKIP_HARNESSES:-0}" != "1" ]; then
  log "Installing bundled harnesses (uno-code, opencode, hermes)"
  sudo -u "${SERVICE_USER}" env HOME="/home/${SERVICE_USER}" UNO_WORK_HERMES_INSTALL_CMD="${UNO_WORK_HERMES_INSTALL_CMD:-}" UNO_WORK_HERMES_VERSION="${UNO_WORK_HERMES_VERSION:-}" bash -s <<'HARNESS' || log "WARNING: harness install had failures; the daemon still works"
set -uo pipefail
npm_prefix="$HOME/.local"
mkdir -p "$npm_prefix"
npm config set prefix "$npm_prefix" >/dev/null 2>&1 || true
grep -q '.local/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"
export PATH="$npm_prefix/bin:$PATH"

curl -fsSL https://console.uno4.dev/cli/uno-code/install.sh | bash || echo "uno-code install failed"
# UnoDriver ждёт бинарь по фиксированному пути ~/.unowork/uno-code/bin/uno-code
# (не через PATH), а установщик кладёт его в ~/.local/bin — без этого симлинка
# демон спавнит uno-code с ENOENT и гейт-харнес не стартует вовсе.
uno_code_bin="$(command -v uno-code || echo "$HOME/.local/bin/uno-code")"
if [ -x "$uno_code_bin" ]; then
  mkdir -p "$HOME/.unowork/uno-code/bin"
  ln -sf "$uno_code_bin" "$HOME/.unowork/uno-code/bin/uno-code"
fi
npm install -g opencode-ai --loglevel=error || echo "opencode install failed"

# Hermes Agent (NousResearch/hermes-agent) ships through PyPI, not npm, and the
# driver spawns `hermes acp` — so the acp extra is mandatory. Pin the version in
# UNO_WORK_HERMES_VERSION when we want reproducible images.
if [ -n "${UNO_WORK_HERMES_INSTALL_CMD:-}" ]; then
  bash -lc "${UNO_WORK_HERMES_INSTALL_CMD}" || echo "hermes install failed"
else
  if ! command -v uv >/dev/null 2>&1; then
    curl -fsSL https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || echo "uv install failed"
    export PATH="$HOME/.local/bin:$PATH"
  fi
  hermes_spec="hermes-agent[acp]"
  [ -n "${UNO_WORK_HERMES_VERSION:-}" ] && hermes_spec="hermes-agent[acp]==${UNO_WORK_HERMES_VERSION}"
  # mcp 2.x dropped the HTTP client Hermes uses: an open pin silently leaves
  # the assistant without its uno-manager tools. Python 3.12: hermes-agent
  # needs >=3.11,<3.14.
  uv tool install --force --python 3.12 "$hermes_spec" --with "mcp>=1.9,<2" >/dev/null 2>&1 || echo "hermes install failed"
fi
HARNESS
fi

if [ -n "${API_KEY}" ]; then
  log "Writing the Uno gateway key into daemon settings"
  # Демон читает настройки из <base-dir>/userdata/settings.json (deriveServerPaths),
  # НЕ из корня base-dir: ключ в ${STATE_DIR}/settings.json он молча игнорирует.
  settings="${STATE_DIR}/userdata/settings.json"
  sudo -u "${SERVICE_USER}" env HOME="/home/${SERVICE_USER}" python3 - "$settings" "$API_KEY" <<'PY'
import json, os, sys
path, key = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(path):
    try:
        with open(path) as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = {}
data.setdefault("uno", {})["apiKey"] = key
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as handle:
    json.dump(data, handle, indent=2)
os.chmod(path, 0o600)
PY
fi

# Work-бокс — 2 ГБ RAM без свопа, а демон + два-три uno-code (bun) легко
# съедают гигабайт. Без свопа упор в память = зависший бокс (SSH без баннера,
# run-канал BOX_BUSY) — видели 01.09 на боксе 395, лечилось только ребутом.
# Своп превращает это в замедление, а OOM-killer получает шанс сработать.
if ! swapon --show --noheadings 2>/dev/null | grep -q .; then
  log "Adding a 1G swapfile (no swap configured)"
  if fallocate -l 1G /swapfile 2>/dev/null; then
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo 'vm.swappiness=20' > /etc/sysctl.d/90-uno-work.conf
    sysctl -q -w vm.swappiness=20 || true
  else
    log "  fallocate failed — continuing without swap"
  fi
fi

# Журнал по умолчанию живёт в tmpfs и пропадает при ребуте — после зависшего
# бокса нечего читать. Persistent-хранилище, ограниченное 200 МБ.
if ! grep -q '^Storage=persistent' /etc/systemd/journald.conf 2>/dev/null; then
  log "Making the systemd journal persistent"
  mkdir -p /var/log/journal
  sed -i 's/^#\?Storage=.*/Storage=persistent/' /etc/systemd/journald.conf
  grep -q '^SystemMaxUse=' /etc/systemd/journald.conf \
    || sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=200M/' /etc/systemd/journald.conf
  systemctl restart systemd-journald || true
fi

# --- Scratch-dir sweep ------------------------------------------------------
# Harnesses built with `bun build --compile` (OpenCode, Uno Code) write their
# embedded native library into the temp dir on every start and never remove it:
# ~4.7 MB per provider probe, ~1.4 GB a day on a box. Daemons from 0.0.58 give
# each harness its own BUN_TMPDIR and remove it, but older daemons, crashes and
# other tools still leave files behind. Hourly, remove files older than a day
# that no process has open or mapped.
log "Installing the scratch-dir sweep"
cat > /usr/local/sbin/uno-work-tmp-sweep <<'SCRIPT'
#!/bin/sh
set -eu
DIR="${1:-${UNO_WORK_STATE_DIR:-/var/lib/uno-work}/tmp}"
[ -d "${DIR}" ] || exit 0
DIR="$(cd "${DIR}" && pwd -P)"
busy="$(mktemp)"
candidates="$(mktemp)"
trap 'rm -f "${busy}" "${candidates}"' EXIT
# Everything under DIR that a process holds: open descriptors and mappings
# (a loaded .so stays mapped after its descriptor is closed).
for p in /proc/[0-9]*; do
  awk -v d="${DIR}/" 'index($6, d) == 1 { print $6 }' "${p}/maps" 2>/dev/null || true
  for fd in "${p}"/fd/*; do
    t="$(readlink "${fd}" 2>/dev/null)" || continue
    case "${t}" in "${DIR}"/*) printf '%s\n' "${t}" ;; esac
  done
done | sed 's/ (deleted)$//' | sort -u > "${busy}"
removed=0
kept=0
find "${DIR}" -mindepth 1 -type f -mmin +1440 -amin +1440 2>/dev/null > "${candidates}" || true
while IFS= read -r f; do
  if grep -Fxq -- "${f}" "${busy}"; then
    kept=$((kept + 1))
  else
    rm -f -- "${f}" && removed=$((removed + 1))
  fi
done < "${candidates}"
# Per-harness BUN_TMPDIR dirs a crashed daemon did not get to remove.
find "${DIR}" -mindepth 1 -maxdepth 1 -type d -name 'uno-bun-*' -empty -mmin +60 -delete 2>/dev/null || true
echo "uno-work-tmp-sweep: removed ${removed}, kept ${kept} in use"
SCRIPT
chmod 0755 /usr/local/sbin/uno-work-tmp-sweep

cat > /etc/systemd/system/uno-work-tmp-sweep.service <<'UNIT'
[Unit]
Description=Remove stale Uno Work scratch files nobody holds open
Documentation=https://uno4.dev/docs/work

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/uno-work-tmp-sweep
Nice=19
IOSchedulingClass=idle
UNIT

cat > /etc/systemd/system/uno-work-tmp-sweep.timer <<'UNIT'
[Unit]
Description=Hourly sweep of stale Uno Work scratch files
Documentation=https://uno4.dev/docs/work

[Timer]
OnBootSec=15min
OnUnitActiveSec=1h
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now uno-work-tmp-sweep.timer >/dev/null 2>&1 || log "  could not enable the sweep timer"

# Office engine (docx/xlsx/pptx editors in the browser). Opt-in: golden images
# bake it in; other machines get it from the "Install Office" button.
if [ "${UNO_WORK_INSTALL_OFFICE:-0}" = "1" ]; then
  OFFICE_URL="${UNO_WORK_OFFICE_URL:-https://console.uno4.dev/cli/work/office-engine/office-engine-oo13.tar.gz}"
  OFFICE_SHA256="${UNO_WORK_OFFICE_SHA256:-5269aa464d77200637a8abe7c4fb2b1ce123e88deb3b89811be54ac5545c6c28}"
  if [ -f "${STATE_DIR}/office-engine/vendor/web-apps/apps/api/documents/api.js" ]; then
    log "Office engine already installed"
  else
    log "Installing the Office engine"
    otmp="$(mktemp -d -p "${STATE_DIR}")"
    curl -fsSL --retry 3 "${OFFICE_URL}" -o "${otmp}/office.tar.gz" || die "Office download failed"
    echo "${OFFICE_SHA256}  ${otmp}/office.tar.gz" | sha256sum -c - >/dev/null || die "Office checksum mismatch"
    mkdir -p "${otmp}/unpacked"
    tar -xzf "${otmp}/office.tar.gz" -C "${otmp}/unpacked" --no-same-owner
    rm -f "${otmp}/office.tar.gz"
    [ -f "${otmp}/unpacked/vendor/web-apps/apps/api/documents/api.js" ] || die "Office package layout not recognised"
    rm -rf "${STATE_DIR}/office-engine"
    mv "${otmp}/unpacked" "${STATE_DIR}/office-engine"
    rm -rf "${otmp}"
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "${STATE_DIR}/office-engine"
    log "  Office engine installed ($(du -sh "${STATE_DIR}/office-engine" | cut -f1))"
  fi
fi

log "Installing the systemd unit"
# `curl … | bash` leaves BASH_SOURCE unset, and `set -u` turns that into a fatal
# error right here — the unit never lands and the old daemon keeps running while
# the script still reports success. Default to empty and fall back to the copy
# that ships inside the bundle.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "${script_dir}" ] && [ -f "${script_dir}/uno-work.service" ]; then
  cp "${script_dir}/uno-work.service" /etc/systemd/system/uno-work.service
else
  cp "${INSTALL_DIR}/app/deploy/uno-work.service" /etc/systemd/system/uno-work.service 2>/dev/null \
    || die "uno-work.service not found next to the installer"
fi

# --- User systemd session ----------------------------------------------------
# Apps the agents build schedule work with user systemd timers (`systemctl
# --user`), and the App SDK instructions tell them to. Without lingering the
# service user has no user manager at all (it never logs in), so every
# `systemctl --user` failed with "Failed to connect to bus" and no timer ever
# ran. Linger starts user@<uid> at boot and keeps it alive; the drop-in gives
# the daemon — and every harness and terminal it spawns — the runtime dir that
# `systemctl --user` looks for (a system service has no XDG_RUNTIME_DIR).
log "Keeping a user systemd session for ${SERVICE_USER}"
service_uid="$(id -u "${SERVICE_USER}")"
if ! loginctl enable-linger "${SERVICE_USER}" >/dev/null 2>&1; then
  # No logind to ask (containers, chroots): the flag file is all linger is.
  install -d -m 0755 /var/lib/systemd/linger
  touch "/var/lib/systemd/linger/${SERVICE_USER}"
fi
install -d -m 0755 /etc/systemd/system/uno-work.service.d
cat > /etc/systemd/system/uno-work.service.d/user-session.conf <<DROPIN
# Written by install.sh — the service user's systemd session (user timers).
[Unit]
Wants=user@${service_uid}.service
After=user@${service_uid}.service

[Service]
Environment=XDG_RUNTIME_DIR=/run/user/${service_uid}
DROPIN

# Where the daemon finds the machine's browser (playwright's registry) and how it
# asks for it to be set up on first use (see "The machine's browser" above).
cat > /etc/systemd/system/uno-work.service.d/browser.conf <<DROPIN
# Written by install.sh — the machine's browser (Chromium from the bundle's playwright-core).
[Service]
Environment=PLAYWRIGHT_BROWSERS_PATH=${BROWSERS_DIR}
Environment=UNO_WORK_BROWSER_SETUP_REQUEST=${BROWSER_REQUEST_DIR}/request
Environment=UNO_WORK_BROWSER_SETUP_STATUS=${BROWSER_STATUS_DIR}/status.json
DROPIN

# --- Docker without sudo ------------------------------------------------------
# On a machine with docker (Work images, the docker template) the daemon lists,
# starts and stops docker apps on Home with plain `docker` as ${SERVICE_USER},
# and agents / the terminal run docker as ${SERVICE_USER}; `uno` is the login
# user of Uno boxes. Neither can use sudo (NoNewPrivileges), so without the
# docker group docker apps vanish from Home and `docker` fails with
# "permission denied" (seen on fresh machines from Work golden 168; older
# machines had the group). prepare-image.sh re-checks this before a snapshot.
if getent group docker >/dev/null 2>&1; then
  for docker_user in "${SERVICE_USER}" uno; do
    if id "${docker_user}" >/dev/null 2>&1 && ! id -nG "${docker_user}" | tr ' ' '\n' | grep -qx docker; then
      log "Adding ${docker_user} to the docker group"
      usermod -aG docker "${docker_user}"
    fi
  done
fi

systemctl daemon-reload
systemctl enable --now uno-work-browser-setup.path >/dev/null 2>&1 \
  || log "  could not enable browser setup on first use; the agent's browser won't install itself"
if [ "${UNO_WORK_SKIP_BROWSER:-1}" = "0" ]; then
  log "Installing the machine's browser now (Chromium + virtual display, ~1.1 GB)"
  "${INSTALL_DIR}/bin/uno-work-browser-setup" \
    || log "WARNING: browser setup failed (${BROWSER_STATUS_DIR}/setup.log); it retries on first use"
fi
systemctl start "user@${service_uid}.service" >/dev/null 2>&1 || log "  could not start the user session; user timers start after a reboot"
# `enable --now` only starts a stopped unit; an upgrade leaves the old process
# running on the old bundle. Restart unconditionally so the new code takes over.
systemctl enable uno-work >/dev/null
systemctl restart uno-work

# 30 секунд хватало на быстрой машине, но на слабом боксе демон успевает
# только прогнать миграции: первый запуск после установки видели ~60 с.
log "Waiting for the daemon"
for _ in $(seq 1 120); do
  # --max-time: while the daemon boots it can accept the connection without
  # answering, and a bare curl then hangs forever instead of retrying (seen on
  # the golden build box during the 0.0.57 upgrade).
  if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log "Daemon is up on ${HOST}:${PORT}"
    log "Pair a browser:  uno-work auth pairing create --base-dir ${STATE_DIR} --ttl 10m --role owner --json"
    exit 0
  fi
  sleep 1
done

die "Daemon did not become healthy — check: journalctl -u uno-work -n 50"
