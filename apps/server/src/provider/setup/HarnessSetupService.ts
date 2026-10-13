/**
 * HarnessSetup — install a harness CLI or sign it in, as background jobs.
 *
 * The runner (`makeHarnessSetupRunner`) is plain Promise-land so the child
 * processes and their timers are easy to reason about and to fake in tests;
 * `HarnessSetupLive` wires it to the daemon's settings, provider registry and
 * platform and exposes it as an Effect service for `ws.ts`.
 *
 * Flows:
 *   install <driver>        run the installer from `harnessInstallCommands`,
 *                           then re-probe that driver's default instance.
 *   auth codex apiKey       `codex login --with-api-key`, key on stdin.
 *   auth codex oauth        `codex login --device-auth`; URL + code parsed
 *                           from stdout, process waits for the browser half.
 *   auth claudeAgent apiKey store ANTHROPIC_API_KEY in the default Claude
 *                           instance's environment (secret store backed).
 *   auth claudeAgent oauth  `claude auth login`; URL parsed from stdout, the
 *                           user pastes the code back via `submitCode`.
 *   resume / restart        a second `authStart` while a browser sign-in waits
 *                           hands the same job back (the page was closed or
 *                           reloaded: the link and code are still good);
 *                           `restart` or `authCancel` stops it.
 *   signed in elsewhere     while a browser sign-in waits, the daemon re-probes
 *                           the harness: a login done in a terminal ends the job
 *                           as succeeded instead of blocking the row for 10 min.
 *   sign out codex          `codex logout`.
 *   sign out claudeAgent    `claude auth logout` + drop the stored
 *                           ANTHROPIC_API_KEY; on a Uno box Claude Code then
 *                           runs on Uno AI again (where the plan allows it).
 *
 * Job logs never contain the API key: it is scrubbed by the job store.
 *
 * @module provider/setup/HarnessSetupService
 */
import * as NodeOS from "node:os";
import { access, constants as fsConstants } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";

import {
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  type ProviderAuthCancelInput,
  type ProviderAuthCancelResult,
  type ProviderAuthDriver,
  type ProviderAuthJobStatus,
  type ProviderAuthMethod,
  type ProviderAuthSignOutInput,
  type ProviderAuthSignOutResult,
  type ProviderAuthStartInput,
  type ProviderAuthStartResult,
  type ProviderAuthStatusInput,
  type ProviderAuthSubmitCodeInput,
  ProviderDriverKind,
  type ProviderInstallJobStatus,
  type ProviderInstallStartInput,
  type ProviderInstallStartResult,
  type ProviderInstallStatusInput,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ProviderSetupRpcError,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Path, Schema } from "effect";

import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { isInstallableDriver, resolveInstallPlan } from "./harnessInstallCommands.ts";
import { SetupJobStore, type SetupJobRecord } from "./harnessJobs.ts";
import {
  type HarnessProcessHandle,
  type HarnessProcessSpawner,
  spawnHarnessProcess,
  withUserLocalBinOnPath,
} from "./harnessProcess.ts";
import { lastNonEmptyLine, parseOAuthPrompt } from "./harnessSetupParsers.ts";

export const AUTH_JOB_TIMEOUT_MS = 10 * 60_000;
/** How often a waiting browser sign-in checks whether the harness got signed in another way. */
export const AUTH_WATCH_INTERVAL_MS = 7_000;
export const SIGN_OUT_TIMEOUT_MS = 30_000;
export const INSTALL_JOB_TIMEOUT_MS = 15 * 60_000;
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

export interface HarnessSetupShape {
  readonly installStart: (
    input: ProviderInstallStartInput,
  ) => Effect.Effect<ProviderInstallStartResult, ProviderSetupRpcError>;
  readonly installStatus: (
    input: ProviderInstallStatusInput,
  ) => Effect.Effect<ProviderInstallJobStatus, ProviderSetupRpcError>;
  readonly authStart: (
    input: ProviderAuthStartInput,
  ) => Effect.Effect<ProviderAuthStartResult, ProviderSetupRpcError>;
  readonly authStatus: (
    input: ProviderAuthStatusInput,
  ) => Effect.Effect<ProviderAuthJobStatus, ProviderSetupRpcError>;
  readonly authSubmitCode: (
    input: ProviderAuthSubmitCodeInput,
  ) => Effect.Effect<ProviderAuthJobStatus, ProviderSetupRpcError>;
  readonly authSignOut: (
    input: ProviderAuthSignOutInput,
  ) => Effect.Effect<ProviderAuthSignOutResult, ProviderSetupRpcError>;
  readonly authCancel: (
    input: ProviderAuthCancelInput,
  ) => Effect.Effect<ProviderAuthCancelResult, ProviderSetupRpcError>;
}

export class HarnessSetup extends Context.Service<HarnessSetup, HarnessSetupShape>()(
  "t3/provider/setup/HarnessSetup",
) {}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

export interface CliEnvironment {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Who the harness is signed in as, as far as the daemon's probe can tell. */
export interface HarnessAuthProbe {
  readonly authenticated: boolean;
  /** Changes when the account or the kind of sign-in changes. */
  readonly signature: string;
}

export interface HarnessSetupRunnerDeps {
  readonly spawn: HarnessProcessSpawner;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly probeNpmGlobalWritable: () => Promise<boolean>;
  readonly probeUvAvailable: () => Promise<boolean>;
  /** Binary + environment the daemon itself uses to run that driver's CLI. */
  readonly resolveCliEnvironment: (driver: ProviderAuthDriver) => Promise<CliEnvironment>;
  readonly storeClaudeApiKey: (apiKey: string) => Promise<void>;
  /** Drops ANTHROPIC_API_KEY from the default Claude instance; true if one was there. */
  readonly removeClaudeApiKey: () => Promise<boolean>;
  readonly refreshProvider: (driver: ProviderDriverKind) => Promise<void>;
  /**
   * The harness's sign-in as the daemon sees it; `refresh` re-probes the CLI
   * first. Absent: a waiting sign-in is not watched for a login done elsewhere.
   */
  readonly probeAuth?: (
    driver: ProviderAuthDriver,
    options: { readonly refresh: boolean },
  ) => Promise<HarnessAuthProbe>;
  readonly authWatchIntervalMs?: number;
  readonly authTimeoutMs?: number;
  readonly signOutTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly now?: () => number;
  readonly makeJobId?: () => string;
  readonly log?: (message: string, meta?: Record<string, unknown>) => void;
}

interface InstallExtra {
  readonly command: string;
}

interface AuthExtra {
  readonly method: ProviderAuthMethod;
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly needsCodeInput: boolean;
}

const fail = (code: ProviderSetupRpcError["code"], message: string) =>
  new ProviderSetupRpcError({ code, message });

export interface HarnessSetupRunner {
  readonly installStart: (input: ProviderInstallStartInput) => ProviderInstallStartResult;
  readonly installStatus: (input: ProviderInstallStatusInput) => ProviderInstallJobStatus;
  readonly authStart: (input: ProviderAuthStartInput) => ProviderAuthStartResult;
  readonly authStatus: (input: ProviderAuthStatusInput) => ProviderAuthJobStatus;
  readonly authSubmitCode: (input: ProviderAuthSubmitCodeInput) => ProviderAuthJobStatus;
  readonly authSignOut: (input: ProviderAuthSignOutInput) => Promise<ProviderAuthSignOutResult>;
  readonly authCancel: (input: ProviderAuthCancelInput) => ProviderAuthCancelResult;
  /** Kill every running child. Used on daemon shutdown. */
  readonly shutdown: () => void;
  /** Resolves once every job started so far has settled. Test helper. */
  readonly drain: () => Promise<void>;
}

export function makeHarnessSetupRunner(deps: HarnessSetupRunnerDeps): HarnessSetupRunner {
  const installs = new SetupJobStore<InstallExtra>({
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.makeJobId ? { makeJobId: deps.makeJobId } : {}),
  });
  const auths = new SetupJobStore<AuthExtra>({
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.makeJobId ? { makeJobId: deps.makeJobId } : {}),
  });
  const handles = new Map<string, HarnessProcessHandle>();
  const pending = new Set<Promise<void>>();
  const log = deps.log ?? (() => {});
  const authTimeoutMs = deps.authTimeoutMs ?? AUTH_JOB_TIMEOUT_MS;
  const installTimeoutMs = deps.installTimeoutMs ?? INSTALL_JOB_TIMEOUT_MS;

  const track = (work: Promise<void>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  const refreshAfterSuccess = async (driver: ProviderDriverKind) => {
    try {
      await deps.refreshProvider(driver);
    } catch (error) {
      log("provider refresh after setup failed", { driver, error: String(error) });
    }
  };

  /**
   * Run one child process to completion, streaming output into the job.
   * Resolves with the exit code (null when the process could not start or
   * was killed by the timeout).
   */
  const runProcess = (input: {
    readonly store: SetupJobStore<InstallExtra> | SetupJobStore<AuthExtra>;
    readonly jobId: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly stdin?: { readonly data: string; readonly close: boolean };
    readonly onOutput?: (accumulated: string) => void;
  }): Promise<{ readonly code: number | null; readonly reason?: string }> =>
    new Promise((resolve) => {
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const handle = deps.spawn({
        command: input.command,
        args: input.args,
        env: input.env,
        onOutput: (chunk) => {
          const job = input.store.appendLog(input.jobId, chunk);
          if (job && input.onOutput) input.onOutput(job.log);
        },
        onExit: (exit) => {
          if (timer) clearTimeout(timer);
          handles.delete(input.jobId);
          if (exit.error) {
            resolve({ code: null, reason: describeSpawnError(input.command, exit.error) });
            return;
          }
          if (timedOut) {
            resolve({ code: null, reason: "Timed out waiting for the command to finish." });
            return;
          }
          resolve({ code: exit.code });
        },
      });
      handles.set(input.jobId, handle);
      timer = setTimeout(() => {
        timedOut = true;
        handle.kill();
      }, input.timeoutMs);
      timer.unref?.();
      if (input.stdin) {
        handle.write(input.stdin.data);
        if (input.stdin.close) handle.endInput();
      }
    });

  /* ---------------------------- install ---------------------------- */

  const runInstall = async (job: SetupJobRecord<InstallExtra>) => {
    const driver = job.driver as ProviderDriverKind;
    const needsNpm = driver === "codex" || driver === "claudeAgent" || driver === "opencode";
    const [npmGlobalWritable, uvAvailable] = await Promise.all([
      needsNpm ? deps.probeNpmGlobalWritable().catch(() => false) : Promise.resolve(true),
      driver === "hermes" ? deps.probeUvAvailable().catch(() => false) : Promise.resolve(true),
    ]);
    const plan = resolveInstallPlan(driver, {
      platform: deps.platform,
      homeDir: deps.homeDir,
      npmGlobalWritable,
      uvAvailable,
    });
    if (plan.kind === "unsupported") {
      installs.finish(job.jobId, { state: "failed", error: plan.reason });
      return;
    }

    installs.updateExtra(job.jobId, { command: plan.display });
    installs.markRunning(job.jobId);
    installs.appendLog(job.jobId, `$ ${plan.display}\n`);
    const result = await runProcess({
      store: installs,
      jobId: job.jobId,
      command: plan.command,
      args: plan.args,
      env: { ...withUserLocalBinOnPath(deps.baseEnv, deps.homeDir), ...plan.env },
      timeoutMs: installTimeoutMs,
    });

    if (result.code === 0) {
      installs.finish(job.jobId, { state: "succeeded" });
      await refreshAfterSuccess(driver);
      return;
    }
    const current = installs.get(job.jobId);
    installs.finish(job.jobId, {
      state: "failed",
      error:
        result.reason ?? `Installer exited with code ${result.code}.${summarizeTail(current?.log)}`,
    });
  };

  const installStart = (input: ProviderInstallStartInput): ProviderInstallStartResult => {
    if (!isInstallableDriver(input.driver)) {
      throw fail(
        "unsupported",
        input.driver === "uno"
          ? "Uno Code ships with Uno Work and cannot be installed separately."
          : `The "${input.driver}" harness has no installer here.`,
      );
    }
    const started = installs.start({
      kind: "install",
      driver: input.driver,
      extra: { command: "" },
    });
    if (!started.ok) {
      throw fail("conflict", `An install for ${input.driver} is already running.`);
    }
    track(
      runInstall(started.job).catch((error: unknown) => {
        installs.finish(started.job.jobId, { state: "failed", error: describeError(error) });
      }),
    );
    return { jobId: started.job.jobId };
  };

  const installStatus = (input: ProviderInstallStatusInput): ProviderInstallJobStatus => {
    const job = installs.get(input.jobId);
    if (!job) throw fail("notFound", "Unknown install job.");
    return {
      jobId: job.jobId,
      driver: ProviderDriverKind.make(job.driver),
      state: job.state,
      log: job.log,
      command: job.extra.command,
      ...(job.error ? { error: job.error } : {}),
    };
  };

  /* ------------------------------ auth ----------------------------- */

  const toAuthStatus = (job: SetupJobRecord<AuthExtra>): ProviderAuthJobStatus => ({
    jobId: job.jobId,
    driver: job.driver as ProviderAuthDriver,
    method: job.extra.method,
    state: job.state,
    log: job.log,
    ...(job.extra.verificationUrl ? { verificationUrl: job.extra.verificationUrl } : {}),
    ...(job.extra.userCode ? { userCode: job.extra.userCode } : {}),
    needsCodeInput: job.extra.needsCodeInput,
    ...(job.error ? { error: job.error } : {}),
  });

  /** Settle a waiting sign-in from outside its CLI process, and stop that process. */
  const settleFromOutside = (
    jobId: string,
    outcome: { readonly state: "succeeded" } | { readonly state: "failed"; readonly error: string },
    note: string,
  ): boolean => {
    const current = auths.get(jobId);
    if (!current || (current.state !== "queued" && current.state !== "running")) return false;
    auths.appendLog(jobId, `${note}\n`);
    auths.updateExtra(jobId, { needsCodeInput: false });
    auths.finish(jobId, outcome);
    handles.get(jobId)?.kill();
    return true;
  };

  /**
   * While a browser sign-in waits, the person may sign the same CLI in from a
   * terminal (12.10: the page lost the job, "Try again" answered "already in
   * progress" for ten minutes, and the terminal login showed up only on the
   * next scheduled probe). Re-probe the harness every few seconds; a sign-in
   * that was not there when the job started ends it as succeeded.
   */
  const watchForSignInElsewhere = async (job: SetupJobRecord<AuthExtra>): Promise<() => void> => {
    const probeAuth = deps.probeAuth;
    if (!probeAuth) return () => {};
    const driver = job.driver as ProviderAuthDriver;
    const baseline = await probeAuth(driver, { refresh: false }).catch(() => null);
    let probing = false;
    const timer = setInterval(() => {
      if (probing) return;
      probing = true;
      void probeAuth(driver, { refresh: true })
        .then((now) => {
          const signedInElsewhere =
            now.authenticated && (!baseline?.authenticated || now.signature !== baseline.signature);
          if (!signedInElsewhere) return;
          clearInterval(timer);
          settleFromOutside(
            job.jobId,
            { state: "succeeded" },
            "[signed in outside this window — nothing more to do here]",
          );
        })
        .catch((error: unknown) => {
          log("sign-in watch probe failed", { driver, error: String(error) });
        })
        .finally(() => {
          probing = false;
        });
    }, deps.authWatchIntervalMs ?? AUTH_WATCH_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  const runCliLogin = async (
    job: SetupJobRecord<AuthExtra>,
    input: {
      readonly args: ReadonlyArray<string>;
      readonly stdin?: { readonly data: string; readonly close: boolean };
      readonly parsePrompt: boolean;
    },
  ) => {
    const driver = job.driver as ProviderAuthDriver;
    const cli = await deps.resolveCliEnvironment(driver);
    auths.markRunning(job.jobId);
    auths.appendLog(job.jobId, `$ ${cli.binaryPath} ${input.args.join(" ")}\n`);
    const stopWatching = input.parsePrompt ? await watchForSignInElsewhere(job) : () => {};
    const result = await runProcess({
      store: auths,
      jobId: job.jobId,
      command: cli.binaryPath,
      args: input.args,
      env: withUserLocalBinOnPath({ ...deps.baseEnv, ...cli.env }, deps.homeDir),
      timeoutMs: authTimeoutMs,
      ...(input.stdin ? { stdin: input.stdin } : {}),
      ...(input.parsePrompt
        ? {
            onOutput: (accumulated: string) => {
              const parsed = parseOAuthPrompt(accumulated);
              const current = auths.get(job.jobId);
              if (!current) return;
              const patch: {
                verificationUrl?: string;
                userCode?: string;
                needsCodeInput?: boolean;
              } = {};
              if (parsed.verificationUrl && !current.extra.verificationUrl) {
                patch.verificationUrl = parsed.verificationUrl;
              }
              if (parsed.userCode && !current.extra.userCode) patch.userCode = parsed.userCode;
              if (parsed.needsCodeInput && !current.extra.needsCodeInput) {
                patch.needsCodeInput = true;
              }
              if (Object.keys(patch).length > 0) auths.updateExtra(job.jobId, patch);
            },
          }
        : {}),
    });

    stopWatching();
    if (result.code === 0) {
      auths.updateExtra(job.jobId, { needsCodeInput: false });
      auths.finish(job.jobId, { state: "succeeded" });
      await refreshAfterSuccess(ProviderDriverKind.make(driver));
      return;
    }
    const current = auths.get(job.jobId);
    auths.updateExtra(job.jobId, { needsCodeInput: false });
    auths.finish(job.jobId, {
      state: "failed",
      error:
        result.reason ?? `Sign-in exited with code ${result.code}.${summarizeTail(current?.log)}`,
    });
  };

  const runAuth = async (job: SetupJobRecord<AuthExtra>, apiKey: string | undefined) => {
    const driver = job.driver as ProviderAuthDriver;
    const method = job.extra.method;

    if (driver === "claudeAgent" && method === "apiKey") {
      auths.markRunning(job.jobId);
      await deps.storeClaudeApiKey(apiKey ?? "");
      auths.appendLog(
        job.jobId,
        `Stored ${ANTHROPIC_API_KEY_ENV} in the Claude provider environment on this machine.\n`,
      );
      auths.finish(job.jobId, { state: "succeeded" });
      await refreshAfterSuccess(ProviderDriverKind.make(driver));
      return;
    }
    if (driver === "codex" && method === "apiKey") {
      await runCliLogin(job, {
        args: ["login", "--with-api-key"],
        stdin: { data: `${apiKey ?? ""}\n`, close: true },
        parsePrompt: false,
      });
      return;
    }
    if (driver === "codex") {
      await runCliLogin(job, { args: ["login", "--device-auth"], parsePrompt: true });
      return;
    }
    await runCliLogin(job, { args: ["auth", "login"], parsePrompt: true });
  };

  const authStart = (input: ProviderAuthStartInput): ProviderAuthStartResult => {
    const apiKey = input.method === "apiKey" ? input.apiKey?.trim() : undefined;
    if (input.method === "apiKey" && !apiKey) {
      throw fail("invalid", "Paste an API key first.");
    }
    const waiting = auths.findActive("auth", input.driver);
    if (waiting) {
      // The same browser sign-in asked for again (the page was closed or
      // reloaded): its link and code are still good — hand it back.
      const sameFlow =
        waiting.extra.method === "oauth" && input.method === "oauth" && input.restart !== true;
      if (sameFlow) return { jobId: waiting.jobId, resumed: true };
      settleFromOutside(
        waiting.jobId,
        { state: "failed", error: "Replaced by a new sign-in." },
        "[replaced by a new sign-in]",
      );
    }
    const started = auths.start({
      kind: "auth",
      driver: input.driver,
      extra: { method: input.method, needsCodeInput: false },
      ...(apiKey ? { secret: apiKey } : {}),
    });
    if (!started.ok) {
      throw fail("conflict", `A sign-in for ${input.driver} is already in progress.`);
    }
    track(
      runAuth(started.job, apiKey).catch((error: unknown) => {
        auths.updateExtra(started.job.jobId, { needsCodeInput: false });
        auths.finish(started.job.jobId, { state: "failed", error: describeError(error) });
      }),
    );
    return { jobId: started.job.jobId };
  };

  const authStatus = (input: ProviderAuthStatusInput): ProviderAuthJobStatus => {
    const job = auths.get(input.jobId);
    if (!job) throw fail("notFound", "Unknown sign-in job.");
    return toAuthStatus(job);
  };

  const authSubmitCode = (input: ProviderAuthSubmitCodeInput): ProviderAuthJobStatus => {
    const job = auths.get(input.jobId);
    if (!job) throw fail("notFound", "Unknown sign-in job.");
    const code = input.code.trim();
    if (code.length === 0) throw fail("invalid", "Paste the code from the browser first.");
    if (job.state !== "running") {
      throw fail("invalid", "This sign-in is not waiting for a code.");
    }
    const handle = handles.get(job.jobId);
    if (!handle) throw fail("invalid", "This sign-in is not waiting for a code.");
    handle.write(`${code}\n`);
    auths.appendLog(job.jobId, "[code submitted]\n");
    return toAuthStatus(auths.updateExtra(job.jobId, { needsCodeInput: false }) ?? job);
  };

  const authCancel = (input: ProviderAuthCancelInput): ProviderAuthCancelResult => {
    const waiting = auths.findActive("auth", input.driver);
    const cancelled = waiting
      ? settleFromOutside(
          waiting.jobId,
          { state: "failed", error: "Sign-in cancelled." },
          "[cancelled]",
        )
      : false;
    return { driver: input.driver, cancelled };
  };

  /* ---------------------------- sign out --------------------------- */

  /** One short CLI call, output collected (no job: sign-out is quick). */
  const runQuick = (
    command: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ): Promise<{ readonly code: number | null; readonly output: string; readonly reason?: string }> =>
    new Promise((resolve) => {
      let output = "";
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const handle = deps.spawn({
        command,
        args,
        env,
        onOutput: (chunk) => {
          output += chunk;
        },
        onExit: (exit) => {
          if (timer) clearTimeout(timer);
          if (exit.error) {
            resolve({ code: null, output, reason: describeSpawnError(command, exit.error) });
            return;
          }
          if (timedOut) {
            resolve({ code: null, output, reason: "Timed out waiting for the command to finish." });
            return;
          }
          resolve({ code: exit.code, output });
        },
      });
      timer = setTimeout(() => {
        timedOut = true;
        handle.kill();
      }, deps.signOutTimeoutMs ?? SIGN_OUT_TIMEOUT_MS);
      timer.unref?.();
      handle.endInput();
    });

  const authSignOut = async (
    input: ProviderAuthSignOutInput,
  ): Promise<ProviderAuthSignOutResult> => {
    const driver = input.driver;
    // Signing out while a sign-in still waits for its browser half: that
    // sign-in is moot — stop it rather than ask the person to hunt for it.
    authCancel({ driver });
    const cli = await deps.resolveCliEnvironment(driver);
    const args = driver === "codex" ? ["logout"] : ["auth", "logout"];
    const result = await runQuick(
      cli.binaryPath,
      args,
      withUserLocalBinOnPath({ ...deps.baseEnv, ...cli.env }, deps.homeDir),
    );
    const removedKey = driver === "claudeAgent" ? await deps.removeClaudeApiKey() : false;
    await refreshAfterSuccess(ProviderDriverKind.make(driver));
    // `claude auth logout` without a login, or after only an API key, may
    // complain; the stored key going away is a sign-out too.
    if (result.code === 0 || removedKey) return { driver, signedOut: true };
    log("provider sign-out failed", { driver, code: result.code, reason: result.reason });
    return {
      driver,
      signedOut: false,
      error:
        result.reason ?? `Sign-out exited with code ${result.code}.${summarizeTail(result.output)}`,
    };
  };

  return {
    installStart,
    installStatus,
    authStart,
    authStatus,
    authSubmitCode,
    authSignOut,
    authCancel,
    shutdown: () => {
      for (const handle of handles.values()) handle.kill();
    },
    drain: async () => {
      while (pending.size > 0) {
        await Promise.all(Array.from(pending));
      }
    },
  };
}

/** A provider snapshot's sign-in, reduced to "signed in?" and "as whom / how". */
export function describeHarnessAuth(
  provider:
    | {
        readonly auth: {
          readonly status: string;
          readonly type?: string | undefined;
          readonly label?: string | undefined;
          readonly email?: string | undefined;
        };
      }
    | undefined,
): HarnessAuthProbe {
  const auth = provider?.auth;
  return {
    authenticated: auth?.status === "authenticated",
    signature: [auth?.status ?? "", auth?.type ?? "", auth?.label ?? "", auth?.email ?? ""].join(
      "|",
    ),
  };
}

const isProviderSetupRpcError = Schema.is(ProviderSetupRpcError);

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function describeSpawnError(command: string, error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `"${command}" was not found on this machine's PATH.`;
  return `Could not start "${command}": ${error.message}`;
}

function summarizeTail(log: string | undefined): string {
  const line = log ? lastNonEmptyLine(log) : undefined;
  return line ? ` ${line}` : "";
}

/* ------------------------------------------------------------------ *
 * Effect wrapper + live layer
 * ------------------------------------------------------------------ */

const liftSync =
  <I, O>(run: (input: I) => O) =>
  (input: I): Effect.Effect<O, ProviderSetupRpcError> =>
    Effect.try({
      try: () => run(input),
      catch: (error) =>
        isProviderSetupRpcError(error)
          ? error
          : new ProviderSetupRpcError({ code: "failed", message: describeError(error) }),
    });

export function makeHarnessSetupShape(runner: HarnessSetupRunner): HarnessSetupShape {
  return {
    installStart: liftSync(runner.installStart),
    installStatus: liftSync(runner.installStatus),
    authStart: liftSync(runner.authStart),
    authStatus: liftSync(runner.authStatus),
    authSubmitCode: liftSync(runner.authSubmitCode),
    authCancel: liftSync(runner.authCancel),
    authSignOut: (input) =>
      Effect.tryPromise({
        try: () => runner.authSignOut(input),
        catch: (error) =>
          isProviderSetupRpcError(error)
            ? error
            : new ProviderSetupRpcError({ code: "failed", message: describeError(error) }),
      }),
  };
}

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

const isWritableDir = (dir: string): Promise<boolean> =>
  access(dir, fsConstants.W_OK).then(
    () => true,
    () => false,
  );

/** `npm prefix -g` then a write check on its `lib/node_modules`. */
const probeNpmGlobalWritable = (env: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise((resolve) => {
    const child = nodeSpawn("npm", ["prefix", "-g"], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      const prefix = output.trim();
      if (code !== 0 || prefix.length === 0) {
        resolve(false);
        return;
      }
      const modulesDir = process.platform === "win32" ? prefix : `${prefix}/lib/node_modules`;
      void isWritableDir(modulesDir).then((writable) =>
        writable ? resolve(true) : isWritableDir(prefix).then(resolve),
      );
    });
  });

const probeCommandAvailable = (command: string, env: NodeJS.ProcessEnv): Promise<boolean> =>
  new Promise((resolve) => {
    const child = nodeSpawn(command, ["--version"], {
      env,
      stdio: "ignore",
      windowsHide: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

export const HarnessSetupLive = Layer.effect(
  HarnessSetup,
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const serverSettings = yield* ServerSettingsService;
    const path = yield* Path.Path;
    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const runFork = Effect.runForkWith(runtimeContext);
    const homeDir = NodeOS.homedir();
    const baseEnv = withUserLocalBinOnPath(process.env, homeDir);

    const resolveCliEnvironment = (driver: ProviderAuthDriver) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const instance =
          deriveProviderInstanceConfigMap(settings)[
            defaultInstanceIdForDriver(ProviderDriverKind.make(driver))
          ];
        const instanceEnv = mergeProviderInstanceEnvironment(instance?.environment, baseEnv);
        if (driver === "codex") {
          const config = decodeCodexSettings(instance?.config ?? {});
          const homePath = config.homePath.trim();
          return {
            binaryPath: config.binaryPath,
            env: {
              ...instanceEnv,
              ...(homePath.length > 0
                ? { CODEX_HOME: path.resolve(expandHomePath(homePath)) }
                : {}),
            },
          } satisfies CliEnvironment;
        }
        const config = decodeClaudeSettings(instance?.config ?? {});
        const env = yield* makeClaudeEnvironment(config, instanceEnv);
        return { binaryPath: config.binaryPath, env } satisfies CliEnvironment;
      }).pipe(Effect.provideService(Path.Path, path));

    const storeClaudeApiKey = (apiKey: string) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
        const existing: ProviderInstanceConfig = settings.providerInstances[instanceId] ?? {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: settings.providers.claudeAgent,
        };
        const variable: ProviderInstanceEnvironmentVariable = {
          name: ANTHROPIC_API_KEY_ENV,
          value: apiKey,
          sensitive: true,
        };
        const environment = [
          ...(existing.environment ?? []).filter((entry) => entry.name !== ANTHROPIC_API_KEY_ENV),
          variable,
        ];
        yield* serverSettings.updateSettings({
          providerInstances: {
            ...settings.providerInstances,
            [instanceId]: { ...existing, environment },
          },
        });
      });

    const removeClaudeApiKey = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
      const existing = settings.providerInstances[instanceId];
      const environment = existing?.environment ?? [];
      if (!existing || !environment.some((entry) => entry.name === ANTHROPIC_API_KEY_ENV)) {
        return false;
      }
      yield* serverSettings.updateSettings({
        providerInstances: {
          ...settings.providerInstances,
          [instanceId]: {
            ...existing,
            environment: environment.filter((entry) => entry.name !== ANTHROPIC_API_KEY_ENV),
          },
        },
      });
      return true;
    });

    const runner = makeHarnessSetupRunner({
      spawn: spawnHarnessProcess,
      platform: process.platform,
      homeDir,
      baseEnv,
      probeNpmGlobalWritable: () => probeNpmGlobalWritable(baseEnv),
      probeUvAvailable: () => probeCommandAvailable("uv", baseEnv),
      resolveCliEnvironment: (driver) => runPromise(resolveCliEnvironment(driver)),
      storeClaudeApiKey: (apiKey) => runPromise(storeClaudeApiKey(apiKey)),
      removeClaudeApiKey: () => runPromise(removeClaudeApiKey),
      refreshProvider: (driver) =>
        runPromise(providerRegistry.refresh(driver)).then(() => undefined),
      probeAuth: (driver, options) => {
        const kind = ProviderDriverKind.make(driver);
        return runPromise(
          options.refresh ? providerRegistry.refresh(kind) : providerRegistry.getProviders,
        ).then((providers) =>
          describeHarnessAuth(
            providers.find(
              (provider) =>
                provider.driver === kind &&
                provider.instanceId === defaultInstanceIdForDriver(kind),
            ) ?? providers.find((provider) => provider.driver === kind),
          ),
        );
      },
      log: (message, meta) => {
        runFork(Effect.logWarning(message, meta));
      },
    });

    yield* Effect.addFinalizer(() => Effect.sync(() => runner.shutdown()));
    return makeHarnessSetupShape(runner);
  }),
);
