import { describe, expect, it } from "vitest";

import {
  applyHandoffSeed,
  buildContinueSeed,
  buildHandoffContext,
  buildModelFallbackNote,
  CONTINUE_HANDOFF_OPTIONS,
  CONTINUE_SEED_PREFIX,
  HANDOFF_PREAMBLE_END,
  HANDOFF_PREAMBLE_START,
  isContinueSeedText,
  LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START,
  resolvePendingHandoffSeed,
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
