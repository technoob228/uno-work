/**
 * CustomAcpSupport — the generic ACP client side used for custom harnesses
 * (any agent that speaks ACP over stdio; contract in docs/custom-harness.md).
 *
 * Unlike the Cursor/Hermes helpers nothing here knows the agent: option ids,
 * model ids and modes come from what the agent itself advertises.
 *
 *   - permissions: our Approve / Approve for session / Deny are mapped onto
 *     the agent's `options[]` by their standard `kind`
 *     (allow_once / allow_always / reject_once / reject_always), never by id;
 *   - models: a `session/new` config option with `category: "model"`
 *     (set via `session/set_config_option`), else the unstable
 *     `models` state (set via `session/set_model`), else none;
 *   - the executable is resolved by us (absolute, `~/`, or PATH lookup) and
 *     spawned without a shell.
 *
 * @module CustomAcpSupport
 */
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import type {
  CustomHarnessSettings,
  ProviderApprovalDecision,
  RuntimeMode,
} from "@t3tools/contracts";
import { isAbsoluteCommandPath } from "@t3tools/shared/customHarness";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
} from "./AcpSessionRuntime.ts";
import { collectSessionConfigOptionValues, extractModelConfigId } from "./AcpRuntimeModel.ts";

/** SIGTERM → SIGKILL grace period for a custom agent process. */
export const CUSTOM_HARNESS_FORCE_KILL_AFTER_MS = 3_000;

/** Model id meaning "whatever the agent uses by default" (no set_model sent). */
export const CUSTOM_HARNESS_DEFAULT_MODEL = "default";

/* ------------------------------------------------------------------ *
 * Executable, working directory
 * ------------------------------------------------------------------ */

export type ResolveResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

export function expandHome(value: string, home = os.homedir()): string {
  if (value === "~") return home;
  return value.startsWith("~/") ? nodePath.join(home, value.slice(2)) : value;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    if (process.platform === "win32") return true;
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the executable actually is. Bare names are looked up on the PATH the
 * harness will get (the daemon's plus `~/.local/bin`, where user installs
 * land), so "installed" and "can start" agree.
 */
export async function resolveHarnessExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  home = os.homedir(),
): Promise<ResolveResult> {
  const expanded = expandHome(command.trim(), home);
  if (isAbsoluteCommandPath(expanded)) {
    return (await isExecutableFile(expanded))
      ? { ok: true, path: expanded }
      : { ok: false, reason: `${expanded} does not exist or is not executable.` };
  }
  const pathEntries = (env.PATH ?? process.env.PATH ?? "")
    .split(nodePath.delimiter)
    .filter((entry) => entry.length > 0 && nodePath.isAbsolute(entry));
  const localBin = nodePath.join(home, ".local", "bin");
  if (!pathEntries.includes(localBin)) pathEntries.push(localBin);
  const extensions =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => ext.toLowerCase())]
      : [""];
  for (const dir of pathEntries) {
    for (const ext of extensions) {
      const candidate = nodePath.join(dir, `${expanded}${ext}`);
      if (await isExecutableFile(candidate)) return { ok: true, path: candidate };
    }
  }
  return { ok: false, reason: `"${expanded}" was not found on PATH.` };
}

/** PATH the harness runs with: the given one plus `~/.local/bin`. */
export function harnessPath(env: NodeJS.ProcessEnv, home = os.homedir()): string {
  const localBin = nodePath.join(home, ".local", "bin");
  const entries = (env.PATH ?? "").split(nodePath.delimiter).filter((entry) => entry.length > 0);
  return entries.includes(localBin)
    ? entries.join(nodePath.delimiter)
    : [...entries, localBin].join(nodePath.delimiter);
}

/** Folder the session runs in (`session/new.cwd` and the process cwd). */
export function resolveHarnessCwd(
  config: Pick<CustomHarnessSettings, "workingDirectory" | "customDirectory">,
  threadCwd: string,
  home = os.homedir(),
): string {
  switch (config.workingDirectory) {
    case "home":
      return home;
    case "custom": {
      const custom = expandHome(config.customDirectory.trim(), home);
      return custom.length > 0 && nodePath.isAbsolute(custom) ? custom : threadCwd;
    }
    default:
      return threadCwd;
  }
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

type PermissionKind = EffectAcpSchema.PermissionOptionKind;

function optionOfKinds(
  request: EffectAcpSchema.RequestPermissionRequest,
  kinds: ReadonlyArray<PermissionKind>,
): string | undefined {
  for (const kind of kinds) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    const id = option?.optionId?.trim();
    if (id) return id;
  }
  return undefined;
}

/**
 * Our decision → the agent's option, by standard kind. `undefined` means
 * "answer `cancelled`" (the agent offered nothing matching, or the person
 * cancelled).
 */
export function selectPermissionOptionForDecision(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  switch (decision) {
    case "accept":
      return optionOfKinds(request, ["allow_once", "allow_always"]);
    case "acceptForSession":
      return optionOfKinds(request, ["allow_always", "allow_once"]);
    case "decline":
      return optionOfKinds(request, ["reject_once", "reject_always"]);
    default:
      return undefined;
  }
}

const EDIT_TOOL_KINDS = new Set(["edit", "delete", "move"]);

/**
 * Permission modes without asking the person: `full-access` approves
 * everything, `auto-accept-edits` approves file edits. Returns the option to
 * answer with, or `undefined` to ask.
 */
export function autoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
  runtimeMode: RuntimeMode,
): string | undefined {
  const kind = request.toolCall.kind ?? undefined;
  const autoApprove =
    runtimeMode === "full-access" ||
    (runtimeMode === "auto-accept-edits" && kind !== undefined && EDIT_TOOL_KINDS.has(kind));
  return autoApprove ? optionOfKinds(request, ["allow_once", "allow_always"]) : undefined;
}

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

type SessionSetupResponse =
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

export interface DiscoveredModels {
  readonly source: "configOption" | "sessionModels" | "none";
  readonly configId?: string;
  readonly current?: string;
  readonly models: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

export function discoverSessionModels(setup: SessionSetupResponse): DiscoveredModels {
  const configId = extractModelConfigId(setup);
  const option = configId
    ? setup.configOptions?.find((candidate) => candidate.id.trim() === configId)
    : undefined;
  if (configId && option && option.type === "select") {
    const names = new Map<string, string>();
    for (const entry of option.options) {
      const flat = "value" in entry ? [entry] : entry.options;
      for (const item of flat) names.set(item.value, item.name);
    }
    return {
      source: "configOption",
      configId,
      current: option.currentValue,
      models: collectSessionConfigOptionValues(option).map((id) => ({
        id,
        name: names.get(id) ?? id,
      })),
    };
  }
  const state = setup.models;
  if (state && state.availableModels.length > 0) {
    return {
      source: "sessionModels",
      current: state.currentModelId,
      models: state.availableModels.map((model) => ({ id: model.modelId, name: model.name })),
    };
  }
  return { source: "none", models: [] };
}

/**
 * Switch the session to `model` the way the agent advertised. No-op for
 * the "default" pseudo-model, for agents without model selection, and for
 * ids the agent did not list (a stale pick from the config list).
 */
export function applyCustomHarnessModel<E>(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "setConfigOption" | "request">;
  readonly sessionId: string;
  readonly discovered: DiscoveredModels;
  readonly model: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<boolean, E> {
  const model = input.model?.trim();
  if (!model || model === CUSTOM_HARNESS_DEFAULT_MODEL) return Effect.succeed(false);
  if (model === input.discovered.current) return Effect.succeed(false);
  const known = input.discovered.models.some((candidate) => candidate.id === model);
  if (input.discovered.source === "configOption" && input.discovered.configId && known) {
    return input.runtime
      .setConfigOption(input.discovered.configId, model)
      .pipe(Effect.mapError(input.mapError), Effect.as(true));
  }
  if (input.discovered.source === "sessionModels" && known) {
    return input.runtime
      .request("session/set_model", { sessionId: input.sessionId, modelId: model })
      .pipe(Effect.mapError(input.mapError), Effect.as(true));
  }
  return Effect.succeed(false);
}

/* ------------------------------------------------------------------ *
 * Runtime
 * ------------------------------------------------------------------ */

/** Keeps the last `maxChars` of a stream of text (the agent's stderr). */
export function makeTextTail(maxChars = 8_000) {
  let text = "";
  return {
    append: (chunk: string) => {
      text = (text + chunk).slice(-maxChars);
    },
    get: () => text,
  };
}

export interface CustomAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "clientCapabilities" | "spawn" | "dropUnsupportedMcpTransports"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Resolved absolute executable. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
}

export const makeCustomAcpRuntime = (
  input: CustomAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const { childProcessSpawner, command, args, environment, ...runtimeOptions } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: {
          command,
          args,
          cwd: input.cwd,
          env: environment,
          shell: false,
          inheritProcessEnv: false,
          forceKillAfterMs: CUSTOM_HARNESS_FORCE_KILL_AFTER_MS,
        },
        dropUnsupportedMcpTransports: true,
        // Uno Work does not serve fs/* or terminal/* to custom agents: they
        // read, write and run commands themselves and report it through
        // tool_call updates (docs/custom-harness.md).
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
