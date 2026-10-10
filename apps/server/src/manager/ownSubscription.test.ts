import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ASSISTANT_INSTRUCTIONS_TEMPLATE } from "./Layers/AssistantService.ts";
import { AI_STATUS_UNKNOWN, handleManagerMcpMessage, MANAGER_MCP_TOOLS } from "./mcp.ts";
import {
  AI_STATUS_RULE_SUBSCRIPTION,
  AI_STATUS_RULE_UNO_AI,
  aiStatus,
  isKnownUnrunnable,
  ownSubscriptions,
  pickSpawnSelection,
} from "./ownSubscription.ts";

const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    auth: { status: "authenticated", type: "max", label: "Claude Max Subscription" },
    checkedAt: "2026-10-10T00:00:00.000Z",
    models: [
      { slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: null },
      { slug: "claude-sonnet-5-5", name: "Sonnet", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

const claudeSignedIn = provider({});
const claudeOnUnoAi = provider({
  auth: { status: "authenticated", type: "unoAi", label: "Uno AI" } as never,
});
const claudeSignedOut = provider({
  status: "warning",
  auth: { status: "unauthenticated" } as never,
});
const claudeApiKey = provider({
  auth: { status: "authenticated", type: "apiKey", label: "Claude API Key" } as never,
});
const codexSignedIn = provider({
  instanceId: "codex" as never,
  driver: "codex" as never,
  displayName: "Codex",
  auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Plus Subscription" } as never,
  models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }] as never,
});
const codexSignedOut = provider({
  instanceId: "codex" as never,
  driver: "codex" as never,
  status: "error",
  auth: { status: "unauthenticated" } as never,
  models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }] as never,
});
const uno = provider({
  instanceId: "uno" as never,
  driver: "uno" as never,
  auth: { status: "authenticated" } as never,
  models: [{ slug: "uno/uno/smart", name: "Smart", isCustom: false, capabilities: null }] as never,
});

const selection = (instanceId: string, model: string) =>
  ({ instanceId, model }) as unknown as ModelSelection;

describe("the owner's subscription, from what the daemon's probes found", () => {
  it("counts a harness the owner signed in to themselves", () => {
    expect(ownSubscriptions([uno, claudeSignedIn, codexSignedIn])).toMatchObject([
      {
        harness: "claudeAgent",
        name: "Claude",
        plan: "Claude Max Subscription",
        runsOn: "claude-plan",
        models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      },
      { harness: "codex", name: "ChatGPT", runsOn: "chatgpt-plan" },
    ]);
  });

  it("Claude Code on Uno AI, an API key, a signed-out or switched-off harness are not it", () => {
    expect(ownSubscriptions([claudeOnUnoAi])).toEqual([]);
    expect(ownSubscriptions([claudeApiKey])).toEqual([]);
    expect(ownSubscriptions([claudeSignedOut, codexSignedOut])).toEqual([]);
    expect(ownSubscriptions([provider({ enabled: false })])).toEqual([]);
    expect(ownSubscriptions([provider({ installed: false })])).toEqual([]);
    expect(ownSubscriptions([])).toEqual([]);
  });

  it("the account's default AI goes first when it is one of them", () => {
    const both = [claudeSignedIn, codexSignedIn];
    expect(ownSubscriptions(both).map((entry) => entry.harness)).toEqual(["claudeAgent", "codex"]);
    expect(ownSubscriptions(both, "codex").map((entry) => entry.harness)).toEqual([
      "codex",
      "claudeAgent",
    ]);
  });
});

describe("what a chat Uno starts runs on", () => {
  it("no model named: the signed-in subscription, whatever the account's default AI", () => {
    for (const defaultAi of [null, "uno", "claude", "byok"]) {
      expect(
        pickSpawnSelection({ requested: null, defaultAi, providers: [uno, claudeSignedIn] }),
      ).toEqual({ instanceId: "claudeAgent", model: claudeSignedIn.models[0]?.slug });
    }
    expect(
      pickSpawnSelection({
        requested: null,
        defaultAi: "codex",
        providers: [uno, claudeSignedIn, codexSignedIn],
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.4" });
  });

  it("no subscription: as before — the account's AI when usable, else the project's default", () => {
    expect(
      pickSpawnSelection({ requested: null, defaultAi: "uno", providers: [uno, claudeOnUnoAi] }),
    ).toEqual({ instanceId: "uno", model: "uno/uno/smart" });
    expect(
      pickSpawnSelection({ requested: null, defaultAi: null, providers: [uno, claudeOnUnoAi] }),
    ).toBeNull();
    expect(
      pickSpawnSelection({ requested: null, defaultAi: "claude", providers: [claudeSignedOut] }),
    ).toBeNull();
  });

  it("a model Uno named is kept when this computer can run it", () => {
    const named = selection("claudeAgent", "claude-sonnet-5-5");
    expect(
      pickSpawnSelection({ requested: named, defaultAi: "uno", providers: [uno, claudeSignedIn] }),
    ).toBe(named);
    // Claude Code on Uno AI runs (premium credit): Uno asked for it by name.
    expect(
      pickSpawnSelection({
        requested: named,
        defaultAi: "uno",
        providers: [uno, claudeOnUnoAi, codexSignedIn],
      }),
    ).toBe(named);
    // A harness the daemon doesn't list: no signal, left alone.
    const foreign = selection("harness-kimi", "default");
    expect(pickSpawnSelection({ requested: foreign, defaultAi: null, providers: [uno] })).toBe(
      foreign,
    );
  });

  it("a harness that isn't signed in is replaced, not started to fail", () => {
    const named = selection("claudeAgent", "claude-opus-5-5");
    // Claude signed out, ChatGPT signed in → the ChatGPT subscription.
    expect(
      pickSpawnSelection({
        requested: named,
        defaultAi: "uno",
        providers: [uno, claudeSignedOut, codexSignedIn],
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.4" });
    // No subscription at all → Uno AI (the account's AI).
    expect(
      pickSpawnSelection({
        requested: named,
        defaultAi: "uno",
        providers: [uno, claudeSignedOut],
      }),
    ).toEqual({ instanceId: "uno", model: "uno/uno/smart" });
    // Nothing known to fall to → null: the caller keeps what was named.
    expect(
      pickSpawnSelection({ requested: named, defaultAi: null, providers: [claudeSignedOut] }),
    ).toBeNull();
  });

  it("knows a harness can't run only from a real signal", () => {
    const named = selection("claudeAgent", "claude-opus-5-5");
    expect(isKnownUnrunnable(named, [claudeSignedOut])).toBe(true);
    expect(isKnownUnrunnable(named, [provider({ installed: false })])).toBe(true);
    expect(isKnownUnrunnable(named, [provider({ enabled: false })])).toBe(true);
    expect(isKnownUnrunnable(named, [claudeSignedIn])).toBe(false);
    expect(isKnownUnrunnable(named, [claudeOnUnoAi])).toBe(false);
    // Probes not in yet / sign-in not verified: not a "no".
    expect(isKnownUnrunnable(named, [])).toBe(false);
    expect(isKnownUnrunnable(named, [provider({ auth: { status: "unknown" } as never })])).toBe(
      false,
    );
  });
});

describe("ai_status — what Uno is told", () => {
  it("signed in: heavy work goes to the subscription, in the header's words", () => {
    const status = aiStatus({ providers: [uno, claudeSignedIn, codexSignedOut], defaultAi: "uno" });
    expect(status.ownSubscriptions).toEqual([
      {
        harness: "claudeAgent",
        name: "Claude",
        plan: "Claude Max Subscription",
        defaultModel: claudeSignedIn.models[0]?.slug,
        models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      },
    ]);
    expect(status.notSignedIn).toEqual([
      { harness: "codex", name: "ChatGPT", why: "not signed in" },
    ]);
    expect(status.heavyWork.modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: claudeSignedIn.models[0]?.slug,
    });
    expect(status.heavyWork.runsOn).toBe("Your Claude plan");
    expect(status.heavyWork.whoPays).toContain("Uno doesn't charge");
    expect(status.rule).toBe(AI_STATUS_RULE_SUBSCRIPTION);
  });

  it("ChatGPT only: the ChatGPT plan", () => {
    const status = aiStatus({ providers: [uno, claudeOnUnoAi, codexSignedIn], defaultAi: null });
    expect(status.heavyWork.runsOn).toBe("Your ChatGPT plan");
    expect(status.heavyWork.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.4" });
    expect(status.notSignedIn).toEqual([
      { harness: "claudeAgent", name: "Claude", why: "runs on Uno AI" },
    ]);
  });

  it("not signed in: Uno AI, no model to pass, and why each harness isn't it", () => {
    const status = aiStatus({
      providers: [uno, claudeApiKey, provider({ ...codexSignedOut, installed: false })],
      defaultAi: "uno",
    });
    expect(status.ownSubscriptions).toEqual([]);
    expect(status.heavyWork).toEqual({
      modelSelection: null,
      runsOn: "Uno AI",
      whoPays: "Uno AI: the owner's AI time and premium credit.",
    });
    expect(status.rule).toBe(AI_STATUS_RULE_UNO_AI);
    expect(status.notSignedIn).toEqual([
      { harness: "claudeAgent", name: "Claude", why: "API key" },
      { harness: "codex", name: "ChatGPT", why: "not installed" },
    ]);
    // The answer of a wiring that can't see providers is the same "no".
    expect(aiStatus({ providers: [], defaultAi: null })).toEqual(AI_STATUS_UNKNOWN);
  });

  const callTool = (extras: Parameters<typeof handleManagerMcpMessage>[3]) =>
    Effect.runPromise(
      handleManagerMcpMessage(
        {} as never,
        {} as never,
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ai_status" } },
        extras,
      ),
    ).then((outcome) => {
      if (outcome.kind !== "response") throw new Error("expected a response");
      const body = outcome.body as { result: { content: Array<{ text: string }> } };
      return JSON.parse(body.result.content[0]?.text ?? "null") as unknown;
    });

  it("the uno-manager tool answers from the daemon's providers", async () => {
    const status = aiStatus({ providers: [uno, claudeSignedIn], defaultAi: null });
    expect(await callTool({ aiStatus: () => Effect.succeed(status) })).toEqual(status);
    // No provider registry in the wiring: "no subscription known", never a guess.
    expect(await callTool({})).toEqual(AI_STATUS_UNKNOWN);
  });

  it("the tool and create_thread say the same thing to every assistant", () => {
    const tool = (name: string) => MANAGER_MCP_TOOLS.find((entry) => entry.name === name);
    expect(tool("ai_status")?.description).toContain("never guess");
    expect(tool("create_thread")?.description).toContain("ai_status");
  });
});

describe("Uno's instructions", () => {
  it("send heavy work to the subscription by ai_status, not by a guess", () => {
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("## Heavy work");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("call `ai_status`");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("`heavyWork.modelSelection` is null");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("never guess");
    // The limit of a subscription: tell and offer, never silence.
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("don't go silent");
  });
});
