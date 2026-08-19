#!/usr/bin/env bash
#
# Готовит бокс к съёмке golden-образа Uno Work.
#
#   curl -fsSL https://console.uno4.dev/cli/work/install.sh | sudo bash
#   curl -fsSL https://console.uno4.dev/cli/work/prepare-image.sh | sudo bash
#   # затем: POST /api/v1/boxes/{id}/image
#
# Зачем отдельный шаг. Установщик поднимает демон, а тот при первом старте
# создаёт вещи, которые обязаны быть УНИКАЛЬНЫМИ для каждой машины:
#
#   userdata/secrets/server-signing-key.bin — ключ подписи сессионных кук.
#       Уедет в образ — и кука, выданная на одном боксе, будет валидна на
#       любом другом боксе из того же образа. Это чужая сессия в чужой
#       машине, а не косметика.
#   userdata/environment-id — идентификатор окружения, по нему клиенты
#       различают backends.
#   userdata/state.sqlite — проекты, треды, pairing-токены и активные сессии.
#
# Поэтому образ снимаем с установленным ПО и ПУСТЫМ состоянием: демон
# сгенерирует ключ и базу при первом старте клона.
#
set -euo pipefail

STATE_DIR="${UNO_WORK_STATE_DIR:-/var/lib/uno-work}"
SERVICE_USER="${UNO_WORK_USER:-unowork}"
PORT="${UNO_WORK_PORT:-80}"

log() { printf '\033[1;35m[prepare-image]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[prepare-image]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."
[ -x /opt/uno-work/bin/uno-work ] || die "Daemon is not installed — run install.sh first."

# 1. Убедиться, что образ снимается с рабочего софта, а не со сломанного.
log "Проверяю, что демон и харнесы живые"
systemctl is-active --quiet uno-work || die "uno-work service is not running"
curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || die "health probe failed"

for harness in uno-code opencode hermes; do
  if sudo -u "${SERVICE_USER}" env HOME="/home/${SERVICE_USER}" bash -lc "command -v ${harness}" >/dev/null 2>&1; then
    log "  ${harness}: ok"
  else
    log "  ${harness}: НЕ УСТАНОВЛЕН — образ будет без него"
  fi
done

# 2. Погасить демон, чтобы он не переписал состояние после чистки.
log "Останавливаю демон"
systemctl stop uno-work

# 3. Стереть всё, что должно быть уникальным для каждой машины.
log "Чищу состояние (ключ подписи, environment-id, БД, логи, вложения)"
rm -rf \
  "${STATE_DIR}/userdata" \
  "${STATE_DIR}/caches" \
  "${STATE_DIR}/worktrees" \
  "${STATE_DIR}"/*.log
install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${STATE_DIR}"

# Ключ Gateway в образ не кладём: он персональный, пишется при провижне.
rm -f "${STATE_DIR}/settings.json"

# 4. Убрать следы, из-за которых клоны выглядели бы одинаково.
log "Убираю machine-id, SSH host keys, историю и кэши"
: > /etc/machine-id
rm -f /var/lib/dbus/machine-id
rm -f /etc/ssh/ssh_host_*
rm -rf /home/"${SERVICE_USER}"/.bash_history /root/.bash_history
rm -rf /home/"${SERVICE_USER}"/projects/* 2>/dev/null || true
rm -rf /var/lib/apt/lists/* /var/log/journal/* 2>/dev/null || true
apt-get clean >/dev/null 2>&1 || true

# systemd восстановит host keys на первом старте клона.
systemctl enable ssh >/dev/null 2>&1 || true

log "Готово. Демон включён в автозапуск, состояние пустое."
log "Снимай образ: POST /api/v1/boxes/{id}/image"
log "ВАЖНО: не запускай uno-work на этом боксе до съёмки — он создаст состояние заново."
