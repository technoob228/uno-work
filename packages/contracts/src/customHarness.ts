/**
 * Custom harnesses — bring your own agent into Uno Work.
 *
 * A custom harness is any program that speaks the Agent Client Protocol
 * (ACP, JSON-RPC 2.0 over stdio): your own agent, Gemini CLI (`--acp`),
 * `opencode acp`, an ACP shim around another CLI, … Uno Work spawns it once
 * per chat, drives it with `initialize` → `session/new` → `session/prompt`,
 * and renders its `session/update` stream, permission requests and plans
 * like any built-in agent. The full contract lives in docs/custom-harness.md.
 *
 * Two ways to register one, same result:
 *
 *   - Settings → Harnesses → "Add custom harness": stored as a
 *     `providerInstances` entry with `driver: "acp"`; secret environment
 *     variables go to the daemon's secret store.
 *   - A file `~/.uno/harnesses/<id>.json` (written by a person or by an AI
 *     on the machine) — see {@link CustomHarnessFile}. Loaded read-only as
 *     instance `harness-<id>`; values for its `secretEnv` names are entered
 *     in Settings and kept in the secret store, never in the file.
 *
 * @module customHarness
 */
import { Effect, Schema } from "effect";

import { ProviderInstanceEnvironment, ProviderInstanceId } from "./providerInstance.ts";

/** Driver kind of every custom (ACP) harness instance. */
export const CUSTOM_HARNESS_DRIVER_KIND = "acp";

/** Instance id of a file-registered harness `~/.uno/harnesses/<id>.json`. */
export const CUSTOM_HARNESS_FILE_INSTANCE_PREFIX = "harness-";

/** Where the chat's session runs: the thread's project folder (default), home, or a fixed folder. */
export const CustomHarnessWorkingDirectory = Schema.Literals(["project", "home", "custom"]);
export type CustomHarnessWorkingDirectory = typeof CustomHarnessWorkingDirectory.Type;

export const CustomHarnessModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
});
export type CustomHarnessModel = typeof CustomHarnessModel.Type;

/**
 * Driver config of a custom harness (`providerInstances.<id>.config` for
 * `driver: "acp"`). Commands are argv arrays — never run through a shell.
 */
export const CustomHarnessSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Executable: an absolute path or a bare name looked up on PATH. */
  command: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  workingDirectory: CustomHarnessWorkingDirectory.pipe(
    Schema.withDecodingDefault(Effect.succeed("project" as const)),
  ),
  /** Absolute folder, used when `workingDirectory === "custom"`. */
  customDirectory: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** e.g. `["npm", "install", "-g", "@acme/agent"]` — run only from the Install button. */
  installCommand: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** e.g. `["kimi", "--version"]` — exit 0 means installed; first line is shown as the version. */
  detectCommand: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Models for the picker. Empty → discovered over ACP, or a single "Default". */
  models: Schema.Array(CustomHarnessModel).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** ACP `authenticate` method id to call after `initialize`; empty → skip. */
  authMethodId: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** One emoji or up to two letters. */
  icon: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  description: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Pass the Uno AI gateway key as `UNO_GATEWAY_API_KEY` (+ `UNO_GATEWAY_BASE_URL`). */
  shareUnoGateway: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Pass this machine's Uno identity (`UNO_AGENT_API_KEY`, `UNO_API_URL`, `UNO_BOX_ID`). */
  shareUnoAccount: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type CustomHarnessSettings = typeof CustomHarnessSettings.Type;

/* ------------------------------------------------------------------ *
 * RPC
 * ------------------------------------------------------------------ */

export class CustomHarnessRpcError extends Schema.TaggedErrorClass<CustomHarnessRpcError>()(
  "CustomHarnessRpcError",
  {
    code: Schema.Literals(["invalid", "notFound", "conflict", "failed"]),
    message: Schema.String,
  },
) {}

export const CustomHarnessSource = Schema.Literals(["settings", "file"]);
export type CustomHarnessSource = typeof CustomHarnessSource.Type;

export const CustomHarnessSecretState = Schema.Struct({
  name: Schema.String,
  isSet: Schema.Boolean,
});
export type CustomHarnessSecretState = typeof CustomHarnessSecretState.Type;

export const CustomHarnessSummary = Schema.Struct({
  instanceId: ProviderInstanceId,
  source: CustomHarnessSource,
  /** Absolute path of the JSON file when `source === "file"`. */
  filePath: Schema.optional(Schema.String),
  name: Schema.String,
  config: CustomHarnessSettings,
  /** Names only — values never leave the daemon. File harnesses: `secretEnv`. */
  secrets: Schema.Array(CustomHarnessSecretState),
  /** Non-secret variables of a file harness (settings harnesses: in settings). */
  environment: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
});
export type CustomHarnessSummary = typeof CustomHarnessSummary.Type;

export const CustomHarnessInvalidFile = Schema.Struct({
  file: Schema.String,
  reason: Schema.String,
});
export type CustomHarnessInvalidFile = typeof CustomHarnessInvalidFile.Type;

export const CustomHarnessListResult = Schema.Struct({
  /** `~/.uno/harnesses` (display form). */
  directory: Schema.String,
  /** Where the daemon keeps a copy of docs/custom-harness.md for agents. */
  guidePath: Schema.String,
  harnesses: Schema.Array(CustomHarnessSummary),
  invalid: Schema.Array(CustomHarnessInvalidFile),
});
export type CustomHarnessListResult = typeof CustomHarnessListResult.Type;

/**
 * Test either a registered harness (`instanceId`) or an unsaved draft from
 * the Add dialog (`config` + `environment`, values in clear — the same
 * values would reach the daemon on save anyway).
 */
export const CustomHarnessTestInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
  config: Schema.optional(Schema.Unknown),
  environment: Schema.optional(ProviderInstanceEnvironment),
});
export type CustomHarnessTestInput = typeof CustomHarnessTestInput.Type;

export const CustomHarnessTestStage = Schema.Literals([
  "validate",
  "spawn",
  "initialize",
  "authenticate",
  "session",
  "prompt",
  "done",
]);
export type CustomHarnessTestStage = typeof CustomHarnessTestStage.Type;

export const CustomHarnessTestResult = Schema.Struct({
  ok: Schema.Boolean,
  /** Last stage reached (`done` when everything passed). */
  stage: CustomHarnessTestStage,
  /** Human-readable reason when `ok === false`. */
  error: Schema.optional(Schema.String),
  /** Resolved executable. */
  command: Schema.String,
  agentName: Schema.optional(Schema.String),
  agentVersion: Schema.optional(Schema.String),
  protocolVersion: Schema.optional(Schema.Number),
  loadSession: Schema.Boolean,
  mcpHttp: Schema.Boolean,
  images: Schema.Boolean,
  authMethods: Schema.Array(Schema.String),
  models: Schema.Array(Schema.String),
  modes: Schema.Array(Schema.String),
  /** Text the agent streamed back for "Reply with OK". */
  reply: Schema.String,
  stopReason: Schema.optional(Schema.String),
  /** The agent asked for permission during the test (auto-declined). */
  permissionRequested: Schema.Boolean,
  /** Tail of the agent's stderr. */
  stderr: Schema.String,
  durationMs: Schema.Number,
});
export type CustomHarnessTestResult = typeof CustomHarnessTestResult.Type;

export const CustomHarnessSetSecretInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: Schema.String,
  /** Empty string removes the value. */
  value: Schema.String,
});
export type CustomHarnessSetSecretInput = typeof CustomHarnessSetSecretInput.Type;

export const CustomHarnessInstallStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type CustomHarnessInstallStartInput = typeof CustomHarnessInstallStartInput.Type;

export const CustomHarnessInstallStatusInput = Schema.Struct({
  jobId: Schema.String,
});
export type CustomHarnessInstallStatusInput = typeof CustomHarnessInstallStatusInput.Type;

export const CustomHarnessInstallStatus = Schema.Struct({
  jobId: Schema.String,
  instanceId: ProviderInstanceId,
  state: Schema.Literals(["queued", "running", "succeeded", "failed"]),
  command: Schema.String,
  log: Schema.String,
  error: Schema.optional(Schema.String),
});
export type CustomHarnessInstallStatus = typeof CustomHarnessInstallStatus.Type;
