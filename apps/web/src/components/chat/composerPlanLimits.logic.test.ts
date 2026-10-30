import type { PlanLimitsAccount } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { chatPlanLimitsFrom } from "./composerPlanLimits.logic";

const account = (
  id: string,
  provider: PlanLimitsAccount["provider"],
  usedPercent: number,
  instanceId?: string,
) =>
  ({
    id,
    provider,
    ...(instanceId ? { instanceId } : {}),
    windows: [{ id: "five_hour", kind: "session", label: "5h", usedPercent }],
  }) as unknown as PlanLimitsAccount;

const NOW = Date.parse("2026-10-30T10:00:00.000Z");

describe("chatPlanLimitsFrom", () => {
  it("shows the room of the chat's own plan, first", () => {
    const limits = chatPlanLimitsFrom({
      accounts: [account("chatgpt:a", "chatgpt", 10), account("claude:a", "claude", 62)],
      driver: "claudeAgent",
      instanceId: "claudeAgent",
      now: NOW,
    });
    expect(limits.roomPercent).toBe(38);
    expect(limits.accounts.map((entry) => entry.id)).toEqual(["claude:a", "chatgpt:a"]);
  });

  it("follows a second account", () => {
    const limits = chatPlanLimitsFrom({
      accounts: [account("claude:a", "claude", 62), account("claude:b", "claude", 5, "claude_2")],
      driver: "claudeAgent",
      instanceId: "claude_2",
      now: NOW,
    });
    expect(limits.account?.id).toBe("claude:b");
    expect(limits.roomPercent).toBe(95);
  });

  it("shows nothing for a chat without a plan", () => {
    for (const driver of ["uno", "opencode"]) {
      const limits = chatPlanLimitsFrom({
        accounts: [account("claude:a", "claude", 62)],
        driver,
        instanceId: driver,
        now: NOW,
      });
      expect(limits.account).toBeNull();
      expect(limits.accounts).toEqual([]);
    }
  });

  it("shows nothing before the numbers arrive", () => {
    const limits = chatPlanLimitsFrom({
      accounts: null,
      driver: "claudeAgent",
      instanceId: "claudeAgent",
      now: NOW,
    });
    expect(limits.account).toBeNull();
  });
});
