/**
 * A command this daemon does not know (sent by a newer interface — "one
 * window", or a desktop app ahead of its cloud computer) answers with a plain
 * OrchestrationDispatchCommandError "… isn't supported by this computer"
 * instead of a schema-decoding defect.
 *
 * The dispatch payload becomes `Union([ClientOrchestrationCommand,
 * UnsupportedClientCommand])`. The fallback matches only an object whose
 * `type` is a string this daemon does not know: a known command with a bad
 * field still fails decoding exactly as before, so real bugs stay loud.
 *
 * A brand-new RPC *method* is still answered by effect's RpcServer with a
 * connection-wide defect ("Unknown request tag") — clients must check a
 * capability before calling one (contracts environment.ts).
 */
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  WsRpcGroup,
} from "@t3tools/contracts";
import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { type Rpc, RpcGroup } from "effect/unstable/rpc";

import packageJson from "../package.json" with { type: "json" };

export const UNSUPPORTED_CLIENT_COMMAND_TAG = "UnsupportedClientCommand" as const;

const UnsupportedClientCommand = Schema.Struct({
  _tag: Schema.Literal(UNSUPPORTED_CLIENT_COMMAND_TAG),
  type: Schema.String,
});
export type UnsupportedClientCommand = typeof UnsupportedClientCommand.Type;

function literalTypesOf(union: unknown): ReadonlySet<string> {
  const known = new Set<string>();
  const members = (union as { readonly members?: ReadonlyArray<unknown> }).members ?? [];
  for (const member of members) {
    const literal = (
      member as { readonly fields?: { readonly type?: { readonly literal?: unknown } } }
    ).fields?.type?.literal;
    if (typeof literal === "string") known.add(literal);
  }
  return known;
}

/** Command types this daemon decodes (read from the union, never a hand list). */
export const KNOWN_CLIENT_COMMAND_TYPES = literalTypesOf(ClientOrchestrationCommand);

const UnsupportedClientCommandFromAny = Schema.Unknown.pipe(
  Schema.decodeTo(
    UnsupportedClientCommand,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        const type =
          typeof raw === "object" && raw !== null
            ? (raw as Record<string, unknown>)["type"]
            : undefined;
        if (typeof type === "string" && type.length > 0 && !KNOWN_CLIENT_COMMAND_TYPES.has(type)) {
          return Effect.succeed({ _tag: UNSUPPORTED_CLIENT_COMMAND_TAG, type });
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(raw), { message: "Not a client command" }),
        );
      },
      encode: (command) => Effect.succeed(command),
    }),
  ),
);

export const TolerantClientOrchestrationCommand = Schema.Union([
  ClientOrchestrationCommand,
  UnsupportedClientCommandFromAny,
]);

export function isUnsupportedClientCommand(value: unknown): value is UnsupportedClientCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly _tag?: unknown })._tag === UNSUPPORTED_CLIENT_COMMAND_TAG
  );
}

export function unsupportedCommandError(
  command: UnsupportedClientCommand,
): OrchestrationDispatchCommandError {
  return new OrchestrationDispatchCommandError({
    message: `"${command.type}" isn't supported by this computer (Uno Work ${packageJson.version}). Update this computer to use it.`,
  });
}

/**
 * WsRpcGroup with the tolerant dispatch payload. Typed as WsRpcGroup: the
 * marker only ever reaches the dispatch handler, which checks for it first.
 */
export function makeServerWsRpcGroup(): typeof WsRpcGroup {
  const rpcs: Array<Rpc.Any> = [];
  const requests = (WsRpcGroup as unknown as { readonly requests: ReadonlyMap<string, unknown> })
    .requests;
  for (const rpc of requests.values()) {
    const props = rpc as Rpc.AnyWithProps & { setPayload(schema: Schema.Top): Rpc.Any };
    rpcs.push(
      props._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
        ? props.setPayload(TolerantClientOrchestrationCommand)
        : (rpc as Rpc.Any),
    );
  }
  return RpcGroup.make(...rpcs) as unknown as typeof WsRpcGroup;
}

export const ServerWsRpcGroup = makeServerWsRpcGroup();
