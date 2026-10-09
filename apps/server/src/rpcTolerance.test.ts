import { ORCHESTRATION_WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  isUnsupportedClientCommand,
  KNOWN_CLIENT_COMMAND_TYPES,
  ServerWsRpcGroup,
  TolerantClientOrchestrationCommand,
  unsupportedCommandError,
} from "./rpcTolerance.ts";

const decode = (raw: unknown) =>
  Effect.runSyncExit(
    Schema.decodeUnknownEffect(Schema.toCodecJson(TolerantClientOrchestrationCommand))(raw),
  );

describe("tolerant dispatch payload", () => {
  it("knows this daemon's command types from the union", () => {
    expect(KNOWN_CLIENT_COMMAND_TYPES.has("thread.turn.start")).toBe(true);
    expect(KNOWN_CLIENT_COMMAND_TYPES.has("project.create")).toBe(true);
    expect(KNOWN_CLIENT_COMMAND_TYPES.size).toBeGreaterThan(15);
  });

  it("a command of a type from a newer interface → the 'not supported' marker", () => {
    const exit = decode({ type: "thread.teleport", commandId: "c1", threadId: "t1" });
    expect(Exit.isSuccess(exit)).toBe(true);
    const value = Exit.isSuccess(exit) ? exit.value : null;
    expect(isUnsupportedClientCommand(value)).toBe(true);
    expect(value).toMatchObject({ type: "thread.teleport" });
    expect(
      unsupportedCommandError({ _tag: "UnsupportedClientCommand", type: "thread.teleport" })
        .message,
    ).toMatch(/^"thread\.teleport" isn't supported by this computer \(Uno Work .+\)\. Update/);
  });

  it("a known type with a bad field still fails decoding (bugs stay loud)", () => {
    expect(Exit.isFailure(decode({ type: "thread.archive", commandId: 42 }))).toBe(true);
    expect(Exit.isFailure(decode("thread.archive"))).toBe(true);
    expect(Exit.isFailure(decode({ commandId: "c1" }))).toBe(true);
  });

  it("a valid known command decodes as before", () => {
    const exit = decode({ type: "thread.archive", commandId: "c1", threadId: "t1" });
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(isUnsupportedClientCommand(Exit.isSuccess(exit) ? exit.value : null)).toBe(false);
  });

  it("the server group is WsRpcGroup with only the dispatch payload swapped", () => {
    const original = WsRpcGroup.requests;
    const served = ServerWsRpcGroup.requests;
    expect([...served.keys()]).toEqual([...original.keys()]);
    for (const [tag, rpc] of served) {
      const before = original.get(tag)!;
      expect(rpc.successSchema).toBe(before.successSchema);
      if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
        expect(rpc.payloadSchema).toBe(TolerantClientOrchestrationCommand);
      } else {
        expect(rpc.payloadSchema).toBe(before.payloadSchema);
      }
    }
  });
});
