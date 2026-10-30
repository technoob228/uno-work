import { describe, expect, it } from "vitest";

import {
  agentSwitchStillOwed,
  applyHandoffSeed,
  buildAgentSwitchSeed,
  buildContinueSeed,
  buildHandoffContext,
  buildModelFallbackNote,
  CONTINUE_HANDOFF_OPTIONS,
  CONTINUE_SEED_PREFIX,
  DEFAULT_HANDOFF_TOKEN_CAP,
  HANDOFF_PREAMBLE_END,
  HANDOFF_PREAMBLE_START,
  handoffHistoryBudget,
  handoffItems,
  handoffTokenCap,
  isContinueSeedText,
  LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START,
  resolvePendingHandoffSeed,
  selectHandoffItems,
  stripHandoffPreamble,
  TELEGRAM_HANDOFF_OPTIONS,
  wrapHandoffPreamble,
} from "./handoff.ts";

const message = (
  role: "user" | "assistant" | "system",
  text: string,
  overrides: { streaming?: boolean; turnId?: string | null; id?: string } = {},
) => ({
  id: overrides.id ?? `${role}-${text.slice(0, 8)}`,
  role,
  text,
  streaming: overrides.streaming ?? false,
  turnId: overrides.turnId ?? null,
});

describe("stripHandoffPreamble", () => {
  it("strips the shared preamble and the legacy Telegram one", () => {
    for (const marker of [HANDOFF_PREAMBLE_START, LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START]) {
      const text = [marker, "User: earlier", HANDOFF_PREAMBLE_END, "", "the actual question"].join(
        "\n",
      );
      expect(stripHandoffPreamble(text)).toBe("the actual question");
    }
  });

  it("strips a whole continue seed, header line included", () => {
    const seed = buildContinueSeed({
      thread: { title: "Fix login", messages: [message("user", "hi")] },
      sourceMachineLabel: "Mac",
      sourceBranch: "main",
    });
    expect(stripHandoffPreamble(`${seed}\n\nnext question`)).toBe("next question");
  });

  it("leaves ordinary messages and mid-text markers alone", () => {
    expect(stripHandoffPreamble("plain message")).toBe("plain message");
    const quoted = `Someone wrote:\n${HANDOFF_PREAMBLE_START}\nx\n${HANDOFF_PREAMBLE_END}`;
    expect(stripHandoffPreamble(quoted)).toBe(quoted);
  });
});

describe("buildHandoffContext", () => {
  it("keeps the last N user/assistant messages, oldest first, within the char budget", () => {
    const messages = [
      message("user", "one"),
      message("assistant", "two"),
      message("system", "ignored"),
      message("assistant", "streaming", { streaming: true }),
      message("user", "   "),
      message("user", "x".repeat(50)),
    ];
    const context = buildHandoffContext({ messages }, { messageCount: 3, messageChars: 10 });
    expect(context).toBe(["User: one", "Assistant: two", `User: ${"x".repeat(10)}…`].join("\n"));
  });

  it("returns null when nothing is worth carrying", () => {
    expect(buildHandoffContext({ messages: [] }, TELEGRAM_HANDOFF_OPTIONS)).toBeNull();
    expect(
      buildHandoffContext({ messages: [message("system", "sys")] }, TELEGRAM_HANDOFF_OPTIONS),
    ).toBeNull();
  });

  it("applies the sanitizer and drops messages it empties", () => {
    const context = buildHandoffContext(
      { messages: [message("user", "keep HINT"), message("assistant", "HINT")] },
      { ...TELEGRAM_HANDOFF_OPTIONS, sanitize: (text) => text.replace("HINT", "") },
    );
    expect(context).toBe("User: keep ");
  });

  it("does not nest preambles when the source thread itself was handed off", () => {
    const inherited = `${wrapHandoffPreamble("User: older")}\n\nreal question`;
    const context = buildHandoffContext(
      { messages: [message("user", inherited), message("assistant", "answer")] },
      TELEGRAM_HANDOFF_OPTIONS,
    );
    expect(context).toBe("User: real question\nAssistant: answer");
  });
});

describe("buildContinueSeed", () => {
  it("starts with the machine header and wraps the recent history", () => {
    const seed = buildContinueSeed({
      thread: {
        title: "Fix login",
        messages: [message("user", "please fix login"), message("assistant", "done")],
      },
      sourceMachineLabel: "Misha's Mac",
      sourceBranch: "feat/login",
    });
    const lines = seed.split("\n");
    expect(lines[0]).toContain(`${CONTINUE_SEED_PREFIX}Misha's Mac]`);
    expect(lines[0]).toContain('"Fix login"');
    expect(lines[0]).toContain('branch "feat/login"');
    expect(lines[0]).toContain("uncommitted changes");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(HANDOFF_PREAMBLE_START);
    expect(seed).toContain("User: please fix login\nAssistant: done");
    expect(seed.endsWith(HANDOFF_PREAMBLE_END)).toBe(true);
    expect(isContinueSeedText(seed)).toBe(true);
  });

  it("uses the continue budget: 40 messages, 4k chars each", () => {
    expect(CONTINUE_HANDOFF_OPTIONS).toEqual({ messageCount: 40, messageChars: 4_000 });
    const messages = Array.from({ length: 45 }, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", `m${index} ${"y".repeat(5_000)}`, {
        id: `m${index}`,
      }),
    );
    const seed = buildContinueSeed({
      thread: { title: "Long", messages },
      sourceMachineLabel: "Mac",
      sourceBranch: null,
    });
    expect(seed).not.toContain("m4 ");
    expect(seed).toContain("m5 ");
    expect(seed).toContain("m44 ");
    const longest = Math.max(...seed.split("\n").map((line) => line.length));
    expect(longest).toBeLessThan(4_100);
  });

  it("omits the branch note and the transcript when there is nothing to carry", () => {
    const seed = buildContinueSeed({
      thread: { title: "Empty", messages: [] },
      sourceMachineLabel: "Mac",
      sourceBranch: null,
    });
    expect(seed).not.toContain("branch");
    expect(seed).not.toContain(HANDOFF_PREAMBLE_START);
  });
});

describe("resolvePendingHandoffSeed", () => {
  const seed = buildContinueSeed({
    thread: { title: "T", messages: [message("user", "earlier")] },
    sourceMachineLabel: "Mac",
    sourceBranch: null,
  });

  it("returns the seed before the first real turn and prepends it to the prompt", () => {
    const messages = [
      message("user", seed, { id: "seed" }),
      message("user", "next", { id: "cur" }),
    ];
    const pending = resolvePendingHandoffSeed({ messages, currentMessageId: "cur" });
    expect(pending).toBe(seed);
    expect(applyHandoffSeed(pending, "next")).toBe(`${seed}\n\nnext`);
  });

  it("stops once the harness has answered, and ignores ordinary user messages", () => {
    const answered = [
      message("user", seed, { id: "seed" }),
      message("user", "first", { id: "first" }),
      message("assistant", "reply", { id: "reply" }),
      message("user", "second", { id: "cur" }),
    ];
    expect(resolvePendingHandoffSeed({ messages: answered, currentMessageId: "cur" })).toBeNull();

    const plain = [message("user", "hello", { id: "a" }), message("user", "next", { id: "cur" })];
    expect(resolvePendingHandoffSeed({ messages: plain, currentMessageId: "cur" })).toBeNull();
    expect(applyHandoffSeed(null, "next")).toBe("next");
  });

  it("never treats the current message itself as a seed", () => {
    const messages = [message("user", seed, { id: "cur" })];
    expect(resolvePendingHandoffSeed({ messages, currentMessageId: "cur" })).toBeNull();
  });
});

describe("buildModelFallbackNote", () => {
  it("names both models and the source machine", () => {
    const note = buildModelFallbackNote({
      sourceMachineLabel: "Mac",
      requested: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
      applied: { instanceId: "codex", model: "gpt-5" },
    });
    expect(note).toContain("Mac");
    expect(note).toContain("claudeAgent / claude-sonnet-4-6");
    expect(note).toContain("codex / gpt-5");
  });
});

describe("handoff budget", () => {
  it("defaults like T3 and clamps the override", () => {
    expect(handoffTokenCap(undefined)).toBe(DEFAULT_HANDOFF_TOKEN_CAP);
    expect(handoffTokenCap("")).toBe(16_000);
    expect(handoffTokenCap("not a number")).toBe(16_000);
    expect(handoffTokenCap("10")).toBe(1_024);
    expect(handoffTokenCap("999999")).toBe(64_000);
    expect(handoffTokenCap("32000")).toBe(32_000);
  });

  it("is the cap while the window has room", () => {
    expect(handoffHistoryBudget({ tokenCap: 16_000, userText: "hi" })).toBe(16_000);
  });

  it("charges the request and attachments, leaves a reserve, and stops at zero", () => {
    // 32k window: 16k reserved, 8k an image, the rest is the budget.
    expect(
      handoffHistoryBudget({
        tokenCap: 16_000,
        userText: "",
        attachments: [{ type: "image" }],
        contextWindow: 32_000,
      }),
    ).toBe(32_000 - 16_000 - 8_192 - 2);
    expect(
      handoffHistoryBudget({
        tokenCap: 16_000,
        userText: "x".repeat(200_000),
      }),
    ).toBe(0);
  });
});

const say = (id: string, role: "user" | "assistant", text: string, second: number) => ({
  id,
  role,
  text,
  createdAt: `2026-10-30T10:00:${String(second).padStart(2, "0")}.000Z`,
});

const command = (id: string, input: string, second: number, status = "completed") => ({
  id: id as never,
  tone: "tool" as const,
  kind: "tool.completed",
  summary: "Ran command",
  payload: {
    itemType: "command_execution",
    status,
    detail: "exit 1",
    data: { item: { command: input } },
  },
  turnId: null,
  createdAt: `2026-10-30T10:00:${String(second).padStart(2, "0")}.000Z`,
});

describe("handoffItems", () => {
  it("keeps order and role, adds commands and plans, drops the message being sent", () => {
    const items = handoffItems(
      {
        messages: [
          say("m1", "user", "build it", 1),
          say("m2", "assistant", "done", 4),
          say("m3", "user", "now", 5),
        ],
        activities: [command("a1", "bun test", 2, "failed")],
        proposedPlans: [{ planMarkdown: "1. Do it", createdAt: "2026-10-30T10:00:03.000Z" }],
      },
      "m3",
    );
    expect(items.map((item) => [item.role, item.label])).toEqual([
      ["user", "User"],
      ["assistant", "Command (failed)"],
      ["assistant", "Plan"],
      ["assistant", "Assistant"],
    ]);
    expect(items[1]?.text).toBe("bun test\nexit 1");
  });

  it("drops notes that only moved the chat along, and a carried preamble", () => {
    const items = handoffItems(
      {
        messages: [
          say("m1", "user", wrapHandoffPreamble("User: older"), 1),
          say(
            "m2",
            "user",
            "(Uno Work) Your plan's limit has reset. Continue where you left off, without repeating finished work.",
            2,
          ),
          say("m3", "assistant", "partial work", 3),
        ],
        activities: [],
      },
      "none",
    );
    expect(items.map((item) => item.text)).toEqual(["partial work"]);
  });
});

describe("selectHandoffItems", () => {
  const items = [
    { role: "user", label: "User", text: "the original ask", createdAt: "1" },
    { role: "assistant", label: "Assistant", text: "a".repeat(300), createdAt: "2" },
    { role: "user", label: "User", text: "b".repeat(300), createdAt: "3" },
    { role: "assistant", label: "Assistant", text: "the last answer", createdAt: "4" },
    { role: "user", label: "User", text: "the last ask", createdAt: "5" },
  ] as const;

  it("carries a short chat whole", () => {
    expect(selectHandoffItems(items, 16_000)).toEqual(items);
  });

  it("puts the last ask, the last answer and the original ask first, keeping their order", () => {
    expect(selectHandoffItems(items, 90).map((item) => item.text)).toEqual([
      "the original ask",
      "the last answer",
      "the last ask",
    ]);
  });

  it("skips what doesn't fit whole, never cuts it", () => {
    const selected = selectHandoffItems(items, 400);
    expect(selected.map((item) => item.text.length)).toEqual([16, 300, 15, 12]);
  });
});

describe("buildAgentSwitchSeed", () => {
  const thread = (count: number, size = 40) => ({
    messages: Array.from({ length: count }, (_, index) =>
      say(
        `m${index}`,
        index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        `${String(index).padStart(3, "0")}${"x".repeat(size)}`,
        index % 60,
      ),
    ),
    activities: [],
  });

  it("says nothing when the chat has nothing to carry", () => {
    expect(
      buildAgentSwitchSeed({
        threadId: "t",
        thread: { messages: [], activities: [] },
        currentMessageId: "none",
        fromAgent: "Codex",
        budget: 16_000,
      }),
    ).toBeNull();
  });

  it("carries a short chat whole and says so", () => {
    const seed = buildAgentSwitchSeed({
      threadId: "t",
      thread: thread(4),
      currentMessageId: "none",
      fromAgent: "Codex",
      budget: 16_000,
    });
    expect(seed).toMatchObject({ carried: 4, total: 4 });
    expect(seed?.text).toContain("This chat was with Codex");
    expect(seed?.text).toContain("This is the whole chat.");
    expect(seed?.text).toContain(HANDOFF_PREAMBLE_START);
    expect(seed?.text).toContain(HANDOFF_PREAMBLE_END);
    expect(seed?.text).toContain("not a new request");
  });

  it("stays within the budget and points at what was left out", () => {
    const seed = buildAgentSwitchSeed({
      threadId: "thread-7",
      thread: thread(400),
      currentMessageId: "none",
      fromAgent: "Codex",
      budget: 16_000,
    });
    expect(seed?.total).toBe(400);
    expect(seed?.carried).toBeLessThan(400);
    expect(Buffer.byteLength(seed?.text ?? "")).toBeLessThanOrEqual(16_000);
    expect(seed?.text).toContain(`${400 - (seed?.carried ?? 0)} of 400 items are left out`);
    expect(seed?.text).toContain('threadId "thread-7"');
    // The original ask survives a long chat.
    expect(seed?.text).toContain("User: 000");
  });

  it("with no room left the agent still hears the chat exists", () => {
    const seed = buildAgentSwitchSeed({
      threadId: "t",
      thread: thread(4),
      currentMessageId: "none",
      fromAgent: "Codex",
      budget: 0,
    });
    expect(seed).toMatchObject({ carried: 0, total: 4 });
    expect(seed?.text).toContain("chat_status");
    expect(seed?.text).not.toContain(HANDOFF_PREAMBLE_START);
  });

  it("names the other account instead of an agent, and warns about outside text", () => {
    const seed = buildAgentSwitchSeed({
      threadId: "t",
      thread: thread(2),
      currentMessageId: "none",
      fromAgent: null,
      budget: 16_000,
      holdsOutsideText: true,
    });
    expect(seed?.text).toContain("on the person's other account");
    expect(seed?.text).toContain("came from outside Uno");
  });

  it("never touches the person's request", () => {
    const request = "x".repeat(50_000);
    expect(applyHandoffSeed("seed", request).endsWith(request)).toBe(true);
  });
});

describe("agentSwitchStillOwed", () => {
  const switched = {
    id: "a1" as never,
    tone: "info" as const,
    kind: "chat.agent-switched",
    summary: "Switched to Claude",
    payload: {
      to: "Claude",
      toInstanceId: "claudeAgent",
      fromInstanceId: "codex",
      carried: 2,
      total: 2,
      turnCount: 1,
    },
    turnId: null,
    createdAt: "2026-10-30T10:00:10.000Z",
  };

  it("is false for a chat that never moved", () => {
    expect(agentSwitchStillOwed({ messages: [], activities: [] })).toBe(false);
  });

  it("is true until the new agent answers or finishes a turn", () => {
    expect(
      agentSwitchStillOwed({
        messages: [say("m1", "assistant", "before", 5)],
        activities: [switched],
      }),
    ).toBe(true);
    expect(
      agentSwitchStillOwed({
        messages: [say("m2", "assistant", "after", 20)],
        activities: [switched],
      }),
    ).toBe(false);
    expect(
      agentSwitchStillOwed({
        messages: [],
        activities: [switched],
        latestTurn: { state: "completed", completedAt: "2026-10-30T10:00:20.000Z" },
      }),
    ).toBe(false);
  });
});
