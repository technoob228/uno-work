import { describe, expect, it } from "@effect/vitest";

import { stripHandoffPreamble, telegramSendOutcome } from "./TelegramConnector.ts";

// The reply decision itself lives in `connectorReplies.ts` (shared with
// Slack); see `connectorReplies.test.ts`.
describe("TelegramConnector helpers", () => {
  it("strips an inherited handoff preamble so preambles never nest", () => {
    const preambled = [
      "[Context: this Telegram chat previously ran in another thread (the harness/model was switched). Recent history, oldest first:]",
      "User: earlier question",
      "Assistant: earlier answer",
      "[End of context. Reply to the message below.]",
      "",
      "the actual question",
    ].join("\n");
    expect(stripHandoffPreamble(preambled)).toBe("the actual question");
    expect(stripHandoffPreamble("plain message")).toBe("plain message");
  });

  it("gives up on a chat that refuses, retries a passing failure", () => {
    expect(telegramSendOutcome(403)).toBe("gone");
    expect(telegramSendOutcome(400)).toBe("gone");
    expect(telegramSendOutcome(429)).toBe("retry");
    expect(telegramSendOutcome(502)).toBe("retry");
    expect(telegramSendOutcome(undefined)).toBe("retry");
  });
});
