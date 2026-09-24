import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vitest";

import { homeStartModelSelection } from "./homeStartModel";

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
