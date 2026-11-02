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
      model: "claude-opus-5-5",
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
      model: "claude-opus-5-5",
      now: NOW,
    });
    expect(limits.account?.id).toBe("claude:b");
    expect(limits.roomPercent).toBe(95);
  });

  it("counts a model's own limit only for that model, and names it", () => {
    const plan = {
      id: "claude:a",
      provider: "claude",
      windows: [
        { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 89 },
        { id: "seven_day_fable", kind: "weekly", label: "F", usedPercent: 100, scope: "Fable" },
      ],
    } as unknown as PlanLimitsAccount;
    const on = (model: string) =>
      chatPlanLimitsFrom({
        accounts: [plan],
        driver: "claudeAgent",
        instanceId: "claudeAgent",
        model,
        now: NOW,
      });
    expect(on("claude-opus-5-5")).toMatchObject({ roomPercent: 11, roomScope: null });
    expect(on("claude-fable-5-1")).toMatchObject({ roomPercent: 0, roomScope: "Fable" });
  });

  it("shows nothing for a chat without a plan", () => {
    for (const driver of ["uno", "opencode"]) {
      const limits = chatPlanLimitsFrom({
        accounts: [account("claude:a", "claude", 62)],
        driver,
        instanceId: driver,
        model: null,
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
      model: "claude-opus-5-5",
      now: NOW,
    });
    expect(limits.account).toBeNull();
  });
});
