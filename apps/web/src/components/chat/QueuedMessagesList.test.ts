import { describe, expect, it } from "vitest";

import { queuedMessageStatus } from "./QueuedMessagesList";

describe("the line under a waiting message (T48)", () => {
  it("says what it really waits for", () => {
    expect(queuedMessageStatus({ hold: false, index: 0, pause: null })).toBe(
      "The agent is still working: this goes by itself the moment it's done",
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

describe("a card's answer in the list (T71)", () => {
  it("says it is going, not that it waits for the agent", () => {
    expect(queuedMessageStatus({ hold: false, index: 1, pause: null, steer: true })).toBe(
      "Sending…",
    );
    expect(
      queuedMessageStatus({
        hold: false,
        index: 0,
        pause: null,
        steer: true,
        waitingForPerson: true,
      }),
    ).toBe("Sends once you answer the agent above");
    expect(queuedMessageStatus({ hold: true, index: 0, pause: null, steer: true })).toBe(
      "Waiting for you to send it",
    );
  });
});
