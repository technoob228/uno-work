/**
 * T3 v2 compat: the RPC group a socket with `?orchestrationProtocol=2` gets.
 *
 * Method names are upstream's (packages/contracts/src/rpc.ts +
 * ORCHESTRATION_V2_WS_METHODS); schemas are loose on purpose — payloads are
 * checked in the handlers, successes are JSON we build in mapShell / mapThread,
 * errors are upstream-shaped tagged objects. This keeps us off upstream's
 * 4000 lines of v2 schemas (and their effect version); the contract smoke
 * decodes every frame with the real upstream decoders.
 *
 * Any other upstream method is rerouted by the serialization
 * (serialization.ts) to `uno.v2.unsupported` (one failed request, socket
 * stays up) or, for subscriptions, to `uno.v2.silentStream` (an empty stream
 * that never ends: the screen shows nothing instead of an error).
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const V2_METHODS = {
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  dispatchCommand: "orchestration.dispatchCommand",
  launchThread: "orchestration.launchThread",
  getThreadProjection: "orchestration.getThreadProjection",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  unsupported: "uno.v2.unsupported",
  silentStream: "uno.v2.silentStream",
} as const;

const unary = <const Tag extends string>(tag: Tag) =>
  Rpc.make(tag, { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown });

const stream = <const Tag extends string>(tag: Tag) =>
  Rpc.make(tag, {
    payload: Schema.Unknown,
    success: Schema.Unknown,
    error: Schema.Unknown,
    stream: true,
  });

export const WsRpcGroupV2 = RpcGroup.make(
  unary(V2_METHODS.serverProbe),
  unary(V2_METHODS.serverGetConfig),
  stream(V2_METHODS.subscribeServerConfig),
  stream(V2_METHODS.subscribeServerLifecycle),
  stream(V2_METHODS.subscribeAuthAccess),
  unary(V2_METHODS.dispatchCommand),
  unary(V2_METHODS.launchThread),
  unary(V2_METHODS.getThreadProjection),
  unary(V2_METHODS.getArchivedShellSnapshot),
  stream(V2_METHODS.subscribeShell),
  stream(V2_METHODS.subscribeThread),
  unary(V2_METHODS.unsupported),
  stream(V2_METHODS.silentStream),
);

export const V2_KNOWN_TAGS: ReadonlySet<string> = new Set(Object.values(V2_METHODS));

/** Upstream subscriptions are named subscribe… / ….subscribe / …Subscribe…. */
export function isUpstreamSubscriptionTag(tag: string): boolean {
  return /(^|\.)subscribe|Subscribe/.test(tag);
}

/** Upstream `EnvironmentAuthorizationError`: every upstream RPC's error union
 *  carries it (RpcScopeAuthorization middleware), so the phone decodes it as a
 *  plain failure of that one request. */
export function v2UnsupportedError(method: string) {
  return {
    _tag: "EnvironmentAuthorizationError" as const,
    message: `Uno Work doesn't support ${method} from the phone yet.`,
    requiredScope: "orchestration:operate",
  };
}
