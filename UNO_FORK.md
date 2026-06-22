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

### 7. Прочее

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
