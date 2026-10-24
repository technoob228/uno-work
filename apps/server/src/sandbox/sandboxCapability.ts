/**
 * Can this computer hold an assistant to its selected projects? Linux with
 * bubblewrap that really starts a sandbox (user namespaces may be off, or
 * AppArmor may refuse them): the probe runs `bwrap` with the same
 * namespaces the harness spawn uses ({@link BWRAP_PROBE_ARGS}).
 *
 * Cached: a working sandbox stays working for the daemon's life (an update
 * restarts it); a failed probe is retried after a minute (bwrap installed
 * meanwhile). A Mac answers no — no sandbox there yet.
 *
 * @module sandbox/sandboxCapability
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { BWRAP_PROBE_ARGS } from "./harnessSandbox.ts";

export interface AssistantSandboxCapability {
  readonly available: boolean;
  /** The bwrap that passed the probe. */
  readonly bwrapPath: string | null;
  /** Why not, for logs. */
  readonly reason: string | null;
}

export interface SandboxProbeDeps {
  readonly platform: NodeJS.Platform;
  readonly findBwrap: () => string | null;
  /** Exit code of `bwrap args`, or null when it could not run / timed out. */
  readonly run: (command: string, args: ReadonlyArray<string>) => Promise<number | null>;
}

const PROBE_TIMEOUT_MS = 5_000;
const NEGATIVE_TTL_MS = 60_000;

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"] as const;

export function findBwrapOnHost(pathEnv: string | undefined = process.env.PATH): string | null {
  const dirs = (pathEnv ?? "").split(nodePath.delimiter).filter((dir) => dir.length > 0);
  for (const candidate of [
    ...BWRAP_CANDIDATES,
    ...dirs.map((dir) => nodePath.join(dir, "bwrap")),
  ]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

function runProbe(command: string, args: ReadonlyArray<string>): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const child = spawn(command, [...args], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, PROBE_TIMEOUT_MS);
    child.on("error", () => done(null));
    child.on("exit", (code) => done(code));
  });
}

const liveDeps: SandboxProbeDeps = {
  platform: process.platform,
  findBwrap: () => findBwrapOnHost(),
  run: runProbe,
};

export async function probeAssistantSandbox(
  deps: SandboxProbeDeps = liveDeps,
): Promise<AssistantSandboxCapability> {
  if (deps.platform !== "linux") {
    return { available: false, bwrapPath: null, reason: `no sandbox on ${deps.platform} yet` };
  }
  const bwrapPath = deps.findBwrap();
  if (bwrapPath === null) {
    return { available: false, bwrapPath: null, reason: "bubblewrap (bwrap) is not installed" };
  }
  const code = await deps.run(bwrapPath, BWRAP_PROBE_ARGS);
  if (code !== 0) {
    return {
      available: false,
      bwrapPath,
      reason:
        code === null
          ? "bwrap did not start (timed out or failed to spawn)"
          : `bwrap exited with ${code} (user namespaces may be disabled)`,
    };
  }
  return { available: true, bwrapPath, reason: null };
}

let cached: { readonly at: number; readonly value: Promise<AssistantSandboxCapability> } | null =
  null;

/** {@link probeAssistantSandbox}, cached (see the module doc). */
export function assistantSandboxCapability(
  now: number = Date.now(),
  deps: SandboxProbeDeps = liveDeps,
): Promise<AssistantSandboxCapability> {
  const current = cached;
  if (current === null) {
    const value = probeAssistantSandbox(deps);
    cached = { at: now, value };
    return value;
  }
  return current.value.then((value) => {
    if (value.available || now - current.at < NEGATIVE_TTL_MS) return value;
    if (cached === current) cached = { at: now, value: probeAssistantSandbox(deps) };
    return cached?.value ?? value;
  });
}

/** Tests: forget the cached answer. */
export function resetAssistantSandboxCapabilityCache(): void {
  cached = null;
}
