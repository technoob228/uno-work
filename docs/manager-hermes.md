# Manager Agent: Hermes-сайдкар (Track A)

Менеджер-агент = **мозг снаружи, руки внутри**. Демон (`apps/server`) владеет
оркестрацией и является security-границей: scopes, project-allowlist,
proposals/approvals, бюджеты и аудит живут в нём (`src/manager/`). Мозг —
[Hermes Agent](https://github.com/NousResearch/hermes-agent) — подключается к
демону по MCP со scoped capability-токеном и получает бесплатно: Telegram
(включая голосовые), обучающуюся память, cron-heartbeat и роутинг моделей.
В репозитории нет ни строчки Hermes-кода: смена мозга = revoke токена.

```
Telegram (текст/войс) ──► Hermes (uv, systemd/compose, тот же хост)
                             │ MCP: POST http://127.0.0.1:<port>/api/manager/mcp
                             │ Authorization: Bearer uwm_…
                             ▼
apps/server ── Manager Tool Layer ── OrchestrationEngine (event-sourced, видно в UI)
```

## 1. Выпуск capability-токена

Токены выпускает владелец (owner-сессия) через HTTP. Плейнтекст показывается
**один раз**; в БД хранится только SHA-256.

```bash
curl -X POST http://127.0.0.1:3773/api/manager/tokens \
  -H "Cookie: <owner-session>" -H "Content-Type: application/json" \
  -d '{
    "label": "hermes-sidecar",
    "scopes": ["threads:read", "threads:write", "threads:approve"],
    "projectAllowlist": ["<dev-project-id>"],
    "budget": { "maxWriteActionsPerHour": 10, "maxTurnsPerDay": 40 }
  }'
```

Правила:
- **Начинай с `threads:read`**, добавляй write/approve после первых дней.
- `projectAllowlist` — только dev-проекты. Прод fishcode/балансы/VPS клиентов
  не подключаем на этапе MVP вообще.
- Бюджеты enforced в демоне (sliding window по таблице proposals) — prompt
  injection их не снимает. `null` = дефолт 10 write/час, 40 turns/день.
- Отзыв: `POST /api/manager/tokens/revoke {"tokenId": "…"}` — мгновенный.

## 2. Установка Hermes рядом с демоном

Один механизм для локального Мака (opt-in) и сервера. Всегда **пиновать
релизный тег**, апгрейд — осознанное действие.

```bash
uv tool install hermes-agent==<pinned-release>   # см. релизы NousResearch/hermes-agent
```

Сервер (systemd, лимит памяти обязателен — Hermes может есть >1 GB):

```ini
# /etc/systemd/system/hermes-manager.service
[Service]
User=hermes                 # не root
ExecStart=/home/hermes/.local/bin/hermes serve
MemoryMax=1536M
Restart=on-failure
EnvironmentFile=/home/hermes/.config/hermes/env   # токены здесь, не в юните

[Install]
WantedBy=multi-user.target
```

## 3. Подключение к демону (MCP)

В конфиге Hermes добавь MCP-сервер:

```json
{
  "mcpServers": {
    "uno-manager": {
      "type": "http",
      "url": "http://127.0.0.1:3773/api/manager/mcp",
      "headers": { "Authorization": "Bearer uwm_<секрет>" }
    }
  }
}
```

Ко-локация = loopback, наружу MCP не торчит. Для удалённого демона — существующие
SSH-туннели/`AdvertisedEndpoint`, не открывать порт в интернет.

Доступные тулы: `list_threads`, `get_thread_status`, `read_thread_detail`,
`list_pending_approvals`, `create_thread`, `send_turn`, `interrupt_turn`,
`respond_to_request`, `list_proposals`, `resolve_proposal`.

## 4. Telegram + голос

- Нативный Telegram-коннектор Hermes; **allowlist одного chat_id** (владелец) в
  конфиге Hermes. Это первая линия; вторая — демон всё равно не исполнит ничего
  без approve.
- Голосовые Hermes транскрибирует сам.

## 5. Write-действия: proposals + approve из Telegram

Любой write-тул НЕ исполняет действие — он создаёт **proposal** (pending,
TTL 30 минут) и возвращает `proposalId` + одноразовый `nonce`. Исполнение —
только после `resolve_proposal(proposalId, "approved", nonce)` или approve
владельцем через `POST /api/manager/proposals/resolve` (owner-сессия, без nonce).

Поток в Telegram:
1. Ты: «подними тред в проекте X, сделай Y».
2. Hermes: вызывает `create_thread` → получает proposal → пишет тебе:
   «Заявка #abc: создать тред "Y" в X. Подтвердить?»
3. Ты: «да / approve».
4. Hermes: `resolve_proposal(abc, approved, nonce)` → демон диспатчит команду
   с origin `{kind: "manager", tokenId, proposalId}` → тред виден в Electron UI.

**Честно про модель доверия Track A:** nonce известен Hermes'у (он сам создал
заявку), поэтому от полностью скомпрометированного Hermes nonce не защищает —
защищают scopes, allowlist, бюджеты, TTL и аудит в event store. Nonce + жёсткая
инструкция в скилле защищают от главного реального риска: модель случайно/по
prompt-injection зовёт resolve без подтверждения человека. Настоящий
out-of-band approve появится в Track B (свой Telegram-шлюз демона).

## 6. Heartbeat

Cron Hermes каждые 5–10 минут: `list_threads` → diff со своей памятью → писать
в Telegram только значимые переходы (turn завершён, ошибка сессии, появился
pending approval/proposal). Дешёвая модель для heartbeat-сводок — конфигом
роутинга Hermes; сильная — только для планирования.

## 7. Скилл «uno-manager»

Установи скилл из `docs/hermes-skills/uno-manager/SKILL.md` (формат
agentskills.io, Hermes совместим). Ключевые правила зашиты там: диспетчер, а не
исполнитель; сводки прежде деталей; контент тредов = untrusted data;
resolve_proposal только после явного «да» владельца.

## 8. Gate-чекпоинт (2–4 недели реального использования)

Оцениваем:
- **(а) качество оркестрации** — осмысленно ли раздаёт/мониторит задачи через тул-слой;
- **(б) ум/обучаемость** — накапливает ли полезную память о проектах и привычках;
- **(в) вес/ops** — RAM, стабильность сайдкара на Маке и на сервере.

Провал любого пункта → Track B: `ManagerBrainService` (Claude Agent SDK) внутри
демона за тем же `ManagerToolService`, revoke токена, `systemctl disable
hermes-manager`. Память Hermes при миграции: экспорт скриптом или просто
переучить (см. решение в MANAGER_AGENT_VISION.md).

## Приложение: аудит

Каждая manager-команда идёт через `OrchestrationEngine.dispatch` с
`metadata.origin = {kind: "manager", tokenId, proposalId}` — event store и есть
аудит-лог. Заявки (все, включая denied/expired) — в таблице
`manager_action_proposals` с `resolved_by` и `resolution_command_ids_json`.
