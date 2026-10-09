# Uno Work — Changelog

История релизов Uno Work desktop-приложения. Артефакты — на странице
[Releases](https://github.com/technoob228/uno-work/releases).

> Mac: auto-update на ad-hoc-signed билдах не работает. После апгрейда —
> вручную качать `Uno-Work.dmg` и перетаскивать в `/Applications`.

---

## v0.0.117 — 2026-10-09

- Switching computers in the browser always shows the interface of the computer you switch to. If it runs another Uno Work version, the page opens it in its own version (Uno remembers your choice: app.uno4.work opens that computer next time too).
- "A new version of Uno Work is ready · Reload" appears on every screen when the computer you use runs a newer Uno Work than the page — not only inside a chat.
- After an update, a tab that still runs the previous version reloads by itself instead of breaking on a missing file.

## v0.0.116 — 2026-10-08

- Home is one click away again: a "Home" row on top of the sidebar (and a house on the folded rail) opens the start screen from any chat, file or app. The web version without a computer has the same "Home" row.
- Home: "In progress" can be hidden — "Hide" next to its title (Undo in the toast). It stays hidden on this device; Customize → Add widget → "In progress" brings it back.
- Sidebar: "Needs you" shows only when an approval or a question really waits for you, with their number — no more "Needs you" with nothing in it.
- New computers start warm: the image keeps OpenCode's plugin files, so the first chat doesn't wait for a download.

## v0.0.115 — 2026-10-08

- Agents can write into any free chat, also one you wrote in — "Hand back to agent" is gone. To keep agents out of a chat: right-click it → "Don't let agents write here" (or the strip above the input); agents then get "The person closed this chat to agents". The same button lets them back.
- New chat: the folder chip ("Home folder ▾") also makes folders — "New folder…", "Upload a folder…", "Clone from GitHub…". The new folder goes to ~/projects and the chat moves into it with what you typed. A folder or a .zip dropped on a new chat does the same as "Upload a folder…"; pictures and videos stay attachments. "Empty project" and "From GitHub" also put the folder in ~/projects now. A fresh computer's empty sidebar says "No chats yet" with New chat and Add a project.
- Update: after Uno Work updates itself, Security gets the line "You updated Uno Work to … (was …)" — the computer now waits for the update to finish before telling the console.
- Computers started from a memory snapshot (the fast start) keep their own sign-in key on disk: restarting or updating Uno Work no longer signs the person out, and every such computer has its own environment id. Saving keys on such a computer works again.

## v0.0.114 — 2026-10-08

- Right panel: when a chat is marked Done or archived (or deleted), everything open in that chat's panel closes — browser tabs, site previews, files, apps. On the desktop app their pages are unloaded too. Tabs pinned to the project or "everywhere" stay. A chat brought back from Done or the archive starts with an empty panel.
- Sidebar (legacy, with projects): Done chats fold into one "Done · N" row under each project, like Snoozed; click to unfold. Archived chats never show in the sidebar (Settings → Archived chats, as before). The standard sidebar already folded them; in Dev mode its shelf now says "Done" instead of "Settled".

## v0.0.113 — 2026-10-08

- Uno Work updates itself on a cloud computer: "A new version of Uno Work is ready · Update" (above the chat, on Home, in My Uno). The owner presses Update, the computer downloads the release from the Uno console over HTTPS, checks it against the console's checksum list, installs it and restarts Uno Work once (about two minutes); if the new version doesn't start, the computer goes back to the previous one by itself. Chats and files are not touched. Only an owner session can start it; agents have no tool for it. The update shows up in Security ("You updated Uno Work to …"). Computers get the button with 0.0.113 — older ones need one last manual update.
- Chat: "AI is busy" and "the model didn't answer" are calm lines with "Try again" (it sends your last message again); "busy" counts down and retries once by itself. Other failed turns get "Try again" too. "AI time is used up" says the date and keeps addresses in the buttons.
- My Uno → Plan & billing matches the console: a cancelled plan says "Ends on …, no more charges" with "Keep my plan" (opens the console in a new tab); the Always on tile shows memory only, so cores read the same as on the computer.
- Home: "Describe your site / bot" opens the chat where you already described it, not a new one. "Connect with SSH" is no longer the first advice unless you picked the server goal or use Dev mode — it sits under the card as "For developers".
- Light chat: when Uno didn't finish in one go the button says "Continue". The agent asks "open to everyone or by password?" before publishing a personal page and gives the link to form entries after publishing a site with a form.
- Files: one line says what "This computer" and "Cloud storage" are (the computer's files go with it; Cloud storage stays and keeps copies of computers); project and app folders carry a small tag.
- Economy: a command your agent left running (a build, a script under nohup, a background shell) keeps the computer awake until it ends; the computer's status names it ("python3 is still running").
- Computer menu: the Economy switch explains itself in one line. Browser panel: "The agent is using this browser" goes away when the agent's turn ends. Phone (390): the chips under Home's input no longer run past its edge.

## v0.0.112 — 2026-10-07

- Smart paused after the AI time (plans with unlimited Fast, console flag `AI_SMART_STOP`): a strip above the composer of Uno Code / Hermes chats says "Smart is paused until you add AI time. Fast keeps working." with "Add AI time — +15 h for $10" (the pack checkout in the console, new tab); Home and My Uno say the same; the premium line steps aside (Fast answers premium then too).
- AI time used up: the billing banner and the light chat's stop card lead with "Add AI time" — straight to the pack checkout.
- Light Uno Work: "Start free — 3 days" only while the console has free trial places; otherwise "Get Plus — $20/mo" and "Free trials are paused right now."
- Sites: "Entries" at every site (chat card, site panel, Apps & sites, My Uno) opens the site's form entries in the console; "Manage in console" from a chat goes to that site's page (a bot chat → Home), not to Uno AI.
- Links in chats: your own sites, apps and previews open in the right panel; the console and other web links open in a new tab (the system browser on desktop).
- Sidebar: grey rows while the computer's chats load, instead of a flash of "No chats yet".

## v0.0.111 — 2026-10-07

- The console sees what is built on a Uno Work computer: the computer reports its apps (name, port, running or not — no commands, paths or env) to the console, where they show up in the computer's Apps tab under "Built on this computer". Sent when the list changes or every 10 minutes; a computer cloned from a memory snapshot sends it at once.
- My Uno → Plan & billing says "AI time" instead of "hours" ("Smart uses your AI time", "after your AI time runs out").

## v0.0.110 — 2026-10-06

- Free Telegram bot in the Uno AI chat: when Uno saves the bot (bot_setup), a card with Open @BotFather and a safe field for the token appears right in the chat; a pasted token never goes into the chat; "Live" tile in the light sidebar with the bot's answers and "Keep it on".
- My Uno → Plan & billing for "Always on + boosts" plans: Always on, boosts and AI time instead of RAM hours; Add computer over the plan explains running on boosts.
- "AI time" is the Uno AI unit everywhere (no more visible "AI hours").
- Assistant quiz in the light Work: on a plan that already has cloud Uno Work, "Set it up" opens Uno Work with the answers right away, without the plan step.

## v0.0.109 — 2026-10-05

- Personal assistant lives in the person's own Telegram bot: a "Create your assistant's bot" card (Open @BotFather, three steps, token check), greeting in the person's language; service notifications from the computer go through Uno's bot under "💻 From your Uno computer".
- Asking for a bot or an assistant: the token is the first step, before any work; a bot token card with Open @BotFather; skipping the token is a grey line, not a bubble.
- Uno suggests the assistant it already has instead of building a new bot; "Changed N files" folded under an answer, paths with `~`; agent rules for saving context (subagents, ranged reads).
- Connection status said quietly in the computer chip and menu, no reconnect toasts.
- Light mode sidebar matches the full app (Uno Work ▾, ✎, chats, account menu).
- Assistant quiz on Home and in light Uno AI; "Skip for now" carries the brief into the chat.
- Client side of a per-account Uno Work address (`<label>.uno4.work`), off until the backend flag.
- Hermes retries 3 times (the Uno AI gateway retries on a fallback model itself).

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
