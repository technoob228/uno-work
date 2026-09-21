import { describe, expect, it } from "vitest";

import { describeMachineError } from "./machineErrors";

describe("describeMachineError", () => {
  it.each([
    // Strings production sent during the 21.09 e2e run.
    [
      '409: {"error":"NETWORK_NOT_READY: box 1792 hostname is not published yet — retry shortly"}',
      "Still getting an address",
      true,
    ],
    [
      "Failed to fetch remote auth endpoint https://b.app.uno4.dev/.well-known/t3/environment (Failed to fetch).",
      "The computer isn't answering yet",
      true,
    ],
    [
      '503: {"status":"starting","message":"your machine is starting"}',
      "The computer isn't answering yet",
      true,
    ],
    ["500: INTERNAL_ERROR", "The computer isn't answering yet", true],
    ['409: {"error":"NO_NODE_CAPACITY"}', "No free capacity right now", false],
    ["Connect your Uno account first.", "Uno account not connected", false],
    [
      "curl -fsSL https://console.uno4.dev/cli/work/install.sh | sudo bash",
      "Uno Work isn't installed there",
      false,
    ],
    ['Box #1792 entered status "error" while booting.', "This computer is broken", false],
  ])("%s → %s", (raw, title, transient) => {
    const human = describeMachineError(new Error(raw));
    expect(human.title).toBe(title);
    expect(human.transient).toBe(transient);
    // The raw text is kept for "Show details", never shown as the message.
    expect(human.details).toBe(raw);
    expect(human.message).not.toContain("{");
  });

  it("never shows JSON in the fallback message", () => {
    const human = describeMachineError(new Error('{"weird":true}'));
    expect(human.title).toBe("Something went wrong");
    expect(human.message).not.toContain("{");
    expect(human.details).toBe('{"weird":true}');
  });
});
