import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { Effect, Option, Path, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  query as claudeQuery,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { compareCliVersions } from "../cliVersion.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;
/**
 * The first Claude Code release that knows each model id (checked in the
 * published CLI binaries, 28.09.2026: `claude-opus-5-5` first appears in
 * 2.1.280, `claude-fable-5-1` in 2.1.257). A CLI that is older keeps the
 * model out of the list and offers an update (`updateAvailable`).
 */
const MINIMUM_CLAUDE_OPUS_5_5_VERSION = "2.1.280";
const MINIMUM_CLAUDE_FABLE_5_1_VERSION = "2.1.257";
const MINIMUM_CLAUDE_OPUS_5_VERSION = "2.1.219";
const MINIMUM_CLAUDE_SONNET_5_VERSION = "2.1.197";
const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.169";
const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154";
const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111";

/**
 * Reasoning / fast mode / 1M context of the current Claude generation. Also
 * used for a newer model the installed CLI lists that this build doesn't
 * know yet (see {@link claudeModelsFromCli}).
 */
function modernClaudeCapabilities(input: {
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
      ...(input.fastMode
        ? [
            buildBooleanOptionDescriptor({
              id: "fastMode",
              label: "Fast Mode",
            }),
          ]
        : []),
      ...(input.contextWindow
        ? [
            buildSelectOptionDescriptor({
              id: "contextWindow",
              label: "Context Window",
              options: [
                { value: "200k", label: "200k", isDefault: true },
                { value: "1m", label: "1M" },
              ],
            }),
          ]
        : []),
    ],
  });
}

const HAIKU_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildBooleanOptionDescriptor({
      id: "thinking",
      label: "Thinking",
    }),
  ],
});

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
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
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
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
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
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
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
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
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
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
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
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
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
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
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
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
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
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
const BUILT_IN_MODEL_SLUGS: ReadonlySet<string> = new Set(BUILT_IN_MODELS.map((m) => m.slug));

/** Built-in models that need a minimum Claude Code, newest requirement first. */
const MINIMUM_VERSION_BY_MODEL: ReadonlyArray<{
  readonly slug: string;
  readonly name: string;
  readonly version: string;
}> = [
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

function getBuiltInClaudeModelsForVersion(
  version: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  return BUILT_IN_MODELS.filter((model) => {
    const requirement = MINIMUM_VERSION_BY_MODEL.find((entry) => entry.slug === model.slug);
    return requirement ? supportsVersion(version, requirement.version) : true;
  });
}

/**
 * The newest model the installed CLI is too old for, or undefined when it
 * runs them all: "Claude Code v2.1.270 is too old for Claude Opus 5.5.
 * Upgrade to v2.1.280 or newer to access it."
 */
function claudeVersionUpgradeMessage(version: string | null): string | undefined {
  const missing = MINIMUM_VERSION_BY_MODEL.filter(
    (entry) => !supportsVersion(version, entry.version),
  ).toSorted((a, b) => compareCliVersions(b.version, a.version))[0];
  if (!missing) return undefined;
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for ${missing.name}. Upgrade to v${missing.version} or newer to access it.`;
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

/** `claude-sonnet-5[1m]` → `claude-sonnet-5`, `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. */
function stripClaudeModelSuffixes(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
}

/** A model the CLI lists (`/model`): id, and whether it has fast mode / a 1M variant. */
export interface ClaudeCliModel {
  readonly value: string;
  readonly resolvedModel?: string | undefined;
  readonly supportsFastMode?: boolean | undefined;
}

/**
 * The installed CLI's own model list (`initializationResult().models`,
 * aliases like `opus` carry `resolvedModel`) → concrete model ids with what
 * they support. A newer CLI brings newer models without a Uno Work release.
 */
export function claudeModelsFromCli(
  models: ReadonlyArray<ClaudeCliModel> | undefined,
): Map<string, { readonly fastMode: boolean; readonly contextWindow: boolean }> {
  const result = new Map<string, { fastMode: boolean; contextWindow: boolean }>();
  for (const model of models ?? []) {
    const raw = (model.resolvedModel ?? model.value ?? "").trim();
    const id = stripClaudeModelSuffixes(raw);
    if (!/^claude-[a-z]+-\d/.test(id)) continue;
    const existing = result.get(id) ?? { fastMode: false, contextWindow: false };
    result.set(id, {
      fastMode: existing.fastMode || model.supportsFastMode === true,
      contextWindow: existing.contextWindow || /\[1m\]$/i.test(raw),
    });
  }
  return result;
}

/** Built-ins the CLI can run, plus the models it lists that this build doesn't know. */
function claudeModelsForCli(
  version: string | null,
  cliModels: ReadonlyArray<ClaudeCliModel> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const listed = claudeModelsFromCli(cliModels);
  const builtIns = BUILT_IN_MODELS.filter(
    (model) =>
      listed.has(model.slug) ||
      getBuiltInClaudeModelsForVersion(version).some((known) => known.slug === model.slug),
  );
  const discovered: ServerProviderModel[] = [];
  for (const [slug, support] of listed) {
    if (BUILT_IN_MODEL_SLUGS.has(slug)) continue;
    discovered.push({
      slug,
      name: claudeModelDisplayName(slug),
      isCustom: false,
      capabilities: slug.startsWith("claude-haiku-")
        ? HAIKU_CAPABILITIES
        : modernClaudeCapabilities(support),
    });
  }
  // Newer than anything this build knows: first.
  return [...discovered, ...builtIns];
}

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  const builtIn = BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities;
  if (builtIn) return builtIn;
  // A newer model the CLI listed (claudeModelsForCli): current-generation options.
  if (slug && isNewerClaudeModel(slug)) {
    return slug.startsWith("claude-haiku-")
      ? HAIKU_CAPABILITIES
      : modernClaudeCapabilities({ fastMode: false, contextWindow: true });
  }
  return DEFAULT_CLAUDE_MODEL_CAPABILITIES;
}

/** A Claude id this build doesn't list (a model newer than the build). */
function isNewerClaudeModel(slug: string): boolean {
  return !BUILT_IN_MODEL_SLUGS.has(slug) && /^claude-[a-z]+-\d/.test(slug);
}

/** Models whose Claude Code effort scale includes `xhigh`. */
const CLAUDE_XHIGH_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
]);

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * Mirrors the mapping used when invoking the Claude Agent SDK
 * ({@link getEffectiveClaudeAgentEffort} in ClaudeAdapter): `ultracode` is a
 * Claude Code setting that pairs with `xhigh`, `ultrathink` is filtered out
 * because it is a prompt-prefix mode, and older model compatibility mappings
 * are preserved for current Claude Code behavior.
 */
export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort || effort === "ultrathink") {
    return undefined;
  }
  if (effort === "ultracode") {
    return "xhigh";
  }
  if (
    effort === "xhigh" &&
    !(model && (CLAUDE_XHIGH_MODELS.has(model) || isNewerClaudeModel(model)))
  ) {
    return "max";
  }
  if (effort === "max" && model === "claude-sonnet-4-6") {
    return "high";
  }
  return effort;
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  switch (getModelSelectionStringOptionValue(modelSelection, "contextWindow")) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /** The CLI's own model list (`/model`); undefined when it didn't say. */
  readonly models?: ReadonlyArray<ClaudeCliModel> | undefined;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: {
          persistSession: false,
          pathToClaudeCodeExecutable: claudeSettings.binaryPath,
          abortController: abort,
          settingSources: ["user", "project", "local"],
          allowedTools: [],
          env: claudeEnvironment,
          stderr: () => {},
        },
      });
      const init = await q.initializationResult();
      const account = init.account as
        | {
            readonly email?: string;
            readonly subscriptionType?: string;
            readonly tokenSource?: string;
          }
        | undefined;
      return {
        email: account?.email,
        subscriptionType: account?.subscriptionType,
        tokenSource: account?.tokenSource,
        slashCommands: parseClaudeInitializationCommands(init.commands),
        models: Array.isArray(init.models)
          ? (init.models as ReadonlyArray<ClaudeCliModel>)
          : undefined,
      } satisfies ClaudeCapabilitiesProbe;
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const command = ChildProcess.make(claudeSettings.binaryPath, [...args], {
    env: claudeEnvironment,
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

/**
 * Claude Code on Uno AI: with no Claude sign-in of its own on this machine,
 * Claude Code runs against the Uno gateway's Anthropic Messages API
 * (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` = the machine's gateway
 * key), billed from the plan's premium credit. A person who signed in to
 * Claude (subscription or API key) keeps running on that — never overridden.
 */
export type ClaudeAuthMode = "own" | "uno";

export interface ClaudeUnoGateway {
  /** Env that runs Claude Code on the Uno gateway; null without a gateway key. */
  readonly environment: () => Readonly<Record<string, string>> | null;
  /** Who chats started from now on run as (read by the adapter per query). */
  readonly setMode: (mode: ClaudeAuthMode) => void;
  /**
   * Whether the account may run Claude on Uno AI at all. False on a trial
   * computer (free chat: the gateway answers /v1/messages with 403), where
   * Claude must ask for the person's own sign-in instead of looking ready.
   * Omitted = allowed.
   */
  readonly available?: () => Effect.Effect<boolean>;
}

/** Shown on the Claude card when Claude on Uno AI isn't in the account's plan. */
export const CLAUDE_UNO_UNAVAILABLE_MESSAGE =
  "Sign in with Claude to use your Claude Pro or Max subscription here. Claude on Uno AI comes with paid plans.";

/** `plan` values of `GET /v1/ai/status` that have no Claude on Uno AI. */
export const UNO_PLANS_WITHOUT_CLAUDE: ReadonlySet<string> = new Set(["work-trial"]);

/**
 * From the gateway's `GET /v1/ai/status`: may this account run Claude on
 * Uno AI? null when the answer doesn't say (then it stays allowed).
 */
export function claudeOnUnoAllowedByAiStatus(json: unknown): boolean | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const plan = (json as Record<string, unknown>)["plan"];
  if (typeof plan !== "string" || plan.length === 0) return null;
  return !UNO_PLANS_WITHOUT_CLAUDE.has(plan);
}

/** Shown on the Claude card while it runs on Uno AI. */
export const CLAUDE_UNO_AI_MESSAGE =
  "Runs on your Uno AI premium credit. Sign in with Claude to use your own subscription instead.";

/** Env names that mean "this Claude has credentials of its own". */
const CLAUDE_OWN_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

export function hasOwnClaudeCredentialsInEnv(environment: NodeJS.ProcessEnv): boolean {
  return CLAUDE_OWN_CREDENTIAL_ENV.some((name) => (environment[name]?.trim().length ?? 0) > 0);
}

/** `claude auth status` → signed in on its own; null when it couldn't tell. */
export function parseClaudeAuthStatusLoggedIn(stdout: string): boolean | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as { loggedIn?: unknown };
    return typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null;
  } catch {
    return null;
  }
}

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
    mode: ClaudeAuthMode,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment: NodeJS.ProcessEnv = process.env,
  unoGateway?: ClaudeUnoGateway,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const checkedAt = new Date().toISOString();
  const allModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in Uno Work settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(claudeSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const versionUpgradeMessage = claudeVersionUpgradeMessage(parsedVersion);
  const updateAvailable = versionUpgradeMessage !== undefined;

  // Uno AI: only when the machine has a gateway key and Claude has no
  // sign-in of its own (env credentials, or `claude auth status`). A status
  // that can't be read counts as "own" — never override a real sign-in.
  let mode: ClaudeAuthMode = "own";
  // Not signed in, and the plan has no Claude on Uno AI (trial): ask for a sign-in.
  let unoUnavailable = false;
  if (unoGateway && unoGateway.environment() !== null) {
    let own = hasOwnClaudeCredentialsInEnv(environment);
    if (!own) {
      const authStatus = yield* runClaudeCommand(
        claudeSettings,
        ["auth", "status", "--json"],
        environment,
      ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);
      const loggedIn =
        Result.isSuccess(authStatus) && Option.isSome(authStatus.success)
          ? parseClaudeAuthStatusLoggedIn(authStatus.success.value.stdout)
          : null;
      own = loggedIn !== false;
    }
    const allowed =
      own || !unoGateway.available
        ? true
        : yield* unoGateway.available().pipe(Effect.orElseSucceed(() => true));
    unoUnavailable = !own && !allowed;
    mode = own || unoUnavailable ? "own" : "uno";
    unoGateway.setMode(mode);
  }

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings, mode).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const models = providerModelsFromSettings(
    claudeModelsForCli(parsedVersion, capabilities?.models),
    PROVIDER,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
  const slashCommands = capabilities?.slashCommands ?? [];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (unoUnavailable) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: CLAUDE_UNO_UNAVAILABLE_MESSAGE,
      },
      ...(updateAvailable ? { updateAvailable } : {}),
    });
  }

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
      ...(updateAvailable ? { updateAvailable } : {}),
    });
  }

  const authMetadata =
    mode === "uno"
      ? { type: "unoAi", label: "Uno AI" }
      : claudeAuthMetadata({
          subscriptionType: capabilities.subscriptionType,
          authMethod: capabilities.tokenSource,
        });
  const message = [mode === "uno" ? CLAUDE_UNO_AI_MESSAGE : undefined, versionUpgradeMessage]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: dedupedSlashCommands,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email && mode === "own" ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(message.length > 0 ? { message } : {}),
    },
    ...(updateAvailable ? { updateAvailable } : {}),
  });
});

export const makePendingClaudeProvider = (claudeSettings: ClaudeSettings): ServerProviderDraft => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in Uno Work settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Claude provider status has not been checked in this session yet.",
    },
  });
};

export { probeClaudeCapabilities };
