import { describe, expect, it } from "vitest";

import { PageToolsRelay, RELAY_BUFFER_CAP } from "./pageToolsRelay.ts";

describe("PageToolsRelay", () => {
  it("holds lines until the app asked and the page's preload is up", () => {
    const relay = new PageToolsRelay<string>();
    expect(relay.push("a")).toEqual([]);
    expect(relay.hello()).toEqual([]);
    expect(relay.push("b")).toEqual([]);
    expect(relay.enable()).toEqual(["a", "b"]);
    expect(relay.push("c")).toEqual(["c"]);
  });

  it("gives an older app (never enables) nothing", () => {
    const relay = new PageToolsRelay<string>();
    relay.hello();
    expect(relay.push("a")).toEqual([]);
    for (let i = 0; i < RELAY_BUFFER_CAP + 50; i += 1) relay.push(`x${i}`);
    const flushed = relay.enable();
    expect(flushed).toHaveLength(RELAY_BUFFER_CAP);
    expect(flushed.at(-1)).toBe(`x${RELAY_BUFFER_CAP + 49}`);
  });

  it("drops the old page's waiting lines and waits for the new page's preload", () => {
    const relay = new PageToolsRelay<string>();
    relay.enable();
    relay.hello();
    relay.navigationStarted();
    expect(relay.push("document request")).toEqual([]);
    expect(relay.hello()).toEqual(["document request"]);
    expect(relay.push("next")).toEqual(["next"]);
    relay.navigationStarted();
    relay.push("stale");
    relay.navigationStarted();
    expect(relay.hello()).toEqual([]);
  });
});
