import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { Effect, Option, Path, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
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
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import {
  buildClaudeModelList,
  CLAUDE_FALLBACK_MODELS,
  type ClaudeCliModel,
  type ClaudeCliModelMemory,
  DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  isNewerClaudeModel,
  rememberClaudeModels,
} from "./claudeModelCatalog.ts";

export {
  type ClaudeCliModel,
  claudeModelDisplayName,
  claudeModelsFromCli,
  getClaudeModelCapabilities,
} from "./claudeModelCatalog.ts";

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;

/** Models whose Claude Code effort scale includes `xhigh`. */
const CLAUDE_XHIGH_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-fable-5-2",
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

// Starts Claude Code: 1-4 s on a healthy machine, past 8 s on one busy with
// parallel agents and a queued disk.
const CAPABILITIES_PROBE_TIMEOUT_MS = 20_000;
/** A second, patient `claude auth status` once the probe told us nothing. */
const AUTH_STATUS_FALLBACK_TIMEOUT_MS = 10_000;

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /**
   * The CLI's own model list for this sign-in (`Query.supportedModels()`,
   * what `/model` shows); undefined when it didn't say.
   */
  readonly models?: ReadonlyArray<ClaudeCliModel> | undefined;
};

/**
 * `Query.supportedModels()` — in SDK 0.3.x the `models` of the same
 * initialization answer, so no second round trip. An SDK without the method
 * (or one that throws) falls back to the initialization answer itself.
 */
async function readSupportedModels(
  q: { readonly supportedModels?: () => Promise<ReadonlyArray<unknown>> },
  init: { readonly models?: unknown },
): Promise<ReadonlyArray<ClaudeCliModel> | undefined> {
  try {
    const listed = typeof q.supportedModels === "function" ? await q.supportedModels() : undefined;
    if (Array.isArray(listed)) return listed as ReadonlyArray<ClaudeCliModel>;
  } catch {
    // fall through to the initialization answer
  }
  return Array.isArray(init.models) ? (init.models as ReadonlyArray<ClaudeCliModel>) : undefined;
}

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
 * account info, slash commands and its model list) but never starts an API
 * request to Anthropic — no tokens. We read the init data and then abort the
 * subprocess. 0.2–0.4 s on a Mac, a few seconds on a busy 2-vCPU computer.
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
        models: await readSupportedModels(q, init),
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
    Effect.flatMap((result) => {
      if (Result.isFailure(result)) {
        return Effect.logWarning("Claude capabilities probe failed", {
          reason: String(result.failure).slice(0, 300),
        }).pipe(Effect.as(undefined));
      }
      return Option.isSome(result.success)
        ? Effect.succeed(result.success.value)
        : Effect.logWarning("Claude capabilities probe timed out", {
            timeoutMs: CAPABILITIES_PROBE_TIMEOUT_MS,
          }).pipe(Effect.as(undefined));
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
  "Runs on your Uno AI premium credit, then your balance. Sign in with Claude to use your own subscription instead.";

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

export interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}

const stringOrUndefined = (value: unknown) => (typeof value === "string" ? value : undefined);

/** `claude auth status --json`; null when it couldn't tell. */
export function parseClaudeAuthStatus(stdout: string): ClaudeAuthStatus | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.loggedIn !== "boolean") return null;
    return {
      loggedIn: parsed.loggedIn,
      email: stringOrUndefined(parsed.email),
      subscriptionType: stringOrUndefined(parsed.subscriptionType),
      authMethod: stringOrUndefined(parsed.authMethod),
    };
  } catch {
    return null;
  }
}

const readClaudeAuthStatus = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
) =>
  runClaudeCommand(claudeSettings, ["auth", "status", "--json"], environment).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result) && Option.isSome(result.success)
        ? parseClaudeAuthStatus(result.success.value.stdout)
        : null,
    ),
  );

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
    mode: ClaudeAuthMode,
    /** The CLI version just read: a new CLI is probed again, not served from cache. */
    version: string | null,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment: NodeJS.ProcessEnv = process.env,
  unoGateway?: ClaudeUnoGateway,
  /** The CLI's last model list per version + sign-in, for a probe that misses. */
  cliModelMemory?: ClaudeCliModelMemory,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const checkedAt = new Date().toISOString();
  const allModels = providerModelsFromSettings(
    CLAUDE_FALLBACK_MODELS,
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

  // Uno AI: only when the machine has a gateway key and Claude has no
  // sign-in of its own (env credentials, or `claude auth status`). A status
  // that can't be read counts as "own" — never override a real sign-in.
  let mode: ClaudeAuthMode = "own";
  // Not signed in, and the plan has no Claude on Uno AI (trial): ask for a sign-in.
  let unoUnavailable = false;
  const hasEnvCredentials = hasOwnClaudeCredentialsInEnv(environment);
  let authStatus: ClaudeAuthStatus | null = null;
  if (unoGateway && unoGateway.environment() !== null) {
    let own = hasEnvCredentials;
    if (!own) {
      authStatus = yield* readClaudeAuthStatus(claudeSettings, environment, DEFAULT_TIMEOUT_MS);
      own = authStatus?.loggedIn !== false;
    }
    const allowed =
      own || !unoGateway.available
        ? true
        : yield* unoGateway.available().pipe(Effect.orElseSucceed(() => true));
    unoUnavailable = !own && !allowed;
    mode = own || unoUnavailable ? "own" : "uno";
    unoGateway.setMode(mode);
  }

  // One local start of Claude Code per check (account, slash commands and its
  // model list in one answer, no tokens), cached by the driver for 5 minutes.
  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings, mode, parsedVersion).pipe(
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  // The models this CLI listed for this sign-in; a probe that missed reuses
  // the last answer of the same CLI version and sign-in, else the built-ins.
  if (capabilities?.models) cliModelMemory?.remember(parsedVersion, mode, capabilities.models);
  const modelList = buildClaudeModelList({
    version: parsedVersion,
    cliModels: capabilities?.models ?? cliModelMemory?.recall(parsedVersion, mode),
  });
  rememberClaudeModels(modelList.models);
  const versionUpgradeMessage = modelList.upgradeMessage;
  const updateAvailable = versionUpgradeMessage !== undefined;
  const models = providerModelsFromSettings(
    modelList.models,
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

  // No probe answer says nothing about the sign-in: it's a local start of
  // Claude Code that a busy machine can miss. Ask `claude auth status`; warn
  // only when it says signed out. If that can't answer either, don't raise an
  // alarm over a Claude that is working — the sign-in just stays unknown.
  const signInToConfirm = !capabilities && mode === "own" && !hasEnvCredentials;
  if (signInToConfirm && authStatus === null) {
    authStatus = yield* readClaudeAuthStatus(
      claudeSettings,
      environment,
      AUTH_STATUS_FALLBACK_TIMEOUT_MS,
    );
  }
  const signInUnknown = signInToConfirm && authStatus === null;

  if (signInToConfirm && authStatus?.loggedIn === false) {
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

  const email = capabilities?.email ?? authStatus?.email;
  const authMetadata =
    mode === "uno"
      ? { type: "unoAi", label: "Uno AI" }
      : claudeAuthMetadata({
          subscriptionType: capabilities?.subscriptionType ?? authStatus?.subscriptionType,
          authMethod: capabilities?.tokenSource ?? authStatus?.authMethod,
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
      auth: signInUnknown
        ? { status: "unknown" }
        : {
            status: "authenticated",
            ...(email && mode === "own" ? { email } : {}),
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
    CLAUDE_FALLBACK_MODELS,
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
