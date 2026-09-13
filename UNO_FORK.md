# Uno Work — fork of T3 Code

Этот репозиторий — форк [pingdotgg/t3code](https://github.com/pingdotgg/t3code), кастомизированный под продукт **Uno Work**. Основной апстрим-документ — [`AGENTS.md`](./AGENTS.md). Здесь описаны только наши изменения относительно апстрима.

Продуктовый план Uno Work лежит в [`UNO_ROADMAP.md`](./UNO_ROADMAP.md).

## Запуск

```bash
bun dev:desktop   # запускает web + Electron одновременно (через scripts/dev-runner.ts)
bun dev           # ТОЛЬКО web — Electron не стартует
bun fmt && bun lint && bun typecheck  # перед коммитом
```

`bun --filter '@t3tools/desktop' dev` напрямую **не работает** — `VITE_DEV_SERVER_URL` инжектится только через корневой `dev-runner`.

Если приложение надо оставить запущенным после ответа агента, не держать его в интерактивном PTY tool-session. Запускать как user launchd job:

```bash
launchctl submit -l xyz.unowork.dev -o /tmp/uno-work-dev.log -e /tmp/uno-work-dev.err -- /bin/zsh -lc "cd '$PWD' && exec $(command -v bun) dev:desktop"
```

Остановить такой dev-запуск:

```bash
launchctl remove xyz.unowork.dev
```

После `bun dev:desktop` не считать запуск успешным только по Vite URL. Обязательный smoke:

```bash
curl -I http://127.0.0.1:5733/
curl http://127.0.0.1:13773/.well-known/t3/environment
```

Если Electron показывает белый экран, полностью остановить и заново запустить `bun dev:desktop`. После изменений в `apps/desktop/src/main.ts` не полагаться на hot-restart watcher: он может оставить `dev-electron` живым без корректно поднятого окна/backend. Для диагностики смотреть процессы `dev-electron`, `--t3code-dev-root` и `apps/server/dist/bin.mjs`; браузерная проверка `5733` сама по себе не доказывает, что desktop shell жив. Успешный desktop smoke должен показать в Electron-логе `[desktop] renderer snapshot` с `content-ready` и `rootTextLength > 0`.

Dev Electron включает локальный CDP endpoint для Playwright: `http://127.0.0.1:9223`. Он нужен агентам, чтобы управлять уже открытым Uno Work/browser-pane через `chromium.connectOverCDP(...)`, а не отдельным браузером без профиля. Порт слушает только localhost; переопределить или отключить можно через `UNO_WORK_ELECTRON_REMOTE_DEBUGGING_PORT` (`0`/`false`/`off` отключает).

## Делта относительно апстрима

### 1. Brand: «T3 Code» / «Uno Work» → «Work»

- `apps/web/src/branding.ts` — `APP_BASE_NAME = "Work"`
- `apps/desktop/src/appBranding.ts` (+ `.test.ts`)
- `apps/desktop/scripts/electron-launcher.mjs` — `APP_DISPLAY_NAME = "Work (Dev)" | "Work"`
- `apps/desktop/src/main.ts` — текст диалогов + `USER_DATA_DIR_NAME = "unowork"` (миграция со старого `LEGACY_USER_DATA_DIR_NAME = "T3 Code (Alpha)"`)
- `apps/desktop/package.json` — `productName: "Work"`
- `scripts/build-desktop-artifact.ts` — `appId: "com.unotools.work"`, `artifactName: "Uno-Work-${version}-${arch}.${ext}"`, description/author/CLI help
- В UI — только логотип + бейдж «Work», без слова «Uno».

### 2. Dev mode toggle

`apps/web/src/devMode.ts` — простой хук + storage-event на `localStorage.ui_dev_mode`. Скрывает технические кнопки от обычных пользователей.

Кнопка-тоггл (`<CodeIcon>`) живёт в `ChatHeader` слева, рядом с бейджем проекта. По клику переключает `ui_dev_mode` и через `window` event синхронизирует все потребители.

Под `{devMode && …}` спрятаны:

- `ChatHeader`: ProjectScripts, OpenInPicker, GitActions (Commit & push), Terminal toggle, Diff toggle.
- `ChatView`: `BranchToolbar` (только когда есть git-репо).

### 3. Preview pane (наша главная новая фича)

Правая боковая панель для preview файлов — markdown / html / pdf / csv / json / images / xlsx / unknown. Лежит в `apps/web/src/components/preview/`:

- `PreviewPaneContext.tsx` — провайдер + хуки (`usePreviewPane`, `openFile`, `openBrowser`, `setOpen`, `toggleOpen`).
- `PreviewPane.tsx` — сама панель с вкладками + `PathBar` (с middle-ellipsis сворачиванием длинного пути и кнопкой «Copy path»).
- `FileBrowser.tsx` — модальный браузер файлов, открывается из `<FolderIcon>` в `ChatHeader`.
- `previewFileKind.ts` (или там же) — детектор `detectFileKind(name)` по расширению.

Серверная часть: `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts` + `apps/server/src/workspace/Services/WorkspaceFileSystem.ts` — RPC для чтения файлов и листинга директорий. Контракты в `packages/contracts/src/filesystem.ts` + добавлено в `rpc.ts` / `ipc.ts`.

### 4. Mutual exclusion: Diff panel ↔ Preview pane

В `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` — два `useEffect`, которые гарантируют, что в один момент открыта только одна панель: открыли Diff → закрыли Preview, и наоборот.

### 5. Click-to-preview routing для «Changed files»

`ChatView.onOpenTurnDiff` (см. `apps/web/src/components/ChatView.tsx`) роутит клик по файлу в карточке «Changed files»:

- `kind === "text"` (код) → старый Diff (TanStack Router search params).
- Всё остальное (md/html/pdf/csv/json/image/xlsx/unknown) → `usePreviewPane().openFile(...)`.

**Важно про путь:** `node.path` из `ChangedFilesTree` — project-relative (`test.html`). FileBrowser передаёт **абсолютный** путь. Поэтому в `onOpenTurnDiff` мы вручную джойним с `gitCwd` (корень проекта, с учётом worktree). Без этого Electron резолвит относительный путь от своего `cwd` (корень репозитория) и получает ENOENT.

### 6. Встроенный браузер (в панели preview)

Браузерные вкладки живут в той же правой панели, что и preview файлов (как в Codex Desktop).

- **Контракты:** `PreviewFileKind` получил `"browser"`; в `packages/contracts/src/server.ts` — `BrowserBridgeStreamEvent`; RPC `subscribeBrowserBridge` в `rpc.ts`; типы кредов + `browserProfileScope` в `ipc.ts`/`settings.ts`.
- **Web:** `apps/web/src/components/preview/BrowserPane.tsx` — Electron `<webview>` с тулбаром (назад/вперёд/обновить/адресная строка/автозаполнение/открыть внешне), все вкладки смонтированы (скрытые `display:none`). `browserUrl.ts` — нормализация ввода в URL (+ тесты). `PreviewPaneContext` — `openUrl`/`updateBrowserTab`, `currentProjectKey`. Иконка-глобус в `ChatHeader`, меню «файл/страница» на «+», скролл активной вкладки в табстрипе. `BrowserBridgeListener.tsx` подписывается на bridge-события и на `onBrowserOpenUrlRequest`.
- **Electron:** `webviewTag: true`, `will-attach-webview` снимает preload/nodeIntegration с гостя, `did-attach-webview` уводит `target=_blank` в новую вкладку. IPC кредов в `main.ts`/`preload.ts`; хранилище `browserCredentials.ts` (пароли через safeStorage, + тесты).
- **Мост модель→браузер:** `apps/server/src/browserBridge.ts` + endpoint `POST /api/browser/open` (Bearer-токен из env подпроцесса) в `http.ts`; пуш через WS `subscribeBrowserBridge` (`ws.ts`). Env `UNO_WORK_BRIDGE_URL`/`UNO_WORK_BRIDGE_TOKEN` инжектятся во все драйверы. Инструкции про браузер (+ ссылка на `getuno.xyz/llms.txt`) — `provider/browserInstructions.ts`: Claude через `systemPrompt.append`, Codex через `developer_instructions`, OpenCode/Uno через `instructions`-файл в `OPENCODE_CONFIG_CONTENT`.
- **Настройки:** раздел «Browser» (`settings.browser.tsx` + `BrowserSettingsPanel.tsx`) — выбор профиля (аккаунт/проект) и менеджер сохранённых входов.

### 7. Плагины — само-расширяемость (Settings → Extensions)

Агент, работающий внутри Uno Work, может расширять сам harness: плагин — это `<id>.json` **или** директория `<id>/plugin.json` (с ассетами рядом) в `<baseDir>/userdata/plugins/` (в dev-режиме `<baseDir>/dev/plugins/`). Демон следит за директорией и подхватывает изменения без рестарта. Манифест декларативный: **hooks** (реакция на события оркестрации → shell-команда) и **crons** (`schedule` — 5-польный cron, либо `every` — интервал, минимум 1m). Никакого исполнения чужого JS в процессе демона — только spawn `/bin/sh -c` с таймаутом (дефолт 60 с, максимум 10 мин) и ограничением параллелизма (4).

- **Контракты:** `packages/contracts/src/plugins.ts` (`PluginManifest`, `ServerPlugin`, `PluginsSnapshot`, `PluginsError`); RPC `server.listPlugins` / `server.setPluginEnabled` / `subscribePlugins` в `rpc.ts`.
- **Сервер:** `apps/server/src/plugins/` — `cron.ts` (парсер + матчинг, тесты), `PluginRegistry.ts` (загрузка/watch/снапшоты, паттерн `serverSettings.ts`), `PluginRuntime.ts` (подписка на `OrchestrationEngine.streamDomainEvents` + 30-сек cron-свип; каждый запуск логируется `plugins.action.completed` и записывается в историю для UI), `pluginInstructions.ts` (блок системного промпта). Путь `pluginsDir` — в `config.ts`; старт — `serverRuntimeStartup.ts`; слои — `server.ts`.
- **Инструкции агенту** инжектятся во все четыре драйвера рядом с browser-инструкциями (Claude — `appendSystemPrompt`, Codex — `appendDeveloperInstructions`, OpenCode/Uno — общий `uno-browser-instructions.md` через `extraSections`). Благодаря этому «сделай, чтобы приложение …» превращается в плагин без участия человека.
- **UI:** Settings → Extensions (`settings.extensions.tsx` + `ExtensionsSettingsPanel.tsx`): список плагинов, вкл/выкл (правит `enabled` в файле), ошибки невалидных манифестов, последние запуски (live через `subscribePlugins`).
- Хуки исполняют команды с env `UNO_PLUGIN_EVENT` (JSON события), `UNO_PLUGIN_EVENT_TYPE`, `UNO_PLUGIN_ID`, `UNO_PLUGIN_TRIGGER`.

**Панельные плагины (фаза A ТЗ `.plans/20-plugin-panels-custom-ai-ui.md`).** Плагин-директория может объявить `"panel": { "title": ..., "path": "panel/index.html" }` — статическую «софтинку» во вкладке правой панели: агент пишет HTML+inline JS, а cron того же плагина обновляет `data.json` рядом. Никаких localhost-серверов.

- **Раздача:** `apps/server/src/plugins/http.ts` — `GET /api/plugins/:pluginId/panel/*`; `panelPaths.ts` — резолв путей (entry-файл манифеста и его директория как корень, защита от traversal, тесты). Заголовки: MIME по расширению, `X-Content-Type-Options: nosniff`, CSP `self` + inline, `Cache-Control: no-cache`. Плагин выключен/без панели/неизвестен → 404.
- **Auth-компромисс:** панель рендерится в `<iframe sandbox="allow-scripts">` **без** `allow-same-origin`, поэтому её собственные запросы (`data.json`) не несут сессионную куку в принципе. Навигационные запросы (`Sec-Fetch-Dest: iframe/document` и запросы без заголовка) требуют сессию, субресурсы — нет. Обоснование зафиксировано комментарием в `plugins/http.ts`.
- **Реестр:** `PluginRegistry.ts` знает обе формы, валидирует `panel` (только директория, относительный путь, файл существует), считает коллизию id ошибкой у обеих форм и перевешивает `fs.watch` на каждую плагин-директорию после reload (плюс дедуп снапшотов — запись `data.json` кроном не будит UI).
- **UI:** вкладка `kind: "plugin-panel"` (`PreviewPaneContext.makePluginPanelFile` → `/api/plugins/<id>/panel/`), рендер iframe в `PreviewPane.tsx`, кнопка «Открыть панель» в Settings → Extensions и подменю «Панели» в меню «+» табстрипа (список через `server.listPlugins`).

**Мост панель ↔ приложение (фаза B того же ТЗ).** Панель может управлять приложением через `postMessage`: `{ __unoPanel: 1, id, method, params }` → `{ __unoPanel: 1, id, result | error }`. Методы v1: `openFile`, `openUrl`, `sendToThread`, `subscribe`.

- **Хост:** `apps/web/src/components/preview/panelBridge.ts` (протокол, словарь методов, rate limit 10 вызовов/с на вкладку, фильтр подписок через общий `hookMatches`) + обвязка в `PluginPanelBody` (`PreviewPane.tsx`). Сообщения принимаются ТОЛЬКО при `event.source === iframe.contentWindow` своей вкладки: у opaque origin `event.origin === "null"`, проверять по нему нечего. Мост создаётся один раз на документ панели, контекст проекта читается из ref — иначе подписки терялись бы при смене контекста.
- **События:** `apps/web/src/environments/runtime/shellEventBus.ts` — fire-after-commit-шина поверх уже существующего `subscribeShell` (публикуется в `runtime/service.ts` после применения события к стору). Панели отдаются только события её проекта, переведённые в точечную нотацию `thread.upserted` / `thread.removed` / `project.upserted` / `project.removed` (сырого потока доменных событий у клиента нет — по WS приезжает проекция с `kind`).
- **`sendToThread`:** RPC `plugins.sendToThread` (контракты `PluginSendToThreadInput/Result`), реализация — `apps/server/src/plugins/panelThread.ts`, вызов из `ws.ts`. Тред создаётся в проекте вкладки с заголовком `[<имя плагина>] <threadTag>`; `threadTag` (по умолчанию `panel`) переиспользует живой тред — карта `pluginId+tag → threadId` живёт в памяти `PluginRegistry`, живость проверяется через `ProjectionSnapshotQuery`. `runtimeMode`/`interactionMode` наследуются (переиспользуемый тред — свои, новый — от первого треда проекта; наследовать не от чего → `approval-required`, НЕ `full-access`). Каждый вызов пишется в `recentRuns` (`trigger: "panel sendToThread"`) и логируется; клиент показывает тост «Плагин X отправил задачу агенту».
- **Origin:** `OrchestrationCommandOrigin` стал union — к `{ kind: "manager" }` добавился `{ kind: "plugin", pluginId }`; он проставляется в метаданных всех событий команды, так что event store остаётся аудит-логом и для панелей.
- **Общий словарь паттернов:** `hookMatches` переехал в `@t3tools/shared/pluginPatterns` — одна реализация на хуки демона (`PluginRuntime`) и подписки панели.
- **Харднинг раздачи:** в `plugins/http.ts` добавлена realpath-проверка (файл после разыменования обязан оставаться внутри директории плагина) — симлинк из панельной папки наружу больше не читается неаутентифицированным субресурсным запросом.
- **Инструкции агенту:** `pluginInstructions.ts` содержит готовый JS-сниппет моста (промис-обёртка) и описание методов с ограничениями.

**Кастомный AI-интерфейс (фаза C того же ТЗ).** Панель может попросить хост-чат себе в соседи: `"panel": { …, "chat": { "threadTag": "reports", "visibility": "answers-only" } }`. Вкладка делится на две части — сверху iframe плагина, снизу настоящий чат приложения по треду этой панели. Чат всегда рендерит хост: плагин не рисует сообщения и права треда не расширяет (селектор runtime mode в таком композере скрыт).

- **Тред — один на панель:** RPC `plugins.resolvePanelThread` (`panelThread.ts`, `makePanelThreadResolver`) ходит в ТУ ЖЕ карту `pluginId + threadTag → threadId` в памяти `PluginRegistry`, что и `sendToThread`, но хода не запускает. Общий код обоих RPC — `loadPanelContext` + `resolveOrCreatePanelThread`; наследование `runtimeMode`/`interactionMode` и fallback `approval-required` — как в фазе B. Карта в памяти → после рестарта демона панель заводит новый тред (принято).
- **`EmbeddedThreadChat`** (`apps/web/src/components/chat/EmbeddedThreadChat.tsx`) — обёртка над `ChatView` с флагом `embedded`. **Компромисс, зафиксированный в ТЗ (C1):** `ChatView` — одна функция на ~3.5к строк, где вся обвязка композера (60+ пропсов) вычисляется на месте, поэтому вместо вытаскивания «таймлайн + композер» переиспользуется весь `ChatView`, а `embedded` гасит в нём chrome и эффекты, которые обязаны быть в одном экземпляре на документ: заголовок, `BranchToolbar`, plan sidebar, терминалы, глобальные хоткеи, `setCurrentChatContext`, общий ref композера, автофокус, фокус-режим. Подписку на детали треда `ChatView` держит сам (`retainThreadDetailSubscription`), поэтому встроенный чат работает с любым тредом, не только с тредом маршрута.
- **`visibility`** (`apps/web/src/components/chat/embeddedChatVisibility.ts`, юнит-тесты): `full` | `answers-only` (реплики пользователя, ответы ассистента с текстом и планы; `work`-строки и пустые заготовки ответа скрыты) | `composer-only` (таймлайна нет). Фильтр применяется на выборке строк таймлайна в хосте; approvals и вопросы-к-пользователю живут в композере и видны всегда. В манифесте `visibility` — строка, валидируется реестром (`validatePanelChat`) с понятной ошибкой, наружу уходит уже литералом.
- **Раскладка:** `apps/web/src/components/preview/PluginPanelChat.tsx` — `PluginPanelSplit` (пропорция в `localStorage.plugin_panel_chat_split`, ручка-ресайзер), `PluginPanelChat` (резолв треда, отказ для проекта не-основного окружения), `usePluginPanels` (live-список панелей через `subscribePlugins` — им же теперь питается меню «+», раньше читало `listPlugins` разово по клику). Split вертикальный (панель сверху, чат снизу): правая панель узкая, «слева/справа» там нечитаемо. Iframe в дереве не переезжает — иначе документ плагина перезагружался бы при появлении чата.

### 8. «Продолжить на другой машине» (Continue on <machine>)

Один чат переезжает с демона, где он живёт, на другой подключённый демон: кнопка в `ChatHeader` (иконка монитор+телефон) и пункт «Continue on another machine…» в контекстном меню треда. Фаза 1 — вручную, по одному треду; примитивы рассчитаны на будущий per-project «Sync».

- **Контракты:** `packages/contracts/src/threadContinue.ts` — пять RPC: `thread.continue.inspect` (цель, read-only: есть ли папка, git ли это, ветка, число незакоммиченных изменений), `thread.continue.prepare` (источник), `thread.continue.receive` (цель), `thread.continue.cleanup` (источник, best-effort удаление transport-ветки), `thread.continue.complete` (источник); `ThreadContinueError` с machine-readable `reason`. Внутренняя команда `thread.message.user.append` в `orchestration.ts` — добавить user-сообщение без запуска хода.
- **Файлы едут через git.** `apps/server/src/git/continueTransport.ts`: снимок рабочего дерева (tracked + untracked, без ignored) делается чекпоинт-машинерией (`CheckpointStore.captureCheckpoint` теперь принимает `parents`/`message`) в скрытый ref `refs/t3/continue/<threadId>` с родителем HEAD, пушится (`--force`, существующая ветка того же имени перезаписывается, а не ломает повтор) в ветку `uno/continue/<threadId>` на remote проекта (`origin` или первый remote). На цели: fetch по URL в тот же скрытый ref, `restoreCheckpoint` кладёт дерево в рабочую копию, **не трогая HEAD/ветку** — изменения остаются незакоммиченными, как на источнике. **Рабочая копия цели становится точной копией источника**: её собственные незакоммиченные правки и untracked-файлы в этом проекте заменяются/удаляются — поэтому диалог перед стартом зовёт `inspect` и при изменениях на цели требует явную галочку «Replace them». После успешного receive источник удаляет ветку на remote (`cleanup`: `git push <remote> --delete`); неудача логируется и показывается в тосте как «Could not remove the transfer branch on the remote», перенос не откатывается. Нет remote → ранний отказ «Add a git remote (GitHub or Uno Git) to continue on another machine.»
- **История едет как seed.** `apps/server/src/orchestration/handoff.ts` — общий с Telegram-коннектором модуль: `buildHandoffContext` (Telegram: 12×600), `buildContinueSeed` (40×4k + заголовок «[Continued from <machine>] …»). Сами строки-маркеры преамбулы лежат в `packages/shared/src/handoff.ts` (`@t3tools/shared/handoff`), `handoff.ts` их реэкспортирует — web узнаёт seed по тем же константам. Seed становится первым user-сообщением нового треда и **не** отправляется как ход; `ProviderCommandReactor` через `resolvePendingHandoffSeed` подклеивает его к промпту первого реального хода (у Claude/Codex прошлые сообщения проекции в харнесс иначе не попадают — только OpenCode читает `contextMessages`). В таймлайне (`MessagesTimeline.tsx`, `HandoffSeedBody`) seed рендерится свёрнутой карточкой «Continued from <machine> · N earlier messages» с «Show history»; текст после преамбулы (сообщение из Telegram, пометка о смене модели) виден всегда. Детектор — `isHandoffSeed`/`describeHandoffSeed` в `apps/web/src/continueOnMachine.ts`.
- **Обработчики:** `apps/server/src/orchestration/continueOnMachine.ts` (явные deps, как `plugins/panelThread.ts`). На цели: проект по пути (`existing`) или клон + `project.create` (`create`, путь считает клиент как в «Move to a box»); модель — та же, если харнесс установлен, иначе default проекта / auto-bootstrap с пометкой в seed; `.env` пишется best-effort; активности `thread.continued.from` / `thread.continued.on`; origin `{kind:"system", component:"thread-continue"}`.
- **Web:** `apps/web/src/continueOnMachine.ts` — степ-машина connect → prepare → receive → cleanup → complete → open с чекпоинтом прогресса (retry продолжает с упавшего шага, повторного push нет; cleanup после первой попытки не повторяется); `inspectContinueTarget` / `describeContinueTarget` / `canStartContinue` — что диалог показывает под списком машин и когда кнопка активна (нет папки → «will be cloned to <path>»; чистый чекаут → «its files will be updated»; есть изменения → красная строка + обязательный чекбокс; папка не git → отказ). `ContinueOnMachineDialog.tsx`; строки в `continueOnMachineCopy.ts`. «Saving files → Pushing» показывается одним шагом: prepare — один RPC.
- **Тесты:** `handoff.test.ts`, `continueOnMachine.test.ts` (fake transport: inspect, cleanup non-blocking, повторный prepare с той же веткой), `git/continueTransport.test.ts` (реальный git, bare-репозиторий вместо GitHub: правки, новые файлы, удаления, ignored, HEAD цели не сдвинут, `readStatus`, force-update и удаление ветки), `apps/web/src/continueOnMachine.test.ts` (шаг cleanup, гейтинг чекбокса, детектор seed), `MessagesTimeline.test.tsx` (свёрнутая карточка seed). Против настоящего GitHub/Uno Git и двух живых демонов не проверялось.

### 9. Прочее

- `apps/web/src/components/AddEnvModal.tsx`, `SidebarEnvSwitcher.tsx` — кастомные обёртки над свитчером сред.
- `apps/web/src/index.css` — кастомные стили (Uno-палитра / акценты).
- `apps/web/src/components/ChatMarkdown.tsx`, `ChatView.browser.tsx` — мелкие правки рендера.
- `apps/server/src/ws.ts` — расширен для нового RPC.

## Мердж апстрима

Конфликтные точки при `git fetch upstream && git merge upstream/main`:

- `apps/web/src/components/chat/ChatHeader.tsx` — мы добавили devMode + порядок кнопок.
- `apps/web/src/components/ChatView.tsx` — onOpenTurnDiff, импорты preview.
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx` — mutual exclusion.
- `apps/web/src/branding.ts`, `apps/desktop/src/appBranding*.ts`, `apps/desktop/package.json`, `electron-launcher.mjs`, `apps/desktop/src/main.ts` — наш бренд.
- `scripts/build-desktop-artifact.ts` — `appId`, `artifactName`, description/author.
- `packages/contracts/src/{filesystem,rpc,ipc}.ts` — новые методы для preview.

Перед мерджем: запустить `bun typecheck` после resolve. После: `bun dev:desktop` и проверить, что (а) логотип «Work», (б) dev-toggle переключает кнопки, (в) preview pane открывается на md/html, (г) клик по changed file роутит правильно.
