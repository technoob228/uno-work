import { describe, expect, it } from "vitest";

import { hideBootShell } from "./bootShell";
import { isFirstSnapshotPending } from "./firstSnapshot";
import { pickShownValue } from "./heldValue";

describe("isFirstSnapshotPending", () => {
  it("waits while a known computer hasn't sent its chats", () => {
    expect(
      isFirstSnapshotPending({
        waitedEnvironmentId: "env",
        bootstrapComplete: false,
        graceOver: false,
      }),
    ).toBe(true);
  });

  it("stops waiting once the snapshot is in, or the wait ran out", () => {
    expect(
      isFirstSnapshotPending({
        waitedEnvironmentId: "env",
        bootstrapComplete: true,
        graceOver: false,
      }),
    ).toBe(false);
    expect(
      isFirstSnapshotPending({
        waitedEnvironmentId: "env",
        bootstrapComplete: false,
        graceOver: true,
      }),
    ).toBe(false);
  });

  it("has nothing to wait for without a computer (hosted page with none saved)", () => {
    expect(
      isFirstSnapshotPending({
        waitedEnvironmentId: null,
        bootstrapComplete: false,
        graceOver: false,
      }),
    ).toBe(false);
  });
});

describe("pickShownValue", () => {
  it("shows the live value once everything settled", () => {
    expect(pickShownValue({ settled: true, live: "new", held: "old", cached: "older" })).toBe(
      "new",
    );
  });

  it("keeps what was on screen while sources still load", () => {
    expect(pickShownValue({ settled: false, live: "partial", held: "old", cached: "older" })).toBe(
      "old",
    );
  });

  it("starts from the previous start's value, then the live one", () => {
    expect(
      pickShownValue({ settled: false, live: "partial", held: undefined, cached: "older" }),
    ).toBe("older");
    expect(
      pickShownValue({ settled: false, live: "partial", held: undefined, cached: undefined }),
    ).toBe("partial");
  });
});

describe("hideBootShell", () => {
  it("removes the splash and is safe to call again", () => {
    const removed: string[] = [];
    const element = { remove: () => removed.push("boot-shell") };
    const doc = {
      getElementById: (id: string) =>
        id === "boot-shell" && removed.length === 0 ? element : null,
    } as unknown as Document;
    hideBootShell(doc);
    hideBootShell(doc);
    expect(removed).toEqual(["boot-shell"]);
  });
});
