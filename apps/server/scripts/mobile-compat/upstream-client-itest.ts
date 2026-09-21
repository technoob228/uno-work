// @ts-nocheck — файл запускается из checkout'а АПСТРИМА (их contracts +
// effect rc.115, см. README.md рядом); под нашим tsconfig имена экспортов
// другие, поэтому наш typecheck этот файл не проверяет.
/**
 * Интеграционный тест mobile-compat шима Uno Work.
 *
 * Роль «мобилки»: этот скрипт использует АПСТРИМНЫЙ клиентский стек
 * (packages/contracts + effect rc.115 + RpcClient поверх WebSocket — ровно
 * то, что бандлится в мобильное приложение T3 Code) и подключается к НАШЕМУ
 * демону-форку (effect beta.59) через шим-слой.
 *
 * Путь direct-подключения мобилки:
 *   descriptor → /oauth/token → /api/auth/session → /api/auth/websocket-ticket
 *   → WS /ws?wsTicket=… → subscribeServerConfig → subscribeShell →
 *   server.probe → dispatchCommand(thread.create) → subscribeThread →
 *   dispatchCommand(thread.turn.start "написать в чат").
 */
import {
  AuthAccessTokenResult,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ExecutionEnvironmentDescriptor,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { randomUUID } from "node:crypto";

const BASE = process.env.SHIM_BASE ?? "http://127.0.0.1:13791";
// Принимаем либо голый credential (SHIM_PAIRING), либо готовую мобильную
// ссылку из `auth pairing create --base-url … --qr` (SHIM_PAIR_URL) — её
// разбираем так же, как мобилка: токен из hash первым, потом query.
const PAIRING =
  process.env.SHIM_PAIRING ??
  (() => {
    const pairUrl = process.env.SHIM_PAIR_URL;
    if (!pairUrl) return undefined;
    const parsed = new URL(pairUrl);
    return (
      new URLSearchParams(parsed.hash.slice(1)).get("token") ??
      parsed.searchParams.get("token") ??
      undefined
    );
  })();
if (!PAIRING) throw new Error("SHIM_PAIRING credential or SHIM_PAIR_URL pair link is required");

const log = (step: string, detail: unknown) =>
  console.log(`[itest] ${step}:`, typeof detail === "string" ? detail : JSON.stringify(detail));

// HTTP-ответы декодируем json-кодеком схемы — так же поступает апстримный
// HttpApi-клиент (Schema.toCodecJson под капотом HttpApiClient).
const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema));

// ---------- HTTP (запросы в точности как у апстримного connection driver,
// ---------- ответы декодируются АПСТРИМНЫМИ схемами contracts) ----------

const descriptorRaw = await (await fetch(`${BASE}/.well-known/t3/environment`)).json();
const descriptor = decodeJson(ExecutionEnvironmentDescriptor)(descriptorRaw);
log("descriptor", {
  environmentId: descriptor.environmentId,
  serverVersion: descriptor.serverVersion,
  protocolVersion: (descriptorRaw as { orchestrationProtocolVersion?: number })
    .orchestrationProtocolVersion ?? 1,
});

const tokenRes = await fetch(`${BASE}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: PAIRING,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    client_label: "T3 Mobile (itest)",
    client_device_type: "phone",
    client_os: "ios",
  }),
});
if (!tokenRes.ok) throw new Error(`oauth/token failed: ${tokenRes.status} ${await tokenRes.text()}`);
const token = decodeJson(AuthAccessTokenResult)(await tokenRes.json());
log("oauth/token", {
  token_type: token.token_type,
  expires_in: token.expires_in,
  scope: token.scope,
});

const auth = { authorization: `Bearer ${token.access_token}` };

const session = decodeJson(AuthSessionState)(
  await (await fetch(`${BASE}/api/auth/session`, { headers: auth })).json(),
);
log("session", { authenticated: session.authenticated, scopes: session.scopes });

const ticket = decodeJson(AuthWebSocketTicketResult)(
  await (
    await fetch(`${BASE}/api/auth/websocket-ticket`, { method: "POST", headers: auth })
  ).json(),
);
log("websocket-ticket", { ticket: `${ticket.ticket.slice(0, 16)}…` });

const shellHttp = await (await fetch(`${BASE}/api/orchestration/shell`, { headers: auth })).json();
log("GET /api/orchestration/shell", {
  snapshotSequence: (shellHttp as { snapshotSequence: number }).snapshotSequence,
  projects: (shellHttp as { projects: unknown[] }).projects.length,
  threads: (shellHttp as { threads: unknown[] }).threads.length,
});

// ---------- WS: апстримный RpcClient + WsRpcGroup ----------

const wsUrl =
  `${BASE.replace("http", "ws")}/ws?wsTicket=${encodeURIComponent(ticket.ticket)}` +
  `&orchestrationProtocol=1&clientSurface=mobile&clientDeviceType=phone` +
  `&connectionMethod=direct&clientOs=ios&clientAppVersion=0.0.42`;

const socketLayer = Socket.layerWebSocket(wsUrl, { openTimeout: "15 seconds" }).pipe(
  Layer.provide(Layer.succeed(Socket.WebSocketConstructor, (url, protocols) =>
    new globalThis.WebSocket(url, protocols),
  )),
);
const protocolLayer = Layer.effect(
  RpcClient.Protocol,
  RpcClient.makeProtocolSocket({
    retryTransientErrors: false,
    retryPolicy: Schedule.recurs(0),
  }),
).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup, { flatten: false });

  // 1. subscribeServerConfig — первый RPC настоящей мобилки после коннекта.
  const configEvents = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
    Stream.take(1),
    Stream.runCollect,
  );
  const first = configEvents[0];
  if (first.type !== "snapshot") throw new Error(`expected snapshot, got ${first.type}`);
  log("ws subscribeServerConfig", {
    environmentId: first.config.environment.environmentId,
    matchesDescriptor: first.config.environment.environmentId === descriptor.environmentId,
    serverVersion: first.config.environment.serverVersion,
    capabilities: first.config.environment.capabilities,
  });

  // 2. server.probe — liveness, как у их RpcSession.probe.
  yield* client[WS_METHODS.serverProbe]({});
  log("ws server.probe", "ok");

  // 3. Домашний экран: orchestration.subscribeShell (payload с полями,
  //    которые шлёт свежий апстрим).
  const shellItems = yield* client["orchestration.subscribeShell"]({} as never).pipe(
    Stream.take(1),
    Stream.runCollect,
  );
  const shellFirst = shellItems[0] as { kind: string; snapshot?: { projects: unknown[]; threads: unknown[] } };
  log("ws orchestration.subscribeShell", {
    kind: shellFirst.kind,
    projects: shellFirst.snapshot?.projects.length,
    threads: shellFirst.snapshot?.threads.length,
  });
  const project = (shellFirst.snapshot?.projects as Array<{ id: string; title: string; defaultModelSelection: unknown }>)[0];
  if (!project) throw new Error("no project in shell snapshot");

  // 4. Создание треда — как «＋» в мобилке.
  const threadId = randomUUID();
  const dispatch = (command: Record<string, unknown>) =>
    client["orchestration.dispatchCommand"](command as never);
  const createResult = yield* dispatch({
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId: project.id,
    title: "Mobile shim itest",
    modelSelection: project.defaultModelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  log("ws dispatch thread.create", createResult);

  // 5. Открытие треда: subscribeThread — первый item должен быть snapshot.
  const threadItems = yield* client["orchestration.subscribeThread"]({ threadId } as never).pipe(
    Stream.take(1),
    Stream.runCollect,
  );
  const threadFirst = threadItems[0] as { kind: string; snapshot?: { thread: { id: string; title: string } } };
  log("ws orchestration.subscribeThread", {
    kind: threadFirst.kind,
    threadId: threadFirst.snapshot?.thread.id,
    title: threadFirst.snapshot?.thread.title,
  });

  // 6. «Написать в чат»: thread.turn.start c пользовательским сообщением.
  const turnResult = yield* dispatch({
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: {
      messageId: randomUUID(),
      role: "user",
      text: "Привет из апстримной мобилки через шим!",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  log("ws dispatch thread.turn.start", turnResult);

  // 7. Стрим ответа: читаем события треда после отправки.
  const followUp = yield* client["orchestration.subscribeThread"]({ threadId } as never).pipe(
    Stream.take(3),
    Stream.runCollect,
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.succeed([] as unknown[])),
  );
  log(
    "ws thread events after turn.start",
    (followUp as Array<{ kind: string; snapshot?: { thread?: { session?: unknown } }; event?: { type?: string } }>).map(
      (item) => item.kind + (item.event ? `:${item.event.type}` : ""),
    ),
  );

  log("RESULT", "OK — апстримный клиент видит треды и пишет в чат через шим");
});

await Effect.runPromise(program.pipe(Effect.provide(protocolLayer), Effect.scoped));
process.exit(0);
