# Mobile-compat: проверка шима под апстримную мобилку T3

Шим позволяет официальному мобильному клиенту T3 Code (из сторов) говорить с
нашим демоном-форком по direct-пути (LAN/self-hosted, без relay/DPoP).
Слой: `apps/server/src/compat/` + точечные правки auth/ws/contracts.

## Быстрый смоук без зависимостей (ws-probe.mjs)

Имитирует кадры апстримного rc.115-клиента (числовые request id) против
локального демона:

```bash
# 1. демон
node apps/server/src/bin.ts serve --mode web --port 13791 \
  --base-dir /tmp/uno-shim-home --no-browser /tmp/uno-shim-cwd
# 2. owner-сессия
P=$(node apps/server/src/bin.ts auth pairing create --json \
  --base-dir /tmp/uno-shim-home --role owner | jq -r .credential)
AT=$(curl -s -X POST http://127.0.0.1:13791/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data "grant_type=urn:ietf:params:oauth:grant-type:token-exchange&subject_token=$P" \
  | jq -r .access_token)
# 3. проба
AT=$AT node apps/server/scripts/mobile-compat/ws-probe.mjs
```

Ожидаемо: 0 defect-кадров, `requestId` в ответах — числа, snapshot-чанки
у subscribeServerConfig и subscribeShell.

## Пейринг живого телефона (стор-мобилка T3)

```bash
node apps/server/src/bin.ts auth pairing create \
  --base-dir <base-dir> --role owner --label "mikhail-phone" \
  --base-url https://<публичный-хост-демона> --qr
```

Печатает готовую ссылку `https://<host>/pair#token=<code>`, ASCII-QR для
сканера мобилки и строку ручного ввода (host + code). Мобилка парсит ссылку
локально (токен из hash первым, path отбрасывается — см. апстрим
`apps/mobile/src/features/connection/pairing.ts:parsePairingUrl`), страница
/pair нашей SPA при этом не открывается; QR-сканер принимает и сырую
https-ссылку (`extractPairingUrlFromQrPayload` → `return trimmed`).

## Честный интеграционный тест апстримным клиентом (upstream-client-itest.ts)

Использует АПСТРИМНЫЙ стек (их contracts + RpcClient + effect rc.115 — то,
что бандлится в мобилку). Запускается из checkout'а апстрима:

```bash
git -C ~/uno-project/uno-work-app worktree add /tmp/t3-upstream-main upstream/main --detach
cd /tmp/t3-upstream-main && pnpm install --ignore-scripts
cp <этот-файл> /tmp/t3-upstream-main/packages/client-runtime/mobile-shim-itest.ts
cd /tmp/t3-upstream-main/packages/client-runtime
SHIM_PAIRING=<pairing-credential> node mobile-shim-itest.ts
# либо готовой ссылкой из `auth pairing create --base-url … --qr`:
SHIM_PAIR_URL='https://<host>/pair#token=<code>' node mobile-shim-itest.ts
```

Проходит путь: descriptor → /oauth/token → session → websocket-ticket →
WS → subscribeServerConfig → server.probe → subscribeShell →
thread.create → subscribeThread → thread.turn.start → события треда.

## Известные границы (см. отчёт в треде координатора)

- RuntimeMode "auto" (новый у апстрима) наш сервер не знает — dispatch с ним
  упадёт валидацией; остальные режимы совпадают.
- Капабилити threadSnapshotPagination/reasoningMessages/
  shellResumeCompletionMarker не анонсируем — клиент не шлёт новые параметры.
- Relay/DPoP-контур не поддержан (шим отвечает 400 на DPoP-запрос токена).
- attachments.createUploadUrl / orchestration.searchThreads не реализованы:
  вызов любого неизвестного RPC валит WS-сессию defect-кадром — при
  необходимости добавлять заглушки по образцу server.probe в ws.ts.
