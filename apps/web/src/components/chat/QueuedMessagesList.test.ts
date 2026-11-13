import { describe, expect, it } from "vitest";

import { queuedMessageStatus } from "./QueuedMessagesList";

describe("the line under a waiting message (T48)", () => {
  it("says what it really waits for", () => {
    expect(queuedMessageStatus({ hold: false, index: 0, pause: null })).toBe(
      "Sends when the agent is done",
    );
    expect(queuedMessageStatus({ hold: false, index: 0, pause: "error" })).toBe(
      "Paused: the last turn didn't finish. Send now to go on",
    );
    expect(queuedMessageStatus({ hold: false, index: 0, pause: "person" })).toBe(
      "Sends once you answer the agent above",
    );
    expect(queuedMessageStatus({ hold: false, index: 1, pause: "error" })).toBe(
      "Sends after the one above",
    );
    expect(queuedMessageStatus({ hold: true, index: 0, pause: null })).toBe(
      "Waiting for you to send it",
    );
  });
});
