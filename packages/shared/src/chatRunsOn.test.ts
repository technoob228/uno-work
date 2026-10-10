import { describe, expect, it } from "vitest";

import { assistantModelSelection } from "./assistantLlm.ts";
import {
  CHAT_RUNS_ON_HINT,
  CHAT_RUNS_ON_LABEL,
  chatRunsOn,
  chatRunsOnLabel,
  isOwnSubscription,
  type RunsOnProvider,
} from "./chatRunsOn.ts";

const provider = (driver: string, auth: RunsOnProvider["auth"]): RunsOnProvider =>
  ({ driver, auth }) as RunsOnProvider;

describe("what a chat runs on", () => {
  it("Uno's own harness is Uno AI whatever its auth says", () => {
    expect(chatRunsOn({ provider: provider("uno", { status: "unknown" }) })).toBe("uno-ai");
  });

  it("a Hermes chat is Uno AI on the gateway and a key on a brought provider", () => {
    const hermes = provider("hermes", { status: "authenticated" });
    expect(chatRunsOn({ provider: hermes })).toBe("uno-ai");
    expect(
      chatRunsOn({
        provider: hermes,
        modelSelection: assistantModelSelection({ provider: "uno", model: "uno/smart" }),
      }),
    ).toBe("uno-ai");
    expect(
      chatRunsOn({
        provider: hermes,
        modelSelection: assistantModelSelection({ provider: "xai", model: "grok-latest" }),
      }),
    ).toBe("own-key");
  });

  it("Claude Code: the person's subscription only when they signed in themselves", () => {
    expect(
      chatRunsOn({ provider: provider("claudeAgent", { status: "authenticated", type: "max" }) }),
    ).toBe("claude-plan");
    // Signed in, the probe found no plan name: still their own account.
    expect(chatRunsOn({ provider: provider("claudeAgent", { status: "authenticated" }) })).toBe(
      "claude-plan",
    );
    // Claude Code on Uno AI (paid plans, no sign-in): Uno's money, not "your plan".
    expect(
      chatRunsOn({ provider: provider("claudeAgent", { status: "authenticated", type: "unoAi" }) }),
    ).toBe("uno-ai");
    expect(
      chatRunsOn({
        provider: provider("claudeAgent", { status: "authenticated", type: "apiKey" }),
      }),
    ).toBe("own-key");
  });

  it("Codex: ChatGPT subscription or an OpenAI key", () => {
    expect(
      chatRunsOn({ provider: provider("codex", { status: "authenticated", type: "chatgpt" }) }),
    ).toBe("chatgpt-plan");
    expect(
      chatRunsOn({ provider: provider("codex", { status: "authenticated", type: "apiKey" }) }),
    ).toBe("own-key");
  });

  it("says nothing when the daemon can't tell", () => {
    expect(chatRunsOn({ provider: null })).toBeNull();
    expect(chatRunsOn({ provider: undefined })).toBeNull();
    expect(chatRunsOn({ provider: provider("claudeAgent", { status: "unauthenticated" }) })).toBe(
      null,
    );
    expect(chatRunsOn({ provider: provider("codex", { status: "unknown" }) })).toBeNull();
    expect(chatRunsOn({ provider: provider("opencode", { status: "authenticated" }) })).toBeNull();
    expect(
      chatRunsOn({ provider: provider("harness-kimi", { status: "authenticated" }) }),
    ).toBeNull();
  });

  it("Cursor is the person's Cursor plan", () => {
    expect(chatRunsOn({ provider: provider("cursor", { status: "authenticated" }) })).toBe(
      "cursor-plan",
    );
  });
});

describe("the header's words", () => {
  it("names each case in plain words", () => {
    expect(CHAT_RUNS_ON_LABEL).toEqual({
      "uno-ai": "Uno AI",
      "claude-plan": "Your Claude plan",
      "chatgpt-plan": "Your ChatGPT plan",
      "cursor-plan": "Your Cursor plan",
      "own-key": "Your own key",
    });
    expect(chatRunsOnLabel(null)).toBeNull();
    expect(chatRunsOnLabel("claude-plan")).toBe("Your Claude plan");
  });

  it("every hint says who pays, and a subscription's says Uno doesn't charge", () => {
    for (const hint of Object.values(CHAT_RUNS_ON_HINT)) {
      expect(hint).toMatch(/^This chat runs on /);
    }
    expect(CHAT_RUNS_ON_HINT["claude-plan"]).toContain("Uno doesn't charge");
    expect(CHAT_RUNS_ON_HINT["chatgpt-plan"]).toContain("Uno doesn't charge");
    expect(CHAT_RUNS_ON_HINT["uno-ai"]).toContain("AI time");
  });

  it("only Claude and ChatGPT plans count as the person's subscription", () => {
    expect(isOwnSubscription("claude-plan")).toBe(true);
    expect(isOwnSubscription("chatgpt-plan")).toBe(true);
    expect(isOwnSubscription("uno-ai")).toBe(false);
    expect(isOwnSubscription("own-key")).toBe(false);
    expect(isOwnSubscription("cursor-plan")).toBe(false);
    expect(isOwnSubscription(null)).toBe(false);
  });
});
