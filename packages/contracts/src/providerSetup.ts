/**
 * Provider setup — installing a harness CLI and signing it in from the UI.
 *
 * Both flows run as background jobs on the daemon that owns the machine:
 * the client starts a job, then polls its status until it settles. Jobs are
 * keyed per driver (one install and one sign-in at a time per driver) so a
 * second click while one is running is rejected rather than queued.
 *
 * Nothing here carries secrets back to the client: the API key travels only
 * in `ProviderAuthStartInput`, and job logs are scrubbed of it server-side.
 *
 * @module providerSetup
 */
import { Schema } from "effect";

import { ProviderDriverKind } from "./providerInstance.ts";

export const ProviderSetupJobId = Schema.String.pipe(Schema.brand("ProviderSetupJobId"));
export type ProviderSetupJobId = typeof ProviderSetupJobId.Type;

export const ProviderSetupJobState = Schema.Literals(["queued", "running", "succeeded", "failed"]);
export type ProviderSetupJobState = typeof ProviderSetupJobState.Type;

/** Drivers whose CLI the daemon knows how to install for the current user. */
export const INSTALLABLE_PROVIDER_DRIVERS = [
  "codex",
  "claudeAgent",
  "opencode",
  "hermes",
  "cursor",
] as const;

/** Drivers that support the in-app sign-in flow. */
export const ProviderAuthDriver = Schema.Literals(["codex", "claudeAgent"]);
export type ProviderAuthDriver = typeof ProviderAuthDriver.Type;

export const ProviderAuthMethod = Schema.Literals(["apiKey", "oauth"]);
export type ProviderAuthMethod = typeof ProviderAuthMethod.Type;

export class ProviderSetupRpcError extends Schema.TaggedErrorClass<ProviderSetupRpcError>()(
  "ProviderSetupRpcError",
  {
    /**
     * - `conflict`: a job for this driver is already running.
     * - `unsupported`: the driver/method pair has no setup flow here.
     * - `notFound`: unknown job id (jobs are forgotten after a while).
     * - `invalid`: bad input (empty API key, code submitted to a job that is
     *   not waiting for one, ...).
     * - `failed`: the daemon could not start the job at all.
     */
    code: Schema.Literals(["conflict", "unsupported", "notFound", "invalid", "failed"]),
    message: Schema.String,
  },
) {}

/* ------------------------------------------------------------------ *
 * Install
 * ------------------------------------------------------------------ */

export const ProviderInstallStartInput = Schema.Struct({
  driver: ProviderDriverKind,
});
export type ProviderInstallStartInput = typeof ProviderInstallStartInput.Type;

export const ProviderInstallStartResult = Schema.Struct({
  jobId: ProviderSetupJobId,
});
export type ProviderInstallStartResult = typeof ProviderInstallStartResult.Type;

export const ProviderInstallStatusInput = Schema.Struct({
  jobId: ProviderSetupJobId,
});
export type ProviderInstallStatusInput = typeof ProviderInstallStatusInput.Type;

export const ProviderInstallJobStatus = Schema.Struct({
  jobId: ProviderSetupJobId,
  driver: ProviderDriverKind,
  state: ProviderSetupJobState,
  /** Tail of the combined stdout/stderr of the install command. */
  log: Schema.String,
  /** The command line that was run, for the "show details" affordance. */
  command: Schema.String,
  /** Short human-readable reason when `state === "failed"`. */
  error: Schema.optional(Schema.String),
});
export type ProviderInstallJobStatus = typeof ProviderInstallJobStatus.Type;

/* ------------------------------------------------------------------ *
 * Sign in
 * ------------------------------------------------------------------ */

export const ProviderAuthStartInput = Schema.Struct({
  driver: ProviderAuthDriver,
  method: ProviderAuthMethod,
  /** Required when `method === "apiKey"`. Never echoed back. */
  apiKey: Schema.optional(Schema.String),
});
export type ProviderAuthStartInput = typeof ProviderAuthStartInput.Type;

export const ProviderAuthStartResult = Schema.Struct({
  jobId: ProviderSetupJobId,
});
export type ProviderAuthStartResult = typeof ProviderAuthStartResult.Type;

export const ProviderAuthStatusInput = Schema.Struct({
  jobId: ProviderSetupJobId,
});
export type ProviderAuthStatusInput = typeof ProviderAuthStatusInput.Type;

export const ProviderAuthJobStatus = Schema.Struct({
  jobId: ProviderSetupJobId,
  driver: ProviderAuthDriver,
  method: ProviderAuthMethod,
  state: ProviderSetupJobState,
  /** Tail of the CLI output, with the API key (if any) scrubbed. */
  log: Schema.String,
  /** Where the user must go to finish the browser half of an OAuth flow. */
  verificationUrl: Schema.optional(Schema.String),
  /** One-time device code the user types on the verification page. */
  userCode: Schema.optional(Schema.String),
  /**
   * True once the CLI is waiting for the user to paste the authorization
   * code it got from the browser; `provider.auth.submitCode` delivers it.
   */
  needsCodeInput: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type ProviderAuthJobStatus = typeof ProviderAuthJobStatus.Type;

export const ProviderAuthSubmitCodeInput = Schema.Struct({
  jobId: ProviderSetupJobId,
  code: Schema.String,
});
export type ProviderAuthSubmitCodeInput = typeof ProviderAuthSubmitCodeInput.Type;
