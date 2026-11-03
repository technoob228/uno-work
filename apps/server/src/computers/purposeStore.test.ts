import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MyComputerError, type MyComputerStatus } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lifecycleOn, makeComputersLifecycleBase } from "./ComputersLifecycle.ts";
import { lifecycleOverride, makePurposeStore, PURPOSES_FILE } from "./purposeStore.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), "computers-lifecycle-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const mac = {
  id: "41",
  name: "MacBook",
  os: "darwin",
  arch: "arm64",
  online: true,
  connectedAt: null,
  lastSeenAt: null,
  helperVersion: "0.4.0",
};

describe("purpose store", () => {
  it("is a tool until chosen, keeps the choice across restarts, forgets on remove", () => {
    const store = makePurposeStore(stateDir);
    expect(store.purposeOf("41")).toBe("tool");
    store.set("41", "full");
    expect(makePurposeStore(stateDir).purposeOf("41")).toBe("full");
    expect(makePurposeStore(stateDir).list()).toEqual([{ computerId: "41", purpose: "full" }]);
    expect(statSync(path.join(stateDir, PURPOSES_FILE)).mode & 0o777).toBe(0o600);
    store.forget("41");
    expect(makePurposeStore(stateDir).list()).toEqual([]);
  });

  it("reads a damaged file as no choices", () => {
    writeFileSync(path.join(stateDir, PURPOSES_FILE), "{not json");
    expect(makePurposeStore(stateDir).list()).toEqual([]);
    writeFileSync(
      path.join(stateDir, PURPOSES_FILE),
      JSON.stringify({ v: 1, purposes: { a: "full", b: "weird" } }),
    );
    expect(makePurposeStore(stateDir).list()).toEqual([{ computerId: "a", purpose: "full" }]);
  });
});

describe("the flag", () => {
  it("follows the console unless the env says", () => {
    const on: MyComputerStatus = { enabled: true, computers: [], lifecycle: true };
    expect(lifecycleOn(on, null)).toBe(true);
    expect(lifecycleOn({ ...on, lifecycle: false }, null)).toBe(false);
    expect(lifecycleOn({ enabled: true, computers: [] }, null)).toBe(false);
    expect(lifecycleOn({ ...on, enabled: false }, null)).toBe(false);
    expect(lifecycleOn({ enabled: false, computers: [] }, true)).toBe(true);
    expect(lifecycleOn(on, false)).toBe(false);
  });

  it.each([
    ["on", true],
    ["1", true],
    ["OFF", false],
    ["false", false],
    ["", null],
    [undefined, null],
    ["maybe", null],
  ] as const)("UNO_WORK_COMPUTERS_LIFECYCLE=%s", (value, expected) => {
    expect(lifecycleOverride(value)).toBe(expected);
  });
});

describe("state and setPurpose", () => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  it("saves a purpose for a connected computer and refuses an unknown one", async () => {
    const base = makeComputersLifecycleBase({
      store: makePurposeStore(stateDir),
      status: Effect.succeed({ enabled: true, computers: [mac], lifecycle: true }),
      override: null,
    });
    expect(await run(base.state)).toEqual({ lifecycle: true, purposes: [] });
    expect(await run(base.setPurpose("41", "full"))).toEqual({
      lifecycle: true,
      purposes: [{ computerId: "41", purpose: "full" }],
    });
    await expect(run(base.setPurpose("99", "full"))).rejects.toThrow("isn’t connected");
    expect(JSON.parse(readFileSync(path.join(stateDir, PURPOSES_FILE), "utf8")).purposes).toEqual({
      "41": "full",
    });
  });

  it("keeps the last known flag while the console doesn't answer", async () => {
    let fail = false;
    const base = makeComputersLifecycleBase({
      store: makePurposeStore(stateDir),
      status: Effect.suspend(() =>
        fail
          ? Effect.fail(new MyComputerError({ message: "down" }))
          : Effect.succeed({ enabled: true, computers: [mac], lifecycle: true }),
      ),
      override: null,
    });
    expect((await run(base.state)).lifecycle).toBe(true);
    fail = true;
    expect((await run(base.state)).lifecycle).toBe(true);
  });
});
