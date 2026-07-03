# HermesDriver — план (риски сняты пробами 2026-07-04)

Цель: Hermes как шестой встроенный харнесс в пикере провайдеров — дефолтный
кандидат для чатов ассистента и внешних коннекторов.

## Проверено вживую (probes)

1. `hermes acp` говорит стандартный ACP `protocolVersion: 1` — тот же
   протокол, что у ClaudeDriver/CursorDriver (`effect-acp`). Handshake:
   `agentCapabilities: {loadSession, sessionCapabilities: {fork, list, resume}}`.
2. `session/new {cwd, mcpServers}` работает; ответ содержит
   `models.availableModels` — список **прямо из Uno Gateway** (fable-5,
   opus-4.8, sonnet-5, …), т.е. пикер моделей заполняется ACP-нативно, свой
   каталог-фетч не нужен.
3. Env-инъекция работает: `OPENAI_API_KEY` (= верхнеуровневый `uno.apiKey` из
   настроек приложения) + `OPENAI_BASE_URL=https://api.getuno.xyz/v1` +
   `--provider openai-api`. Ключ из config.yaml Hermes НЕ читает — только env.
   Модельные id на гейтвее namespaced с точками: `anthropic/claude-haiku-4.5`.
4. ACP-extra обязателен: `uv tool install "hermes-agent[acp]" --with "mcp>=1.9"`.

## Архитектура

- `Drivers/HermesDriver.ts` + `Layers/HermesAdapter.ts` — форк CursorAdapter
  (ближайший по размеру/структуре, ~1100 строк) с заменами:
  - spawn: `hermes acp`, env: `HERMES_HOME=<stateDir>/hermes-home-<instanceId>`
    (изоляция от пользовательского ~/.hermes), `OPENAI_API_KEY` из
    настроек (`uno.apiKey`, как UnoDriver), `OPENAI_BASE_URL`, дефолтная
    модель `anthropic/claude-haiku-4.5` (токен-экономия).
  - выпилить cursor-специфику: login-flow, cursor extension methods,
    model-refresh extension (модели приходят в session/new).
  - resume: у Hermes есть `loadSession` + `sessionCapabilities.resume` —
    маппится на наш continuation.
- `HermesSettings` в contracts settings (enabled, binaryPath="hermes",
  model default) + ключ `hermes` в `settings.providers` + запись в
  `DEFAULT_MODEL_BY_PROVIDER`.
- Регистрация в `BUILT_IN_DRIVERS` → инстанс и пикер появляются сами
  (hydration создаёт дефолтный инстанс на driverKind).
- Иконка в web `Icons.tsx`.

## Открытые хвосты (не блокеры)

- Читает ли `hermes acp` project-level `.mcp.json` из cwd — если нет,
  manager-тулы для hermes-чатов ассистента передавать через `mcpServers`
  в `session/new` (наш адаптер уже знает workspace ассистента).
- Пермишн-маппинг ACP permission requests → наш approval-флоу: взять у
  Cursor как есть, проверить на первом же destructive-туле.
- TextGeneration: опционально, в v1 не делаем.

## Definition of done

Пикер: «Hermes» с моделями из гейтвея → чат ассистента на Hermes → он
вызывает uno-manager тулы → спавнит тред → hot-swap Hermes↔Claude в том же
чате без потери файловой памяти.
