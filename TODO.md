# TODO

## Small things

- [ ] Submitting new messages should scroll to bottom
- [ ] Only show last 10 threads for a given project
- [ ] Thread archiving
- [ ] New projects should go on top
- [ ] Projects should be sorted by latest thread update

## Bigger things

- [ ] **Uno Gateway: API-фасады для чужих харнесов** (бэкенд `fishcode`, не этот репо)
  - Зачем: чтобы в треде Claude Code или Codex можно было переключиться на модель из нашего Gateway (Kimi, DeepSeek, Qwen…) — например когда кончились лимиты подписки — не меняя харнес и не теряя тред.
  - Сейчас Gateway отдаёт только `POST /v1/chat/completions`. Этого хватает OpenCode, Hermes и Uno, но не хватает двум главным:
    - [ ] `POST /v1/messages` — Anthropic Messages API. Нужен Claude Code (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`). Транслировать: system, content blocks, `tool_use`/`tool_result`, SSE-стриминг, `stop_reason`, `usage`.
    - [ ] `POST /v1/responses` — OpenAI Responses API. Нужен Codex CLI: в 0.144.1 `wire_api = "chat"` больше не поддерживается («How to fix: set `wire_api = "responses"`»), проверено по бинарю. Транслировать: `input`/`output` items, `reasoning`, `function_call`, свой формат SSE.
  - Оба — фасады над существующим `/v1/chat/completions`, поэтому каталог моделей, биллинг и лимиты переиспользуются. Побочная выгода: становимся drop-in заменой для любого клиента, который умеет только Anthropic или только Responses.
  - Продуктовая часть (настройки харнеса, группы в пикере, тост «лимит исчерпан → switch model») и полный дизайн: `~/uno-project/knowledge/uno-work-gateway-models-in-harnesses.md`.

- [ ] Queueing messages
- [ ] Browser pane performance hardening
  - Проблема: сам bridge/кнопка браузера почти бесплатны, но каждая открытая browser-вкладка в preview pane — это Electron `<webview>` guest renderer. Несколько живых вкладок с тяжёлыми сайтами могут давить на память/CPU и ухудшать отзывчивость всего desktop app.
  - Лимиты: ввести soft limit на количество browser-вкладок (например 5) и hard limit (например 8-10). При превышении показывать пользователю выбор: закрыть старые вкладки, открыть во внешнем браузере или заменить least-recently-used вкладку.
  - Inactive discard: для неактивных browser-вкладок старше N минут сохранять URL/title/history-state минимум как URL, размонтировать `<webview>`, а при возврате восстанавливать с явным индикатором reload. Для вкладок с формами/несохранённым состоянием не discard'ить без подтверждения.
  - Preview close policy: настройка/поведение "закрыть browser tabs при закрытии preview pane" или "оставить вкладки живыми". По умолчанию можно оставлять состояние, но показывать счётчик живых browser tabs и кнопку "Close all browser tabs".
  - Lazy mount: не создавать `<webview>` для новой пустой вкладки до первой навигации; при восстановлении проекта не монтировать все browser tabs сразу, только активную.
  - Resource telemetry: добавить dev-only счётчики количества webview, активных/скрытых вкладок, примерного memory footprint через Electron APIs, duration навигации и число bridge-команд. Логи нужны для сравнения dev/prod.
  - Back-pressure для автоматизации: не принимать параллельные browser automation команды в одну вкладку без очереди; throttle screenshot/evaluate/capturePage, потому что они дорогие.
  - UX guardrails: если вкладка фоном долго грузится или часто шлёт navigation/title events, помечать её как busy и предлагать остановить/закрыть.
  - Acceptance: обычный чат с закрытым preview не должен монтировать `<webview>`; 300-model picker и чат-скролл должны оставаться плавными при закрытом браузере; с 5 открытыми вкладками UI должен деградировать предсказуемо, без фризов.
- [ ] Video attachments (видео-вложения для любой LLM)
  - Проблема: Gateway на бэке говорит на OpenAI-совместимом формате (OpenRouter). В этой схеме нет типа `video` и нет механизма загрузки большого файла — поэтому видео не проходит ни в одну модель, даже в Gemini, который технически умеет нативное видео.
  - Решение (универсальное, делать первым): препроцессинг-слой в Gateway. Видео → кадры (`ffmpeg`, умное семплирование по сменам сцены, а не 1 fps — иначе разоримся на токенах) + звук → транскрипт с таймкодами (Whisper локально). Собрать в обычное мультимодальное сообщение (кадры как `image_url` + текст) и отправить штатным каналом в любую vision-модель (Claude, GPT, Qwen…). Лоссово (движение/жесты курсора между кадрами теряются), но работает везде.
  - Fast-path (делать вторым, под максимальную точность): для Gemini обходить OpenAI-слой и звать родной Google API (File API + `generateContent`) с видеофайлом как есть.
  - Главная инженерная задача — умное семплирование кадров и бюджет токенов. Ложится в ту же архитектуру, что план веб-поиска (Electron-мост → эндпоинт на Gateway).
  - Юзкейс-драйвер: запись скринкаста UI-ревью (вожу курсором по зонам + голосом описываю правки) → спека для агента в рабочей среде. Привязывать правки к видимым на экране надписям (грепабельный ключ между «глазами» и кодом).
