/**
 * GrokProvider — snapshot / status of Grok CLI.
 *
 * The periodic check is cheap (it runs every few minutes): find the binary,
 * `grok --version`, and read the sign-in from `~/.grok/auth.json` and
 * `XAI_API_KEY` (GrokAcpSupport.probeGrokAuth) — no network, no ACP session.
 * The model list is what Grok CLI 1.0.92 offers until a real chat reports
 * the installed CLI's own list (the driver keeps it).
 *
 * @module GrokProvider
 */
import type { GrokSettings, ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { Effect, Option, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveHarnessExecutable } from "../acp/CustomAcpSupport.ts";
import {
  GROK_DEFAULT_MODEL,
  GROK_DISPLAY_NAME,
  type GrokAuthState,
  probeGrokAuth,
} from "../acp/GrokAcpSupport.ts";
import {
  buildServerProvider,
  collectStreamAsString,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { versionFromDetectOutput } from "./CustomHarnessProvider.ts";

const VERSION_TIMEOUT_MS = 15_000;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const GROK_PRESENTATION = {
  displayName: GROK_DISPLAY_NAME,
  // Grok has no ACP modes: planning is its own tool (enter/exit_plan_mode).
  showInteractionModeToggle: false,
} as const;

/** What Grok CLI 1.0.92 lists in `session/new` (checked 23.11.2026). */
export const GROK_FALLBACK_MODELS: ReadonlyArray<{ readonly id: string; readonly name: string }> = [
  { id: GROK_DEFAULT_MODEL, name: "Grok 4.6" },
  { id: "grok-4.5", name: "Grok 4.5" },
];

/** "grok-4.6" → "Grok 4.6", "grok-code-fast-1" → "Grok Code Fast 1"; other names as they are. */
export function grokModelLabel(name: string): string {
  const trimmed = name.trim();
  if (!/^grok-[\w.-]+$/i.test(trimmed)) return trimmed;
  return trimmed
    .split("-")
    .map((part) => (/^[a-z]/i.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function buildGrokModels(
  config: Pick<GrokSettings, "customModels">,
  discovered: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): ReadonlyArray<ServerProviderModel> {
  const source = discovered.length > 0 ? discovered : GROK_FALLBACK_MODELS;
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const model of source) {
    const slug = model.id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: grokModelLabel(model.name || slug),
      ...(slug === GROK_DEFAULT_MODEL ? { isDefault: true } : {}),
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  for (const custom of config.customModels) {
    const slug = custom.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({ slug, name: slug, isCustom: true, capabilities: EMPTY_CAPABILITIES });
  }
  return models;
}

export function buildInitialGrokSnapshot(config: GrokSettings): ServerProviderDraft {
  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: config.enabled,
    checkedAt: new Date().toISOString(),
    models: buildGrokModels(config, []),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: config.enabled ? "Checking Grok…" : "Grok is turned off.",
    },
  });
}

const runVersion = (command: string, env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, ["--version"], { env, shell: false, forceKillAfter: "2 seconds" }),
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

function authProbe(auth: GrokAuthState) {
  const snapshotAuth = {
    status: auth.status,
    ...(auth.type ? { type: auth.type } : {}),
    ...(auth.label ? { label: auth.label } : {}),
  } as const;
  if (auth.status === "unauthenticated") {
    return {
      status: "error" as const,
      auth: snapshotAuth,
      message: `Grok is not signed in. ${auth.message ?? ""}`.trim(),
    };
  }
  return { status: "ready" as const, auth: snapshotAuth };
}

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (input: {
  readonly config: GrokSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly discoveredModels: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
}): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const { config } = input;
  const checkedAt = new Date().toISOString();
  const models = buildGrokModels(config, input.discoveredModels());
  const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
    buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: config.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!config.enabled) {
    return build({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Grok is turned off in Uno Work settings.",
    });
  }

  const executable = yield* Effect.promise(() =>
    resolveHarnessExecutable(config.binaryPath.trim() || "grok", input.environment),
  );
  if (!executable.ok) {
    return build({
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Grok CLI (`grok`) is not installed or not on PATH.",
    });
  }

  const auth = authProbe(yield* Effect.promise(() => probeGrokAuth(input.environment)));
  const detected = yield* runVersion(executable.path, input.environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(detected) || Option.isNone(detected.success)) {
    return build({
      installed: true,
      version: null,
      ...auth,
      ...(auth.status === "ready"
        ? {
            status: "warning" as const,
            message: Result.isFailure(detected)
              ? "`grok --version` failed to run."
              : "`grok --version` timed out.",
          }
        : {}),
    });
  }
  const result = detected.success.value;
  if (result.code !== 0) {
    return build({
      installed: true,
      version: null,
      status: "error",
      auth: auth.auth,
      message: `\`grok --version\` exited with ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    });
  }
  return build({ installed: true, version: versionFromDetectOutput(result), ...auth });
});
