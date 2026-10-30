/**
 * T3 v2 compat: serving a `/ws` upgrade that asked for orchestration
 * protocol 2 (the store T3 Code phone app: `?orchestrationProtocol=2`).
 *
 * ws.ts calls `isOrchestrationV2Upgrade` and, when true, hands the socket to
 * `serveOrchestrationV2Socket` — that is the only fork in shared code. Our own
 * web never sends the parameter, so its sockets never reach this file.
 */
import { Effect, Layer, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { RpcServer } from "effect/unstable/rpc";

// @effect-diagnostics-next-line anyUnknownInErrorContext:off
import { makeV2HandlersLayer } from "./handlers.ts";
import { WsRpcGroupV2 } from "./rpcGroup.ts";
import { layerV2Serialization } from "./serialization.ts";

/** Upstream contracts/environment.ts ORCHESTRATION_PROTOCOL_QUERY_PARAM. */
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
/** Upstream contracts/environment.ts ORCHESTRATION_PROTOCOL_HEADER. */
export const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";

export function isOrchestrationV2Upgrade(request: HttpServerRequest.HttpServerRequest): boolean {
  return Option.match(HttpServerRequest.toURL(request), {
    onNone: () => false,
    onSome: (url) => url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) === "2",
  });
}

export function isOrchestrationV2HttpRequest(
  request: HttpServerRequest.HttpServerRequest,
): boolean {
  return request.headers[ORCHESTRATION_PROTOCOL_HEADER] === "2";
}

/**
 * The per-socket RPC server for a phone. `v1Handlers` is the same handlers
 * layer a web socket of this session gets (ws.ts makeWsRpcHandlersLayer):
 * phone writes reuse it in-process.
 */
export const serveOrchestrationV2Socket = <E, R>(v1Handlers: Layer.Layer<any, E, R>) =>
  Effect.gen(function* () {
    const unsupported = new Set<string>();
    const httpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroupV2, {
      spanPrefix: "ws.rpc.v2",
      spanAttributes: {
        "rpc.transport": "websocket",
        "rpc.system": "effect-rpc",
        "rpc.protocol": "t3-v2",
      },
    }).pipe(
      Effect.provide(
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off
        makeV2HandlersLayer.pipe(
          Layer.provide(v1Handlers),
          Layer.provideMerge(
            layerV2Serialization({
              onUnsupported: (method) => {
                if (unsupported.has(method)) return;
                unsupported.add(method);
                Effect.runFork(
                  Effect.logInfo("t3-v2: phone asked for a method Uno Work does not serve", {
                    method,
                  }),
                );
              },
            }),
          ),
        ),
      ),
    );
    return yield* httpEffect;
  });
