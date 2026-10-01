import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildSimpleModelChoices,
  hasSimpleModelChoices,
  isSimpleChoiceSelected,
} from "./simpleModelPicker.logic";

const id = (value: string) => value as ProviderInstanceId;
const entry = (instanceId: string, driverKind: string, isDefault = true) => ({
  instanceId: id(instanceId),
  driverKind: driverKind as ProviderDriverKind,
  isDefault,
});
const model = (slug: string, name: string, unoGroup?: string, shortName?: string) => ({
  slug,
  name,
  ...(shortName ? { shortName } : {}),
  ...(unoGroup ? { capabilities: { metadata: { unoGroup } } as never } : {}),
});

const OPTIONS = new Map([
  [
    id("hermes"),
    [
      model("uno/smart", "Uno Smart", "included", "Smart"),
      model("uno/fast", "Uno Fast", "included", "Fast"),
      model("anthropic/claude-sonnet", "Claude Sonnet", "premium"),
      model("my/gpu", "My GPU", "personal"),
    ],
  ],
  [id("uno"), [model("uno/uno/smart", "Smart", "included")]],
  [id("claudeAgent"), [model("claude-opus", "Claude Opus")]],
  [id("codex"), [model("gpt-5", "GPT-5")]],
  [id("opencode"), [model("zen", "Zen")]],
]);

describe("buildSimpleModelChoices", () => {
  it("offers Smart / Fast and Premium from Hermes, and signed-in subscriptions", () => {
    const choices = buildSimpleModelChoices({
      entries: [
        entry("hermes", "hermes"),
        entry("uno", "uno"),
        entry("claudeAgent", "claudeAgent"),
        entry("codex", "codex"),
        entry("opencode", "opencode"),
      ],
      isReady: (e) => e.instanceId !== id("codex"),
      modelOptionsByInstance: OPTIONS,
      activeInstanceId: id("opencode"),
      activeModel: "zen",
    });
    expect(choices.included.map((choice) => choice.label)).toEqual(["Smart", "Fast"]);
    expect(choices.included[0]!.instanceId).toBe("hermes");
    expect(choices.premium.map((choice) => choice.model)).toEqual(["anthropic/claude-sonnet"]);
    // ChatGPT is not signed in here; OpenCode is never offered without Dev mode.
    expect(choices.subscriptions.map((choice) => choice.label)).toEqual(["Claude"]);
  });

  it("keeps the chat's own Uno harness", () => {
    const choices = buildSimpleModelChoices({
      entries: [entry("hermes", "hermes"), entry("uno", "uno")],
      isReady: () => true,
      modelOptionsByInstance: OPTIONS,
      activeInstanceId: id("uno"),
      activeModel: "uno/uno/smart",
    });
    expect(choices.included.map((choice) => choice.instanceId)).toEqual(["uno"]);
  });

  it("is empty when nothing is ready (the full picker then shows)", () => {
    const choices = buildSimpleModelChoices({
      entries: [entry("hermes", "hermes")],
      isReady: () => false,
      modelOptionsByInstance: OPTIONS,
      activeInstanceId: null,
      activeModel: null,
    });
    expect(hasSimpleModelChoices(choices)).toBe(false);
  });

  it("marks a subscription row selected by its harness", () => {
    const choices = buildSimpleModelChoices({
      entries: [entry("claudeAgent", "claudeAgent")],
      isReady: () => true,
      modelOptionsByInstance: OPTIONS,
      activeInstanceId: id("claudeAgent"),
      activeModel: "claude-haiku",
    });
    const claude = choices.subscriptions[0]!;
    expect(claude.model).toBe("claude-haiku");
    expect(
      isSimpleChoiceSelected(claude, { instanceId: id("claudeAgent"), model: "claude-haiku" }),
    ).toBe(true);
  });
});
