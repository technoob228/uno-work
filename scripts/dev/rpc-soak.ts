/**
 * rpc-soak: soak harness for the effect RpcClient WebSocket protocol over a bad link.
 *
 * Runs a FAKE RPC server (Bun.serve + websocket, effect JSON wire protocol) and the REAL
 * effect `RpcClient.makeProtocolSocket` through `lossy-proxy.ts`, and counts reconnects,
 * ping timeouts, stream failures and "stalled stream" episodes. Depends only on `effect`
 * (plain `effect/...` specifiers) so it can run from an isolated copy of the effect package:
 *
 *   cd /tmp/uno-net-soak/after && nice -n 19 bun rpc-soak.ts --duration-s 480 \
 *     --proxy-script /path/to/lossy-proxy.ts [--proxy-args "--delay-ms 300 --seed 1"] [--no-proxy] [--port N]
 *
 * Output: one JSON line per event on stdout, and a final {"event":"summary",...} line.
 *
 * Wire format (RpcSerialization.layerJson): one JSON message (or array) per WS text frame.
 *   client -> server: {_tag:"Ping"} | {_tag:"Request",id,tag:"Feed",payload,headers,...}
 *                     | {_tag:"Ack",requestId} | {_tag:"Interrupt",requestId}
 *   server -> client: {_tag:"Pong"} | {_tag:"Chunk",requestId,values:[...]} | {_tag:"Exit",requestId,exit}
 *
 * "stalledStream" episode: current socket open > 20 s, the subscription received nothing for
 * > 20 s, and the server sent something to the client after the last received chunk.
 * "silentSubscription" is the same without the server-sent condition (catches a subscription
 * that was silently orphaned on a reconnect: new socket, server never saw the Feed request).
 */
import { spawn, serve, type ServerWebSocket } from "bun";
import { parseArgs } from "node:util";
import { Duration, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

// `--proxy-args "--delay-ms 1"` has a dash-prefixed value, which parseArgs rejects unless written `--proxy-args=...`.
const argv = Bun.argv
  .slice(2)
  .flatMap((a, i, all) =>
    all[i - 1] === "--proxy-args"
      ? []
      : a === "--proxy-args"
        ? [`--proxy-args=${all[i + 1] ?? ""}`]
        : [a],
  );
const { values: flags } = parseArgs({
  args: argv,
  options: {
    "duration-s": { type: "string", default: "480" },
    "proxy-args": { type: "string", default: "" },
    "proxy-script": {
      type: "string",
      default: new URL("./lossy-proxy.ts", import.meta.url).pathname,
    },
    "no-proxy": { type: "boolean", default: false },
    port: { type: "string", default: "0" },
  },
});
const durationS = Number(flags["duration-s"]);
const STALL_THRESHOLD_MS = 20_000;

// ---------------------------------------------------------------- metrics
const t0 = Date.now();
const stats = {
  socketsConstructed: 0,
  opens: 0,
  closes: 0,
  closeCodes: {} as Record<string, number>,
  hookConnects: 0,
  hookDisconnects: 0,
  pings: 0,
  pongs: 0,
  pingTimeouts: 0,
  subscriptions: 0,
  streamFailures: 0,
  streamEnds: 0,
  resubscribes: 0,
  chunks: 0,
  largeSnapshots: 0,
  stalledStream: { episodes: 0, totalSeconds: 0 },
  silentSubscription: { episodes: 0, totalSeconds: 0 },
  proxyStalls: 0,
  serverConnections: 0,
};
const emit = (event: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, t: +((Date.now() - t0) / 1000).toFixed(2), ...extra }));

// ---------------------------------------------------------------- fake server
let serverLastSendAt = 0;
const SMALL_EVERY_MS = 2_000;
const LARGE_EVERY_MS = 60_000;
const largeValue = (() => {
  const piece = Buffer.from(
    Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256)),
  ).toString("base64");
  return {
    kind: "snapshot",
    data: piece.repeat(Math.ceil(1_500_000 / piece.length)).slice(0, 1_500_000),
  };
})();
const largeFrame = (requestId: string) =>
  JSON.stringify({ _tag: "Chunk", requestId, values: [largeValue] });

type ConnState = { timers: Array<ReturnType<typeof setInterval>> };
const server = serve<ConnState>({
  hostname: "127.0.0.1",
  port: Number(flags.port),
  fetch: (req, srv) =>
    srv.upgrade(req, { data: { timers: [] } })
      ? undefined
      : new Response("ws only", { status: 426 }),
  websocket: {
    idleTimeout: 0,
    sendPings: false,
    open: () => {
      stats.serverConnections++;
    },
    message: (ws: ServerWebSocket<ConnState>, raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
      } catch {
        return;
      }
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
        if (msg?._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
        else if (msg?._tag === "Request" && msg.tag === "Feed") startFeed(ws, String(msg.id));
        // Ack / Interrupt / Eof: ignored (per-connection state only; timers die with the socket)
      }
    },
    close: (ws) => {
      for (const t of ws.data.timers) clearInterval(t);
      ws.data.timers.length = 0;
    },
  },
});
const send = (ws: ServerWebSocket<ConnState>, frame: string) => {
  serverLastSendAt = Date.now();
  ws.send(frame);
};
function startFeed(ws: ServerWebSocket<ConnState>, requestId: string) {
  let seq = 0;
  send(ws, largeFrame(requestId));
  ws.data.timers.push(
    setInterval(
      () =>
        send(
          ws,
          JSON.stringify({
            _tag: "Chunk",
            requestId,
            values: [{ kind: "event", seq: seq++, at: Date.now() }],
          }),
        ),
      SMALL_EVERY_MS,
    ),
    setInterval(() => send(ws, largeFrame(requestId)), LARGE_EVERY_MS),
  );
}

// ---------------------------------------------------------------- proxy child
const decoder = new TextDecoder();
let proxyProc: ReturnType<typeof spawn> | undefined;
const startProxy = (targetPort: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const args = [
      "--target",
      `127.0.0.1:${targetPort}`,
      ...flags["proxy-args"]!.split(/\s+/).filter(Boolean),
    ];
    proxyProc = spawn([process.execPath, flags["proxy-script"]!, ...args], {
      stdout: "pipe",
      stderr: "inherit",
    });
    let buf = "";
    let resolved = false;
    (async () => {
      for await (const chunk of proxyProc!.stdout as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const ev = JSON.parse(line);
            if (ev.event === "listening" && !resolved) {
              resolved = true;
              resolve(ev.port);
            }
            if (ev.event === "stall_start") stats.proxyStalls++;
            const { event, t: _t, ...rest } = ev;
            emit(`proxy_${event}`, rest);
          } catch {
            emit("proxy_output", { line });
          }
        }
      }
      if (!resolved) reject(new Error("proxy exited before listening"));
    })();
  });

// ---------------------------------------------------------------- client
// Subscription / socket state used by the stall detector.
let socketOpenAt: number | undefined; // set while a socket is open
let subscribedAt = 0;
let lastChunkAt = 0;
type Episode = { startedAt: number; silentSince: number } | undefined;
let stalledEp: Episode;
let silentEp: Episode;

const endEpisodes = (why: string) => {
  const now = Date.now();
  for (const [name, ep, bucket] of [
    ["stalledStream", stalledEp, stats.stalledStream],
    ["silentSubscription", silentEp, stats.silentSubscription],
  ] as const) {
    if (!ep) continue;
    const s = (now - ep.startedAt) / 1000;
    bucket.totalSeconds = +(bucket.totalSeconds + s).toFixed(2);
    emit(`${name}_end`, {
      why,
      stalledS: +s.toFixed(1),
      silentS: +((now - ep.silentSince) / 1000).toFixed(1),
    });
  }
  stalledEp = silentEp = undefined;
};
const checkStall = () => {
  if (socketOpenAt === undefined) return;
  const now = Date.now();
  const ref = Math.max(lastChunkAt, subscribedAt);
  const silent = now - ref > STALL_THRESHOLD_MS && now - socketOpenAt > STALL_THRESHOLD_MS;
  if (silent && !silentEp) {
    silentEp = { startedAt: now, silentSince: ref };
    stats.silentSubscription.episodes++;
    emit("silentSubscription_start", { silentS: +((now - ref) / 1000).toFixed(1) });
  }
  if (silent && serverLastSendAt > ref && !stalledEp) {
    stalledEp = { startedAt: now, silentSince: ref };
    stats.stalledStream.episodes++;
    emit("stalledStream_start", { silentS: +((now - ref) / 1000).toFixed(1) });
  }
};

const FeedGroup = RpcGroup.make(Rpc.make("Feed", { success: Schema.Unknown, stream: true }));

const makeProgram = (url: string) => {
  const WsCtor = Layer.succeed(Socket.WebSocketConstructor)((u, protocols) => {
    const id = ++stats.socketsConstructed;
    emit("ws_construct", { id });
    const ws = new globalThis.WebSocket(u, protocols);
    ws.addEventListener("open", () => {
      stats.opens++;
      socketOpenAt = Date.now();
      emit("ws_open", { id });
    });
    ws.addEventListener("close", (e) => {
      stats.closes++;
      const k = String(e.code);
      stats.closeCodes[k] = (stats.closeCodes[k] ?? 0) + 1;
      socketOpenAt = undefined;
      emit("ws_close", { id, code: e.code, reason: e.reason });
    });
    return ws;
  });
  const log = (name: string, update: () => void) =>
    Effect.sync(() => {
      update();
      emit(name);
    });
  const Hooks = Layer.succeed(RpcClient.ConnectionHooks)({
    onConnect: log("hook_connect", () => stats.hookConnects++),
    onDisconnect: log("hook_disconnect", () => stats.hookDisconnects++),
    onPing: log("hook_ping", () => stats.pings++),
    onPong: log("hook_pong", () => stats.pongs++),
    onPingTimeout: log("hook_ping_timeout", () => stats.pingTimeouts++),
  });
  // `heartbeat` is only understood by the patched build; the unpatched one ignores it.
  const protocolOptions = {
    retryTransientErrors: true,
    retryPolicy: Schedule.spaced("1 second"),
    heartbeat: { intervalMs: 10_000, maxSilentIntervals: 3 },
  } as Parameters<typeof RpcClient.layerProtocolSocket>[0];
  const Protocol = RpcClient.layerProtocolSocket(protocolOptions).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(url).pipe(Layer.provide(WsCtor)),
        RpcSerialization.layerJson,
        Hooks,
      ),
    ),
  );

  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FeedGroup);
    const consume = Effect.suspend(() => {
      stats.subscriptions++;
      subscribedAt = Date.now();
      endEpisodes("resubscribe");
      emit("subscribe", { n: stats.subscriptions });
      return client.Feed().pipe(
        Stream.runForEach((value) =>
          Effect.sync(() => {
            lastChunkAt = Date.now();
            stats.chunks++;
            if ((value as { kind?: string } | undefined)?.kind === "snapshot") {
              stats.largeSnapshots++;
              emit("snapshot", { n: stats.largeSnapshots });
            }
            endEpisodes("chunk");
          }),
        ),
        Effect.matchCause({
          onFailure: (cause) => {
            stats.streamFailures++;
            emit("stream_failure", { cause: String(cause).slice(0, 200) });
          },
          onSuccess: () => {
            stats.streamEnds++;
            emit("stream_end");
          },
        }),
      );
    });
    yield* consume.pipe(
      Effect.andThen(Effect.sync(() => void stats.resubscribes++)),
      Effect.andThen(Effect.sleep("250 millis")),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.sync(checkStall).pipe(
      Effect.andThen(Effect.sleep("1 second")),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Effect.sleep(Duration.seconds(durationS));
  }).pipe(Effect.scoped, Effect.provide(Protocol));
};

// ---------------------------------------------------------------- main
let finished = false;
const finish = (code = 0) => {
  if (finished) return;
  finished = true;
  endEpisodes("end_of_run");
  emit("summary", {
    durationS: +((Date.now() - t0) / 1000).toFixed(1),
    noProxy: flags["no-proxy"],
    stats,
  });
  proxyProc?.kill("SIGTERM");
  server.stop(true);
  setTimeout(() => process.exit(code), 300);
};
process.on("SIGINT", () => finish(130));
process.on("SIGTERM", () => finish(143));

const main = async () => {
  const serverPort = server.port as number;
  const port = flags["no-proxy"] ? serverPort : await startProxy(serverPort);
  const url = `ws://127.0.0.1:${port}/`;
  emit("start", { url, serverPort, proxy: !flags["no-proxy"], durationS });
  await Effect.runPromise(makeProgram(url));
};
main().then(
  () => finish(0),
  (error) => {
    emit("fatal", { error: String(error) });
    finish(1);
  },
);
