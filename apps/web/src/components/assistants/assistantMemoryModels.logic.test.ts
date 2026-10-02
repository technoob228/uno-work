import type { AssistantChatSummary, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  chatCostText,
  chatTokensNote,
  choiceValue,
  formatTokens,
  modelChoices,
  SELF_VALUE,
  weekTotals,
} from "./assistantMemoryModels.logic";

const provider = (over: Record<string, unknown>) =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
    ],
    ...over,
  }) as unknown as ServerProvider;

describe("model choices", () => {
  it("lists self first, then every model; unusable ones carry a reason; Hermes is skipped", () => {
    const choices = modelChoices(
      [
        provider({}),
        provider({
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          auth: { status: "unauthenticated" },
          models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null }],
        }),
        provider({ instanceId: "hermes", driver: "hermes" }),
      ],
      "Ana",
    );
    expect(choices.map((c) => [c.value, c.reason])).toEqual([
      [SELF_VALUE, null],
      ["claudeAgent::claude-opus-5-5", null],
      ["codex::gpt-5.5", "not signed in"],
    ]);
    expect(choices[0]?.label).toBe("Ana answers itself");
    expect(
      choiceValue({
        taskType: "x",
        harness: "self",
        model: "—",
        effort: "",
        source: "you",
        note: "",
      }),
    ).toBe(SELF_VALUE);
  });
});

describe("chat cost", () => {
  const chat = (over: Partial<AssistantChatSummary>) =>
    ({ billing: "uno-ai", costUsd: 0, aiHoursRequests: 0, ...over }) as AssistantChatSummary;

  it("says where the money came from", () => {
    expect(chatCostText(chat({ costUsd: 1.234 }), "metered")).toBe("$1.23");
    expect(chatCostText(chat({ costUsd: 0.004 }), "metered")).toBe("<$0.01");
    expect(chatCostText(chat({ costUsd: 0, aiHoursRequests: 4 }), "metered")).toBe("In AI hours");
    expect(chatCostText(chat({ costUsd: 0 }), "metered")).toBe("$0.00");
    expect(chatCostText(chat({ costUsd: null }), "unavailable")).toBe("—");
    expect(chatCostText(chat({ billing: "plan", costUsd: null }), "metered")).toBe("In your plan");
    expect(chatCostText(chat({ billing: "uno-ai-unlabelled" }), "metered")).toBe(
      "In the computer's total",
    );
  });

  it("sums the last seven days", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    const totals = weekTotals(
      [
        chat({ costUsd: 1, createdAt: "2026-10-08T00:00:00Z" }),
        chat({ costUsd: 0, aiHoursRequests: 2, createdAt: "2026-10-07T00:00:00Z" }),
        chat({ billing: "plan", costUsd: null, createdAt: "2026-10-06T00:00:00Z" }),
        chat({ costUsd: 5, createdAt: "2026-09-20T00:00:00Z" }),
      ],
      now,
    );
    expect(totals).toEqual({ usd: 1, aiHoursChats: 1, planChats: 1, count: 3 });
    expect(formatTokens(412_000)).toBe("412k");
    expect(formatTokens(null)).toBe("—");
  });
});

describe("chatTokensNote (tokens shown, no $ — decision 02.10)", () => {
  it("says which plan a subscription chat is in, and nothing for Uno AI", () => {
    expect(chatTokensNote({ billing: "plan", instanceId: "claudeAgent", harness: "Claude" })).toBe(
      "in your Claude plan",
    );
    expect(chatTokensNote({ billing: "plan", instanceId: "codex", harness: "Codex" })).toBe(
      "in your ChatGPT plan",
    );
    expect(chatTokensNote({ billing: "uno-ai", instanceId: "uno", harness: "Uno" })).toBeNull();
  });
});
