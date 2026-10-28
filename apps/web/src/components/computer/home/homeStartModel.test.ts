import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vitest";

import {
  claudePlanStartSelection,
  homeStartModelSelection,
  newChatModelSelection,
  newThreadStartSelection,
} from "./homeStartModel";

function provider(input: {
  provider: string;
  installed?: boolean;
  authStatus?: ServerProvider["auth"]["status"];
  models: ReadonlyArray<string>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.provider),
    driver: ProviderDriverKind.make(input.provider),
    enabled: true,
    installed: input.installed ?? true,
    version: null,
    status: "ready",
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  };
}

const uno = provider({
  provider: "uno",
  models: ["uno/~anthropic/claude-sonnet-latest", "uno/moonshotai/kimi-k2.7-code"],
});
const claude = provider({
  provider: "claudeAgent",
  models: ["claude-opus-4-7", "claude-sonnet-5"],
});
const id = (value: string) => ProviderInstanceId.make(value);

describe("homeStartModelSelection", () => {
  it("is what a new chat gets with nothing picked: the machine's usable default", () => {
    expect(
      homeStartModelSelection({
        stickyActiveProvider: null,
        stickyModelSelectionByProvider: {},
        providers: [uno, claude],
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ instanceId: "uno", model: "uno/moonshotai/kimi-k2.7-code" });
  });

  it("follows the last pick in any chat, options included", () => {
    const sticky = {
      instanceId: id("claudeAgent"),
      model: "claude-sonnet-5",
      options: [{ id: "effort", value: "high" }],
    };
    expect(
      homeStartModelSelection({
        stickyActiveProvider: id("claudeAgent"),
        stickyModelSelectionByProvider: { [id("claudeAgent")]: sticky },
        providers: [uno, claude],
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual(sticky);
  });

  it("drops a pick whose harness is gone from this computer", () => {
    expect(
      homeStartModelSelection({
        stickyActiveProvider: id("claudeAgent"),
        stickyModelSelectionByProvider: {
          [id("claudeAgent")]: { instanceId: id("claudeAgent"), model: "claude-sonnet-5" },
        },
        providers: [uno, { ...claude, installed: false }],
        settings: DEFAULT_UNIFIED_SETTINGS,
      })?.instanceId,
    ).toBe("uno");
  });
});

describe("New chats start on (15.10)", () => {
  const sticky = {
    stickyActiveProvider: id("uno"),
    stickyModelSelectionByProvider: {
      [id("uno")]: { instanceId: id("uno"), model: "uno/moonshotai/kimi-k2.7-code" },
    },
  };
  const choose = (instanceId: string, model: string) => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    newChatModelSelection: { instanceId: id(instanceId), model },
  });

  it("is off by default: new chats follow the last pick", () => {
    expect(DEFAULT_UNIFIED_SETTINGS.newChatModelSelection).toBeNull();
    expect(
      newChatModelSelection({ providers: [uno, claude], settings: DEFAULT_UNIFIED_SETTINGS }),
    ).toBeNull();
    expect(
      homeStartModelSelection({
        ...sticky,
        providers: [uno, claude],
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ instanceId: "uno", model: "uno/moonshotai/kimi-k2.7-code" });
  });

  it("wins over the last pick in any chat", () => {
    expect(
      homeStartModelSelection({
        ...sticky,
        providers: [uno, claude],
        settings: choose("claudeAgent", "claude-sonnet-5"),
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5" });
  });

  it("falls back to the last pick when its harness is off or not installed", () => {
    for (const gone of [
      { ...claude, enabled: false },
      { ...claude, installed: false },
    ]) {
      const settings = choose("claudeAgent", "claude-sonnet-5");
      expect(newChatModelSelection({ providers: [uno, gone], settings })).toBeNull();
      expect(
        homeStartModelSelection({ ...sticky, providers: [uno, gone], settings })?.instanceId,
      ).toBe("uno");
    }
  });

  it("falls back when the harness is gone from this computer", () => {
    expect(
      newChatModelSelection({
        providers: [uno],
        settings: choose("claudeAgent", "claude-sonnet-5"),
      }),
    ).toBeNull();
  });

  it("falls back when its model is no longer listed, rather than picking another", () => {
    const settings = choose("claudeAgent", "claude-retired-1");
    expect(newChatModelSelection({ providers: [uno, claude], settings })).toBeNull();
    expect(homeStartModelSelection({ ...sticky, providers: [uno, claude], settings })).toEqual({
      instanceId: "uno",
      model: "uno/moonshotai/kimi-k2.7-code",
    });
  });

  it("falls back to the machine default with no last pick either", () => {
    expect(
      homeStartModelSelection({
        stickyActiveProvider: null,
        stickyModelSelectionByProvider: {},
        providers: [uno, { ...claude, installed: false }],
        settings: choose("claudeAgent", "claude-sonnet-5"),
      }),
    ).toEqual({ instanceId: "uno", model: "uno/moonshotai/kimi-k2.7-code" });
  });
});

describe("a harness not signed in on this computer", () => {
  const codexSignedOut = provider({
    provider: "codex",
    authStatus: "unauthenticated",
    models: ["gpt-5.5-codex"],
  });
  const providers = [uno, claude, codexSignedOut];
  const codexPick = { instanceId: id("codex"), model: "gpt-5.5-codex" };

  it("isn't where Home starts after it was picked elsewhere", () => {
    expect(
      homeStartModelSelection({
        stickyActiveProvider: id("codex"),
        stickyModelSelectionByProvider: { [id("codex")]: codexPick },
        providers,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ instanceId: "uno", model: "uno/moonshotai/kimi-k2.7-code" });
  });

  it("turns 'New chats start on' off here", () => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, newChatModelSelection: codexPick };
    expect(newChatModelSelection({ providers, settings })).toBeNull();
  });

  it("makes New chat start on the usable default instead of the sticky pick", () => {
    expect(
      newThreadStartSelection({
        stickyActiveProvider: id("codex"),
        projectDefault: null,
        providers,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ instanceId: "uno", model: "uno/moonshotai/kimi-k2.7-code" });
  });

  it("isn't where New chat starts when a project added by the CLI defaults to it", () => {
    expect(
      newThreadStartSelection({
        stickyActiveProvider: null,
        projectDefault: codexPick,
        providers,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ instanceId: "uno", model: "uno/moonshotai/kimi-k2.7-code" });
  });

  it("leaves a project default that runs here alone", () => {
    expect(
      newThreadStartSelection({
        stickyActiveProvider: null,
        projectDefault: { instanceId: id("claudeAgent"), model: "claude-sonnet-5" },
        providers,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toBeNull();
  });

  it("waits for the computer's harness list before re-pointing anything", () => {
    expect(
      newThreadStartSelection({
        stickyActiveProvider: null,
        projectDefault: codexPick,
        providers: [],
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toBeNull();
  });

  it("leaves a signed-in sticky pick alone", () => {
    expect(
      newThreadStartSelection({
        stickyActiveProvider: id("claudeAgent"),
        projectDefault: codexPick,
        providers,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toBeNull();
  });
});

describe("Home for someone who came for their own agent (goal own_agent)", () => {
  const hermes = provider({ provider: "hermes", models: ["uno/smart", "uno/fast"] });
  const opencode = provider({
    provider: "opencode",
    models: ["opencode/big-pickle", "uno/anthropic/claude-sonnet-5.5", "uno/uno/smart"],
  });
  const claudeOwn = {
    ...provider({ provider: "claudeAgent", models: ["claude-sonnet-5", "claude-opus-4-7"] }),
    auth: { status: "authenticated", type: "subscription" },
  } as ServerProvider;
  const claudeOnUnoAi = {
    ...claudeOwn,
    auth: { status: "authenticated", type: "unoAi" },
  } as ServerProvider;
  const codexOut = provider({
    provider: "codex",
    authStatus: "unauthenticated",
    models: ["gpt-5.5"],
  });
  const start = (
    providers: ReadonlyArray<ServerProvider>,
    ownAgent: { picked: "claudeAgent" | "codex" | null } | null,
    sticky: { instanceId: string; model: string } | null = null,
  ) =>
    homeStartModelSelection({
      stickyActiveProvider: sticky ? id(sticky.instanceId) : null,
      stickyModelSelectionByProvider: sticky
        ? { [sticky.instanceId]: { instanceId: id(sticky.instanceId), model: sticky.model } }
        : {},
      providers,
      settings: DEFAULT_UNIFIED_SETTINGS,
      ownAgent,
    });

  it("starts on OpenCode · Smart when no agent of theirs is signed in (agent-flow 25.10: was uno · Smart)", () => {
    expect(start([hermes, uno, opencode, claudeOnUnoAi, codexOut], { picked: null })).toEqual({
      instanceId: "opencode",
      model: "uno/uno/smart",
    });
    // Everyone else keeps the machine default.
    expect(start([hermes, uno, opencode, claudeOnUnoAi, codexOut], null)?.instanceId).toBe(
      "hermes",
    );
  });

  it("starts on the agent they signed in with their own account, the picked one first", () => {
    expect(start([hermes, opencode, claudeOwn, codexOut], { picked: null })?.instanceId).toBe(
      "claudeAgent",
    );
    expect(start([hermes, opencode, claudeOwn, codexOut], { picked: "codex" })?.instanceId).toBe(
      "claudeAgent",
    );
  });

  it("a pick made in a chat still wins", () => {
    expect(
      start(
        [hermes, opencode, claudeOwn],
        { picked: null },
        {
          instanceId: "hermes",
          model: "uno/fast",
        },
      ),
    ).toEqual({ instanceId: "hermes", model: "uno/fast" });
  });

  it("OpenCode picked in the configurator: OpenCode · Smart first, even with Claude Code signed in", () => {
    const providers = [hermes, opencode, claudeOwn, codexOut];
    expect(
      homeStartModelSelection({
        stickyActiveProvider: null,
        stickyModelSelectionByProvider: {},
        providers,
        settings: DEFAULT_UNIFIED_SETTINGS,
        ownAgent: { picked: null, openCodeFirst: true },
      }),
    ).toEqual({ instanceId: "opencode", model: "uno/uno/smart" });
    // No OpenCode on this computer: the agent they signed in with.
    expect(
      homeStartModelSelection({
        stickyActiveProvider: null,
        stickyModelSelectionByProvider: {},
        providers: [hermes, claudeOwn],
        settings: DEFAULT_UNIFIED_SETTINGS,
        ownAgent: { picked: null, openCodeFirst: true },
      })?.instanceId,
    ).toBe("claudeAgent");
  });

  it("no OpenCode and no agent of theirs: the usual default", () => {
    expect(start([hermes, uno], { picked: "claudeAgent" })?.instanceId).toBe("hermes");
  });
});

describe("New chat for someone who picked only OpenCode in the configurator (28.10, 0.0.155)", () => {
  // Account 2707's walk: default_ai=opencode, goal own_agent; the project was
  // seeded with the machine default (Uno · Smart) before anything was picked.
  const hermes = provider({ provider: "hermes", models: ["uno/smart", "uno/fast"] });
  const opencode = provider({
    provider: "opencode",
    models: ["uno/uno/smart", "uno/uno/fast", "opencode/big-pickle"],
  });
  const claudeOnUnoAi = {
    ...provider({ provider: "claudeAgent", models: ["claude-sonnet-5"] }),
    auth: { status: "authenticated", type: "unoAi" },
  } as ServerProvider;
  const onlyOpenCode = { picked: null, openCodeFirst: true } as const;
  const projectDefault = { instanceId: id("hermes"), model: "uno/smart" };
  const newChat = (
    ownAgent: { picked: null; openCodeFirst?: boolean } | null,
    stickyActiveProvider: string | null = null,
  ) =>
    newThreadStartSelection({
      stickyActiveProvider: stickyActiveProvider ? id(stickyActiveProvider) : null,
      projectDefault,
      providers: [hermes, uno, opencode, claudeOnUnoAi],
      settings: DEFAULT_UNIFIED_SETTINGS,
      ownAgent,
    });

  it("opens on OpenCode · Smart, not on the project's seeded uno · Smart", () => {
    expect(newChat(onlyOpenCode)).toEqual({ instanceId: "opencode", model: "uno/uno/smart" });
    // Home's box agrees.
    expect(
      homeStartModelSelection({
        stickyActiveProvider: null,
        stickyModelSelectionByProvider: {},
        providers: [hermes, uno, opencode, claudeOnUnoAi],
        settings: DEFAULT_UNIFIED_SETTINGS,
        ownAgent: onlyOpenCode,
      }),
    ).toEqual({ instanceId: "opencode", model: "uno/uno/smart" });
  });

  it("everyone else keeps the project's start (null: the draft's own)", () => {
    expect(newChat(null)).toBeNull();
  });

  it("a pick the person made in a chat still wins", () => {
    expect(newChat(onlyOpenCode, "hermes")).toBeNull();
  });

  it("OpenCode not usable here: the old behaviour", () => {
    expect(
      newThreadStartSelection({
        stickyActiveProvider: null,
        projectDefault,
        providers: [hermes, uno],
        settings: DEFAULT_UNIFIED_SETTINGS,
        ownAgent: onlyOpenCode,
      }),
    ).toBeNull();
  });
});

describe("Claude plan signed in here → new chats on Claude, none → Uno · Smart (Misha 28.10, P2)", () => {
  // Cap walkthrough 28.10: Claude Code signed in to the person's plan, the
  // next new chat in a project still opened on "uno · Smart".
  const hermes = provider({ provider: "hermes", models: ["uno/smart", "uno/fast"] });
  const opencode = provider({
    provider: "opencode",
    models: ["uno/uno/smart", "uno/uno/fast"],
  });
  const claudePlan = {
    ...provider({ provider: "claudeAgent", models: ["claude-opus-5-5", "claude-sonnet-5-5"] }),
    auth: { status: "authenticated", type: "max", label: "Claude Max Subscription" },
  } as ServerProvider;
  const claudeOnUnoAi = {
    ...claudePlan,
    auth: { status: "authenticated", type: "unoAi", label: "Uno AI" },
  } as ServerProvider;
  const claudeApiKey = {
    ...claudePlan,
    auth: { status: "authenticated", type: "apiKey", label: "Claude API Key" },
  } as ServerProvider;
  const claudeOut = {
    ...claudePlan,
    auth: { status: "unauthenticated" },
  } as ServerProvider;
  const projectDefault = { instanceId: id("uno"), model: "uno/moonshotai/kimi-k2.7-code" };
  const home = (providers: ReadonlyArray<ServerProvider>, sticky: string | null = null) =>
    homeStartModelSelection({
      stickyActiveProvider: sticky ? id(sticky) : null,
      stickyModelSelectionByProvider: sticky
        ? { [sticky]: { instanceId: id(sticky), model: "uno/fast" } }
        : {},
      providers,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
  const newChat = (providers: ReadonlyArray<ServerProvider>, sticky: string | null = null) =>
    newThreadStartSelection({
      stickyActiveProvider: sticky ? id(sticky) : null,
      projectDefault,
      providers,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

  it("Home's box and New chat start on Claude", () => {
    expect(home([hermes, uno, opencode, claudePlan])?.instanceId).toBe("claudeAgent");
    expect(newChat([hermes, uno, opencode, claudePlan])?.instanceId).toBe("claudeAgent");
    expect(
      claudePlanStartSelection({
        providers: [uno, claudePlan],
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ instanceId: "claudeAgent", model: home([uno, claudePlan])?.model });
  });

  it("no plan of theirs (Claude on Uno AI, an API key, signed out): Uno as before", () => {
    for (const claude of [claudeOnUnoAi, claudeApiKey, claudeOut]) {
      expect(home([uno, claude])?.instanceId).toBe("uno");
      // New chat keeps the project's own start.
      expect(newChat([uno, claude])).toBeNull();
    }
  });

  it("a model the person picked in a chat still wins", () => {
    expect(home([hermes, uno, claudePlan], "hermes")).toEqual({
      instanceId: "hermes",
      model: "uno/fast",
    });
    expect(newChat([hermes, uno, claudePlan], "hermes")).toBeNull();
  });

  it("'New chats start on' still wins", () => {
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      newChatModelSelection: { instanceId: id("hermes"), model: "uno/smart" },
    };
    expect(
      homeStartModelSelection({
        stickyActiveProvider: null,
        stickyModelSelectionByProvider: {},
        providers: [hermes, uno, claudePlan],
        settings,
      }),
    ).toEqual({ instanceId: "hermes", model: "uno/smart" });
  });

  it("OpenCode picked in the configurator stays first (0.0.156)", () => {
    expect(
      newThreadStartSelection({
        stickyActiveProvider: null,
        projectDefault,
        providers: [hermes, uno, opencode, claudePlan],
        settings: DEFAULT_UNIFIED_SETTINGS,
        ownAgent: { picked: null, openCodeFirst: true },
      }),
    ).toEqual({ instanceId: "opencode", model: "uno/uno/smart" });
  });
});
