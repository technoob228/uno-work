/**
 * Per-thread environment for a shared OpenCode server.
 *
 * One `opencode serve` process serves every thread of a provider instance
 * (see `opencodeServerPool.ts`), but a few variables must still differ per
 * thread — above all the browser bridge's thread-scoped token
 * (`browserBridge.scopedEnvironment`), which tells `/api/threads*` which chat
 * is calling. A process has one environment, so the per-thread part travels
 * another way:
 *
 * - the daemon writes `<envDir>/<opencodeSessionId>.json` (mode 0600) when a
 *   thread's OpenCode session starts and removes it when the session stops;
 * - a tiny OpenCode plugin (written next to it, loaded through
 *   `OPENCODE_CONFIG_CONTENT.plugin`) implements the `shell.env` hook: every
 *   shell the agent runs (bash tool, `!command`) gets the variables of the
 *   session that runs it. Subagent sessions (the `task` tool) inherit the
 *   variables of their parent session.
 *
 * The files hold nothing a per-thread process didn't already expose: the same
 * user could read another harness's environment from `/proc/<pid>/environ`.
 *
 * @module opencodeSessionEnv
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { UNO_WORK_MCP_SERVER_NAME, UNO_WORK_MCP_SESSION_ARG } from "../unoWork/constants.ts";

/** Env var through which the plugin finds the per-session files. */
export const OPENCODE_SESSION_ENV_DIR_ENV = "UNO_WORK_SESSION_ENV_DIR";

/** OpenCode names MCP tools `<server>_<tool>`. */
const UNO_WORK_TOOL_PREFIX = `${UNO_WORK_MCP_SERVER_NAME}_`;

const PLUGIN_FILE_NAME = "uno-work-session-env.mjs";
const ENV_DIR_NAME = "opencode-session-env";

/**
 * The plugin source. Legacy plugin format (named export of an async factory)
 * — understood by every OpenCode version we ship (uno-code 1.14.x, opencode
 * 1.18.x). Kept dependency-free: it runs inside the compiled Bun binary.
 */
export const OPENCODE_SESSION_ENV_PLUGIN_SOURCE = `// Written by Uno Work. Do not edit: it is rewritten on every start.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export const UnoWorkSessionEnv = async (input) => {
  const serverUrl = input && input.serverUrl ? String(input.serverUrl).replace(/\\/+$/, "") : "";
  const parentOf = new Map();

  const readEnv = (dir, sessionID) => {
    if (!SAFE_ID.test(sessionID)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, sessionID + ".json"), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const lookupParent = async (sessionID, cwd) => {
    if (parentOf.has(sessionID)) return parentOf.get(sessionID);
    if (!serverUrl) return undefined;
    try {
      const response = await fetch(serverUrl + "/session/" + encodeURIComponent(sessionID), {
        headers: cwd ? { "x-opencode-directory": encodeURIComponent(cwd) } : {},
      });
      if (!response.ok) return undefined;
      const info = await response.json();
      const parent = info && typeof info.parentID === "string" ? info.parentID : undefined;
      parentOf.set(sessionID, parent);
      return parent;
    } catch {
      return undefined;
    }
  };

  // The nearest session (itself or a parent, for \`task\` subagents) the
  // daemon wrote variables for.
  const resolveSession = async (dir, sessionID, cwd) => {
    for (let depth = 0; depth < 8 && sessionID; depth += 1) {
      const env = readEnv(dir, sessionID);
      if (env) return { id: sessionID, env };
      sessionID = await lookupParent(sessionID, cwd);
    }
    return undefined;
  };

  return {
    "shell.env": async (hookInput, output) => {
      const dir = process.env.${OPENCODE_SESSION_ENV_DIR_ENV};
      const sessionID = hookInput && typeof hookInput.sessionID === "string" ? hookInput.sessionID : "";
      if (!dir || !sessionID) return;
      const found = await resolveSession(dir, sessionID, hookInput.cwd);
      if (!found) return;
      for (const [key, value] of Object.entries(found.env)) {
        if (typeof value === "string") output.env[key] = value;
      }
    },
    // One server serves every chat, so its uno-work MCP connection can't say
    // which chat calls: each uno-work tool call names its session instead.
    "tool.execute.before": async (hookInput, output) => {
      const tool = hookInput && typeof hookInput.tool === "string" ? hookInput.tool : "";
      if (!tool.startsWith(${JSON.stringify(UNO_WORK_TOOL_PREFIX)})) return;
      if (!output || !output.args || typeof output.args !== "object") return;
      // Never trust a tag the model wrote itself (it can see earlier calls' input).
      delete output.args[${JSON.stringify(UNO_WORK_MCP_SESSION_ARG)}];
      const dir = process.env.${OPENCODE_SESSION_ENV_DIR_ENV};
      const sessionID = typeof hookInput.sessionID === "string" ? hookInput.sessionID : "";
      if (!dir || !sessionID) return;
      const found = await resolveSession(dir, sessionID, undefined);
      if (found) output.args[${JSON.stringify(UNO_WORK_MCP_SESSION_ARG)}] = found.id;
    },
    // Best effort: the stored call input may already carry the tag (a session id, not a secret).
    "tool.execute.after": async (hookInput) => {
      const args = hookInput && hookInput.args;
      if (args && typeof args === "object") delete args[${JSON.stringify(UNO_WORK_MCP_SESSION_ARG)}];
    },
  };
};
`;

export interface OpenCodeSessionEnvPaths {
  /** `file://` URL of the plugin, as it goes into the config's `plugin` list. */
  readonly pluginUrl: string;
  readonly envDir: string;
}

/**
 * Writes the plugin (when its content changed) and creates the env directory.
 * Synchronous on purpose: called once per adapter, before the first spawn.
 */
export function ensureOpenCodeSessionEnvFiles(stateDir: string): OpenCodeSessionEnvPaths {
  const envDir = openCodeSessionEnvDir(stateDir);
  fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(envDir, 0o700);
  } catch {
    // Best effort: a pre-existing directory owned by someone else stays as is.
  }
  const pluginPath = path.join(stateDir, PLUGIN_FILE_NAME);
  let current: string | undefined;
  try {
    current = fs.readFileSync(pluginPath, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== OPENCODE_SESSION_ENV_PLUGIN_SOURCE) {
    const tmp = `${pluginPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, OPENCODE_SESSION_ENV_PLUGIN_SOURCE, { mode: 0o600 });
    fs.renameSync(tmp, pluginPath);
  }
  return { pluginUrl: pathToFileURL(pluginPath).href, envDir };
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

function sessionEnvPath(envDir: string, sessionId: string): string | null {
  return SAFE_SESSION_ID.test(sessionId) ? path.join(envDir, `${sessionId}.json`) : null;
}

/** Atomically writes the variables of one OpenCode session (0600). */
export function writeOpenCodeSessionEnv(
  envDir: string,
  sessionId: string,
  env: Readonly<Record<string, string>>,
): boolean {
  const target = sessionEnvPath(envDir, sessionId);
  if (!target) return false;
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
  fs.renameSync(tmp, target);
  return true;
}

/** Directory of the per-session files under a state dir. */
export function openCodeSessionEnvDir(stateDir: string): string {
  return path.join(stateDir, ENV_DIR_NAME);
}

/** The variables the daemon wrote for one OpenCode session, if any. */
export function readOpenCodeSessionEnv(
  envDir: string,
  sessionId: string,
): Record<string, string> | undefined {
  const target = sessionEnvPath(envDir, sessionId);
  if (!target) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return undefined;
  }
}

export function removeOpenCodeSessionEnv(envDir: string, sessionId: string): void {
  const target = sessionEnvPath(envDir, sessionId);
  if (!target) return;
  try {
    fs.rmSync(target, { force: true });
  } catch {
    // Already gone or unreadable directory — nothing to leak either way.
  }
}

/**
 * Adds the plugin to an `OPENCODE_CONFIG_CONTENT` JSON document. Returns the
 * input unchanged when it isn't a JSON object (we never break a user's config
 * to add our plugin — the thread then simply runs without per-thread env).
 */
export function withOpenCodeSessionEnvPlugin(
  configContent: string | undefined,
  pluginUrl: string,
): string | undefined {
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(configContent ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return configContent;
    }
    config = parsed as Record<string, unknown>;
  } catch {
    return configContent;
  }
  const existing = Array.isArray(config["plugin"]) ? (config["plugin"] as unknown[]) : [];
  if (existing.includes(pluginUrl)) return JSON.stringify(config);
  return JSON.stringify({ ...config, plugin: [...existing, pluginUrl] });
}
