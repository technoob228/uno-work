import { describe, expect, it } from "vitest";

import { boxSleepConfirmCopy } from "./boxSleepCopy";

describe("boxSleepConfirmCopy", () => {
  it("warns that this screen will disconnect for the machine serving it", () => {
    const copy = boxSleepConfirmCopy({
      label: "my-computer",
      isThisScreen: true,
      isConnectedHere: false,
    });
    expect(copy.warning).toMatch(/this screen .* will disconnect/i);
    expect(copy.confirm).toBe("Sleep and disconnect");
  });

  it("names what stops, for any box on the account", () => {
    const copy = boxSleepConfirmCopy({
      label: "outreach-machine",
      isThisScreen: false,
      isConnectedHere: false,
    });
    expect(copy.title).toBe("Put outreach-machine to sleep?");
    expect(copy.body).toMatch(/bots/);
    expect(copy.warning).toBeNull();
  });

  it("mentions offline chats for a machine connected here", () => {
    const copy = boxSleepConfirmCopy({ label: "b", isThisScreen: false, isConnectedHere: true });
    expect(copy.warning).toMatch(/offline/);
  });
});
