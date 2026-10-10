/**
 * GithubAccountService — the account's GitHub (`githubAccount.ts`) bound to
 * this daemon's settings, plus the one-time setup of git on a cloud computer:
 * the `git-credential-uno` helper (`gitCredentialHelper.ts`).
 *
 * The helper is put in place when the daemon starts on a cloud computer and
 * again (cheap, idempotent) whenever the interface asks for the GitHub state
 * — the console may link the computer after the daemon started. Off a cloud
 * computer nothing is installed and the person's own git sign-in is untouched.
 *
 * @module setupTools/GithubAccountService
 */
import { execFile } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { parseSettingsBoxId } from "../unoBoxIdentity.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import { ConnectorsError, type MachineCredentials } from "./connectors.ts";
import {
  gitCredentialHelperScript,
  installGitCredentialHelper,
  type GitConfigResult,
} from "./gitCredentialHelper.ts";
import {
  makeGithubAccountClient,
  type GithubAccountClientDeps,
  type GithubAccountStatus,
} from "./githubAccount.ts";

export interface GithubAccountServiceShape {
  /** Never fails. */
  readonly status: Effect.Effect<GithubAccountStatus>;
  readonly connect: Effect.Effect<{ readonly authorizeUrl: string }, ConnectorsError>;
}

export class GithubAccountService extends Context.Service<
  GithubAccountService,
  GithubAccountServiceShape
>()("t3/setupTools/GithubAccountService") {}

/** `git config --global …` with this process's environment. Exit code, never a throw. */
export function runGitConfigGlobal(
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitConfigResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["config", "--global", ...args],
      { env, timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127; // not found, killed
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
  });
}

/** Installs the helper for this state dir; resolves to the helper's path. */
export function installHelperForStateDir(input: {
  readonly stateDir: string;
  readonly settingsPath: string;
  readonly baseUrl: string;
  readonly nodePath?: string;
  readonly env?: NodeJS.ProcessEnv;
}) {
  return installGitCredentialHelper({
    binDir: NodePath.join(input.stateDir, "bin"),
    script: gitCredentialHelperScript({
      nodePath: input.nodePath ?? process.execPath,
      settingsPath: input.settingsPath,
      baseUrl: input.baseUrl,
    }),
    mkdir: async (dir) => {
      await NodeFS.mkdir(dir, { recursive: true });
    },
    readFile: (path) => NodeFS.readFile(path, "utf8").catch(() => null),
    writeExecutable: async (path, content) => {
      const temporary = `${path}.${process.pid}.tmp`;
      await NodeFS.writeFile(temporary, content, { mode: 0o700 });
      await NodeFS.chmod(temporary, 0o700);
      await NodeFS.rename(temporary, path);
    },
    gitConfigGlobal: (args) => runGitConfigGlobal(args, input.env),
    join: NodePath.join,
  });
}

const asConnectorsError = (cause: unknown) =>
  cause instanceof ConnectorsError
    ? cause
    : new ConnectorsError(500, "internal", cause instanceof Error ? cause.message : String(cause));

export const makeGithubAccountService = (overrides: Partial<GithubAccountClientDeps> = {}) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);

    const credentials = async (): Promise<MachineCredentials | null> => {
      const current = await runPromise(settings.getSettings.pipe(Effect.orElseSucceed(() => null)));
      const boxToken = current?.uno.boxToken?.trim() ?? "";
      const boxId = parseSettingsBoxId(current?.uno.boxId);
      return boxToken.length > 0 && boxId !== null ? { boxToken, boxId } : null;
    };

    const client = makeGithubAccountClient({
      credentials,
      baseUrl: controlPlaneBaseUrl,
      ...overrides,
    });

    // Once per process is enough; a failure (no git, read-only home) is retried next time.
    let helperReady = false;
    const ensureHelper = Effect.promise(async () => {
      if (helperReady) return;
      if ((await credentials().catch(() => null)) === null) return;
      try {
        const result = await installHelperForStateDir({
          stateDir: config.stateDir,
          settingsPath: config.settingsPath,
          baseUrl: controlPlaneBaseUrl(),
        });
        helperReady = true;
        if (result.wroteScript || result.addedHelper || result.setUseHttpPath) {
          await runPromise(
            Effect.logInfo("uno.github.credentialHelper.installed", {
              helperPath: result.helperPath,
              addedHelper: result.addedHelper,
              setUseHttpPath: result.setUseHttpPath,
            }),
          );
        }
      } catch (cause) {
        await runPromise(
          Effect.logWarning("uno.github.credentialHelper.failed", {
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
    });

    yield* Effect.forkDetach(ensureHelper);

    return {
      status: ensureHelper.pipe(Effect.andThen(Effect.promise(() => client.status()))),
      connect: ensureHelper.pipe(
        Effect.andThen(
          Effect.tryPromise({ try: () => client.connect(), catch: asConnectorsError }),
        ),
      ),
    } satisfies GithubAccountServiceShape;
  });

export const GithubAccountServiceLive = Layer.effect(
  GithubAccountService,
  makeGithubAccountService(),
);
