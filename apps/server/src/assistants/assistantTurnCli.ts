/**
 * `uno-work assistant-turn --prompt "…"` — what an assistant's schedule runs.
 *
 * The Uno console wakes the computer at the scheduled time and runs this
 * command (as root, `uno` or `unowork`, depending on the plan). It hands the
 * prompt to the assistant through the running daemon
 * (`POST /api/manager/assistant/scheduled-turn`, authenticated with the
 * assistant's own `uno-manager` token from its workspace `.mcp.json`) and
 * BLOCKS until the assistant's turn is over: the console puts the computer
 * back to sleep the moment this command exits.
 *
 * Which assistant: `--workspace <dir>` when given, else `$UNO_ASSISTANT_WORKSPACE`,
 * else the assistant folders under `~/UnoWork/Assistants` of the current user
 * and of `unowork` — one found is used; several → the default one (`home`).
 *
 * A user that cannot read the workspace (`uno` on a cloud computer) re-runs
 * the command as `unowork` through `sudo -n` once.
 *
 * Nothing secret is printed: only the outcome JSON.
 *
 * @module assistants/assistantTurnCli
 */
import { spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import os from "node:os";
import * as nodePath from "node:path";

import {
  ASSISTANT_PROJECT_ID,
  ASSISTANT_SCHEDULE_DEFAULT_MINUTES,
  ASSISTANT_SCHEDULE_MAX_MINUTES,
} from "@t3tools/contracts";

/** The Linux user the Work daemon runs as on a cloud computer. */
export const WORK_DAEMON_USER = "unowork";
const ASSISTANTS_SUBDIR = nodePath.join("UnoWork", "Assistants");
const MARKER_FILE = ".uno-assistant.json";
const MCP_FILE = ".mcp.json";
const SUDO_GUARD_ENV = "UNO_ASSISTANT_TURN_AS_DAEMON_USER";
/** Extra wait on top of the turn: harness start on a freshly woken computer. */
const CLIENT_SLACK_MS = 60_000;

export interface AssistantTurnCliInput {
  readonly prompt: string;
  readonly name?: string | undefined;
  readonly workspace?: string | undefined;
  readonly timeoutSec?: number | undefined;
}

export interface AssistantTurnCliOutcome {
  readonly exitCode: number;
  /** One line for stdout (JSON) or stderr (the problem). */
  readonly output: string;
}

export class AssistantTurnCliError extends Error {
  readonly permissionDenied: boolean;
  constructor(message: string, permissionDenied = false) {
    super(message);
    this.permissionDenied = permissionDenied;
  }
}

/** `uno-manager` url + Authorization header from a workspace `.mcp.json`. */
export function readManagerEndpoint(
  raw: string,
): { readonly url: string; readonly authorization: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const server = (parsed as { mcpServers?: Record<string, unknown> } | null)?.mcpServers?.[
    "uno-manager"
  ] as { url?: unknown; headers?: Record<string, unknown> } | undefined;
  const url = typeof server?.url === "string" ? server.url : null;
  const authorization = server?.headers?.Authorization ?? server?.headers?.authorization;
  if (url === null || typeof authorization !== "string" || authorization.length === 0) return null;
  return { url, authorization };
}

/** The scheduled-turn endpoint next to the manager MCP url. */
export function scheduledTurnUrl(managerMcpUrl: string): string {
  return new URL("/api/manager/assistant/scheduled-turn", managerMcpUrl).toString();
}

export interface AssistantTurnCliDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly listDirs: (path: string) => Promise<ReadonlyArray<string>>;
  readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  readonly env: NodeJS.ProcessEnv;
  readonly homes: ReadonlyArray<string>;
}

const isPermissionError = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  ((cause as { code?: unknown }).code === "EACCES" ||
    (cause as { code?: unknown }).code === "EPERM");

async function readIfPresent(deps: AssistantTurnCliDeps, path: string): Promise<string | null> {
  try {
    return await deps.readFile(path);
  } catch (cause) {
    if (isPermissionError(cause)) {
      throw new AssistantTurnCliError(`Cannot read ${path}: permission denied.`, true);
    }
    return null;
  }
}

/** The assistant workspace this run talks for. */
export async function findAssistantWorkspace(
  deps: AssistantTurnCliDeps,
  explicit: string | undefined,
): Promise<string> {
  const chosen = explicit?.trim() || deps.env.UNO_ASSISTANT_WORKSPACE?.trim();
  if (chosen) return chosen;
  const candidates: Array<{ readonly dir: string; readonly projectId: string | null }> = [];
  const seen = new Set<string>();
  let denied = false;
  for (const home of deps.homes) {
    const base = nodePath.join(home, ASSISTANTS_SUBDIR);
    let names: ReadonlyArray<string> = [];
    try {
      names = await deps.listDirs(base);
    } catch (cause) {
      if (isPermissionError(cause)) denied = true;
      continue;
    }
    for (const name of names) {
      const dir = nodePath.join(base, name);
      if (seen.has(dir)) continue;
      seen.add(dir);
      let mcp: string | null = null;
      try {
        mcp = await readIfPresent(deps, nodePath.join(dir, MCP_FILE));
      } catch (cause) {
        if (cause instanceof AssistantTurnCliError && cause.permissionDenied) denied = true;
        continue;
      }
      if (mcp === null || readManagerEndpoint(mcp) === null) continue;
      const marker = await readIfPresent(deps, nodePath.join(dir, MARKER_FILE)).catch(() => null);
      let projectId: string | null = null;
      try {
        const value = marker ? (JSON.parse(marker) as { projectId?: unknown }).projectId : null;
        projectId = typeof value === "string" ? value : null;
      } catch {
        projectId = null;
      }
      candidates.push({ dir, projectId });
    }
  }
  if (candidates.length === 1) return candidates[0]!.dir;
  if (candidates.length > 1) {
    const fallback = candidates.find((candidate) => candidate.projectId === ASSISTANT_PROJECT_ID);
    if (fallback) return fallback.dir;
    throw new AssistantTurnCliError(
      `Several assistants on this computer (${candidates.map((c) => c.dir).join(", ")}); pass --workspace.`,
    );
  }
  throw new AssistantTurnCliError(
    denied
      ? "Cannot read the assistant's folder: permission denied."
      : "No assistant on this computer (no ~/UnoWork/Assistants/*/.mcp.json).",
    denied,
  );
}

/** Run one scheduled turn and wait for its end. Never throws. */
export async function runAssistantTurnCli(
  input: AssistantTurnCliInput,
  deps: AssistantTurnCliDeps,
): Promise<AssistantTurnCliOutcome & { readonly permissionDenied?: boolean }> {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) return { exitCode: 2, output: "--prompt is empty." };
  const timeoutSec = Math.min(
    Math.max(1, Math.floor(input.timeoutSec ?? ASSISTANT_SCHEDULE_DEFAULT_MINUTES * 60)),
    ASSISTANT_SCHEDULE_MAX_MINUTES * 60,
  );
  try {
    const workspace = await findAssistantWorkspace(deps, input.workspace);
    const mcpRaw = await readIfPresent(deps, nodePath.join(workspace, MCP_FILE));
    const endpoint = mcpRaw === null ? null : readManagerEndpoint(mcpRaw);
    if (endpoint === null) {
      return {
        exitCode: 1,
        output: `${workspace} is not an assistant folder (no uno-manager in .mcp.json).`,
      };
    }
    const response = await deps.fetchImpl(scheduledTurnUrl(endpoint.url), {
      method: "POST",
      headers: { authorization: endpoint.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        timeoutSec,
      }),
      signal: AbortSignal.timeout(timeoutSec * 1_000 + CLIENT_SLACK_MS),
    });
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error =
        typeof (body as { error?: unknown } | null)?.error === "string"
          ? (body as { error: string }).error
          : `HTTP ${response.status}`;
      return { exitCode: 1, output: `Assistant turn failed: ${error}` };
    }
    const status = (body as { status?: unknown } | null)?.status;
    return {
      exitCode: status === "timeout" ? 1 : 0,
      output: JSON.stringify(body),
    };
  } catch (cause) {
    if (cause instanceof AssistantTurnCliError) {
      return { exitCode: 1, output: cause.message, permissionDenied: cause.permissionDenied };
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      exitCode: 1,
      output: /ECONNREFUSED|fetch failed/i.test(message)
        ? "Uno Work isn't running on this computer (the daemon didn't answer)."
        : `Assistant turn failed: ${message}`,
    };
  }
}

export const nodeAssistantTurnCliDeps = (): AssistantTurnCliDeps => {
  const homes = [os.homedir(), nodePath.join("/home", WORK_DAEMON_USER)];
  return {
    readFile: (path) => fsp.readFile(path, "utf8"),
    listDirs: async (path) =>
      (await fsp.readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    fetchImpl: (input, init) => globalThis.fetch(input, init),
    env: process.env,
    homes: [...new Set(homes)],
  };
};

/**
 * Re-run this very command as the daemon's user (`sudo -n -u unowork`) when
 * the current user can't read the assistant's folder. Null: not possible
 * (already that user, already retried, or not a cloud computer).
 */
export function rerunAsDaemonUser(argv: ReadonlyArray<string>): number | null {
  if (process.env[SUDO_GUARD_ENV] === "1") return null;
  if (process.platform !== "linux") return null;
  if (os.userInfo().username === WORK_DAEMON_USER) return null;
  const [node, script, ...rest] = argv;
  if (!node || !script) return null;
  const result = spawnSync(
    "sudo",
    ["-n", "-H", "-u", WORK_DAEMON_USER, "--", "env", `${SUDO_GUARD_ENV}=1`, node, script, ...rest],
    { stdio: "inherit" },
  );
  if (result.error) return null;
  return result.status ?? 1;
}
