/**
 * Which binary the Uno harness runs, and how an upstream `opencode` binary is
 * kept away from the user's own OpenCode setup.
 *
 * The Uno harness used to need our fork (technoob228/uno-code): its only
 * functional change is the app directory name (`~/.config/uno-code` instead of
 * `~/.config/opencode`, `.uno-code/` and `uno-code.json` in projects), so the
 * injected gateway config never merged with a personal opencode install.
 * Stock opencode gets the same isolation from the XDG base directories:
 *
 * - `XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_CACHE_HOME / XDG_STATE_HOME` point
 *   into `~/.unowork/opencode-home/`, so global config, auth, sessions DB,
 *   plugins cache and logs are private to Uno Work;
 * - the XDG variables are inherited by every shell the agent runs. The
 *   `shell.env` plugin below puts the user's own values back (an empty value
 *   means "use the default" per the XDG spec), so `gh`, `git`, pip and friends
 *   inside the agent's shell see the user's real config;
 * - `OPENCODE_DISABLE_AUTOUPDATE=1`: the version is pinned by Uno Work.
 *
 * What stays different from the fork (cannot be switched off by config
 * without side effects): stock opencode also reads `~/.opencode/` and, inside a
 * project, `opencode.json` / `.opencode/` — the standard opencode files the
 * project itself ships. `OPENCODE_DISABLE_PROJECT_CONFIG` would hide them but
 * also drops the project's AGENTS.md, so it is not set.
 *
 * @module provider/unoHarnessIsolation
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";

export type UnoHarnessKind = "fork" | "upstream";

export interface UnoHarnessBinary {
  readonly binaryPath: string;
  readonly kind: UnoHarnessKind;
}

/** XDG variables that isolate an upstream opencode. */
export const UNO_HARNESS_XDG_VARIABLES = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;

/** Env var through which the restore plugin gets the user's own values. */
export const UNO_HARNESS_SHELL_ENV_RESTORE = "UNO_WORK_SHELL_ENV_RESTORE";

const RESTORE_PLUGIN_FILE_NAME = "uno-work-shell-env-restore.mjs";

/**
 * Plugin source. Legacy plugin format (named export of an async factory),
 * dependency-free: it runs inside the compiled Bun binary.
 */
export const UNO_HARNESS_SHELL_ENV_RESTORE_PLUGIN_SOURCE = `// Written by Uno Work. Do not edit: it is rewritten on every start.
export const UnoWorkShellEnvRestore = async () => ({
  "shell.env": async (_input, output) => {
    let restore;
    try {
      restore = JSON.parse(process.env.${UNO_HARNESS_SHELL_ENV_RESTORE} || "{}");
    } catch {
      return;
    }
    if (!restore || typeof restore !== "object") return;
    for (const [key, value] of Object.entries(restore)) {
      if (typeof value === "string" && !(key in output.env)) output.env[key] = value;
    }
  },
});
`;

function binaryBaseName(binaryPath: string): string {
  // Both separators: a Windows path must classify the same on any host.
  const base = binaryPath.split(/[\\/]/u).at(-1) ?? binaryPath;
  return base.replace(/\.(?:exe|cmd)$/iu, "").toLowerCase();
}

/** Stock opencode (npm `opencode-ai`, brew, GitHub release) — not our fork. */
export function isUpstreamOpenCodeBinary(binaryPath: string): boolean {
  return binaryBaseName(binaryPath) === "opencode";
}

/**
 * Picks the harness binary.
 *
 * - An explicit binary from Settings wins, unless it is the schema's fallback
 *   marker (`opencode` / `uno-code`, never resolved via PATH: that would pick
 *   a personal install) or an absolute path that no longer exists.
 * - Otherwise the bundled stock opencode (`~/.unowork/opencode/bin/opencode`)
 *   when it is installed, else the legacy fork (`~/.unowork/uno-code/bin/uno-code`).
 */
export function resolveUnoHarnessBinary(input: {
  readonly configured: string | undefined;
  readonly forkPath: string;
  readonly upstreamPath: string;
  readonly exists: (path: string) => boolean;
}): UnoHarnessBinary {
  const configured = input.configured?.trim();
  const isSchemaFallback = configured === "opencode" || configured === "uno-code";
  const isStaleAbsolutePath =
    configured !== undefined &&
    configured.length > 0 &&
    nodePath.isAbsolute(configured) &&
    !input.exists(configured);
  if (configured && !isSchemaFallback && !isStaleAbsolutePath) {
    return {
      binaryPath: configured,
      kind: isUpstreamOpenCodeBinary(configured) ? "upstream" : "fork",
    };
  }
  if (input.exists(input.upstreamPath)) {
    return { binaryPath: input.upstreamPath, kind: "upstream" };
  }
  return { binaryPath: input.forkPath, kind: "fork" };
}

/**
 * Environment that isolates an upstream opencode under `home`. `parentEnv` is
 * the environment the harness would otherwise inherit: its XDG values are
 * handed to the restore plugin so the agent's shells keep them.
 */
export function unoUpstreamIsolationEnvironment(
  home: string,
  parentEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const restore: Record<string, string> = {};
  for (const name of UNO_HARNESS_XDG_VARIABLES) {
    restore[name] = parentEnv[name] ?? "";
  }
  return {
    XDG_CONFIG_HOME: nodePath.join(home, "config"),
    XDG_DATA_HOME: nodePath.join(home, "data"),
    XDG_CACHE_HOME: nodePath.join(home, "cache"),
    XDG_STATE_HOME: nodePath.join(home, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    [UNO_HARNESS_SHELL_ENV_RESTORE]: JSON.stringify(restore),
  };
}

/**
 * Writes the restore plugin (when its content changed). Returns its `file://`
 * URL for the config's `plugin` list.
 */
export function ensureUnoShellEnvRestorePlugin(stateDir: string): string {
  fs.mkdirSync(stateDir, { recursive: true });
  const pluginPath = nodePath.join(stateDir, RESTORE_PLUGIN_FILE_NAME);
  let current: string | undefined;
  try {
    current = fs.readFileSync(pluginPath, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== UNO_HARNESS_SHELL_ENV_RESTORE_PLUGIN_SOURCE) {
    const tmp = `${pluginPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, UNO_HARNESS_SHELL_ENV_RESTORE_PLUGIN_SOURCE, { mode: 0o600 });
    fs.renameSync(tmp, pluginPath);
  }
  return pathToFileURL(pluginPath).href;
}
