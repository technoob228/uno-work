/**
 * CustomHarnessProvider — snapshot / status of a custom (ACP) harness.
 *
 * The periodic check is cheap on purpose (it runs every few minutes for
 * every harness): resolve the executable, run the optional `detect` command
 * for a version. It never starts an ACP session — models the agent
 * advertises are learned from real chats and from Test connection and kept
 * in memory by the driver.
 *
 * @module CustomHarnessProvider
 */
import type {
  CustomHarnessSettings,
  ModelCapabilities,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { formatCommandLine, validateHarnessConfig } from "@t3tools/shared/customHarness";
import { Effect, Option, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CUSTOM_HARNESS_DEFAULT_MODEL, resolveHarnessExecutable } from "../acp/CustomAcpSupport.ts";
import {
  buildServerProvider,
  collectStreamAsString,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const DETECT_TIMEOUT_MS = 8_000;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

export interface CustomHarnessPresentation {
  readonly displayName: string;
}

function presentation(input: CustomHarnessPresentation) {
  return {
    displayName: input.displayName,
    badgeLabel: "Custom",
    // Plan/build is a Cursor/Codex notion; ACP modes are agent-specific.
    showInteractionModeToggle: false,
  } as const;
}

/**
 * Picker models: the configured list, else what the agent advertised in a
 * session, else one "Default" entry (the agent's own default model).
 */
export function buildCustomHarnessModels(
  config: Pick<CustomHarnessSettings, "models">,
  discovered: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): ReadonlyArray<ServerProviderModel> {
  const source =
    config.models.length > 0
      ? config.models.map((model) => ({ id: model.id, name: model.name?.trim() || model.id }))
      : discovered;
  const models = source
    .filter((model) => model.id.trim().length > 0)
    .map(
      (model) =>
        ({
          slug: model.id.trim(),
          name: model.name.trim() || model.id.trim(),
          isCustom: true,
          capabilities: EMPTY_CAPABILITIES,
        }) satisfies ServerProviderModel,
    );
  return models.length > 0
    ? models
    : [
        {
          slug: CUSTOM_HARNESS_DEFAULT_MODEL,
          name: "Default",
          isCustom: true,
          capabilities: EMPTY_CAPABILITIES,
        },
      ];
}

export function buildInitialCustomHarnessSnapshot(
  config: CustomHarnessSettings,
  input: CustomHarnessPresentation,
): ServerProviderDraft {
  return buildServerProvider({
    presentation: presentation(input),
    enabled: config.enabled,
    checkedAt: new Date().toISOString(),
    models: buildCustomHarnessModels(config, []),
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: config.enabled ? `Checking ${input.displayName}…` : "Turned off.",
    },
  });
}

/** First non-empty line, shortened — shown as the version. */
export function versionFromDetectOutput(result: CommandResult): string | null {
  const line = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  const semver = line.match(/\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/);
  return (semver?.[0] ?? line).slice(0, 60);
}

const runDetectCommand = (command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, [...args], { env, shell: false, forceKillAfter: "2 seconds" }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code } satisfies CommandResult;
  }).pipe(Effect.scoped);

export const checkCustomHarnessStatus = Effect.fn("checkCustomHarnessStatus")(function* (input: {
  readonly config: CustomHarnessSettings;
  readonly displayName: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly discoveredModels: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
}): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const { config } = input;
  const checkedAt = new Date().toISOString();
  const models = buildCustomHarnessModels(config, input.discoveredModels());
  const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
    buildServerProvider({
      presentation: presentation(input),
      enabled: config.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!config.enabled) {
    return build({
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Turned off in Settings → Harnesses.",
    });
  }

  const valid = validateHarnessConfig(config);
  if (!valid.ok) {
    return build({
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: valid.reason,
    });
  }
  const executable = yield* Effect.promise(() =>
    resolveHarnessExecutable(config.command, input.environment),
  );
  if (!executable.ok) {
    return build({
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message:
        config.installCommand.length > 0
          ? `${executable.reason} Install it from Settings → Harnesses (runs \`${formatCommandLine(config.installCommand)}\`).`
          : `${executable.reason} Install the agent on this machine or fix the command in Settings → Harnesses.`,
    });
  }

  if (config.detectCommand.length === 0) {
    return build({
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "unknown" },
    });
  }

  const detectExecutable = yield* Effect.promise(() =>
    resolveHarnessExecutable(config.detectCommand[0]!, input.environment),
  );
  if (!detectExecutable.ok) {
    return build({
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `Detect command: ${detectExecutable.reason}`,
    });
  }
  const detected = yield* runDetectCommand(
    detectExecutable.path,
    config.detectCommand.slice(1),
    input.environment,
  ).pipe(Effect.timeoutOption(DETECT_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(detected) || Option.isNone(detected.success)) {
    return build({
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: Result.isFailure(detected)
        ? `Detect command failed to run: ${String(detected.failure)}`
        : "Detect command timed out.",
    });
  }
  const result = detected.success.value;
  if (result.code !== 0) {
    return build({
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `\`${formatCommandLine(config.detectCommand)}\` exited with ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    });
  }
  return build({
    installed: true,
    version: versionFromDetectOutput(result),
    status: "ready",
    auth: { status: "unknown" },
  });
});
