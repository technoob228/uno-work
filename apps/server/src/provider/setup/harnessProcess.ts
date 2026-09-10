/**
 * Thin child-process wrapper used by the setup jobs. Kept separate from the
 * job logic so tests can hand `makeHarnessSetup` a fake spawner.
 *
 * Both install and sign-in commands are plain pipes, no PTY: `codex login
 * --device-auth` and `claude auth login` were checked to print their URL /
 * code / "paste code" prompt with stdout redirected, and `claude` reads the
 * pasted code from stdin. npm/uv/curl do not care either way.
 *
 * @module provider/setup/harnessProcess
 */
import { spawn } from "node:child_process";
import * as nodePath from "node:path";

export interface HarnessProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the process could not even be started (ENOENT, EACCES, ...). */
  readonly error?: Error;
}

export interface HarnessProcessSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly onOutput: (chunk: string) => void;
  readonly onExit: (exit: HarnessProcessExit) => void;
}

export interface HarnessProcessHandle {
  readonly write: (data: string) => void;
  readonly endInput: () => void;
  readonly kill: () => void;
}

export type HarnessProcessSpawner = (input: HarnessProcessSpawnInput) => HarnessProcessHandle;

const KILL_ESCALATION_MS = 5_000;

/** Prepend `~/.local/bin` to PATH unless it is already there. */
export function withUserLocalBinOnPath(env: NodeJS.ProcessEnv, homeDir: string): NodeJS.ProcessEnv {
  const localBin = nodePath.join(homeDir, ".local", "bin");
  const current = env.PATH ?? "";
  const entries = current.split(nodePath.delimiter).filter((entry) => entry.length > 0);
  if (entries.includes(localBin)) return env;
  return { ...env, PATH: [localBin, ...entries].join(nodePath.delimiter) };
}

export const spawnHarnessProcess: HarnessProcessSpawner = (input) => {
  let settled = false;
  const settle = (exit: HarnessProcessExit) => {
    if (settled) return;
    settled = true;
    input.onExit(exit);
  };

  const child = spawn(input.command, [...input.args], {
    env: input.env,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32",
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => input.onOutput(chunk));
  child.stderr?.on("data", (chunk: string) => input.onOutput(chunk));
  child.stdin?.on("error", () => {
    // The CLI may exit before we finish writing (e.g. it rejected the key);
    // the exit handler reports that, an EPIPE here adds nothing.
  });
  child.on("error", (error) => settle({ code: null, signal: null, error }));
  child.on("close", (code, signal) => settle({ code, signal }));

  return {
    write: (data) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(data);
    },
    endInput: () => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    },
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_ESCALATION_MS);
      timer.unref();
    },
  };
};
