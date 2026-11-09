/**
 * The Claude plugin in the assistant's shared Hermes home: `hermes plugins
 * install` from the plugin's own repository at the commit Work pins
 * (HERMES_CLAUDE_PLUGIN_SHA), never by its catalog name — Hermes 0.21.5
 * drops the live catalog once it outgrew 2 MiB (09.11) and then knows no
 * such name. A model-provider plugin needs no enabling: Hermes imports it
 * from `plugins/`.
 *
 * What the person reads on a failure is ours, never Hermes' own lines
 * (they talk about catalogs and Git URLs); those go to the log.
 *
 * @module manager/claudePluginInstall
 */
import {
  HERMES_CLAUDE_PLUGIN_REPO,
  HERMES_CLAUDE_PLUGIN_SHA,
  HERMES_CLAUDE_PLUGIN_SUBDIR,
} from "../provider/setup/harnessInstallCommands.ts";
import {
  type HarnessProcessHandle,
  type HarnessProcessSpawner,
  spawnHarnessProcess,
} from "../provider/setup/harnessProcess.ts";
import {
  claudePluginInstalled,
  hermesVersionAtLeast,
  stripAnsi,
} from "./assistantSubscriptions.ts";

/** `owner/repo.git#subdir` — the form Hermes 0.21.5 takes for a plugin in a subfolder. */
export const HERMES_CLAUDE_PLUGIN_SOURCE = `${HERMES_CLAUDE_PLUGIN_REPO}#${HERMES_CLAUDE_PLUGIN_SUBDIR}`;

export function claudePluginInstallArgs(
  hermesVersion: string | null | undefined,
): ReadonlyArray<string> {
  // `--yes-deps` (answer the dependency question without a terminal) came
  // with Hermes 0.22; 0.21 doesn't know it and installs without asking.
  const consent = hermesVersionAtLeast(hermesVersion, "0.22.0") ? ["--yes-deps"] : [];
  return [
    "plugins",
    "install",
    HERMES_CLAUDE_PLUGIN_SOURCE,
    "--ref",
    HERMES_CLAUDE_PLUGIN_SHA,
    ...consent,
    "--no-enable",
  ];
}

const FAILED = "Couldn't connect Uno to your Claude plan on this computer";
const RETRY = "Try again in a minute, or keep Uno on Uno AI.";
const NO_GIT = /git is not installed|git: not found|No such file or directory: '?git'?/i;
const OFFLINE =
  /could not resolve host|failed to connect|unable to access|network is unreachable|temporary failure in name resolution|connection (?:refused|reset|timed out)/i;

/** The sentence the person reads when the plugin didn't land. */
export function claudePluginInstallError(input: {
  readonly output: string;
  readonly timedOut: boolean;
  readonly startError?: Error | undefined;
}): string {
  const output = stripAnsi(input.output);
  const reason =
    input.startError !== undefined
      ? "the assistant's engine didn't start"
      : NO_GIT.test(output)
        ? "git is missing on this computer"
        : input.timedOut || /timed out after/i.test(output)
          ? "the download took too long"
          : OFFLINE.test(output)
            ? "GitHub didn't answer"
            : null;
  return reason === null ? `${FAILED}. ${RETRY}` : `${FAILED}: ${reason}. ${RETRY}`;
}

export interface ClaudePluginInstallResult {
  readonly installed: boolean;
  /** For the person, when it didn't land. */
  readonly detail: string | null;
  /** Hermes' own output, for the log only. */
  readonly output: string;
}

export async function installClaudePlugin(input: {
  readonly binary: string;
  readonly hermesVersion: string | null | undefined;
  readonly sharedHome: string;
  /** Hermes' environment with HERMES_HOME = the shared home. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly spawn?: HarnessProcessSpawner;
}): Promise<ClaudePluginInstallResult> {
  const spawn = input.spawn ?? spawnHarnessProcess;
  const run = await new Promise<{
    readonly output: string;
    readonly timedOut: boolean;
    readonly startError: Error | undefined;
  }>((resolve) => {
    let output = "";
    let timedOut = false;
    let handle: HarnessProcessHandle | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      handle?.kill();
    }, input.timeoutMs);
    handle = spawn({
      command: input.binary,
      args: claudePluginInstallArgs(input.hermesVersion),
      // A public repository: if GitHub ever asks for a login, fail now
      // instead of waiting out the timeout.
      env: { ...input.env, GIT_TERMINAL_PROMPT: "0" },
      cwd: input.cwd,
      onOutput: (chunk) => {
        output += chunk;
      },
      onExit: (exit) => {
        clearTimeout(timer);
        resolve({ output, timedOut, startError: exit.error });
      },
    });
    handle.endInput();
  });
  if (await claudePluginInstalled(input.sharedHome)) {
    return { installed: true, detail: null, output: run.output };
  }
  return { installed: false, detail: claudePluginInstallError(run), output: run.output };
}
