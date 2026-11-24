/**
 * GeminiProvider — snapshot / status of Gemini CLI.
 *
 * The periodic check is cheap (it runs every few minutes): find the binary,
 * `gemini --version`, and read the sign-in from `~/.gemini` and the
 * environment (GeminiAcpSupport.probeGeminiAuth) — no network, no ACP
 * session. The model list is the lineup Gemini CLI 0.70 advertises until a
 * real chat reports the installed CLI's own list (the driver keeps it).
 *
 * @module GeminiProvider
 */
import { access } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { GeminiSettings, ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { GEMINI_ANTIGRAVITY_DETECTED_MESSAGE } from "@t3tools/shared/agentVersions";
import { createModelCapabilities } from "@t3tools/shared/model";
import { Effect, Option, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveHarnessExecutable } from "../acp/CustomAcpSupport.ts";
import {
  GEMINI_AUTO_MODEL,
  GEMINI_DISPLAY_NAME,
  type GeminiAuthState,
  probeGeminiAuth,
} from "../acp/GeminiAcpSupport.ts";
import {
  buildServerProvider,
  collectStreamAsString,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { versionFromDetectOutput } from "./CustomHarnessProvider.ts";

const VERSION_TIMEOUT_MS = 15_000;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const GEMINI_PRESENTATION = {
  displayName: GEMINI_DISPLAY_NAME,
  // Plan is Gemini's own read-only `plan` mode.
  showInteractionModeToggle: true,
} as const;

/** What Gemini CLI 0.70.0 lists in `session/new` (checked 20.11.2026). */
export const GEMINI_FALLBACK_MODELS: ReadonlyArray<{ readonly id: string; readonly name: string }> =
  [
    { id: GEMINI_AUTO_MODEL, name: "Auto" },
    { id: "gemini-3.1-pro-preview-customtools", name: "gemini-3.1-pro-preview" },
    { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview" },
    { id: "gemini-2.5-pro", name: "gemini-2.5-pro" },
    { id: "gemini-3.8-flash", name: "gemini-3.8-flash" },
    { id: "gemini-3.5-flash-lite", name: "gemini-3.5-flash-lite" },
  ];

/** "gemini-3-flash-preview" → "Gemini 3 Flash Preview"; other names as they are. */
export function geminiModelLabel(name: string): string {
  const trimmed = name.trim();
  if (!/^gemini-[\w.-]+$/i.test(trimmed)) return trimmed;
  return trimmed
    .split("-")
    .map((part) => (/^[a-z]/i.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function buildGeminiModels(
  config: Pick<GeminiSettings, "customModels">,
  discovered: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): ReadonlyArray<ServerProviderModel> {
  const source = discovered.length > 0 ? discovered : GEMINI_FALLBACK_MODELS;
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const model of source) {
    const slug = model.id.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: slug === GEMINI_AUTO_MODEL ? "Auto" : geminiModelLabel(model.name || slug),
      // Gemini CLI's own default: its router picks Pro or Flash per turn.
      ...(slug === GEMINI_AUTO_MODEL ? { isDefault: true } : {}),
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

export function buildInitialGeminiSnapshot(config: GeminiSettings): ServerProviderDraft {
  return buildServerProvider({
    presentation: GEMINI_PRESENTATION,
    enabled: config.enabled,
    checkedAt: new Date().toISOString(),
    models: buildGeminiModels(config, []),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: config.enabled ? "Checking Gemini CLI…" : "Gemini CLI is turned off.",
    },
  });
}

/**
 * Google Antigravity on this Mac (/Applications or ~/Applications): the
 * Gemini CLI card then points to the Antigravity agent (T64).
 */
export async function detectAntigravityApp(
  platform: NodeJS.Platform = process.platform,
  home: string = NodeOS.homedir(),
): Promise<boolean> {
  if (platform !== "darwin") return false;
  for (const dir of ["/Applications", NodePath.join(home, "Applications")]) {
    if (
      await access(NodePath.join(dir, "Antigravity.app")).then(
        () => true,
        () => false,
      )
    ) {
      return true;
    }
  }
  return false;
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

function authProbe(auth: GeminiAuthState) {
  const snapshotAuth = {
    status: auth.status,
    ...(auth.type ? { type: auth.type } : {}),
    ...(auth.label ? { label: auth.label } : {}),
    ...(auth.email ? { email: auth.email } : {}),
  } as const;
  if (auth.status === "unauthenticated") {
    return {
      status: "error" as const,
      auth: snapshotAuth,
      message: `Gemini CLI is not signed in. ${auth.message ?? ""}`.trim(),
    };
  }
  return { status: "ready" as const, auth: snapshotAuth };
}

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* (input: {
  readonly config: GeminiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly discoveredModels: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Google Antigravity (the IDE) is on this machine; default: looks in the Applications folders. */
  readonly detectAntigravity?: () => Promise<boolean>;
}): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const { config } = input;
  const checkedAt = new Date().toISOString();
  const models = buildGeminiModels(config, input.discoveredModels());
  const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
    buildServerProvider({
      presentation: GEMINI_PRESENTATION,
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
      message: "Gemini CLI is turned off in Uno Work settings.",
    });
  }

  const executable = yield* Effect.promise(() =>
    resolveHarnessExecutable(config.binaryPath.trim() || "gemini", input.environment),
  );
  if (!executable.ok) {
    const antigravity = yield* Effect.promise(() =>
      (input.detectAntigravity ?? detectAntigravityApp)().catch(() => false),
    );
    return build({
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: antigravity
        ? GEMINI_ANTIGRAVITY_DETECTED_MESSAGE
        : "Gemini CLI (`gemini`) is not installed or not on PATH.",
    });
  }

  const auth = authProbe(yield* Effect.promise(() => probeGeminiAuth(input.environment)));
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
              ? "`gemini --version` failed to run."
              : "`gemini --version` timed out.",
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
      message: `\`gemini --version\` exited with ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    });
  }
  return build({ installed: true, version: versionFromDetectOutput(result), ...auth });
});
