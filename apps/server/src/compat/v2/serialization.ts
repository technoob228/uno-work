import { Layer } from "effect";
import { RpcSerialization } from "effect/unstable/rpc";

import { jsonMobileCompat } from "../rpcSerializationMobileCompat.ts";
import { isUpstreamSubscriptionTag, V2_KNOWN_TAGS, V2_METHODS } from "./rpcGroup.ts";

/**
 * T3 v2 compat: the mobile-compat JSON serialization (numeric request ids of
 * the upstream client) plus one more rule for v2 sockets: a request for a
 * method we do not serve is rerouted instead of reaching RpcServer, which
 * would answer an unknown tag with a connection-wide Defect and drop the
 * phone's whole session. The request id stays, so the phone gets its answer
 * on that request only:
 *  - subscriptions → `uno.v2.silentStream` (empty, never ends);
 *  - everything else → `uno.v2.unsupported` (fails with a tagged error).
 * Rerouted method names are counted per socket (`onUnsupported`) so the smoke
 * can list what the phone asked for that we do not answer.
 */
export function makeV2Serialization(options?: {
  readonly onUnsupported?: (method: string) => void;
}) {
  return RpcSerialization.RpcSerialization.of({
    contentType: jsonMobileCompat.contentType,
    includesFraming: jsonMobileCompat.includesFraming,
    makeUnsafe: () => {
      const inner = jsonMobileCompat.makeUnsafe();
      const reroute = (message: unknown): unknown => {
        if (message === null || typeof message !== "object") return message;
        const frame = message as { _tag?: unknown; tag?: unknown };
        if (frame._tag !== "Request" || typeof frame.tag !== "string") return message;
        if (V2_KNOWN_TAGS.has(frame.tag)) return message;
        const method = frame.tag;
        options?.onUnsupported?.(method);
        return {
          ...frame,
          tag: isUpstreamSubscriptionTag(method) ? V2_METHODS.silentStream : V2_METHODS.unsupported,
          payload: { method },
        };
      };
      return {
        decode: (bytes) => inner.decode(bytes).map(reroute),
        encode: (response) => inner.encode(response),
      };
    },
  });
}

export const layerV2Serialization = (options?: {
  readonly onUnsupported?: (method: string) => void;
}) => Layer.succeed(RpcSerialization.RpcSerialization, makeV2Serialization(options));
