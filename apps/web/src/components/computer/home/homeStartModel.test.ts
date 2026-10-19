import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vitest";

import {
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
        providers,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toEqual({ instanceId: "uno", model: "uno/moonshotai/kimi-k2.7-code" });
  });

  it("leaves a signed-in sticky pick alone", () => {
    expect(
      newThreadStartSelection({
        stickyActiveProvider: id("claudeAgent"),
        providers,
        settings: DEFAULT_UNIFIED_SETTINGS,
      }),
    ).toBeNull();
  });
});
