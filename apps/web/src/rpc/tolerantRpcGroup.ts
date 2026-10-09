/**
 * Stream items this interface does not understand are skipped, not fatal.
 *
 * The interface and the daemon can be different versions (desktop app older
 * than a cloud computer, a canary daemon, "one window" where the interface
 * comes from our address). Every RPC union is closed, and effect's client
 * decodes a stream chunk as one NonEmptyArray: a single event of a type this
 * bundle has never heard of used to fail the whole chunk and end the stream
 * (orchestration shell/thread, lifecycle, inbox …) — then it resubscribed,
 * got the same event and died again.
 *
 * Here every stream's item schema becomes `Union([Known, UnknownStreamItem])`:
 * a known item decodes as before (first member, same cost); anything else
 * decodes to an `UnknownStreamItem` marker that WsTransport logs once per
 * kind and drops. The projection only applies events with a higher sequence
 * (no gap detection), so dropping one is safe.
 */
import { Effect, Schema, SchemaTransformation } from "effect";
import { type Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc";

export const UNKNOWN_STREAM_ITEM_TAG = "UnknownStreamItem" as const;

const UnknownStreamItemSchema = Schema.Struct({
  _tag: Schema.Literal(UNKNOWN_STREAM_ITEM_TAG),
  /** `kind` of the item (shell/thread stream items), when it has one. */
  kind: Schema.NullOr(Schema.String),
  /** `type` of the item or of its `event` (orchestration events, lifecycle). */
  type: Schema.NullOr(Schema.String),
});
export type UnknownStreamItem = typeof UnknownStreamItemSchema.Type;

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
}

export function describeUnknownStreamItem(raw: unknown): UnknownStreamItem {
  const event =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["event"] : null;
  return {
    _tag: UNKNOWN_STREAM_ITEM_TAG,
    kind: stringField(raw, "kind"),
    type: stringField(event, "type") ?? stringField(raw, "type"),
  };
}

/** Anything at all → the marker. Only ever reached after the known schema failed. */
const UnknownStreamItemFromAny = Schema.Unknown.pipe(
  Schema.decodeTo(
    UnknownStreamItemSchema,
    SchemaTransformation.transform({
      decode: (raw) => describeUnknownStreamItem(raw),
      encode: (item) => item,
    }),
  ),
);

export function tolerantStreamItem<S extends Schema.Top>(schema: S) {
  return Schema.Union([schema, UnknownStreamItemFromAny]);
}

export function isUnknownStreamItem(value: unknown): value is UnknownStreamItem {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly _tag?: unknown })._tag === UNKNOWN_STREAM_ITEM_TAG
  );
}

/**
 * The same group with every stream RPC's item schema made tolerant. Payloads,
 * errors, unary results, middleware and annotations stay as they are. Typed as
 * the input group on purpose: the marker never leaves WsTransport.
 */
export function makeTolerantStreamsRpcGroup<G extends RpcGroup.Any>(group: G): G {
  const rpcs: Array<Rpc.Any> = [];
  const requests = (group as unknown as { readonly requests: ReadonlyMap<string, unknown> })
    .requests;
  for (const rpc of requests.values()) {
    const props = rpc as Rpc.AnyWithProps & { setSuccess(schema: Schema.Top): Rpc.Any };
    const success = props.successSchema;
    rpcs.push(
      RpcSchema.isStreamSchema(success)
        ? props.setSuccess(RpcSchema.Stream(tolerantStreamItem(success.success), success.error))
        : (rpc as Rpc.Any),
    );
  }
  return RpcGroup.make(...rpcs) as unknown as G;
}

/** Decode one item the way the client does (tests). */
export function decodeStreamItemForTest<S extends Schema.Top>(schema: S, raw: unknown) {
  return Schema.decodeUnknownEffect(Schema.toCodecJson(tolerantStreamItem(schema)))(raw).pipe(
    Effect.orDie,
  );
}
