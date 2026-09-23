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
curl -fsS --max-time 10 "http://127.0.0.1:${PORT}/api/health" >/dev/null || die "health probe failed"

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
  "${STATE_DIR}"/*.log \
  "${STATE_DIR}/tmp"
install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${STATE_DIR}" "${STATE_DIR}/tmp"

# Ключ Gateway в образ не кладём: он персональный, пишется при провижне.
rm -f "${STATE_DIR}/settings.json"

# 4. Убрать следы, из-за которых клоны выглядели бы одинаково.
log "Убираю machine-id, историю и кэши"
: > /etc/machine-id
rm -f /var/lib/dbus/machine-id
# SSH host keys НЕ удаляем здесь: съёмка образа сама ходит в гостя по SSH
# (guest fs sync перед снапшотом), а OpenSSH ≥9.8 перечитывает ключи с диска
# на каждое соединение — без файлов sshd рвёт коннект, и capture падает.
# Уникальность ключей у клонов обеспечивает uno-work-identity (см. ниже):
# он ротирует host keys на первой загрузке клона вместе с ключом кук.
rm -rf /home/"${SERVICE_USER}"/.bash_history /root/.bash_history
rm -rf /home/"${SERVICE_USER}"/projects/* 2>/dev/null || true
rm -rf /var/lib/apt/lists/* /var/log/journal/* 2>/dev/null || true
apt-get clean >/dev/null 2>&1 || true
# TMPDIR демона живёт на диске состояния (см. uno-work.service), и там копятся
# распакованные .so от bun-бинарей харнесов — по 4.7 МБ на запуск uno-code, без
# уборки. В golden v9 первой съёмкой уехало 3.9 ГБ такого мусора, и min_disk
# образа вырос с 8 до 11 ГБ. npm-кэш root — от `npm install` установщика.
rm -rf /root/.npm/_cacache 2>/dev/null || true

# 5. Вернуть host keys на первой загрузке клона.
#
# Раньше здесь стояло «systemd восстановит host keys сам» — это неверно.
# Ключи пересоздаёт uno-box-agent, но он работает на RESUME, а не на холодной
# загрузке. Первый же бокс, поднятый из такого образа cold boot'ом, встретил
# `Connection refused` на 22-м порту: sshd без host keys не стартует. А по SSH
# в гостя ходит exec-канал ноды — то есть отваливается и /run, и чеканка
# pairing-токена, ради которой всё затевалось.
log "Ставлю юнит ротации SSH host keys (до старта sshd, без рестартов)"
# Ротация ДО старта sshd, а не рестартом после: systemctl restart ssh посреди
# загрузочной транзакции гоняется с собственным start-джобом ssh.service, и
# sshd может остаться лежать (поймано на живом клоне: порт 80 жив, 22 refused).
cat > /usr/local/sbin/uno-work-sshkeys <<'SCRIPT'
#!/bin/sh
set -eu
STATE="${UNO_WORK_STATE_DIR:-/var/lib/uno-work}"
stamp="${STATE}/.identity-host"
host="$(hostname)"
# Штампа нет или hostname другой — это первый бут клона: ключи образа общие
# для всех клонов, им тут не место. Свой бокс после обычного ребута ключи
# сохраняет.
if [ ! -f "${stamp}" ] || [ "$(cat "${stamp}")" != "${host}" ]; then
  rm -f /etc/ssh/ssh_host_*
fi
ssh-keygen -A
SCRIPT
chmod 0755 /usr/local/sbin/uno-work-sshkeys

cat > /etc/systemd/system/uno-work-sshkeys.service <<'UNIT'
[Unit]
Description=Rotate SSH host keys inherited from an image clone
Documentation=https://uno4.dev/docs/work
DefaultDependencies=no
After=local-fs.target
# Before identity: тот пишет штамп hostname, по которому мы отличаем клон.
Before=ssh.service sshd.service uno-work-identity.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/uno-work-sshkeys

[Install]
WantedBy=multi-user.target
UNIT

# 6. Не дать клонам унаследовать ключ подписи сессионных кук.
#
# prepare-image.sh стирает состояние ДО съёмки, но образ на этом не
# заканчивается: warm-up поднимает из него временную машину, снимает пару
# «память+диск», и диск этой машины становится базой быстрого пути. Демон на
# warm-up успевает сгенерировать server-signing-key.bin — и все боксы, поднятые
# по снапшоту, получают ОДИН ключ. Кука, выданная одному клиенту, подошла бы
# другому. То есть дыра, ради которой написан шаг 3, возвращается в обход него.
#
# Различаем клон и пробуждение своей же машины по hostname: у своего бокса он
# при wake не меняется, у клона — всегда другой (его ставит uno-box-agent из
# identity). Поэтому рядом с ключом храним hostname, при котором он создан.
# Проекты и треды не трогаем: небезопасна только identity.
log "Ставлю юнит ротации identity демона (клон не должен наследовать ключ кук)"
cat > /usr/local/sbin/uno-work-identity <<'SCRIPT'
#!/bin/sh
set -eu
STATE="${UNO_WORK_STATE_DIR:-/var/lib/uno-work}"
SERVICE_USER="${UNO_WORK_USER:-unowork}"
stamp="${STATE}/.identity-host"
key="${STATE}/userdata/secrets/server-signing-key.bin"
host="$(hostname)"

# Та же машина — выходим молча (обычное пробуждение бокса).
if [ -f "${stamp}" ] && [ "$(cat "${stamp}")" = "${host}" ]; then
  exit 0
fi

rotated=0
if [ -e "${key}" ] && [ -f "${stamp}" ]; then
  rm -rf "${STATE}/userdata/secrets" "${STATE}/userdata/environment-id"
  rotated=1
fi

printf '%s\n' "${host}" > "${stamp}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${stamp}" 2>/dev/null || true

# --no-block: юнит стоит Before=uno-work.service, синхронный restart отсюда
# упёрся бы в собственную очередь systemd.
if [ "${rotated}" = 1 ]; then
  systemctl restart --no-block uno-work 2>/dev/null || true
fi
exit 0
SCRIPT
chmod 0755 /usr/local/sbin/uno-work-identity

cat > /etc/systemd/system/uno-work-identity.service <<'UNIT'
[Unit]
Description=Drop a Uno Work identity inherited from an image clone
Documentation=https://uno4.dev/docs/work
Before=uno-work.service

[Service]
Type=oneshot
RemainAfterExit=no
ExecStart=/usr/local/sbin/uno-work-identity

[Install]
WantedBy=multi-user.target
UNIT

# Быстрый путь восстанавливает демон уже запущенным, поэтому одного запуска на
# загрузке мало: hostname меняет uno-box-agent уже ПОСЛЕ resume. Ловим момент.
cat > /etc/systemd/system/uno-work-identity.path <<'UNIT'
[Unit]
Description=Watch for a hostname change that means this box is a fresh clone
Documentation=https://uno4.dev/docs/work

[Path]
PathChanged=/etc/hostname
Unit=uno-work-identity.service

[Install]
WantedBy=multi-user.target
UNIT

# 7. Имя машины = имя бокса, ДО старта демона.
#
# uno-box-agent проставляет hostname из MMDS только на resume. Work-образ
# всегда стартует холодным, и все клоны оставались с именем сборочной машины
# («uno-work-golden-v5-build»): в Uno Work две новые машины выглядели одной
# строкой с чужим именем. Демон берёт метку машины из hostname при старте,
# поэтому ставим его раньше демона и раньше uno-work-identity (новое имя = клон
# → ротация ключа кук). MMDS недоступен — оставляем как есть, загрузку не держим.
log "Ставлю юнит имени машины из MMDS (hostname клона = имя бокса)"
cat > /usr/local/sbin/uno-work-hostname <<'SCRIPT'
#!/bin/sh
set -u
url="http://169.254.169.254/uno/identity/hostname"
name=""
i=0
while [ "${i}" -lt 15 ]; do
  name="$(curl -fsS --max-time 2 "${url}" 2>/dev/null | tr -d '\r\n')" && [ -n "${name}" ] && break
  i=$((i + 1))
  sleep 1
done
# Только то, что годится в hostname: буквы, цифры, дефис и точка.
case "${name}" in
  "" | *[!A-Za-z0-9.-]*) exit 0 ;;
esac
[ "$(hostname)" = "${name}" ] && [ "$(cat /etc/hostname 2>/dev/null)" = "${name}" ] && exit 0
printf '%s\n' "${name}" > /etc/hostname
hostname "${name}"
if grep -q '^127\.0\.1\.1' /etc/hosts; then
  sed -i "s/^127\.0\.1\.1.*/127.0.1.1 ${name}/" /etc/hosts
else
  printf '127.0.1.1 %s\n' "${name}" >> /etc/hosts
fi
exit 0
SCRIPT
chmod 0755 /usr/local/sbin/uno-work-hostname

cat > /etc/systemd/system/uno-work-hostname.service <<'UNIT'
[Unit]
Description=Name this machine after its Uno box (MMDS) before Uno Work starts
Documentation=https://uno4.dev/docs/work
After=network.target
Before=uno-work-identity.service uno-work.service

[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=30
ExecStart=/usr/local/sbin/uno-work-hostname

[Install]
WantedBy=multi-user.target
UNIT

# 8. root без пароля в образ не везём.
#
# Базовый rootfs Firecracker (от него все шаблоны Uno и Work-образ) приходил с
# ПУСТЫМ паролем root (+ pam_unix nullok) и автологином root на ttyS0. Пустой
# пароль = `su` даёт root любому процессу машины. Демон Work и его агенты живут
# с NoNewPrivileges и `su` не могут, но всё, что пользователь поставит сам
# (docker-приложения, сервисы из App Store), — может. Пароль блокируем, override
# serial-getty убираем (ttyS0 остаётся обычным getty). Вход — только ключами.
log "Блокирую пароль root и убираю автологин root на ttyS0"
passwd -l root >/dev/null
rm -f /etc/systemd/system/serial-getty@ttyS0.service.d/override.conf
rmdir /etc/systemd/system/serial-getty@ttyS0.service.d 2>/dev/null || true
root_pw="$(awk -F: '$1=="root"{print $2}' /etc/shadow)"
case "${root_pw}" in
  '!'* | '*'*) ;;
  *) die "root password is not locked" ;;
esac

systemctl daemon-reload >/dev/null 2>&1 || true
systemctl enable ssh uno-work-sshkeys.service uno-work-hostname.service uno-work-identity.service uno-work-identity.path >/dev/null 2>&1 || true

# Штамп относится к машине-эталону; в образе его быть не должно, иначе первый
# клон решит, что hostname совпадает, и ключ не ротирует.
rm -f "${STATE_DIR}/.identity-host"

log "Готово. Демон включён в автозапуск, состояние пустое."
log "Снимай образ: POST /api/v1/boxes/{id}/image"
log "ВАЖНО: не запускай uno-work на этом боксе до съёмки — он создаст состояние заново."
