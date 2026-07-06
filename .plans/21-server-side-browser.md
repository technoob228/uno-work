# 21 — Server-side browser: headless-исполнитель bridge-команд

## Контекст

Харнесы общаются со встроенным браузером через bridge: `curl POST /api/browser/command`
→ сервер публикует событие в PubSub → подключённый web-клиент исполняет команду в
Electron `<webview>` → постит результат на `/api/browser/command/result`. Если ни один
клиент не подключён (headless-сервер, управление ассистентом через Telegram), команды
молча таймаутят через 30 с: у PubSub нет учёта подписчиков и нет альтернативного
исполнителя.

Цель — харнесы и ассистент ходят в браузер автономно: на сервере появляется второй
исполнитель (headless Chromium через `playwright-core`) и роутинг
`browser.executor: auto | local | server` (дефолт `auto`: клиент, если подписан, иначе
сервер). Агентам ничего менять не нужно — тот же env (`UNO_WORK_BRIDGE_URL/TOKEN`),
тот же HTTP-API, те же формы ответов.

## Фаза 1 — серверный исполнитель (реализована этим планом)

- `playwright-core` (точный пин, ленивый `await import` — отсутствие Chromium
  деградирует в per-command ошибку, не в падение сервера). Chromium ставится отдельно:
  `npx playwright install chromium` либо `UNO_WORK_BROWSER_EXECUTABLE=<путь к бинарнику>`.
- `packages/contracts/src/settings.ts`: `ServerSettings.browser`
  (`executor: auto|local|server`, `serverAutomationLevel: off|safe|full`, дефолты
  `auto`/`full`). UI нет — правится в `<stateDir>/settings.json`.
- `packages/shared/src/browserAutomationScripts.ts`: DOM-скрипты
  `click`/`clickText`/`type`, общие для webview-исполнителя и серверного — семантика
  побайтово одинакова.
- `apps/server/src/browserBridge.ts`: учёт подписчиков стрима (глобальный счётчик,
  не per-context — известное ограничение фазы 1).
- `apps/server/src/serverBrowser.ts`: сервис `ServerBrowser` — ленивый
  `launchPersistentContext` (профиль в `<stateDir>/browser-profile`), страница на каждый
  bridge-контекст (threadId/cwd), сериализация команд per-страница, финализатор убивает
  браузер вместе с рантаймом. Bun официально playwright не поддерживается — warning и
  хинт «запустите под Node» в ошибке запуска.
- `apps/server/src/browserCommandRouter.ts`: чистое решение
  `decideBrowserExecutorTarget` + `executeBridgeCommand`, читающий политику из
  `ServerSettingsService`; `off` блокирует всё (включая openUrl), `safe` — только
  `evaluate` (формулировки как у клиента).
- Роуты `/api/browser/open` и `/api/browser/command` идут через роутер;
  `/api/browser/command/result` не тронут.

## Фаза 2 — зеркалирование в панель (набросок, не реализовано)

CDP screencast: `page.context().newCDPSession(page)` → `Page.startScreencast` → JPEG-кадры
по существующему WS окружения (новый stream-метод `subscribeBrowserMirror` по образцу
`subscribeBrowserBridge` в `packages/contracts/src/rpc.ts` + `apps/server/src/ws.ts` +
`apps/web/src/rpc/wsRpcClient.ts` + `environmentApi.ts`) → рендер в `<canvas>` в правой
панели, ввод обратно через `Input.dispatchMouseEvent`/`dispatchKeyEvent`. Работает и в
hosted-версии и на телефоне (Electron не нужен) — заменяет `BrowserUnavailableFallback`.

## Фаза 3 — фикс resultUrl для клиентского исполнения (набросок, не реализовано)

Для remote-окружений `resultUrl` строится от `http://127.0.0.1:<port>` сервера — клиент
постит результат в свой собственный localhost, двусторонние команды таймаутят. Фикс:
возвращать результат через RPC окружения (новый unary-метод) вместо голого `fetch` в
`BrowserBridgeListener.postCommandResult`; fetch остаётся fallback-ом для легаси.
