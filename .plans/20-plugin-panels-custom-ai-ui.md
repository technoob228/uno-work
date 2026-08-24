# Панельные плагины и кастомный AI-интерфейс (Plugins v2/v3) — имплементационное ТЗ

Утверждено 2026-08-24: делаем все три фазы A→B→C, последовательно, с приёмкой после каждой.
Дизайн основан на разборе плагинной системы bb (github.com/ymichael/bb) и plugins v1 этого репо
(`apps/server/src/plugins/`, коммиты `d46ca9bc`, `b9f73e08` на ветке `feat/plugins-v1`).

## Контекст и принципы (обязательны для исполнителя)

**Что уже есть (v1):**
- Плагин = JSON-манифест в `ServerConfig.pluginsDir` (`<stateDir>/plugins/`): `hooks` (события
  оркестрации → shell) + `crons` (`schedule`/`every` → shell). Контракты в
  `packages/contracts/src/plugins.ts`; реестр с hot-reload — `apps/server/src/plugins/PluginRegistry.ts`
  (паттерн serverSettings: Ref + PubSub + Semaphore + debounced fs.watch); исполнение —
  `PluginRuntime.ts`; RPC `server.listPlugins` / `server.setPluginEnabled` / `subscribePlugins`;
  UI — Settings → Extensions (`ExtensionsSettingsPanel.tsx`).
- Bridge `/api/browser/open` принимает `{"url"}` и `{"file"}`; события `openUrl`/`openFile` уходят
  клиенту через `subscribeBrowserBridge`, файл открывается вкладкой панели (`BrowserBridgeListener.tsx`).
- Инструкции агенту про плагины и панель — `apps/server/src/plugins/pluginInstructions.ts` +
  `apps/server/src/provider/browserInstructions.ts`, инжектятся во все 4 драйвера.

**Принципы (уроки bb, не нарушать):**
1. Код плагина НИКОГДА не исполняется в процессе демона или в странице приложения. UI плагина —
   только sandboxed iframe (opaque origin, `sandbox="allow-scripts"`). Граница доверия — манифест.
2. Чат/таймлайн всегда рендерит хост. Плагин не рендерит сообщения — он получает хост-чат как
   примитив с параметрами. Плагинная поверхность не может расширить права агента (только сузить).
3. События для плагинов — observe-only, fire-after-commit: сбой плагина ничего не блокирует.
4. Reload атомарный, ошибки конфигурации — первоклассное состояние в UI, не тихий отказ.
5. Декларативность: неизвестные ключи манифеста игнорируются (forward-compat), никакого SDK-версионирования.

**Правила работы в этом репо:**
- Перед коммитом: `bun fmt && bun lint && bun typecheck` зелёные; тесты — ТОЛЬКО `bun run test`
  (никогда `bun test`). См. `AGENTS.md`, `UNO_FORK.md`.
- `bun fmt` форматирует весь репозиторий и трогает чужие неотформатированные файлы
  (`apps/extension/*`, `deploy/pack.ts`, тесты onboarding и др.) — перед коммитом откатывать
  `git checkout --` файлы, которых задача не касается; `git add` только по именам.
- Effect v4 beta: `Layer.pipe` имеет лимит 20 аргументов (RuntimeCoreDependenciesLive в `server.ts`
  впритык — новые слои подкладывать в существующие `Layer.mergeAll`). В тестах `it.effect` подсовывает
  TestClock — для тестов с реальным IO использовать `it.layer(NodeServices.layer, { excludeTestServices: true })`.
- `*/n` в блочном комментарии закрывает комментарий — cron-примеры в JSDoc писать аккуратно.
- Добавление RPC: литерал в `WS_METHODS` + `Rpc.make` + в `WsRpcGroup` (`packages/contracts/src/rpc.ts`),
  реализация в `apps/server/src/ws.ts` (компилятор заставит), фасад в `apps/web/src/rpc/wsRpcClient.ts`.
  Новым сервисам ws.ts нужны mock'и в `apps/server/src/server.test.ts` (см. mock PluginRegistry там).
- `apps/web/src/routeTree.gen.ts` регенерируется сборкой (`bun run build` в `apps/web`).
- Коммиты — по фазе, с trailer `Co-Authored-By` исполнителя.

---

## Фаза A — Панельные плагины (декларативные «софтинки» в правой панели) — ✅ СДЕЛАНО

> Реализовано 2026-08-24 на `feat/plugins-v1`. Отклонения от текста ниже:
> - `PreviewFileKind` живёт в `apps/web/src/components/preview/PreviewPaneContext.tsx`, а не в
>   `packages/contracts/src/filesystem.ts` (там его никогда и не было — так же добавлялся `"browser"`).
> - URL вкладки — `/api/plugins/<id>/panel/` без имени файла: `<rest>` резолвится относительно
>   директории entry-файла, чтобы относительные ссылки внутри панели (`data.json`) работали.
>   Поэтому `ServerPlugin.panel` — ровно `{ title }`, как и планировалось.
> - Роут зарегистрирован только как `/panel/*` (бареный `/panel` без слэша find-my-way считает
>   конфликтом с wildcard-веткой).

**Цель:** агент делает мини-приложение/дашборд как статические файлы плагина; оно живёт вкладкой в
правой панели, без localhost-серверов; cron того же плагина обновляет данные.

### A1. Форма «плагин-директория»
- Реестр учится второй форме: `pluginsDir/<id>/plugin.json` (+ произвольные ассеты рядом).
  Плоские `pluginsDir/<id>.json` продолжают работать. Коллизия id (файл и директория) — ошибка
  валидации у обоих.
- Watch: изменения `plugin.json` внутри поддиректории должны подхватываться. `fs.watch` родителя
  нерекурсивен → при каждом reload перевешивать вотчеры: родительский + по одному на каждую
  директорию плагина (только на неё, не рекурсивно в ассеты — изменение ассетов перезагрузки не
  требует). Все вотчеры в одном Scope, закрываются перед перевеской.
- `setPluginEnabled` работает для обеих форм.

### A2. Манифест: секция `panel`
```json
"panel": { "title": "Deploys", "path": "panel/index.html" }
```
- Контракты (`plugins.ts`): `PluginPanel = { title: string, path: string }`, опционально в
  `PluginManifest`; в `ServerPlugin` — `panel?: { title: string }`.
- Валидация в реестре: `panel` допустим только у формы-директории; `path` — относительный, без
  `..`, файл должен существовать на момент загрузки (иначе `valid: false` с понятной ошибкой).

### A3. Раздача статики
- Роут `GET /api/plugins/:pluginId/panel/*` в `apps/server/src/http.ts` (или отдельный
  `plugins/http.ts` по образцу manager/http.ts), auth — как у attachments
  (`requireAuthenticatedRequest`).
- Резолв строго внутри директории плагина (нормализация + проверка префикса — защита от traversal;
  тесты обязательны). Плагин disabled или без panel → 404.
- Заголовки: MIME по расширению (модуль `Mime` уже используется в http.ts), `X-Content-Type-Options:
  nosniff`, CSP `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; connect-src 'self'` (агентские однофайловые странички с
  инлайн-скриптом — норма). Кэш: `no-cache` (файлы перегенерируются кронами).

### A4. Вкладка в правой панели
- Новый `PreviewFileKind` `"plugin-panel"` (contracts `filesystem.ts` — см. как добавлялся
  `"browser"`); `PreviewFile.url` = `/api/plugins/<id>/panel/<path>`.
- Рендер в `PreviewPane.tsx`: `<iframe sandbox="allow-scripts" src={url}>` на весь контент вкладки.
  НЕ `allow-same-origin` — origin должен остаться opaque (куки сессии в iframe не нужны: сам HTML
  загружен с auth'ом хоста... ВАЖНО: `<iframe src>` шлёт куки same-origin автоматически, а с opaque
  sandbox — fetch из iframe к `/api/plugins/...` пойдёт без куки. Поэтому data-файлы плагина
  (`data.json`) грузить fetch'ем изнутри iframe не выйдет без `allow-same-origin`. Решение v1:
  добавить в sandbox `allow-same-origin` НЕЛЬЗЯ (это снимает изоляцию при same-origin src). Вместо
  этого: сервить панель с отдельного псевдо-origin нельзя без второго порта → приемлемый компромисс:
  роут панели помечать как доступный С СЕССИОННОЙ КУКОЙ ТОЛЬКО для navigation-запросов (Sec-Fetch-Dest:
  iframe/document), а subresource-запросы iframe (fetch data.json) пускать БЕЗ auth, но только для
  путей внутри панели конкретного плагина. Т.е. `GET /api/plugins/:id/panel/*`: navigation — по
  сессии; остальное — без auth (содержимое панели плагина не секретнее его манифеста; путь наружу
  не выйдет благодаря traversal-защите). Зафиксировать это решение комментарием в коде.
- Открытие вкладки: (а) в `ExtensionsSettingsPanel` у плагина с panel — кнопка «Открыть панель»
  (openFileInProject текущего проекта); (б) в меню «+» табстрипа PreviewPane — секция «Панели»
  со списком панельных плагинов (источник — `subscribePlugins`).

### A5. Инструкции агенту
- `pluginInstructions.ts`: описать форму-директорию и `panel`; правило: «результат-приложение без
  backend → панельный плагин; интерактив без сервера — HTML+JS в панели, данные кроном в
  `data.json` рядом»; пример манифеста дашборда (panel + cron, обновляющий data.json).

### A6. Тесты и приёмка
- Registry: директория-форма загружается; panel валидируется (`..` — отказ, отсутствие файла —
  invalid); коллизия id; hot-reload при правке `plugin.json` в поддиректории.
- HTTP: traversal-атаки (`../`, `%2e%2e`, абсолютный путь) → 404/400; корректный MIME; disabled → 404.
- Приёмка вручную: создать плагин-директорию с index.html + cron, увидеть вкладку, увидеть
  обновление данных.

## Фаза B — Мост панель ↔ приложение (postMessage) и origin:plugin — ✅ СДЕЛАНО

> Реализовано 2026-08-24 на `feat/plugins-v1`. Отклонения от текста ниже:
> - **События.** Сырого потока доменных событий (`OrchestrationEvent.type`) у клиента нет:
>   `subscribeShell` отдаёт проекцию с `kind` (`thread-upserted` / `thread-removed` /
>   `project-upserted` / `project-removed`). Поэтому `subscribe` фильтрует их, переведённые в
>   точечную нотацию `thread.upserted` / `thread.removed` / `project.upserted` /
>   `project.removed` (`shellEventToPanelEvent`); `hookMatches` работает как в хуках. Событие
>   `thread-removed` без известного проекта в панель не уходит (нечем ограничить по проекту).
>   Вместо второй WS-подписки на вкладку добавлена локальная шина `shellEventBus.ts`
>   (fire-after-commit поверх уже существующего потока).
> - **Runtime mode.** «Унаследованный от проекта» буквально невозможен: у проекта нет
>   `runtimeMode` (он живёт на треде). Переиспользуемый тред идёт со своим режимом; новый —
>   с режимом первого активного треда проекта; если тредов нет — `approval-required` (как у
>   менеджера), а не `DEFAULT_RUNTIME_MODE` (`full-access`).
> - **Окружение.** Панель раздаёт демон основного окружения (URL вкладки относительный), поэтому
>   `sendToThread` явно требует проект основного окружения и вызывает RPC на его соединении;
>   проект удалённого окружения — понятная ошибка в панель.
> - **Проект вкладки.** В `PreviewPaneContext` добавлен `currentChatProjectId` (проставляет
>   `ChatView`) — `projectKey` там логический (группировка), для оркестрации не годится.
> - **Ответ об ошибке** — `{ __unoPanel: 1, id, error: string }` (строка, а не объект с кодом):
>   так короче обёртка на стороне панели.
> - `recentRuns` пишет сервер (там же, где создаётся тред), а не клиент.

**Цель:** панель — «пульт агента»: навигация, запуск действий, отправка промптов, подписка на события.

### B1. Протокол
- В iframe: `window.parent.postMessage({ __unoPanel: 1, id, method, params }, "*")`; ответ хоста —
  `{ __unoPanel: 1, id, result }` либо `{ id, error }`. Хост принимает сообщения только от
  `event.source === iframe.contentWindow` своей вкладки; методы — фиксированный словарь; rate limit
  ~10 вызовов/сек на вкладку (сверх — error).
- Хост-сторона: модуль `apps/web/src/components/preview/panelBridge.ts` + обвязка в рендере
  plugin-panel вкладки. Плагину — короткий JS-сниппет в инструкциях агенту (промис-обёртка).

### B2. Методы v1
- `openFile { path }` / `openUrl { url }` — реюз `openFileInProject`/`openUrlInProject` текущего
  проекта вкладки.
- `sendToThread { text, threadTag? }` — новый ws-RPC `plugins.sendToThread`
  (payload: pluginId, projectRef текущего проекта, text, threadTag?):
  - contracts: `OrchestrationCommandOrigin` расширить союзом `{ kind: "plugin", pluginId }`
    (additive; сейчас там `{ kind: "manager" }`).
  - сервер: по `threadTag` ищет живой тред этого плагина (mapping держать в памяти реестра:
    `pluginId+tag → threadId`, проверять что тред жив через ProjectionSnapshotQuery); нет — создаёт
    тред в проекте (title `[<plugin name>] <threadTag ?? "panel">`), затем `thread.turn.start` с
    origin plugin. Runtime mode — унаследованный от проекта, НЕ full-access принудительно.
  - UX-страховка: тост в клиенте «Плагин X отправил задачу агенту» (слушатель события) + запись в
    `recentRuns` плагина (`trigger: "panel sendToThread"`).
- `subscribe { pattern }` → хост подписывается на общий поток оркестрации, который у клиента уже
  есть (subscribeShell), фильтрует `hookMatches(pattern, event.type)` и постит события в iframe
  (`{ __unoPanel: 1, event }`). `hookMatches` вынести в `packages/shared` (использовать и сервером).
  Ограничение: только события проекта вкладки.

### B3. Тесты и приёмка
- Юнит: словарь методов, отклонение неизвестных, rate limit, фильтр pattern.
- Сервер: sendToThread создаёт тред с origin plugin; threadTag реюзает тред.
- Приёмка: панель с кнопкой «Спроси агента» реально запускает тред.

## Фаза C — Кастомный AI-интерфейс («чат приезжает в панель»)

**Цель Миши:** жить в правой панели: сверху кастомный интерфейс, рядом — компактный чат с фильтром
шума; центральный чат свёрнут. Харнесс любой.

### C1. `EmbeddedThreadChat`
- Выделить из ChatView переиспользуемый компонент `EmbeddedThreadChat({ threadRef, variant:
  "compact", visibility, composer: boolean })`. НЕ копипаста: обернуть существующие подкомпоненты
  (таймлайн, композер) с урезанным chrome (без заголовка/тулбаров/переключателя прав —
  `permissionPolicy: inherit`). Основной чат-роут переходит на те же подкомпоненты — регрессий ноль
  (ручной смоук обязателен).
- `visibility`: `"full"` | `"answers-only"` (только завершённые ответы ассистента + approvals +
  вопросы-к-пользователю; активности/инструменты скрыты) | `"composer-only"`. Фильтр — на уровне
  выборки строк таймлайна в хосте.

### C2. Манифест и layout
- `panel.chat: { threadTag: string, visibility?: "full"|"answers-only"|"composer-only" }`.
- Вкладка plugin-panel с chat рендерит split: iframe (60%) + `EmbeddedThreadChat` (40%,
  ресайз ручкой; пропорция в localStorage). Тред резолвится/создаётся тем же mapping'ом, что
  `sendToThread` (B2) — панель и её чат смотрят в один тред.
- Focus-режим правой панели (`previewLayoutMode: "focus"`) с такой вкладкой = полноэкранный
  кастомный интерфейс.

### C3. Инструкции агенту
- Обновить pluginInstructions: полный рецепт «кастомный интерфейс» = panel + chat + мост
  (sendToThread/subscribe) + пример.

### C4. Приёмка
- Смоук основного чата (ничего не сломано), смоук compact-чата в панели: отправка, ответ,
  approvals работают; `answers-only` скрывает activity-шум; права не расширяются.

## Порядок исполнения
Каждая фаза: отдельный коммит(ы) на `feat/plugins-v1`, зелёные fmt/lint/typecheck/`bun run test`
(4 CORS/OTLP-падения в server.test.ts — pre-existing, не чинить и не ломать сильнее), обновление
`UNO_FORK.md` (секция 7) и этого файла (отметить фазу сделанной). После фазы — стоп на приёмку.

## Заметки приёмки фазы A (для фазы B)
- Харднинг в B: в раздаче panel-статики добавить realpath-проверку (fs.realPath файла обязан
  оставаться внутри директории плагина) — закрыть чтение наружу через symlink в панельной папке
  для неаутентифицированных subresource-запросов.
- Риски, зафиксированные исполнителем A: postMessage из opaque-origin iframe приходит с
  `event.origin === "null"` — фильтровать строго по `event.source`; URL панели относительный
  (демон primary-окружения) — в sendToThread явно выбирать окружение вкладки; список панелей в
  «+»-меню читается по клику, для live-обновления понадобится subscribePlugins в PreviewPane.
