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
  uv tool install "$hermes_spec" --with "mcp>=1.9" >/dev/null 2>&1 || echo "hermes install failed"
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

log "Installing the systemd unit"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${script_dir}/uno-work.service" ]; then
  cp "${script_dir}/uno-work.service" /etc/systemd/system/uno-work.service
else
  cp "${INSTALL_DIR}/app/deploy/uno-work.service" /etc/systemd/system/uno-work.service 2>/dev/null \
    || die "uno-work.service not found next to the installer"
fi

systemctl daemon-reload
systemctl enable --now uno-work >/dev/null

# 30 секунд хватало на быстрой машине, но на слабом боксе демон успевает
# только прогнать миграции: первый запуск после установки видели ~60 с.
log "Waiting for the daemon"
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log "Daemon is up on ${HOST}:${PORT}"
    log "Pair a browser:  uno-work auth pairing create --base-dir ${STATE_DIR} --ttl 10m --role owner --json"
    exit 0
  fi
  sleep 1
done

die "Daemon did not become healthy — check: journalctl -u uno-work -n 50"
