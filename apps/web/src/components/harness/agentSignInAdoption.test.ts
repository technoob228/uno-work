import {
  type AssistantLlmStatus,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vitest";

import { assistantAdoption, signedInChatSelection } from "./agentSignInAdoption";

/**
 * Cap walkthrough 28.10 (P3): Claude Code signed in on the start screen, then
 * Settings → AI asked "Your Claude plan — Sign in to Claude" all over again.
 * One sign-in now moves the assistant onto the plan as well.
 */
function status(input: {
  provider?: AssistantLlmStatus["provider"];
  claude?: "ready" | "sign-in" | "unavailable" | "needs-hermes" | null;
  subscriptions?: boolean;
}): AssistantLlmStatus {
  return {
    threadId: "assistant",
    provider: input.provider ?? "uno",
    model: "uno/smart",
    harness: { state: "ready" } as AssistantLlmStatus["harness"],
    keys: [],
    gatewayConfigured: true,
    ...(input.subscriptions === false
      ? {}
      : {
          subscriptions:
            input.claude === null
              ? []
              : [
                  {
                    provider: "claude",
                    state: input.claude ?? "ready",
                    plan: "Claude Max",
                    account: "a@b.c",
                    signIn: "harness",
                    message: null,
                  },
                ],
        }),
  } as AssistantLlmStatus;
}

describe("the assistant after a Claude sign-in", () => {
  it("moves to the Claude plan while it runs on Uno AI", () => {
    expect(assistantAdoption({ driver: "claudeAgent", method: "oauth", status: status({}) })).toBe(
      "switch",
    );
  });

  it("waits while the computer hasn't seen the new sign-in", () => {
    expect(
      assistantAdoption({
        driver: "claudeAgent",
        method: "oauth",
        status: status({ claude: "sign-in" }),
      }),
    ).toBe("wait");
    expect(assistantAdoption({ driver: "claudeAgent", method: "oauth", status: null })).toBe(
      "wait",
    );
  });

  it("leaves a choice of the person's own alone", () => {
    for (const provider of ["xai", "chatgpt", "claude", "openrouter"] as const) {
      expect(
        assistantAdoption({ driver: "claudeAgent", method: "oauth", status: status({ provider }) }),
      ).toBe("skip");
    }
  });

  it("does nothing for an API key, Codex, or where the plan can't run", () => {
    expect(assistantAdoption({ driver: "claudeAgent", method: "apiKey", status: status({}) })).toBe(
      "skip",
    );
    expect(assistantAdoption({ driver: "codex", method: "oauth", status: status({}) })).toBe(
      "skip",
    );
    expect(
      assistantAdoption({
        driver: "claudeAgent",
        method: "oauth",
        status: status({ claude: "unavailable" }),
      }),
    ).toBe("skip");
    // An older daemon: no plans for the assistant there.
    expect(
      assistantAdoption({
        driver: "claudeAgent",
        method: "oauth",
        status: status({ subscriptions: false }),
      }),
    ).toBe("skip");
  });
});

describe("new chats after a sign-in", () => {
  const claude: ServerProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", type: "max" },
    checkedAt: "2026-10-28T00:00:00.000Z",
    models: [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  };

  it("start on the agent that just signed in", () => {
    expect(
      signedInChatSelection({
        driver: "claudeAgent",
        providers: [claude],
        settings: DEFAULT_UNIFIED_SETTINGS,
      })?.instanceId,
    ).toBe("claudeAgent");
  });

  it("stay as they are when that agent isn't on this computer", () => {
    expect(
      signedInChatSelection({
        driver: "codex",
        providers: [claude],
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toBeNull();
  });
});
