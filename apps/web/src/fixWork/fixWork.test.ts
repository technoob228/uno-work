import { describe, expect, it } from "vitest";

import { FIX_WORK_RUNTIME_MODE, fixWorkPrompt } from "./fixWork";

describe("fixWorkPrompt", () => {
  it("keeps the person's words and points at the playbook", () => {
    expect(fixWorkPrompt("  Chats hang  ", "/s/fix-work/1/PLAYBOOK.md")).toBe(
      "Fix Work. What went wrong: Chats hang\n\nFollow the steps in /s/fix-work/1/PLAYBOOK.md",
    );
  });

  it("asks when the person didn't say", () => {
    expect(fixWorkPrompt("   ", "/p")).toContain("I'm not sure yet. Ask me.");
  });

  it("runs in Ask mode", () => {
    expect(FIX_WORK_RUNTIME_MODE).toBe("approval-required");
  });
});
