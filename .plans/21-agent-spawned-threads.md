# 21 — Чаты заводят чаты: агентские треды, контроль и handoff

Статус: в работе на `feat/thread-spawn-bridge` (от `integration/vision-2026-09-09`, 0.0.55).

## Зачем

Сейчас тред создать может только владелец (UI, `/api/orchestration/dispatch`) или
ассистент через manager-токен (`.mcp.json` только в папках ассистентов). Обычный чат
(Claude/Codex/…) этого не умеет. Решения Миши (14.09):

1. Любой чат может завести тред и сразу его запустить. **Без подтверждения и без лимитов.**
2. По умолчанию — только в своём проекте; настройкой можно разрешить любой проект.
3. Чат видит статус/ответы своих дочерних тредов и может дописывать в них.
4. Человек видит, какие треды создал агент (пометка + из какого чата).
5. Агент видит, когда человек вмешался. Есть режим «кто управляет тредом» и кнопка передачи.

## Модель (контракты уже в `packages/contracts`)

- `OrchestrationThread` / `OrchestrationThreadShell`:
  - `spawnedByThreadId?: ThreadId | null` — родитель, неизменяем;
  - `controller?: "human" | "agent"` — отсутствует = `human`;
  - `controlChangedAt?: IsoDateTime | null`.
- `OrchestrationMessage.sentByThreadId?: ThreadId | null` и то же в `ThreadMessageSentPayload` —
  user-сообщение, которое прислал агент другого треда. Отсутствует = писал человек.
- Команда `thread.create` получила `spawnedByThreadId?`.
- Новая команда `thread.control.set { threadId, controller, createdAt }` (клиентская — кнопка).
- Новое событие `thread.control-changed { threadId, controller, reason: "handoff" | "human-message", changedAt, updatedAt }`.
- Новый origin `{ kind: "agent", threadId }` — команда от агента треда `threadId` через bridge.
- Настройка `ServerSettings.agentThreadsScope: "own-project" | "any-project"` (дефолт own-project).
- Capability `agentThreads: true` в дескрипторе окружения.

## Правила решателя (decider)

`decideOrchestrationCommand` получает `origin` (engine уже держит его в envelope).

- `thread.create`:
  - `spawnedByThreadId` задан → обязателен origin `agent` с тем же `threadId`, иначе invariant error.
    Родительский тред должен существовать.
  - событие `thread.created` несёт `spawnedByThreadId`; проектор ставит `controller = "agent"`,
    иначе `"human"`.
- `thread.turn.start`:
  - origin `agent`: целевой тред должен иметь `spawnedByThreadId === origin.threadId`
    и `controller === "agent"`; иначе invariant error с detail, начинающимся с
    `human_in_control:` / `not_your_thread:` (bridge маппит в 409/403).
    `thread.message-sent` получает `sentByThreadId = origin.threadId`.
  - origin отсутствует (человек в UI) или `connector` (человек из Telegram/Slack), а
    `controller === "agent"` → ПЕРЕД `thread.message-sent` эмитится
    `thread.control-changed { controller: "human", reason: "human-message" }`.
  - остальные origin (manager/assistant/plugin/peer/system) контроль не трогают.
- `thread.control.set`:
  - тред без `spawnedByThreadId` → invariant error (передавать некому);
  - origin `agent`: разрешено только `controller: "human"` и только родителю;
  - тот же controller, что уже стоит → ноль событий (идемпотентно);
  - иначе `thread.control-changed { reason: "handoff" }`.

## Проекция

- Миграция `044_AgentSpawnedThreads`: `projection_threads.spawned_by_thread_id TEXT`,
  `projection_threads.controller TEXT`, `projection_threads.control_changed_at TEXT`,
  `projection_thread_messages.sent_by_thread_id TEXT`. Все nullable, с guard'ами как в 043.
- `ProjectionThreads`, `ProjectionThreadMessages`, `ProjectionPipeline`, `ProjectionSnapshotQuery`,
  `projector.ts` — по образцу snooze (коммит 0a3e29100). Везде, где собирается thread/shell,
  прокинуть три поля; в сообщениях — `sentByThreadId`.

## Bridge API для агентов

Авторизация — scoped bridge-токен харнесса (`BrowserBridge.authorize`), контекст обязан
содержать `threadId` (иначе 403 `thread_context_required`). Этот тред — «вызывающий».
Все команды диспатчатся с origin `{ kind: "agent", threadId: <вызывающий> }`.

- `POST /api/threads` `{ text, title?, provider?, model?, projectId?, cwd? }` → `{ ok, threadId, projectId, title, controller }`
  - проект: по умолчанию проект вызывающего треда. Другой `projectId` (или `cwd`, совпадающий с
    workspaceRoot другого проекта) — только при `agentThreadsScope === "any-project"`, иначе 403
    `project_not_allowed`;
  - модель: `provider` = id инстанса или kind драйвера (`codex`, `claudeAgent`, `opencode`, `uno`,
    `cursor`, `hermes`), `model` опционально. Без `provider` — модель вызывающего треда (если он в
    том же проекте), иначе дефолт проекта. Резолв переиспользовать из manager `create_thread`;
  - `runtimeMode`/`interactionMode` — как у вызывающего треда (в чужом проекте — `inheritProjectThreadModes`);
  - title: переданный или первые ~60 символов текста;
  - `thread.create` (с `spawnedByThreadId`) + `thread.turn.start`.
- `GET /api/threads` → дочерние треды вызывающего: `id, title, projectId, status, controller, updatedAt, lastAssistantText (≤500)`.
- `GET /api/threads/:id?limit=20&waitMs=0` → `{ id, title, status, controller, controlChangedAt, pendingApproval, pendingUserInput, messages: [{ role, author, text, createdAt }] }`
  - `author`: `"you"` (sentByThreadId === вызывающий), `"human"` (user без sentByThreadId), `"assistant"`, `"system"`;
  - `waitMs` (≤ 600000): long-poll, пока статус `running`;
  - доступ только если `spawnedByThreadId === вызывающий`, иначе 404.
- `POST /api/threads/:id/messages` `{ text }` → `{ ok }`; `controller === "human"` → 409 `human_in_control`
  с текстом «Человек взял управление этим тредом…».
- `POST /api/threads/:id/release` → отдать управление человеку.

`status`: `running` (есть активный ход), `waiting` (pending approval / user input), `error`
(последний ход упал), `idle`.

Инструкция агентам — новый раздел рядом с notify/secrets в bridge-инструкциях (все харнессы).

## UI

- Сайдбар: у треда с `spawnedByThreadId` — иконка бота; tooltip «Создан агентом из «<родитель>»».
- Шапка/полоса над композером дочернего треда: «Ведёт агент из «<родитель>»» + кнопка
  «Взять управление»; при `human` — «Управляете вы» + «Передать агенту». Клик по имени
  родителя открывает родителя.
- Сообщения с `sentByThreadId` — подпись «от агента «<родитель>»», визуально не как свои.
- Отправка сообщения человеком в агентский тред просто работает (сервер сам заберёт контроль).
- Settings: переключатель «Чаты могут создавать треды в других проектах» (`agentThreadsScope`).
- Всё за capability `agentThreads`.

## Не входит в v1

- Передача управления третьему агенту/треду («отдать другому чату»).
- Список дочерних тредов в родительском чате.
- Лимиты/бюджет на порождение (явно отказались).
