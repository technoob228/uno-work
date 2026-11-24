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
 *   a second account        `instanceId` on any of these: the same flow in that
 *                           instance's own sign-in folder (providerAccounts.ts);
 *                           one sign-in at a time per account, not per harness.
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
import { access, constants as fsConstants, rm } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import * as nodePath from "node:path";

import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  defaultInstanceIdForDriver,
  GeminiSettings,
  GrokSettings,
  type ProviderAccountAddInput,
  type ProviderAccountAddResult,
  type ProviderAccountRemoveInput,
  type ProviderAccountRemoveResult,
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
  type ProviderInstallHelp,
  type ProviderInstallJobStatus,
  type ProviderInstallStartInput,
  type ProviderInstallStartResult,
  type ProviderInstallStatusInput,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  ProviderSetupRpcError,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Path, Schema } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import {
  accountDisplayName,
  accountFolder,
  accountFolderOf,
  accountInstanceConfig,
  isAccountFolder,
  newAccountInstanceId,
  prepareAccountFolder,
  removeAccountFolder,
} from "../providerAccounts.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import {
  isInstallableDriver,
  isNpmInstalledDriver,
  resolveInstallPlan,
} from "./harnessInstallCommands.ts";
import {
  installManagedNode,
  locateNpm,
  ManagedNodeError,
  managedNodeDownload,
  npmMissingHelp,
  withDirFirstOnPath,
  withManagedNodeOnPath,
  type NpmRuntime,
} from "./npmRuntime.ts";
import { SetupJobStore, type SetupJobRecord } from "./harnessJobs.ts";
import {
  type HarnessProcessHandle,
  type HarnessProcessSpawner,
  spawnHarnessProcess,
  withUserLocalBinOnPath,
} from "./harnessProcess.ts";
import { lastNonEmptyLine, parseOAuthPrompt } from "./harnessSetupParsers.ts";
import {
  clearGeminiGoogleSignIn,
  GEMINI_ACP_ARGS,
  GEMINI_API_KEY_AUTH_TYPE,
  GEMINI_API_KEY_ENV,
  GEMINI_GOOGLE_AUTH_TYPE,
  GEMINI_PROCESS_ENV,
  geminiGoogleAccount,
  readGeminiSelectedAuthType,
  writeGeminiSelectedAuthType,
} from "../acp/GeminiAcpSupport.ts";
import { GROK_API_KEY_ENV, GROK_PROCESS_ENV, probeGrokAuth } from "../acp/GrokAcpSupport.ts";
import {
  ANTIGRAVITY_API_KEY_ENV,
  ANTIGRAVITY_LOGIN_ARGS,
  type AntigravityAuthState,
  antigravityLoginResponse,
  antigravityProcessEnvironment,
  antigravityTokenFile,
  findAntigravityAuthorizationUrl,
  probeAntigravityAuth,
} from "../acp/AntigravityAcpSupport.ts";
import {
  defaultAntigravityInstallDeps,
  installAntigravityCli,
  resolveAntigravityExecutable,
} from "../AntigravityInstallation.ts";

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
  /** A second account: its folder and instance. Refused unless the setting is on. */
  readonly accountAdd: (
    input: ProviderAccountAddInput,
  ) => Effect.Effect<ProviderAccountAddResult, ProviderSetupRpcError>;
  /** Sign the account out, drop its folder and instance. */
  readonly accountRemove: (
    input: ProviderAccountRemoveInput,
  ) => Effect.Effect<ProviderAccountRemoveResult, ProviderSetupRpcError>;
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
  /** A working npm on this machine (PATH, then the usual Node folders, then ~/.uno/node). */
  readonly locateNpm: () => Promise<NpmRuntime | null>;
  /**
   * Brings Node.js into ~/.uno/node when the machine has none. Absent where
   * Uno Work brings no Node (Windows): the card tells what to install.
   */
  readonly installManagedNode?: (log: (line: string) => void) => Promise<void>;
  /** Homebrew is there (the card then offers a brew command). */
  readonly brewAvailable?: () => Promise<boolean>;
  readonly probeUvAvailable: () => Promise<boolean>;
  /** Binary + environment the daemon itself uses to run that driver's CLI (or that instance's). */
  readonly resolveCliEnvironment: (
    driver: ProviderAuthDriver,
    instanceId?: ProviderInstanceId,
  ) => Promise<CliEnvironment>;
  readonly storeClaudeApiKey: (apiKey: string) => Promise<void>;
  /** Gemini CLI's sign-in files and stored key; absent: Gemini sign-in is refused. */
  readonly gemini?: GeminiSignInStore;
  /** Grok CLI's sign-in and stored key; absent: Grok sign-in is refused. */
  readonly grok?: GrokSignInStore;
  /** Antigravity's managed install and sign-in; absent: both are refused. */
  readonly antigravity?: AntigravitySetupStore;
  /** Drops ANTHROPIC_API_KEY from the default Claude instance; true if one was there. */
  readonly removeClaudeApiKey: () => Promise<boolean>;
  readonly refreshProvider: (
    driver: ProviderDriverKind,
    instanceId?: ProviderInstanceId,
  ) => Promise<void>;
  /**
   * The harness's sign-in as the daemon sees it; `refresh` re-probes the CLI
   * first. Absent: a waiting sign-in is not watched for a login done elsewhere.
   */
  readonly probeAuth?: (
    driver: ProviderAuthDriver,
    options: { readonly refresh: boolean; readonly instanceId?: ProviderInstanceId },
  ) => Promise<HarnessAuthProbe>;
  readonly authWatchIntervalMs?: number;
  readonly authTimeoutMs?: number;
  readonly signOutTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly now?: () => number;
  readonly makeJobId?: () => string;
  readonly log?: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Gemini CLI has no `login` command: its Google sign-in runs when the CLI
 * starts with the Google sign-in selected and no tokens (GeminiAcpSupport),
 * an API key is `GEMINI_API_KEY` plus the CLI's own "use the key" choice.
 */
export interface GeminiSignInStore {
  /** The Google account the CLI is signed in to here, if any. */
  readonly googleAccount: () => Promise<string | undefined>;
  readonly selectedAuthType: () => Promise<string | undefined>;
  readonly selectAuthType: (type: string | undefined) => Promise<void>;
  /** GEMINI_API_KEY into the default Gemini instance's environment. */
  readonly storeApiKey: (apiKey: string) => Promise<void>;
  /** Drops it; true if one was there. */
  readonly removeApiKey: () => Promise<boolean>;
  /** Token files gone, the account marked signed out; true if there was one. */
  readonly clearGoogleSignIn: () => Promise<boolean>;
}

/**
 * Grok CLI signs in with `grok login --device-auth` (an xAI device code, no
 * code to paste back) into `~/.grok/auth.json`, or reads `XAI_API_KEY`.
 */
export interface GrokSignInStore {
  /** A stored xAI sign-in (not the key) is there. */
  readonly signedIn: () => Promise<boolean>;
  /** XAI_API_KEY into the default Grok instance's environment. */
  readonly storeApiKey: (apiKey: string) => Promise<void>;
  /** Drops it; true if one was there. */
  readonly removeApiKey: () => Promise<boolean>;
}

/**
 * Google Antigravity (`agy`): Uno Work installs Google's CLI itself (no npm),
 * signs in with `agy acp --login` (a Google link; the page it lands on shows
 * a code to paste back) into the sign-in file, or a Gemini API key.
 */
export interface AntigravitySetupStore {
  /** Downloads, verifies and activates Google's current CLI; logs progress. */
  readonly install: (log: (line: string) => void) => Promise<{ readonly version: string }>;
  /** The sign-in a chat would use (API key, file or this computer's keyring). */
  readonly auth: () => Promise<AntigravityAuthState>;
  /** ANTIGRAVITY_GEMINI_API_KEY into the Antigravity instance's environment. */
  readonly storeApiKey: (apiKey: string) => Promise<void>;
  /** Drops it; true if one was there. */
  readonly removeApiKey: () => Promise<boolean>;
  /** Deletes the sign-in file Uno Work's sign-in wrote; true if there was one. */
  readonly clearFileSignIn: () => Promise<boolean>;
}

/** Device sign-in of Grok CLI 1.0.92 (prints the link and the code, polls xAI). */
export const GROK_LOGIN_ARGS: ReadonlyArray<string> = ["login", "--device-auth"];

interface InstallExtra {
  readonly command: string;
  readonly help?: ProviderInstallHelp;
}

interface AuthExtra {
  readonly driver: ProviderAuthDriver;
  /** A second account's sign-in; absent: the harness's default one. */
  readonly instanceId?: ProviderInstanceId;
  readonly method: ProviderAuthMethod;
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly needsCodeInput: boolean;
  readonly codeCheck?: "checking" | "rejected";
}

/** Written into the job log when a pasted code goes to the CLI. */
export const CODE_SUBMITTED_MARK = "[code submitted]";

/**
 * The CLI's output since the last code went in (all of it before any):
 * whether it asks for a code is read from there, so the prompt it printed
 * before the code doesn't bring the box back (cap walkthrough 28.10, P4:
 * the code box stayed up after Submit, nothing moved for 25 s).
 */
export function outputSinceCodeSubmitted(log: string): {
  readonly submitted: boolean;
  readonly text: string;
} {
  const at = log.lastIndexOf(CODE_SUBMITTED_MARK);
  return at < 0
    ? { submitted: false, text: log }
    : { submitted: true, text: log.slice(at + CODE_SUBMITTED_MARK.length) };
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

  const refreshAfterSuccess = async (
    driver: ProviderDriverKind,
    instanceId?: ProviderInstanceId,
  ) => {
    try {
      await (instanceId ? deps.refreshProvider(driver, instanceId) : deps.refreshProvider(driver));
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
    const needsNpm = isNpmInstalledDriver(driver);
    const [located, uvAvailable] = await Promise.all([
      needsNpm ? deps.locateNpm().catch(() => null) : Promise.resolve(null),
      driver === "hermes" ? deps.probeUvAvailable().catch(() => false) : Promise.resolve(true),
    ]);
    let npm = located;
    if (needsNpm && !npm) {
      // No Node.js here (T64): bring Uno Work's own, or say what to do by hand.
      installs.markRunning(job.jobId);
      let managedError: ManagedNodeError | undefined;
      if (deps.installManagedNode) {
        installs.updateExtra(job.jobId, { command: "Get Node.js for Uno Work" });
        try {
          await deps.installManagedNode((line) => installs.appendLog(job.jobId, line));
          npm = await deps.locateNpm().catch(() => null);
        } catch (error) {
          managedError =
            error instanceof ManagedNodeError
              ? error
              : new ManagedNodeError(describeError(error), "unpack");
          installs.appendLog(job.jobId, `${managedError.message}\n`);
        }
      }
      if (!npm) {
        const help = npmMissingHelp({
          driver,
          platform: deps.platform,
          brewAvailable: await (deps.brewAvailable?.() ?? Promise.resolve(false)).catch(
            () => false,
          ),
          ...(managedError ? { managedNodeError: managedError } : {}),
        });
        installs.updateExtra(job.jobId, { help });
        installs.finish(job.jobId, { state: "failed", error: help.title });
        return;
      }
    }
    const plan = resolveInstallPlan(driver, {
      platform: deps.platform,
      homeDir: deps.homeDir,
      npmGlobalWritable: npm?.globalWritable ?? true,
      uvAvailable,
      ...(npm ? { npmBin: npm.npm } : {}),
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
      env: {
        ...(npm?.binDir
          ? withDirFirstOnPath(withUserLocalBinOnPath(deps.baseEnv, deps.homeDir), npm.binDir)
          : withUserLocalBinOnPath(deps.baseEnv, deps.homeDir)),
        ...plan.env,
      },
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

  /** Google's CLI straight from Google's release manifest: no npm, no sudo, no shell. */
  const runAntigravityInstall = async (job: SetupJobRecord<InstallExtra>) => {
    const store = deps.antigravity;
    if (!store) {
      installs.finish(job.jobId, {
        state: "failed",
        error: "Antigravity can't be installed on this computer.",
      });
      return;
    }
    installs.updateExtra(job.jobId, { command: "Antigravity CLI from Google" });
    installs.markRunning(job.jobId);
    const { version } = await store.install((line) => {
      installs.appendLog(job.jobId, `${line}\n`);
    });
    installs.finish(job.jobId, { state: "succeeded" });
    log("antigravity installed", { version });
    await refreshAfterSuccess(ProviderDriverKind.make("antigravity"));
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
    const run = input.driver === "antigravity" ? runAntigravityInstall : runInstall;
    track(
      run(started.job).catch((error: unknown) => {
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
      ...(job.state === "failed" && job.extra.help ? { help: job.extra.help } : {}),
    };
  };

  /* ------------------------------ auth ----------------------------- */

  /** One sign-in at a time per account: the store's key for a job. */
  const authJobKey = (input: {
    readonly driver: ProviderAuthDriver;
    readonly instanceId?: ProviderInstanceId | undefined;
  }): string => input.instanceId ?? input.driver;

  const toAuthStatus = (job: SetupJobRecord<AuthExtra>): ProviderAuthJobStatus => ({
    jobId: job.jobId,
    driver: job.extra.driver,
    method: job.extra.method,
    state: job.state,
    log: job.log,
    ...(job.extra.verificationUrl ? { verificationUrl: job.extra.verificationUrl } : {}),
    ...(job.extra.userCode ? { userCode: job.extra.userCode } : {}),
    needsCodeInput: job.extra.needsCodeInput,
    ...(job.extra.codeCheck ? { codeCheck: job.extra.codeCheck } : {}),
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
    const { driver, instanceId } = job.extra;
    const scope = instanceId ? { instanceId } : {};
    const baseline = await probeAuth(driver, { refresh: false, ...scope }).catch(() => null);
    let probing = false;
    const timer = setInterval(() => {
      if (probing) return;
      probing = true;
      void probeAuth(driver, { refresh: true, ...scope })
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
    const { driver, instanceId } = job.extra;
    const cli = await (instanceId
      ? deps.resolveCliEnvironment(driver, instanceId)
      : deps.resolveCliEnvironment(driver));
    // Cancelled (or signed out) while it was still queued: start nothing, or
    // the login would wait on its stdin until the timeout with no one to answer.
    if (auths.get(job.jobId)?.state !== "queued") return;
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
                codeCheck?: "checking" | "rejected";
              } = {};
              if (parsed.verificationUrl && !current.extra.verificationUrl) {
                patch.verificationUrl = parsed.verificationUrl;
              }
              if (parsed.userCode && !current.extra.userCode) patch.userCode = parsed.userCode;
              // After a code went in, only a prompt printed since then asks
              // again — and means that code didn't work.
              const since = outputSinceCodeSubmitted(accumulated);
              // A retry comes with a link of its own (Gemini CLI: a new
              // sign-in each time); the old one would not take the new code.
              const retryUrl = since.submitted
                ? parseOAuthPrompt(since.text).verificationUrl
                : undefined;
              if (retryUrl && retryUrl !== current.extra.verificationUrl) {
                patch.verificationUrl = retryUrl;
              }
              const asks = since.submitted
                ? parseOAuthPrompt(since.text).needsCodeInput
                : parsed.needsCodeInput;
              if (asks && !current.extra.needsCodeInput) {
                patch.needsCodeInput = true;
                if (since.submitted) patch.codeCheck = "rejected";
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
      await refreshAfterSuccess(ProviderDriverKind.make(driver), instanceId);
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

  const runGeminiAuth = async (job: SetupJobRecord<AuthExtra>, apiKey: string | undefined) => {
    const store = deps.gemini;
    if (!store) throw new Error("Gemini CLI sign-in is not available on this computer.");
    if (job.extra.method === "apiKey") {
      auths.markRunning(job.jobId);
      await store.storeApiKey(apiKey ?? "");
      await store.selectAuthType(GEMINI_API_KEY_AUTH_TYPE);
      auths.appendLog(
        job.jobId,
        `Stored ${GEMINI_API_KEY_ENV} in the Gemini CLI provider environment on this machine; Gemini CLI now signs in with it.\n`,
      );
      auths.finish(job.jobId, { state: "succeeded" });
      await refreshAfterSuccess(ProviderDriverKind.make("gemini"));
      return;
    }
    const account = await store.googleAccount();
    if (account) {
      auths.markRunning(job.jobId);
      await store.selectAuthType(GEMINI_GOOGLE_AUTH_TYPE);
      auths.appendLog(
        job.jobId,
        `Gemini CLI is already signed in to ${account}. To use another account, sign out first.\n`,
      );
      auths.finish(job.jobId, { state: "succeeded" });
      await refreshAfterSuccess(ProviderDriverKind.make("gemini"));
      return;
    }
    // The CLI asks for the Google sign-in when it starts with it selected and
    // no tokens: it prints the link, reads the code from stdin (nothing else
    // may be written there first — it would be taken for the code), and once
    // the tokens are saved it waits for ACP. The sign-in watch sees the
    // account appear and stops it.
    const previous = await store.selectedAuthType();
    await store.selectAuthType(GEMINI_GOOGLE_AUTH_TYPE);
    try {
      await runCliLogin(job, { args: GEMINI_ACP_ARGS, parsePrompt: true });
    } finally {
      if (auths.get(job.jobId)?.state !== "succeeded" && previous !== GEMINI_GOOGLE_AUTH_TYPE) {
        await store.selectAuthType(previous).catch((error: unknown) => {
          log("restoring the Gemini CLI sign-in choice failed", { error: String(error) });
        });
      }
    }
  };

  const runGrokAuth = async (job: SetupJobRecord<AuthExtra>, apiKey: string | undefined) => {
    const store = deps.grok;
    if (!store) throw new Error("Grok sign-in is not available on this computer.");
    if (job.extra.method === "apiKey") {
      auths.markRunning(job.jobId);
      await store.storeApiKey(apiKey ?? "");
      auths.appendLog(
        job.jobId,
        `Stored ${GROK_API_KEY_ENV} in the Grok provider environment on this machine; Grok now signs in with it.\n`,
      );
      auths.finish(job.jobId, { state: "succeeded" });
      await refreshAfterSuccess(ProviderDriverKind.make("grok"));
      return;
    }
    if (await store.signedIn()) {
      auths.markRunning(job.jobId);
      auths.appendLog(
        job.jobId,
        "Grok is already signed in to an xAI account here. To use another account, sign out first.\n",
      );
      auths.finish(job.jobId, { state: "succeeded" });
      await refreshAfterSuccess(ProviderDriverKind.make("grok"));
      return;
    }
    await runCliLogin(job, { args: GROK_LOGIN_ARGS, parsePrompt: true });
  };

  const runAntigravityAuth = async (job: SetupJobRecord<AuthExtra>, apiKey: string | undefined) => {
    const store = deps.antigravity;
    if (!store) throw new Error("Antigravity sign-in is not available on this computer.");
    const driver = ProviderDriverKind.make("antigravity");
    if (job.extra.method === "apiKey") {
      auths.markRunning(job.jobId);
      await store.storeApiKey(apiKey ?? "");
      auths.appendLog(
        job.jobId,
        `Stored ${ANTIGRAVITY_API_KEY_ENV} in the Antigravity provider environment on this machine; Antigravity now signs in with it.\n`,
      );
      auths.finish(job.jobId, { state: "succeeded" });
      await refreshAfterSuccess(driver);
      return;
    }
    const auth = await store.auth();
    if (auth.status === "authenticated" && auth.type !== "gemini-api-key") {
      auths.markRunning(job.jobId);
      auths.appendLog(
        job.jobId,
        "Antigravity is already signed in to a Google account on this computer. To use another account, sign out first.\n",
      );
      auths.finish(job.jobId, { state: "succeeded" });
      await refreshAfterSuccess(driver);
      return;
    }
    // `agy acp --login` prints the Google link, reads the code (or the
    // page's URL) from stdin and exits 0 once the sign-in file is written.
    await runCliLogin(job, { args: ANTIGRAVITY_LOGIN_ARGS, parsePrompt: true });
  };

  const runAuth = async (job: SetupJobRecord<AuthExtra>, apiKey: string | undefined) => {
    const { driver, method } = job.extra;

    if (driver === "antigravity") {
      await runAntigravityAuth(job, apiKey);
      return;
    }

    if (driver === "gemini") {
      await runGeminiAuth(job, apiKey);
      return;
    }
    if (driver === "grok") {
      await runGrokAuth(job, apiKey);
      return;
    }

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
    // A second account is a plan's sign-in, not an API key: the key is the
    // default instance's, and an extra one would read as a provider's account.
    if (input.method === "apiKey" && input.instanceId) {
      throw fail("invalid", "A second account signs in with its plan, not an API key.");
    }
    if (input.driver === "gemini" && input.instanceId) {
      throw fail("invalid", "Gemini CLI has one account per computer.");
    }
    if (input.driver === "grok" && input.instanceId) {
      throw fail("invalid", "Grok has one account per computer.");
    }
    if (input.driver === "antigravity" && input.instanceId) {
      throw fail("invalid", "Antigravity has one account per computer.");
    }
    const jobKey = authJobKey(input);
    const waiting = auths.findActive("auth", jobKey);
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
      driver: jobKey,
      extra: {
        driver: input.driver,
        ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        method: input.method,
        needsCodeInput: false,
      },
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
    if (job.extra.driver === "antigravity") {
      // Only the code or the page's URL for this very sign-in: anything else
      // (a second line, another link) would answer a prompt it wasn't meant for.
      const pending = findAntigravityAuthorizationUrl(job.log);
      if (!pending || antigravityLoginResponse(pending, code) === undefined) {
        throw fail(
          "invalid",
          "That is not the code from the Antigravity page. Copy the code it shows (or the page's address) and paste it here.",
        );
      }
    }
    handle.write(`${code}\n`);
    auths.appendLog(job.jobId, `${CODE_SUBMITTED_MARK}\n`);
    return toAuthStatus(
      auths.updateExtra(job.jobId, { needsCodeInput: false, codeCheck: "checking" }) ?? job,
    );
  };

  const authCancel = (input: ProviderAuthCancelInput): ProviderAuthCancelResult => {
    const waiting = auths.findActive("auth", authJobKey(input));
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
    const { driver, instanceId } = input;
    // Signing out while a sign-in still waits for its browser half: that
    // sign-in is moot — stop it rather than ask the person to hunt for it.
    authCancel(input);
    if (driver === "gemini") {
      const store = deps.gemini;
      if (!store)
        return { driver, signedOut: false, error: "Gemini CLI sign-in is not available." };
      try {
        await store.removeApiKey();
        await store.clearGoogleSignIn();
        await store.selectAuthType(undefined);
      } catch (error) {
        log("provider sign-out failed", { driver, error: describeError(error) });
        return { driver, signedOut: false, error: describeError(error) };
      }
      await refreshAfterSuccess(ProviderDriverKind.make(driver));
      return { driver, signedOut: true };
    }
    if (driver === "antigravity") {
      const store = deps.antigravity;
      if (!store) {
        return { driver, signedOut: false, error: "Antigravity sign-in is not available." };
      }
      try {
        const removedKey = await store.removeApiKey();
        const removedFile = await store.clearFileSignIn();
        await refreshAfterSuccess(ProviderDriverKind.make(driver));
        const after = await store.auth();
        if (after.status === "authenticated" && after.type === "google-keyring") {
          // The keyring sign-in is the Antigravity app's and the terminal's
          // too: signing it out from here would sign the whole computer out.
          return {
            driver,
            signedOut: removedKey || removedFile,
            error:
              "Antigravity stays signed in through the Antigravity app on this computer. Sign out there (or run `agy logout`) to stop it.",
          };
        }
        return { driver, signedOut: true };
      } catch (error) {
        log("provider sign-out failed", { driver, error: describeError(error) });
        return { driver, signedOut: false, error: describeError(error) };
      }
    }
    if (driver === "grok") {
      const store = deps.grok;
      if (!store) return { driver, signedOut: false, error: "Grok sign-in is not available." };
      const removedKey = await store.removeApiKey().catch((error: unknown) => {
        log("provider sign-out failed", { driver, error: describeError(error) });
        return false;
      });
      const hadSignIn = await store.signedIn().catch(() => false);
      const cli = await deps.resolveCliEnvironment(driver);
      const result = hadSignIn
        ? await runQuick(
            cli.binaryPath,
            ["logout"],
            withUserLocalBinOnPath({ ...deps.baseEnv, ...cli.env }, deps.homeDir),
          )
        : { code: 0, output: "" };
      await refreshAfterSuccess(ProviderDriverKind.make(driver));
      if (result.code === 0 || (removedKey && !hadSignIn)) return { driver, signedOut: true };
      log("provider sign-out failed", { driver, code: result.code, reason: result.reason });
      return {
        driver,
        signedOut: false,
        error:
          result.reason ??
          `Sign-out exited with code ${result.code}.${summarizeTail(result.output)}`,
      };
    }
    const cli = await (instanceId
      ? deps.resolveCliEnvironment(driver, instanceId)
      : deps.resolveCliEnvironment(driver));
    const args = driver === "codex" ? ["logout"] : ["auth", "logout"];
    const result = await runQuick(
      cli.binaryPath,
      args,
      withUserLocalBinOnPath({ ...deps.baseEnv, ...cli.env }, deps.homeDir),
    );
    // The stored key is the default instance's: a second account has none.
    const removedKey =
      driver === "claudeAgent" && !instanceId ? await deps.removeClaudeApiKey() : false;
    await refreshAfterSuccess(ProviderDriverKind.make(driver), instanceId);
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
  if (code === "ENOENT") {
    return `Uno Work could not find "${nodePath.basename(command)}" on this computer.`;
  }
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

export function makeHarnessSetupShape(
  runner: HarnessSetupRunner,
  accounts: Pick<HarnessSetupShape, "accountAdd" | "accountRemove">,
): HarnessSetupShape {
  return {
    ...accounts,
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
const decodeGeminiSettings = Schema.decodeUnknownSync(GeminiSettings);
const decodeGrokSettings = Schema.decodeUnknownSync(GrokSettings);
const decodeAntigravitySettings = Schema.decodeUnknownSync(AntigravitySettings);

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
    const baseEnv = withManagedNodeOnPath(withUserLocalBinOnPath(process.env, homeDir), homeDir);
    // Two agents installed at once share one Node.js download.
    let managedNodeInstall: Promise<void> | null = null;
    const managedNodeAvailable = managedNodeDownload(process.platform, process.arch) !== null;

    const resolveCliEnvironment = (driver: ProviderAuthDriver, instanceId?: ProviderInstanceId) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const instance =
          deriveProviderInstanceConfigMap(settings)[
            instanceId ?? defaultInstanceIdForDriver(ProviderDriverKind.make(driver))
          ];
        if (instanceId && instance?.driver !== driver) {
          return yield* fail("notFound", "This account is not on this computer any more.");
        }
        const instanceEnv = mergeProviderInstanceEnvironment(instance?.environment, baseEnv);
        if (driver === "codex") {
          const config = decodeCodexSettings(instance?.config ?? {});
          // A shadow home holds that account's auth.json: `codex login` writes it there.
          const { effectiveHomePath } = yield* resolveCodexHomeLayout(config);
          return {
            binaryPath: config.binaryPath,
            env: {
              ...instanceEnv,
              ...(effectiveHomePath ? { CODEX_HOME: effectiveHomePath } : {}),
            },
          } satisfies CliEnvironment;
        }
        if (driver === "gemini") {
          const config = decodeGeminiSettings(instance?.config ?? {});
          return {
            binaryPath: config.binaryPath.trim() || "gemini",
            env: { ...instanceEnv, ...GEMINI_PROCESS_ENV },
          } satisfies CliEnvironment;
        }
        if (driver === "antigravity") {
          const config = decodeAntigravitySettings(instance?.config ?? {});
          const executable = yield* Effect.promise(() =>
            resolveAntigravityExecutable({ binaryPath: config.binaryPath, env: instanceEnv }),
          );
          if (!executable.ok) {
            return yield* fail(
              "invalid",
              "Install Antigravity first (Settings → AI → Antigravity).",
            );
          }
          // The sign-in goes to the file (no keyring prompt, no browser on
          // this computer): the link is opened in the person's own browser.
          const env = antigravityProcessEnvironment(instanceEnv, { store: "file" });
          delete env.DISPLAY;
          delete env.WAYLAND_DISPLAY;
          return { binaryPath: executable.path, env } satisfies CliEnvironment;
        }
        if (driver === "grok") {
          const config = decodeGrokSettings(instance?.config ?? {});
          return {
            binaryPath: config.binaryPath.trim() || "grok",
            env: { ...instanceEnv, ...GROK_PROCESS_ENV },
          } satisfies CliEnvironment;
        }
        const config = decodeClaudeSettings(instance?.config ?? {});
        const env = yield* makeClaudeEnvironment(config, instanceEnv);
        return { binaryPath: config.binaryPath, env } satisfies CliEnvironment;
      }).pipe(Effect.provideService(Path.Path, path));

    /** A key into the default instance's environment, stored as sensitive. */
    const storeApiKey = (
      driver: "claudeAgent" | "gemini" | "grok" | "antigravity",
      name: string,
      apiKey: string,
    ) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
        const existing: ProviderInstanceConfig = settings.providerInstances[instanceId] ?? {
          driver: ProviderDriverKind.make(driver),
          config: settings.providers[driver],
        };
        const variable: ProviderInstanceEnvironmentVariable = {
          name,
          value: apiKey,
          sensitive: true,
        };
        const environment = [
          ...(existing.environment ?? []).filter((entry) => entry.name !== name),
          variable,
        ];
        yield* serverSettings.updateSettings({
          providerInstances: {
            ...settings.providerInstances,
            [instanceId]: { ...existing, environment },
          },
        });
      });

    const removeApiKey = (
      driver: "claudeAgent" | "gemini" | "grok" | "antigravity",
      name: string,
    ) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
        const existing = settings.providerInstances[instanceId];
        const environment = existing?.environment ?? [];
        if (!existing || !environment.some((entry) => entry.name === name)) {
          return false;
        }
        yield* serverSettings.updateSettings({
          providerInstances: {
            ...settings.providerInstances,
            [instanceId]: {
              ...existing,
              environment: environment.filter((entry) => entry.name !== name),
            },
          },
        });
        return true;
      });

    // Gemini CLI's files are where the daemon's own Gemini runs look
    // (`GEMINI_CLI_HOME` of the default instance, else the home folder).
    const geminiEnv = () =>
      runPromise(resolveCliEnvironment("gemini")).then((cli) => ({ ...process.env, ...cli.env }));
    const gemini: GeminiSignInStore = {
      googleAccount: () => geminiEnv().then(geminiGoogleAccount),
      selectedAuthType: () => geminiEnv().then(readGeminiSelectedAuthType),
      selectAuthType: (type) => geminiEnv().then((env) => writeGeminiSelectedAuthType(env, type)),
      storeApiKey: (apiKey) => runPromise(storeApiKey("gemini", GEMINI_API_KEY_ENV, apiKey)),
      removeApiKey: () => runPromise(removeApiKey("gemini", GEMINI_API_KEY_ENV)),
      clearGoogleSignIn: () => geminiEnv().then(clearGeminiGoogleSignIn),
    };

    // Grok's sign-in is where the daemon's own Grok runs look (`GROK_HOME`
    // of the default instance, else ~/.grok). Only the stored sign-in counts
    // here: the key is checked apart (removeApiKey).
    const grokEnv = () =>
      runPromise(resolveCliEnvironment("grok")).then((cli) => ({ ...process.env, ...cli.env }));
    const grok: GrokSignInStore = {
      signedIn: () =>
        grokEnv().then(async (env) => {
          const withoutKey: NodeJS.ProcessEnv = { ...env };
          delete withoutKey[GROK_API_KEY_ENV];
          return (await probeGrokAuth(withoutKey)).status === "authenticated";
        }),
      storeApiKey: (apiKey) => runPromise(storeApiKey("grok", GROK_API_KEY_ENV, apiKey)),
      removeApiKey: () => runPromise(removeApiKey("grok", GROK_API_KEY_ENV)),
    };

    // Antigravity's sign-in is the daemon's own Antigravity's (AntigravityAcpSupport).
    const antigravityEnv = () =>
      runPromise(
        serverSettings.getSettings.pipe(
          Effect.map((settings) => {
            const instance =
              deriveProviderInstanceConfigMap(settings)[
                defaultInstanceIdForDriver(ProviderDriverKind.make("antigravity"))
              ];
            return mergeProviderInstanceEnvironment(instance?.environment, baseEnv);
          }),
        ),
      );
    const antigravity: AntigravitySetupStore = {
      install: async (logLine) =>
        installAntigravityCli(await defaultAntigravityInstallDeps(logLine, baseEnv)),
      auth: () => antigravityEnv().then((env) => probeAntigravityAuth(env)),
      storeApiKey: (apiKey) =>
        runPromise(storeApiKey("antigravity", ANTIGRAVITY_API_KEY_ENV, apiKey)),
      removeApiKey: () => runPromise(removeApiKey("antigravity", ANTIGRAVITY_API_KEY_ENV)),
      clearFileSignIn: () =>
        antigravityEnv().then(async (env) => {
          const file = antigravityTokenFile(env);
          const existed = await access(file).then(
            () => true,
            () => false,
          );
          if (existed) await rm(file, { force: true });
          return existed;
        }),
    };

    const runner = makeHarnessSetupRunner({
      spawn: spawnHarnessProcess,
      platform: process.platform,
      homeDir,
      baseEnv,
      locateNpm: () => locateNpm({ env: baseEnv, homeDir, platform: process.platform }),
      ...(managedNodeAvailable
        ? {
            installManagedNode: (log: (line: string) => void) => {
              managedNodeInstall ??= installManagedNode(
                { homeDir, platform: process.platform, arch: process.arch },
                log,
              ).finally(() => {
                managedNodeInstall = null;
              });
              return managedNodeInstall;
            },
          }
        : {}),
      brewAvailable: async () => {
        for (const brew of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
          if (
            await access(brew, fsConstants.X_OK).then(
              () => true,
              () => false,
            )
          )
            return true;
        }
        return false;
      },
      probeUvAvailable: () => probeCommandAvailable("uv", baseEnv),
      resolveCliEnvironment: (driver, instanceId) =>
        runPromise(resolveCliEnvironment(driver, instanceId)),
      storeClaudeApiKey: (apiKey) =>
        runPromise(storeApiKey("claudeAgent", ANTHROPIC_API_KEY_ENV, apiKey)),
      removeClaudeApiKey: () => runPromise(removeApiKey("claudeAgent", ANTHROPIC_API_KEY_ENV)),
      gemini,
      grok,
      antigravity,
      refreshProvider: (driver, instanceId) =>
        runPromise(
          instanceId
            ? providerRegistry.refreshInstance(instanceId)
            : providerRegistry.refresh(driver),
        ).then(() => undefined),
      probeAuth: (driver, options) => {
        const kind = ProviderDriverKind.make(driver);
        const wanted = options.instanceId ?? defaultInstanceIdForDriver(kind);
        return runPromise(
          !options.refresh
            ? providerRegistry.getProviders
            : options.instanceId
              ? providerRegistry.refreshInstance(options.instanceId)
              : providerRegistry.refresh(kind),
        ).then((providers) =>
          describeHarnessAuth(
            providers.find(
              (provider) => provider.driver === kind && provider.instanceId === wanted,
            ) ??
              (options.instanceId
                ? undefined
                : providers.find((provider) => provider.driver === kind)),
          ),
        );
      },
      log: (message, meta) => {
        runFork(Effect.logWarning(message, meta));
      },
    });

    const accountAdd: HarnessSetupShape["accountAdd"] = (input) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        if (!settings.multipleAccounts) {
          return yield* fail("invalid", 'Turn on "Use more than one account" first.');
        }
        if (input.driver === "gemini") {
          return yield* fail("invalid", "Gemini CLI has one account per computer.");
        }
        if (input.driver === "grok") {
          return yield* fail("invalid", "Grok has one account per computer.");
        }
        if (input.driver === "antigravity") {
          return yield* fail("invalid", "Antigravity has one account per computer.");
        }
        const instanceId = newAccountInstanceId(input.driver);
        const folder = accountFolder(homeDir, instanceId);
        yield* Effect.tryPromise({
          try: () =>
            prepareAccountFolder({
              driver: input.driver,
              home: homeDir,
              folder,
              claudeDir: path.join(homeDir, ".claude"),
            }),
          catch: (error) => fail("failed", describeError(error)),
        });
        const instance = accountInstanceConfig({ driver: input.driver, name: input.name, folder });
        yield* serverSettings.updateSettings({
          providerInstances: { ...settings.providerInstances, [instanceId]: instance },
        });
        return { instanceId, displayName: accountDisplayName(input.driver, input.name) };
      }).pipe(
        Effect.mapError((error) =>
          isProviderSetupRpcError(error) ? error : fail("failed", describeError(error)),
        ),
      );

    const accountRemove: HarnessSetupShape["accountRemove"] = ({ instanceId }) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSettings;
        const instance = settings.providerInstances[instanceId];
        const folder = instance ? accountFolderOf(instance) : null;
        if (!instance || folder === null || !isAccountFolder(homeDir, folder)) {
          return yield* fail("notFound", "This is not a second account of this computer.");
        }
        const driver = instance.driver as ProviderAuthDriver;
        // Sign out first: on a Mac the sign-in is a Keychain item, not in the folder.
        const signedOut = yield* Effect.tryPromise({
          try: () => runner.authSignOut({ driver, instanceId }),
          catch: (error) => fail("failed", describeError(error)),
        });
        yield* Effect.tryPromise({
          try: () => removeAccountFolder(homeDir, folder),
          catch: (error) => fail("failed", describeError(error)),
        });
        const { [instanceId]: _gone, ...rest } = settings.providerInstances;
        yield* serverSettings.updateSettings({ providerInstances: rest });
        return {
          instanceId,
          removed: true,
          // The folder is gone either way; a refused sign-out only matters on a Mac.
          ...(signedOut.signedOut ? {} : { error: signedOut.error ?? "Sign-out failed." }),
        };
      }).pipe(
        Effect.mapError((error) =>
          isProviderSetupRpcError(error) ? error : fail("failed", describeError(error)),
        ),
      );

    yield* Effect.addFinalizer(() => Effect.sync(() => runner.shutdown()));
    return makeHarnessSetupShape(runner, { accountAdd, accountRemove });
  }),
);
