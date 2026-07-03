# HermesDriver — план (риски сняты пробами 2026-07-04; РЕАЛИЗОВАН 2026-07-04)

> Статус: драйвер реализован (`Drivers/HermesDriver.ts`, `Layers/HermesAdapter.ts`,
> `Layers/HermesProvider.ts`, `acp/HermesAcpSupport.ts`). Ниже — план + две
> грабли, найденные на реализации (секция «Найдено на реализации»).

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

## Найдено на реализации (2026-07-04, вторая волна проб)

1. **Угон провайдера в openrouter.** `session/set_model` с `openai-api:<model>`
   при УЖЕ активном openai-api гонит id через `detect_provider_for_model`;
   namespaced-модели (`anthropic/…`) находятся в каталоге openrouter → hermes
   пересоздаёт агента на openrouter с невалидным ключом, все turn'ы падают
   в 401. Обход: двойной вызов — `openrouter:<model>` (чистая смена, detection
   не запускается при target≠current), затем `openai-api:<model>`.
   Код: `applyHermesAcpModelSelection`.
2. **`set_model` теряет ACP-переданные MCP-серверы.** Смена модели пересоздаёт
   агента (`_make_agent`), и `enabled_toolsets` нового агента собираются
   только из config.yaml — mcpServers из `session/new` выпадают (глобальная
   регистрация остаётся, toolset-имена теряются). Обход: per-thread
   `HERMES_HOME=<stateDir>/hermes-home-<instanceId>/threads/<threadId>` с
   config.yaml, куда адаптер пишет `model.default/provider` и `mcp_servers`
   из project-level `.mcp.json` — toolsets переживают любой rebuild, заодно
   начальный set_model не нужен, а state.db не делится между конкурентными
   hermes-процессами. Код: `buildHermesConfigYaml` + startSession.
3. **Каталог моделей.** С `openai-api` hermes отдаёт в `session/new` живой
   `/v1/models` гейтвея verbatim — 1000+ моделей (весь апстрим). Пикер
   строится не из ACP-ответа, а из каталога Uno Gateway (тот же фетч, что у
   UnoDriver: tier/pricing/modalities), отфильтрованного до agentic-вендоров
   (`isHermesPickerModel`).
4. **Режимы/опции.** configOptions всегда пуст; modes — ровно три
   edit-approval политики (default / accept_edits / dont_ask), plan-режима
   нет (`showInteractionModeToggle: false`). Маппинг: `full-access` →
   dont_ask, иначе default. Отдельные optionDescriptors в v1 не заведены
   (кандидат: select «Edit approval» c accept_edits — решение за Михаилом).

## Definition of done

Пикер: «Hermes» с моделями из гейтвея → чат ассистента на Hermes → он
вызывает uno-manager тулы → спавнит тред → hot-swap Hermes↔Claude в том же
чате без потери файловой памяти.
