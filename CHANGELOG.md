# Uno Work — Changelog

История релизов Uno Work desktop-приложения. Артефакты — на странице
[Releases](https://github.com/technoob228/uno-work/releases).

> Mac: auto-update на ad-hoc-signed билдах не работает. После апгрейда —
> вручную качать `Uno-Work.dmg` и перетаскивать в `/Applications`.

---

## v0.0.27 — 2026-05-22

Фикс каскада из 5 багов, ломавших онбординг на чистом маке после v0.0.26.

### Bug A — codex как дефолтный text-gen провайдер

На чистой установке UI первым делом показывал ошибку
*"Codex provider status: Codex CLI not installed"*: schema по умолчанию
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

В model picker'е Uno-провайдер показывал тултип *"OpenCode CLI (`opencode`)
is not installed"* потому что:
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

Старое: *"Local-first, with optional remote power when you need it"* — не
объясняло, что именно делать в приложении.

- `apps/web/src/components/onboarding/steps/WelcomeStep.tsx` — теперь:
  *"work on code, text files, tables, with all context of your data,
  stored locally"*.

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
