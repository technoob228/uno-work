/**
 * The Claude models Uno Work offers: what the installed Claude Code itself
 * lists for the current sign-in (`Query.supportedModels()` — read from the
 * SDK's initialization answer, no request to Anthropic, no tokens), on top of
 * a built-in list. The built-in list stays as the fallback (the CLI did not
 * answer, an older SDK) and as the source of what the CLI does not say: the
 * curated reasoning scales, the 1M context option, the first Claude Code
 * release that knows a model (an older CLI gets "Update").
 *
 * A model the CLI lists that this build doesn't know shows up under the CLI's
 * id with safe defaults (see {@link capabilitiesForListedModel}); family names
 * the CLI resolves (`fable` → its default Fable) travel with the model as
 * `aliases`, so "fable" means what the installed Claude Code means by it.
 *
 * Pure apart from {@link rememberClaudeModels} (what the turn path reads);
 * the probe itself lives in ClaudeProvider.ts. Tested in
 * claudeModelCatalog.test.ts.
 */
import type { ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { compareCliVersions } from "../cliVersion.ts";
import { buildBooleanOptionDescriptor, buildSelectOptionDescriptor } from "../providerSnapshot.ts";

export const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * The first Claude Code release that knows each model id (checked in the
 * published CLI binaries, 28.09.2026: `claude-opus-5-5` first appears in
 * 2.1.280, `claude-fable-5-1` in 2.1.257; 09.11.2026: `claude-fable-5-2` —
 * 2.1.321, "now the default Fable model"). A CLI that is older keeps the
 * model out of the list and offers an update (`updateAvailable`) — unless it
 * lists the model itself.
 */
const MINIMUM_CLAUDE_FABLE_5_2_VERSION = "2.1.321";
const MINIMUM_CLAUDE_OPUS_5_5_VERSION = "2.1.280";
const MINIMUM_CLAUDE_FABLE_5_1_VERSION = "2.1.257";
const MINIMUM_CLAUDE_OPUS_5_VERSION = "2.1.219";
const MINIMUM_CLAUDE_SONNET_5_VERSION = "2.1.197";
const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.169";
const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154";
const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111";

const CONTEXT_WINDOW_DESCRIPTOR = () =>
  buildSelectOptionDescriptor({
    id: "contextWindow",
    label: "Context Window",
    options: [
      { value: "200k", label: "200k", isDefault: true },
      { value: "1m", label: "1M" },
    ],
  });

const FAST_MODE_DESCRIPTOR = () =>
  buildBooleanOptionDescriptor({
    id: "fastMode",
    label: "Fast Mode",
  });

/**
 * Reasoning / fast mode / 1M context of the current Claude generation. Also
 * the default for a newer model the installed CLI lists without saying its
 * reasoning scale.
 */
export function modernClaudeCapabilities(input: {
  readonly fastMode: boolean;
  readonly contextWindow: boolean;
}): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "effort",
        label: "Reasoning",
        options: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High", isDefault: true },
          { value: "xhigh", label: "Extra High" },
          { value: "max", label: "Max" },
          { value: "ultracode", label: "Ultracode" },
          { value: "ultrathink", label: "Ultrathink" },
        ],
        promptInjectedValues: ["ultrathink"],
      }),
      ...(input.fastMode ? [FAST_MODE_DESCRIPTOR()] : []),
      ...(input.contextWindow ? [CONTEXT_WINDOW_DESCRIPTOR()] : []),
    ],
  });
}

export const HAIKU_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildBooleanOptionDescriptor({
      id: "thinking",
      label: "Thinking",
    }),
  ],
});

/**
 * The built-in list: newest first within a family. Fallback when the CLI
 * doesn't answer, and the capabilities of every model in it even when the
 * CLI does.
 */
export const CLAUDE_FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: modernClaudeCapabilities({ fastMode: true, contextWindow: true }),
  },
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultracode", label: "Ultracode" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        FAST_MODE_DESCRIPTOR(),
        CONTEXT_WINDOW_DESCRIPTOR(),
      ],
    }),
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultracode", label: "Ultracode" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        CONTEXT_WINDOW_DESCRIPTOR(),
      ],
    }),
  },
  {
    slug: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    isCustom: false,
    capabilities: modernClaudeCapabilities({ fastMode: true, contextWindow: true }),
  },
  {
    slug: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    isCustom: false,
    capabilities: modernClaudeCapabilities({ fastMode: false, contextWindow: true }),
  },
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultracode", label: "Ultracode" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        CONTEXT_WINDOW_DESCRIPTOR(),
      ],
    }),
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultracode", label: "Ultracode" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        FAST_MODE_DESCRIPTOR(),
        CONTEXT_WINDOW_DESCRIPTOR(),
      ],
    }),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        FAST_MODE_DESCRIPTOR(),
        CONTEXT_WINDOW_DESCRIPTOR(),
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        FAST_MODE_DESCRIPTOR(),
        CONTEXT_WINDOW_DESCRIPTOR(),
      ],
    }),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
          ],
        }),
        FAST_MODE_DESCRIPTOR(),
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        CONTEXT_WINDOW_DESCRIPTOR(),
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: HAIKU_CAPABILITIES,
  },
];
const FALLBACK_BY_SLUG: ReadonlyMap<string, ServerProviderModel> = new Map(
  CLAUDE_FALLBACK_MODELS.map((model) => [model.slug, model]),
);

/** Built-in models that need a minimum Claude Code, newest requirement first. */
const MINIMUM_VERSION_BY_MODEL: ReadonlyArray<{
  readonly slug: string;
  readonly name: string;
  readonly version: string;
}> = [
  {
    slug: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    version: MINIMUM_CLAUDE_FABLE_5_2_VERSION,
  },
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5", version: MINIMUM_CLAUDE_OPUS_5_5_VERSION },
  { slug: "claude-fable-5-1", name: "Claude Fable 5.1", version: MINIMUM_CLAUDE_FABLE_5_1_VERSION },
  { slug: "claude-opus-5", name: "Claude Opus 5", version: MINIMUM_CLAUDE_OPUS_5_VERSION },
  { slug: "claude-sonnet-5", name: "Claude Sonnet 5", version: MINIMUM_CLAUDE_SONNET_5_VERSION },
  { slug: "claude-fable-5", name: "Claude Fable 5", version: MINIMUM_CLAUDE_FABLE_5_VERSION },
  { slug: "claude-opus-4-8", name: "Claude Opus 4.8", version: MINIMUM_CLAUDE_OPUS_4_8_VERSION },
  { slug: "claude-opus-4-7", name: "Claude Opus 4.7", version: MINIMUM_CLAUDE_OPUS_4_7_VERSION },
];

function supportsVersion(version: string | null | undefined, minimum: string): boolean {
  return version ? compareCliVersions(version, minimum) >= 0 : false;
}

function meetsMinimumVersion(slug: string, version: string | null | undefined): boolean {
  const requirement = MINIMUM_VERSION_BY_MODEL.find((entry) => entry.slug === slug);
  return requirement ? supportsVersion(version, requirement.version) : true;
}

// ── Ids and names ───────────────────────────────────────────────────

/** `claude-sonnet-5[1m]` → `claude-sonnet-5`, `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. */
function stripClaudeModelSuffixes(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
}

/** A Claude model id worth listing: `claude-<family>-<version>…`, nothing exotic. */
const CLAUDE_MODEL_ID = /^claude-[a-z]+-\d[a-z0-9-]*$/;
const MAX_MODEL_ID_LENGTH = 64;

function isClaudeModelId(id: string): boolean {
  return id.length <= MAX_MODEL_ID_LENGTH && CLAUDE_MODEL_ID.test(id);
}

/** `claude-fable-5-2` → `fable`. */
export function claudeModelFamily(slug: string): string | undefined {
  return /^claude-([a-z]+)-/.exec(slug)?.[1];
}

/** `claude-opus-4-5` → [4, 5]; ids that don't end in a version → []. */
function claudeModelVersionParts(slug: string): ReadonlyArray<number> {
  const match = /^claude-[a-z]+((?:-\d{1,3})+)$/.exec(slug);
  return match ? match[1]!.slice(1).split("-").map(Number) : [];
}

function compareVersionParts(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * `claude-opus-5-5` → `Claude Opus 5.5`, `claude-haiku-4-5-20251001` →
 * `Claude Haiku 4.5`; anything else is kept as it is.
 */
export function claudeModelDisplayName(slug: string): string {
  const match = /^claude-([a-z]+)((?:-\d{1,2})+)$/.exec(stripClaudeModelSuffixes(slug));
  if (!match) return slug;
  const family = match[1]!;
  const version = match[2]!.slice(1).split("-").join(".");
  return `Claude ${family[0]!.toUpperCase()}${family.slice(1)} ${version}`;
}

// ── What the CLI lists ──────────────────────────────────────────────

/**
 * One entry of the CLI's model list (`Query.supportedModels()`, SDK
 * `ModelInfo`). `resolvedModel` is not in the SDK's type but Claude Code sends
 * it for aliases (`fable` → `claude-fable-5-2`). Everything is optional: it is
 * another program's answer.
 */
export interface ClaudeCliModel {
  readonly value: string;
  readonly resolvedModel?: string | undefined;
  readonly displayName?: string | undefined;
  readonly description?: string | undefined;
  readonly supportsEffort?: boolean | undefined;
  readonly supportedEffortLevels?: ReadonlyArray<string> | undefined;
  readonly supportsFastMode?: boolean | undefined;
  readonly supportsAdaptiveThinking?: boolean | undefined;
}

/** A concrete model the CLI lists, with what it said about it. */
export interface ListedClaudeModel {
  readonly slug: string;
  /** The CLI's own name for it ("Fable 5.2"), when an entry gave one. */
  readonly displayName: string | undefined;
  /** Family names the CLI resolves to this model (`fable`, `opus`). */
  readonly aliases: ReadonlyArray<string>;
  /** The CLI's "Default (recommended)". */
  readonly isCliDefault: boolean;
  readonly fastMode: boolean;
  /** A `[1m]` variant was listed. */
  readonly contextWindow: boolean;
  /** The CLI's reasoning scale (`low`…`max`), in our order; empty when it didn't say. */
  readonly effortLevels: ReadonlyArray<string>;
}

const EFFORT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
  ["max", "Max"],
];
const KNOWN_EFFORT_LEVELS: ReadonlySet<string> = new Set(EFFORT_LABELS.map(([level]) => level));

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * The installed CLI's own model list → concrete model ids with what the CLI
 * says about them. Aliases (`fable`, `opus[1m]`) are folded into the model
 * they resolve to; entries that are not a Claude model id are skipped.
 */
export function claudeModelsFromCli(
  models: ReadonlyArray<unknown> | undefined,
): ReadonlyMap<string, ListedClaudeModel> {
  const result = new Map<string, ListedClaudeModel>();
  for (const entry of models ?? []) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const value = stringField(record.value);
    const raw = stringField(record.resolvedModel) ?? value;
    if (!raw) continue;
    const slug = stripClaudeModelSuffixes(raw);
    if (!isClaudeModelId(slug)) continue;

    const alias = value ? stripClaudeModelSuffixes(value) : undefined;
    const family = claudeModelFamily(slug);
    const displayName = stringField(record.displayName);
    const levels = Array.isArray(record.supportedEffortLevels)
      ? record.supportedEffortLevels.filter(
          (level): level is string => typeof level === "string" && KNOWN_EFFORT_LEVELS.has(level),
        )
      : [];
    const existing = result.get(slug);
    const aliases = new Set(existing?.aliases ?? []);
    // Only the family's own short name: `opusplan` and friends mean more than the model.
    if (alias && alias !== slug && alias === family) aliases.add(alias);
    const effortLevels = new Set([...(existing?.effortLevels ?? []), ...levels]);
    result.set(slug, {
      slug,
      // The entry that names the model itself ("Fable 5.1") wins over an alias's ("Fable").
      displayName:
        (alias === slug ? displayName : undefined) ??
        existing?.displayName ??
        (displayName && /\d/.test(displayName) ? displayName : undefined),
      aliases: [...aliases],
      isCliDefault: (existing?.isCliDefault ?? false) || alias === "default",
      fastMode: (existing?.fastMode ?? false) || record.supportsFastMode === true,
      contextWindow: (existing?.contextWindow ?? false) || /\[1m\]$/i.test(raw),
      effortLevels: EFFORT_LABELS.map(([level]) => level).filter((level) =>
        effortLevels.has(level),
      ),
    });
  }
  return result;
}

/** Families whose current models all take the 1M context window. */
const ONE_MILLION_CONTEXT_FAMILIES: ReadonlySet<string> = new Set(["opus", "sonnet", "fable"]);

/**
 * Options of a model the CLI lists that this build doesn't know: the CLI's
 * reasoning scale (+ Ultracode with `xhigh`, + the Ultrathink prompt word),
 * fast mode when it says so, the 1M window for the families that all have it
 * (200k stays the default). No scale said: the current generation's options.
 */
export function capabilitiesForListedModel(model: ListedClaudeModel): ModelCapabilities {
  const family = claudeModelFamily(model.slug) ?? "";
  const contextWindow = model.contextWindow || ONE_MILLION_CONTEXT_FAMILIES.has(family);
  if (model.effortLevels.length === 0) {
    return family === "haiku"
      ? HAIKU_CAPABILITIES
      : modernClaudeCapabilities({ fastMode: model.fastMode, contextWindow });
  }
  const levels = new Set(model.effortLevels);
  const defaultLevel = levels.has("high") ? "high" : model.effortLevels.at(-1);
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "effort",
        label: "Reasoning",
        options: [
          ...EFFORT_LABELS.filter(([level]) => levels.has(level)).map(([value, label]) =>
            value === defaultLevel ? { value, label, isDefault: true } : { value, label },
          ),
          ...(levels.has("xhigh") ? [{ value: "ultracode", label: "Ultracode" }] : []),
          { value: "ultrathink", label: "Ultrathink" },
        ],
        promptInjectedValues: ["ultrathink"],
      }),
      ...(model.fastMode ? [FAST_MODE_DESCRIPTOR()] : []),
      ...(contextWindow ? [CONTEXT_WINDOW_DESCRIPTOR()] : []),
    ],
  });
}

function listedModelName(model: ListedClaudeModel): string {
  const fromId = claudeModelDisplayName(model.slug);
  if (fromId !== model.slug) return fromId;
  const cliName = model.displayName;
  if (!cliName) return model.slug;
  return /^claude\b/i.test(cliName) ? cliName : `Claude ${cliName}`;
}

/** Into the list next to its family, newest first; a family this build doesn't know goes first. */
function insertByFamily(list: ServerProviderModel[], model: ServerProviderModel): void {
  const family = claudeModelFamily(model.slug);
  const version = claudeModelVersionParts(model.slug);
  let lastOfFamily = -1;
  for (let index = 0; index < list.length; index += 1) {
    const other = list[index]!;
    if (claudeModelFamily(other.slug) !== family) continue;
    if (compareVersionParts(version, claudeModelVersionParts(other.slug)) > 0) {
      list.splice(index, 0, model);
      return;
    }
    lastOfFamily = index;
  }
  list.splice(lastOfFamily + 1, 0, model);
}

export interface ClaudeModelList {
  readonly models: ReadonlyArray<ServerProviderModel>;
  /**
   * "Claude Code v2.1.316 is too old for Claude Fable 5.2. Upgrade to
   * v2.1.321 or newer to access it." — the newest built-in model the CLI is
   * too old for and doesn't list; undefined when it runs them all.
   */
  readonly upgradeMessage: string | undefined;
}

/**
 * The Claude model list for this CLI: the built-ins it can run (by version,
 * or because it lists them), plus what it lists that this build doesn't
 * know. Nothing the CLI leaves out is dropped — with an API key or Uno AI it
 * lists only its family aliases, and chats on older models must keep them.
 */
export function buildClaudeModelList(input: {
  readonly version: string | null;
  readonly cliModels: ReadonlyArray<unknown> | undefined;
}): ClaudeModelList {
  const listed = claudeModelsFromCli(input.cliModels);
  const models: ServerProviderModel[] = [];
  for (const model of CLAUDE_FALLBACK_MODELS) {
    const fromCli = listed.get(model.slug);
    if (!fromCli && !meetsMinimumVersion(model.slug, input.version)) continue;
    models.push({
      ...model,
      ...(fromCli && fromCli.aliases.length > 0 ? { aliases: fromCli.aliases } : {}),
      ...(fromCli?.isCliDefault ? { isDefault: true } : {}),
    });
  }
  for (const fromCli of listed.values()) {
    if (FALLBACK_BY_SLUG.has(fromCli.slug)) continue;
    insertByFamily(models, {
      slug: fromCli.slug,
      name: listedModelName(fromCli),
      isCustom: false,
      capabilities: capabilitiesForListedModel(fromCli),
      ...(fromCli.aliases.length > 0 ? { aliases: fromCli.aliases } : {}),
      ...(fromCli.isCliDefault ? { isDefault: true } : {}),
    });
  }

  const missing = MINIMUM_VERSION_BY_MODEL.filter(
    (entry) => !supportsVersion(input.version, entry.version) && !listed.has(entry.slug),
  ).toSorted((a, b) => compareCliVersions(b.version, a.version))[0];
  const versionLabel = input.version ? `v${input.version}` : "the installed version";
  return {
    models,
    upgradeMessage: missing
      ? `Claude Code ${versionLabel} is too old for ${missing.name}. Upgrade to v${missing.version} or newer to access it.`
      : undefined,
  };
}

// ── The last list per CLI version and sign-in ───────────────────────

/**
 * The CLI's last model list per (version, auth mode), so a probe that misses
 * on a busy machine doesn't drop the models it listed a minute ago (the list
 * would flap every 5-minute check). A new CLI version or the other sign-in
 * asks again; nothing is reused across them.
 */
export interface ClaudeCliModelMemory {
  readonly remember: (version: string | null, mode: string, models: ReadonlyArray<unknown>) => void;
  readonly recall: (version: string | null, mode: string) => ReadonlyArray<unknown> | undefined;
}

const CLI_MODEL_MEMORY_SIZE = 4;

const cliModelMemoryKey = (version: string | null, mode: string) => `${version ?? "?"}\0${mode}`;

export function makeClaudeCliModelMemory(): ClaudeCliModelMemory {
  const byKey = new Map<string, ReadonlyArray<unknown>>();
  return {
    remember: (version, mode, models) => {
      const entry = cliModelMemoryKey(version, mode);
      byKey.delete(entry);
      byKey.set(entry, models);
      while (byKey.size > CLI_MODEL_MEMORY_SIZE) {
        const oldest = byKey.keys().next().value;
        if (oldest === undefined) break;
        byKey.delete(oldest);
      }
    },
    recall: (version, mode) => byKey.get(cliModelMemoryKey(version, mode)),
  };
}

// ── Capabilities on the turn path ───────────────────────────────────

/**
 * Models the last status check listed that this build doesn't know, by slug
 * and by alias: a turn on one of them gets the options the picker showed
 * (fast mode the CLI said it has), not a guess.
 */
const listedCapabilities = new Map<string, ModelCapabilities>();

/** After every status check: what the picker offers is what turns honour. */
export function rememberClaudeModels(models: ReadonlyArray<ServerProviderModel>): void {
  for (const model of models) {
    if (model.isCustom || FALLBACK_BY_SLUG.has(model.slug) || !model.capabilities) continue;
    listedCapabilities.set(model.slug, model.capabilities);
  }
  for (const model of models) {
    for (const alias of model.aliases ?? []) {
      const capabilities = model.capabilities ?? FALLBACK_BY_SLUG.get(model.slug)?.capabilities;
      if (capabilities) listedCapabilities.set(alias, capabilities);
    }
  }
}

/** A Claude id this build doesn't list (a model newer than the build). */
export function isNewerClaudeModel(slug: string): boolean {
  return !FALLBACK_BY_SLUG.has(slug) && /^claude-[a-z]+-\d/.test(slug);
}

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  if (!slug) return DEFAULT_CLAUDE_MODEL_CAPABILITIES;
  const builtIn = FALLBACK_BY_SLUG.get(slug)?.capabilities;
  if (builtIn) return builtIn;
  const listed = listedCapabilities.get(slug);
  if (listed) return listed;
  // A newer model no status check has described yet: current-generation options.
  if (isNewerClaudeModel(slug)) {
    return slug.startsWith("claude-haiku-")
      ? HAIKU_CAPABILITIES
      : modernClaudeCapabilities({ fastMode: false, contextWindow: true });
  }
  return DEFAULT_CLAUDE_MODEL_CAPABILITIES;
}
