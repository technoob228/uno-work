import { assert, describe, it } from "@effect/vitest";

import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { deriveMachineMonogram, parseUnoBoxSshTarget } from "./workspace.ts";

describe("uno box ssh target", () => {
  it("parses the command the control plane returns", () => {
    assert.deepEqual(parseUnoBoxSshTarget("ssh -p 30000 uno@45.182.189.80"), {
      host: "45.182.189.80",
      port: 30000,
      user: "uno",
    });
  });

  it("defaults to port 22 when the command has no -p", () => {
    assert.deepEqual(parseUnoBoxSshTarget("ssh root@box.example.com"), {
      host: "box.example.com",
      port: 22,
      user: "root",
    });
  });

  it("returns null rather than guessing when the command is unrecognisable", () => {
    // Guessing a port produces a connection attempt that fails much later, in a
    // place where the cause is no longer visible.
    assert.isNull(parseUnoBoxSshTarget("pending"));
    assert.isNull(parseUnoBoxSshTarget(""));
    assert.isNull(parseUnoBoxSshTarget(null));
  });
});

describe("machine monogram", () => {
  it("takes initials from a two-word label", () => {
    assert.equal(deriveMachineMonogram("Mac Book"), "MB");
    assert.equal(deriveMachineMonogram("cozy-maple"), "CM");
  });

  it("keeps digits, because boxes are numbered", () => {
    assert.equal(deriveMachineMonogram("box12"), "BO");
    assert.equal(deriveMachineMonogram("hostkey81337"), "HO");
  });

  it("pads a one-character label instead of returning a lone letter", () => {
    assert.equal(deriveMachineMonogram("m"), "M·");
  });

  it("falls back for an empty label", () => {
    assert.equal(deriveMachineMonogram("   "), "··");
  });
});

describe("legacy registry commands (migration 038)", () => {
  // Grants, claims, peer requests and the cross-machine policy were writable
  // by any connected client without a role check. They are gone: nothing
  // enforced them, and they were a ready-made escalation point once roles
  // arrive. This test is the lock on the door.
  const REMOVED = [
    "workspace.setPolicy",
    "workspace.upsertGrant",
    "workspace.removeGrant",
    "workspace.acquireClaim",
    "workspace.releaseClaim",
    "workspace.createRequest",
    "workspace.decideRequest",
  ] as const;

  it("does not name them in WS_METHODS", () => {
    const methods = new Set<string>(Object.values(WS_METHODS));
    for (const removed of REMOVED) {
      assert.isFalse(methods.has(removed), `${removed} is still routable`);
    }
  });

  it("does not serve them in the websocket RPC group", () => {
    const served = new Set<string>(WsRpcGroup.requests.keys());
    for (const removed of REMOVED) {
      assert.isFalse(served.has(removed), `${removed} is still in the RPC group`);
    }
    // The machine list and instruction layers stay — the app uses them.
    assert.isTrue(served.has(WS_METHODS.workspaceGetState));
    assert.isTrue(served.has(WS_METHODS.workspaceSyncMachines));
    assert.isTrue(served.has(WS_METHODS.workspaceSetInstructions));
  });
});
