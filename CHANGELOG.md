# Uno Work — Changelog

История релизов Uno Work desktop-приложения. Артефакты — на странице
[Releases](https://github.com/technoob228/uno-work/releases).

> Mac: auto-update на ad-hoc-signed билдах не работает. После апгрейда —
> вручную качать `Uno-Work.dmg` и перетаскивать в `/Applications`.

---

## v0.0.28 — 2026-05-23

Веб-поиск в Uno-харнессе, инлайн-редактор в preview-панели, синхронизация
fullscreen-состояния окна с фронтом и обновлённый маркетинговый лендинг.

### Feature 1 — Brave-powered web search через bundled MCP-мост

Uno-харнесс получает tool `web_search(query, count?, country?, freshness?)`,
который проксирует запрос на `POST api.getuno.xyz/v1/search` (Brave Search
под капотом, биллинг через `users.llm_balance`). Ключ Brave хранится только
на Gateway — десктоп его не видит.

- `apps/desktop/resources/mcp/uno-search.mjs` — stdio MCP-сервер без
  внешних зависимостей (≈200 строк, line-delimited JSON-RPC 2.0).
- `apps/desktop/src/main.ts` — `backendChildEnv()` пробрасывает
  `UNO_MCP_SEARCH_SCRIPT` + `UNO_MCP_NODE_BIN` (Electron в режиме
  `ELECTRON_RUN_AS_NODE=1` работает как Node-интерпретатор).
- `apps/server/src/provider/Drivers/UnoDriver.ts` — при наличии
  `serverSettings.uno.apiKey` и bundled-скрипта в `OPENCODE_CONFIG_CONTENT`
  добавляется секция `mcp["uno-search"]` типа `local`.
- `apps/web/src/components/settings/SettingsPanels.tsx` — в Uno account
  секции появилась строка **Web search** с бейджем Active/Inactive.

Активируется автоматически когда в Settings привязан Uno API-ключ. Без
ключа индикатор «Inactive», MCP-секция в конфиге uno-code не появляется.

### Feature 2 — инлайн-редактор в preview-панели

Preview-панель умеет редактировать markdown-документы прямо в overlay-
панели: кнопка «карандаш» переключает между ReactMarkdown-выводом и
текстовым редактором, изменения сохраняются через `turndown` обратно в
исходный файл.

- `apps/web/src/components/preview/PreviewPane.tsx` — режим редактора,
  `detectFileKind`-экспорт, EnvironmentId-скоупинг для multi-environment
  set-ups.
- `apps/web/package.json` — добавлены `turndown` + `@types/turndown`.

### Feature 3 — синхронизация fullscreen-состояния окна с рендером

Renderer получает события `desktop:window-fullscreen-state` и проставляет
класс `is-fullscreen` на `<html>`. Используется для корректного отступа
под traffic-light кнопки и для адаптации chrome в полноэкранном режиме.

- `apps/desktop/src/main.ts` + `apps/desktop/src/preload.ts` — IPC-каналы
  `desktop:window-fullscreen-state` и `desktop:window-fullscreen-get-state`.
- `apps/web/src/lib/windowFullscreen.ts` — `syncDocumentFullscreenClass()`
  с теплым стартом и подпиской.
- `apps/web/src/main.tsx`, `apps/web/src/index.css` — подключение в
  bootstrap + базовые стили.
- `packages/contracts/src/ipc.ts` — `getWindowFullscreenState` и
  `onWindowFullscreenChange` в типах `DesktopBridge`.

### Feature 4 — refresh Uno snapshot после установки uno-code

После того как silent-installer допроливает `uno-code`, Uno-провайдер
автоматически перечитывает модели — больше не нужно дёргать ручной
«Re-detect».

- `apps/web/src/lib/desktopUnoCodeReactQuery.ts` — отслеживает переход
  `pending → installed`, инвалидирует Uno-snapshot ровно один раз.

### Feature 5 — рефакторинг ProviderPresentation

`OpenCodeProvider` экспортирует `ProviderPresentation` — общий интерфейс
(displayName, binaryCommand, minimumVersion, showInteractionModeToggle)
для `OpenCodeDriver` и `UnoDriver`. Раньше Uno-driver дублировал константы
руками; теперь обе ветки используют один источник истины.

- `apps/server/src/provider/Layers/OpenCodeProvider.ts` — вытащен
  `ProviderPresentation` и сделан параметром
  `checkOpenCodeProviderStatus`/`makePendingOpenCodeProvider`.
- `apps/server/src/provider/Drivers/UnoDriver.ts` — переключён на новый
  параметр; константа `UNO_PRESENTATION` живёт рядом с драйвером.

### Fix — ClaudeAdapter: providerRefs после завершения turn

После того как turn завершался, `context.turnState` сбрасывался в
`undefined` и `providerRefs.turnId` пропадал — UI терял возможность
сослаться на последний turn. Сохраняем `lastCompletedTurnId` и
возвращаем его в `providerRefs`, пока новый turn не стартовал.

- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — добавлено поле
  `lastCompletedTurnId` в `ClaudeSessionContext`.

### Marketing — обновлённый лендинг и CI

- `apps/marketing/src/pages/index.astro`, `apps/marketing/src/pages/download.astro`,
  `apps/marketing/src/layouts/Layout.astro` — освежены копирайт и блоки.
- `apps/marketing/public/favicon.svg`, `apps/marketing/public/logos/*`,
  `apple-touch-icon.png`, `favicon-*.png`, `favicon.ico`, `icon.png` —
  единый набор бренд-ассетов.
- `.github/workflows/marketing-storage.yml` — workflow публикации
  `apps/marketing` в UNO Storage по push в main.

### Docs — roadmap

`UNO_ROADMAP.md`: добавлен блок **Claude Billing Profiles And Fallback**
(подписка/Agent SDK/API/Bedrock/Vertex/Uno Gateway, безопасный restart +
resume, «Continue with …» recovery action).

---

## v0.0.27 — 2026-05-22

Фикс каскада из 5 багов, ломавших онбординг на чистом маке после v0.0.26.

### Bug A — codex как дефолтный text-gen провайдер

На чистой установке UI первым делом показывал ошибку
_"Codex provider status: Codex CLI not installed"_: schema по умолчанию
устанавливала `textGenerationModelSelection.instanceId = codex`, хотя продукт
называется Uno Work. Пользователь видел «у вас ничего не работает» вместо
«выберите провайдер».

- `packages/contracts/src/settings.ts` — дефолт `textGenerationModelSelection`
  переключён с `codex` на `uno`.

Существующие пользователи с уже сохранённым `codex` остаются на `codex`
(`withDecodingDefault` не перезаписывает значения). Новые ставят `uno`.

### Bug B — установщик встроенного харнесса Uno Code

#### B-i: релизы

В репо `technoob228/uno-code` не было ни одного релиза, инсталлер ловил 404
от `releases/latest` и крашился с `release-fetch-failed`.

Опубликован релиз `uno-v1.14.48-uno.1`: darwin-arm64, linux-x64, linux-arm64,
windows-x64. Intel Mac не публикуется (macos-13 free-tier runners висят в
очереди > 24ч) — фоллбэк через graceful-баннер из B-ii.

- `~/uno-project/uno-code/.github/workflows/uno-release.yml` — убрана
  `macos-13` из матрицы, добавлен комментарий с обоснованием.

#### B-ii: graceful 404

Если для текущей платформы релиза нет — раньше падало с криптическим
`GitHub API returned 404 ...`. Теперь — `release-not-published` /
`asset-missing` с человекочитаемым описанием и ссылкой на Settings → Uno →
custom binary path.

- `apps/desktop/src/unoCodeInstaller.ts` — отдельный код ошибки
  `release-not-published`, расширены сообщения для `asset-missing`.
- `apps/web/src/components/onboarding/steps/HarnessesStep.tsx` —
  non-blocking amber-баннер вместо блокирующей ошибки, варианты строк
  `bundled-installing` / `bundled-failed`, кнопка **Retry** через
  `desktopBridge.retryUnoCodeInstall()`.

### Bug C — UnoSettings schema + driver

В model picker'е Uno-провайдер показывал тултип _"OpenCode CLI (`opencode`)
is not installed"_ потому что:

- В schema под ключом `providers.uno` лежал `OpenCodeSettings` (binaryPath
  по умолчанию = `opencode`).
- После установки Uno Code путь писался в `providers.opencode.binaryPath`,
  а не в `providers.uno`.
- `UnoDriver` хардкодил `~/.unowork/uno-code/bin/uno-code` и игнорировал
  config.binaryPath, так что custom binary path из Settings никуда не
  доходил.

Все три ниточки чиним:

- `packages/contracts/src/settings.ts` — новый
  `UnoProviderSettings` (зеркало `OpenCodeSettings`, но
  `binaryPath` default = `uno-code`). `providers.uno` теперь использует его.
- `apps/desktop/src/main.ts` — `writeOpenCodeBinaryPathToSettings`
  переименован в `writeUnoBinaryPathToSettings`, целевой slot —
  `providers.uno.binaryPath`.
- `apps/server/src/provider/Drivers/UnoDriver.ts` —
  `binaryPath: config.binaryPath?.trim() || UNO_BINARY_PATH`. Status banner
  перестаёт врать, юзер может указать кастомный бинарь через Settings
  (важно для bring-your-own-binary сценария из B-ii).

Миграция не нужна: все поля используют `withDecodingDefault`, on-disk
`{ binaryPath: "opencode" }` валиден и просто перезапишется на следующее
обновление.

### Bug D — Uno API key терялся после рестарта

Пользователь вводил Uno key → Connect → видел Connected → после рестарта
поле пустое.

Корень: `useUpdateSettings` делал fire-and-forget RPC и optimistic UI
update без `await`. Если онбординг закрывался раньше, чем долетал ответ
сервера — запись на диск не успевала.

- `apps/web/src/hooks/useSettings.ts` — `updateSettings` теперь
  `await`-ит RPC, возвращает `Promise<void>`, на ошибку показывает
  toast. Убран guard `if (currentServerConfig)`, который молча скипал
  optimistic apply.
- `apps/web/src/routes/onboarding.tsx` — `beforeLoad` ждёт
  `startServerStateSync()` перед рендером.
- `apps/web/src/components/onboarding/steps/UnoLlmStep.tsx` — `handleConnect`
  стал `async`, кнопка показывает inline loading state, на ошибку
  оставляет draft в поле.

### Bug E — Welcome копирайт

Старое: _"Local-first, with optional remote power when you need it"_ — не
объясняло, что именно делать в приложении.

- `apps/web/src/components/onboarding/steps/WelcomeStep.tsx` — теперь:
  _"work on code, text files, tables, with all context of your data,
  stored locally"_.

---

## v0.0.26 — 2026-05-20

Major feature release. Подробности — в
[memory snapshot v0.0.26](https://github.com/technoob228/uno-work/releases/tag/v0.0.26).

- Full-screen 7-step онбординг-визард (заменил старый API-key диалог).
- Uno LLM Gateway driver (отдельный provider kind).
- Uno Code auto-install при первом запуске (macOS + Windows).
- Marketing landing page редизайн.
- Env-switching фикс (помним последний thread в env).
- Preview pane scoped по проекту.
- Брендинг «OpenCode» → «Uno Code».
- README переписан под Uno Work.
