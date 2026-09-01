import { assert, describe, it } from "@effect/vitest";

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
