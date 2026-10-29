import { describe, expect, it } from "vitest";

import { isTransientReconnectState, reconnectEpisodeKey } from "./reconnectWarningGrace";

describe("reconnect warning grace", () => {
  it("treats connecting and reconnecting as transient", () => {
    expect(isTransientReconnectState("connecting")).toBe(true);
    expect(isTransientReconnectState("reconnecting")).toBe(true);
    expect(isTransientReconnectState("disconnected")).toBe(false);
    expect(isTransientReconnectState("error")).toBe(false);
    expect(isTransientReconnectState(null)).toBe(false);
  });

  it("keys an episode by environment only while it is reconnecting", () => {
    expect(reconnectEpisodeKey(null)).toBeNull();
    expect(reconnectEpisodeKey({ environmentId: "env-1", connectionState: "reconnecting" })).toBe(
      "env-1",
    );
    expect(reconnectEpisodeKey({ environmentId: "env-1", connectionState: "error" })).toBeNull();
  });
});
