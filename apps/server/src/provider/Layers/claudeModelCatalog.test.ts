import type { ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildClaudeModelList,
  capabilitiesForListedModel,
  claudeModelsFromCli,
  getClaudeModelCapabilities,
  makeClaudeCliModelMemory,
  rememberClaudeModels,
} from "./claudeModelCatalog.ts";

const EFFORT = ["low", "medium", "high", "xhigh", "max"];

/** `Query.supportedModels()` of Claude Code 2.1.321 signed in with a subscription (09.11.2026). */
const CLI_2_1_321_SUBSCRIPTION = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
    supportsFastMode: true,
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "For complex work and everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
    supportsFastMode: true,
  },
  {
    value: "fable",
    resolvedModel: "claude-fable-5-2",
    displayName: "Fable 5.2",
    description: "For your toughest challenges",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
    supportsFastMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "Most efficient for simpler tasks",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    displayName: "Haiku 5.5",
    description: "Fastest for quick answers",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
  },
  {
    value: "claude-fable-5-1",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable 5.1",
    description: "Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
  },
  {
    value: "claude-haiku-4-5-20251001",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku 4.5",
    description: "Fastest for quick answers",
  },
  {
    value: "claude-sonnet-5",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet 5",
    description: "Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
  },
  {
    value: "claude-opus-5",
    resolvedModel: "claude-opus-5",
    displayName: "Opus 5",
    description: "Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
    supportsFastMode: true,
  },
  {
    value: "claude-fable-5",
    resolvedModel: "claude-fable-5",
    displayName: "Fable 5",
    description: "Most capable for your hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
  },
  {
    value: "claude-opus-4-8",
    resolvedModel: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
    supportsFastMode: true,
  },
  {
    value: "claude-opus-4-7",
    resolvedModel: "claude-opus-4-7",
    displayName: "Opus 4.7",
    description: "Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: EFFORT,
  },
  {
    value: "claude-opus-4-6",
    resolvedModel: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
  {
    value: "claude-sonnet-4-6",
    resolvedModel: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
];

/** The same CLI on an API key / Uno AI (`ANTHROPIC_AUTH_TOKEN`): only the family aliases. */
const CLI_2_1_321_API_KEY = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    supportedEffortLevels: EFFORT,
    supportsFastMode: true,
  },
  {
    value: "opus",
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Best for everyday, complex tasks · $5/$25 per Mtok",
    supportedEffortLevels: EFFORT,
    supportsFastMode: true,
  },
  {
    value: "fable",
    resolvedModel: "claude-fable-5-2",
    displayName: "Fable",
    description:
      "Fable 5.2 · Most capable for your hardest and longest-running tasks · $8/$40 per Mtok",
    supportedEffortLevels: EFFORT,
    supportsFastMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    supportedEffortLevels: EFFORT,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    displayName: "Haiku",
    supportedEffortLevels: EFFORT,
  },
];

const slugs = (models: ReadonlyArray<ServerProviderModel>) => models.map((model) => model.slug);
const find = (models: ReadonlyArray<ServerProviderModel>, slug: string) =>
  models.find((model) => model.slug === slug);
const optionIds = (model: ServerProviderModel | undefined, id: string) => {
  const descriptor = model?.capabilities?.optionDescriptors?.find((entry) => entry.id === id);
  return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : undefined;
};
const hasOption = (model: ServerProviderModel | undefined, id: string) =>
  model?.capabilities?.optionDescriptors?.some((entry) => entry.id === id) ?? false;

describe("the Claude model list follows the installed CLI", () => {
  it("lists Fable 5.2 and the new Sonnet / Haiku from Claude Code 2.1.321, next to their families", () => {
    const list = buildClaudeModelList({ version: "2.1.321", cliModels: CLI_2_1_321_SUBSCRIPTION });
    expect(slugs(list.models)).toEqual([
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-fable-5-2",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-4-6",
      "claude-haiku-5-5",
      "claude-haiku-4-5",
    ]);
    const fable = find(list.models, "claude-fable-5-2");
    expect(fable?.name).toBe("Claude Fable 5.2");
    expect(fable?.aliases).toEqual(["fable"]);
    expect(hasOption(fable, "fastMode")).toBe(true);
    expect(optionIds(fable, "contextWindow")).toEqual(["200k", "1m"]);
    expect(find(list.models, "claude-opus-5-5")?.aliases).toEqual(["opus"]);
    expect(find(list.models, "claude-sonnet-5-5")?.aliases).toEqual(["sonnet"]);
    expect(find(list.models, "claude-sonnet-5-5")?.name).toBe("Claude Sonnet 5.5");
    expect(find(list.models, "claude-sonnet-5")?.aliases).toBeUndefined();
    expect(list.upgradeMessage).toBeUndefined();
  });

  it('marks the CLI\'s "Default (recommended)" — the strongest pick comes from the CLI (14.11)', () => {
    const list = buildClaudeModelList({ version: "2.1.321", cliModels: CLI_2_1_321_API_KEY });
    expect(list.models.filter((model) => model.isDefault).map((model) => model.slug)).toEqual([
      "claude-opus-5-5",
    ]);
    const silent = buildClaudeModelList({ version: "2.1.321", cliModels: undefined });
    expect(silent.models.some((model) => model.isDefault)).toBe(false);
  });

  it("keeps the older models with an API key or on Uno AI, where the CLI lists only aliases", () => {
    const list = buildClaudeModelList({ version: "2.1.321", cliModels: CLI_2_1_321_API_KEY });
    for (const slug of [
      "claude-fable-5-1",
      "claude-opus-4-6",
      "claude-haiku-4-5",
      "claude-sonnet-5",
    ]) {
      expect(slugs(list.models)).toContain(slug);
    }
    const fable = find(list.models, "claude-fable-5-2");
    expect(fable?.name).toBe("Claude Fable 5.2");
    expect(fable?.aliases).toEqual(["fable"]);
    // "Default (recommended)" is the CLI's default, not a model name or an alias.
    expect(find(list.models, "claude-opus-5-5")?.aliases).toEqual(["opus"]);
  });

  it("falls back to the built-ins by version when the CLI didn't answer", () => {
    const current = buildClaudeModelList({ version: "2.1.321", cliModels: undefined });
    expect(slugs(current.models)).toContain("claude-fable-5-2");
    expect(current.upgradeMessage).toBeUndefined();

    // Canary 2534 on 09.11: Claude Code 2.1.316 — no Fable 5.2, "Update" instead.
    const older = buildClaudeModelList({ version: "2.1.316", cliModels: undefined });
    expect(slugs(older.models)).not.toContain("claude-fable-5-2");
    expect(slugs(older.models)).toContain("claude-fable-5-1");
    expect(older.upgradeMessage).toBe(
      "Claude Code v2.1.316 is too old for Claude Fable 5.2. Upgrade to v2.1.321 or newer to access it.",
    );
  });

  it("trusts a CLI that lists a model over its version number", () => {
    const list = buildClaudeModelList({
      version: "2.1.316",
      cliModels: [
        { value: "fable", resolvedModel: "claude-fable-5-2", supportedEffortLevels: EFFORT },
      ],
    });
    expect(slugs(list.models)).toContain("claude-fable-5-2");
    expect(list.upgradeMessage).toBeUndefined();
  });

  it("shows a model this build doesn't know under the CLI's id, with what the CLI says it has", () => {
    const list = buildClaudeModelList({
      version: "2.1.400",
      cliModels: [
        {
          value: "opus",
          resolvedModel: "claude-opus-6",
          displayName: "Opus 6",
          supportedEffortLevels: ["low", "high", "max"],
          supportsFastMode: true,
        },
        {
          value: "claude-mythos-1",
          displayName: "Mythos 1",
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ],
    });
    // A family this build doesn't know first, Opus 6 before Opus 5.5, the rest as it was.
    expect(slugs(list.models).slice(0, 3)).toEqual([
      "claude-mythos-1",
      "claude-opus-6",
      "claude-opus-5-5",
    ]);
    const opus6 = find(list.models, "claude-opus-6");
    expect(opus6?.name).toBe("Claude Opus 6");
    expect(opus6?.aliases).toEqual(["opus"]);
    // The CLI's scale, no Ultracode without xhigh; Ultrathink is a prompt word.
    expect(optionIds(opus6, "effort")).toEqual(["low", "high", "max", "ultrathink"]);
    expect(hasOption(opus6, "fastMode")).toBe(true);
    expect(hasOption(opus6, "contextWindow")).toBe(true);
    // A family nobody knows: no 1M window until the CLI lists one.
    const mythos = find(list.models, "claude-mythos-1");
    expect(mythos?.name).toBe("Claude Mythos 1");
    expect(hasOption(mythos, "contextWindow")).toBe(false);
    expect(hasOption(mythos, "fastMode")).toBe(false);
  });

  it("gives an unknown model the current generation's options when the CLI says nothing about it", () => {
    const [listed] = claudeModelsFromCli([{ value: "claude-sonnet-6" }]).values();
    const caps = capabilitiesForListedModel(listed!);
    const effort = caps.optionDescriptors?.find((entry) => entry.id === "effort");
    expect(
      effort?.type === "select" ? effort.options.find((option) => option.isDefault)?.id : null,
    ).toBe("high");
    expect(caps.optionDescriptors?.some((entry) => entry.id === "contextWindow")).toBe(true);
    expect(caps.optionDescriptors?.some((entry) => entry.id === "fastMode")).toBe(false);
    // Haiku without a scale keeps its thinking switch.
    const [haiku] = claudeModelsFromCli([{ value: "claude-haiku-6" }]).values();
    expect(capabilitiesForListedModel(haiku!).optionDescriptors?.map((entry) => entry.id)).toEqual([
      "thinking",
    ]);
  });

  it("skips what isn't a Claude model id", () => {
    const listed = claudeModelsFromCli([
      null,
      42,
      { value: 7 },
      { value: "gpt-5.5" },
      { value: "default" },
      { value: "opusplan", resolvedModel: "claude-opus-5-5" },
      { value: `claude-opus-${"9".repeat(80)}` },
      { value: "claude-opus-5-5; rm -rf /" },
      { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" },
    ]);
    expect([...listed.keys()]).toEqual(["claude-opus-5-5"]);
    // `opusplan` means more than Opus: not an alias. `opus[1m]` is, and says 1M.
    expect(listed.get("claude-opus-5-5")?.aliases).toEqual(["opus"]);
    expect(listed.get("claude-opus-5-5")?.contextWindow).toBe(true);
  });

  it("serves a turn on a listed model the options the picker showed", () => {
    const list = buildClaudeModelList({
      version: "2.1.400",
      cliModels: [
        {
          value: "sonnet",
          resolvedModel: "claude-sonnet-7",
          supportedEffortLevels: EFFORT,
          supportsFastMode: true,
        },
      ],
    });
    rememberClaudeModels(list.models);
    const caps = getClaudeModelCapabilities("claude-sonnet-7");
    expect(caps.optionDescriptors?.some((entry) => entry.id === "fastMode")).toBe(true);
    expect(getClaudeModelCapabilities("sonnet")).toBe(caps);
    // Built-ins keep their curated options whatever the CLI said.
    expect(
      getClaudeModelCapabilities("claude-opus-4-7").optionDescriptors?.find(
        (entry) => entry.id === "effort",
      ),
    ).toMatchObject({ currentValue: "xhigh" });
  });
});

describe("the CLI's last model list", () => {
  it("is kept per CLI version and sign-in, and nothing else", () => {
    const memory = makeClaudeCliModelMemory();
    memory.remember("2.1.321", "own", CLI_2_1_321_SUBSCRIPTION);
    expect(memory.recall("2.1.321", "own")).toBe(CLI_2_1_321_SUBSCRIPTION);
    expect(memory.recall("2.1.321", "uno")).toBeUndefined();
    expect(memory.recall("2.1.322", "own")).toBeUndefined();
    for (const version of ["2.1.322", "2.1.323", "2.1.324", "2.1.325"]) {
      memory.remember(version, "own", []);
    }
    expect(memory.recall("2.1.321", "own")).toBeUndefined();
    expect(memory.recall("2.1.325", "own")).toEqual([]);
  });
});
