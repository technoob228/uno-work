import { describe, expect, it } from "@effect/vitest";
import { slackChatKey } from "@t3tools/contracts";

// The thread-first session model: a channel does not collapse into one context.
describe("slackChatKey", () => {
  it("keys a DM on the channel alone", () => {
    expect(slackChatKey("D123")).toBe("D123");
    expect(slackChatKey("D123", null)).toBe("D123");
    expect(slackChatKey("D123", "")).toBe("D123");
  });

  it("keys a channel thread on channel + thread_ts (one session per thread)", () => {
    expect(slackChatKey("C999", "1700000000.000100")).toBe("C999:1700000000.000100");
    // A different thread in the same channel is a different session.
    expect(slackChatKey("C999", "1700000000.000200")).not.toBe(
      slackChatKey("C999", "1700000000.000100"),
    );
  });
});
