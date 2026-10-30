/**
 * Which command installs which harness CLI, for the user the daemon runs as.
 *
 * Nothing here needs root: npm packages go to the global prefix when it is
 * writable and to `~/.local` otherwise (its `bin/` is on PATH on the boxes and
 * is the conventional user prefix on macOS/Linux), hermes goes through `uv
 * tool install`, and Cursor ships its own user-level installer script.
 *
 * @module provider/setup/harnessInstallCommands
 */
import * as nodePath from "node:path";

import { INSTALLABLE_PROVIDER_DRIVERS, type ProviderDriverKind } from "@t3tools/contracts";
import { UNO_OPENCODE_VERSION } from "@t3tools/shared/agentVersions";

/**
 * Python Hermes runs on. hermes-agent needs >=3.11,<3.14; without a pin uv
 * takes the first interpreter it finds — on a stock Mac that is the system
 * 3.9 and the install fails ("requirements are unsatisfiable"). uv fetches
 * a managed 3.12 when the machine has none.
 */
export const HERMES_PYTHON = "3.12";

/**
 * The MCP SDK Hermes' tools client works with. mcp 2.x dropped
 * `streamablehttp_client`, and Hermes then silently runs without any HTTP MCP
 * server — the Uno assistant loses `uno-manager` (list_threads, create_thread…).
 * An open `mcp>=1.9` resolves to 2.x today, so cap it.
 */
export const HERMES_MCP_SPEC = "mcp>=1.9,<2";

/**
 * `uv tool install` arguments for Hermes. `--force` so a repair (a Hermes
 * with a broken MCP SDK) replaces the existing install instead of saying
 * "already installed".
 */
export const HERMES_UV_TOOL_ARGS: ReadonlyArray<string> = [
  "tool",
  "install",
  "--force",
  "--python",
  HERMES_PYTHON,
  "hermes-agent[acp]",
  "--with",
  HERMES_MCP_SPEC,
];

/**
 * The Hermes the assistant needs for the person's Claude plan (≥ 0.21.4, the
 * Claude plugin's floor). Hermes stopped publishing to PyPI after 0.19 and
 * its `setup.py` refuses to build a wheel outside Nix (`HERMES_NIX_BUILD=1`
 * is that guard's own switch); its official installer pulls ~2.5 GB of
 * tools. The same `uv tool install` from a pinned release tag is ~200 MB and
 * needs `git` (checked 15.10: 0.21.5, ACP, MCP, the Claude plugin). Pinned:
 * an upgrade is a deliberate change of this tag.
 */
export const HERMES_CLAUDE_READY_REF = "v2026.9.24";
export const HERMES_CLAUDE_READY_VERSION = "0.21.5";

export const HERMES_UV_TOOL_ARGS_CLAUDE_READY: ReadonlyArray<string> = [
  "tool",
  "install",
  "--force",
  "--python",
  HERMES_PYTHON,
  `hermes-agent[acp] @ git+https://github.com/NousResearch/hermes-agent@${HERMES_CLAUDE_READY_REF}`,
  "--with",
  HERMES_MCP_SPEC,
];

export const HERMES_CLAUDE_READY_ENV: Readonly<Record<string, string>> = { HERMES_NIX_BUILD: "1" };

const shellQuote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;

/**
 * Install Hermes the way every computer should have it (Misha 15.10: "it
 * should just be there"): the pinned release that also runs the person's
 * Claude plan; if that can't be built here (no git, GitHub unreachable),
 * the PyPI Hermes as before — the assistant works either way.
 */
export function hermesInstallScript(uvBin: string): string {
  const pinned = HERMES_UV_TOOL_ARGS_CLAUDE_READY.map(shellQuote).join(" ");
  const fallback = HERMES_UV_TOOL_ARGS.map(shellQuote).join(" ");
  return `HERMES_NIX_BUILD=1 ${shellQuote(uvBin)} ${pinned} || ${shellQuote(uvBin)} ${fallback}`;
}

export const HERMES_INSTALL_DISPLAY = `uv tool install --python ${HERMES_PYTHON} "hermes-agent[acp]" --with "${HERMES_MCP_SPEC}"`;

export interface InstallPlanContext {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  /** Whether the npm global prefix can be written by the current user. */
  readonly npmGlobalWritable: boolean;
  readonly uvAvailable: boolean;
}

export type InstallPlan =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
      /** Human-readable command line for the UI. */
      readonly display: string;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
    };

// `@latest`: the same button installs and updates. A CLI that is already
// installed would otherwise stay on whatever version it has — too old for the
// newest models (Claude Opus 5.5 needs Claude Code 2.1.280). Claude Code's own
// auto-updater is left on. OpenCode is pinned: it also runs Uno Code, and a new
// one reaches computers only after it passed our checks.
const NPM_SPEC_BY_DRIVER: Readonly<Record<string, string>> = {
  codex: "@openai/codex@latest",
  claudeAgent: "@anthropic-ai/claude-code@latest",
  opencode: `opencode-ai@${UNO_OPENCODE_VERSION}`,
};

export function isInstallableDriver(driver: ProviderDriverKind): boolean {
  return (INSTALLABLE_PROVIDER_DRIVERS as ReadonlyArray<string>).includes(driver);
}

/** `~/.local` — matches the prefix the boxes already put on PATH. */
export function userLocalNpmPrefix(homeDir: string): string {
  return nodePath.join(homeDir, ".local");
}

export function resolveInstallPlan(
  driver: ProviderDriverKind,
  context: InstallPlanContext,
): InstallPlan {
  if (driver === "uno") {
    return {
      kind: "unsupported",
      reason: "Uno Code ships with Uno Work and cannot be installed separately.",
    };
  }

  const npmSpec = NPM_SPEC_BY_DRIVER[driver];
  if (npmSpec) {
    const env = context.npmGlobalWritable
      ? {}
      : { npm_config_prefix: userLocalNpmPrefix(context.homeDir) };
    const args = ["install", "-g", npmSpec];
    return {
      kind: "command",
      command: "npm",
      args,
      env,
      display: `${context.npmGlobalWritable ? "" : `npm_config_prefix=${env.npm_config_prefix} `}npm ${args.join(" ")}`,
    };
  }

  if (driver === "hermes") {
    if (!context.uvAvailable) {
      if (context.platform === "win32") {
        return {
          kind: "unsupported",
          reason:
            "Hermes is installed with uv, which is not available on this machine. Install uv first (https://docs.astral.sh/uv/).",
        };
      }
      // The Uno assistant runs on Hermes, so a machine without uv gets it the
      // way the Work image does (deploy/install.sh): astral's user-level
      // installer into ~/.local/bin (uv brings its own Python). No curl or no
      // network → the job fails with the installer's own words and a Retry.
      const uvBin = nodePath.join(context.homeDir, ".local", "bin", "uv");
      // Download first: `curl … | sh` would hide a failed download (sh of an
      // empty script exits 0) and the error would read "uv: not found".
      const script = `uv_installer="$(curl -LsSf https://astral.sh/uv/install.sh)" && printf '%s\n' "$uv_installer" | env UV_NO_MODIFY_PATH=1 sh && { ${hermesInstallScript(uvBin)}; }`;
      return {
        kind: "command",
        command: "sh",
        args: ["-c", script],
        env: {},
        display: `install uv, then ${HERMES_INSTALL_DISPLAY}`,
      };
    }
    if (context.platform === "win32") {
      return {
        kind: "command",
        command: "uv",
        args: HERMES_UV_TOOL_ARGS,
        env: {},
        display: HERMES_INSTALL_DISPLAY,
      };
    }
    return {
      kind: "command",
      command: "sh",
      args: ["-c", hermesInstallScript("uv")],
      env: {},
      display: `${HERMES_INSTALL_DISPLAY} (Hermes ${HERMES_CLAUDE_READY_VERSION})`,
    };
  }

  if (driver === "cursor") {
    if (context.platform === "win32") {
      return {
        kind: "unsupported",
        reason: "The Cursor CLI installer script only supports macOS and Linux.",
      };
    }
    const script = "curl https://cursor.com/install -fsS | bash";
    return {
      kind: "command",
      command: "bash",
      args: ["-c", script],
      env: {},
      display: script,
    };
  }

  return {
    kind: "unsupported",
    reason: `No installer is known for the "${driver}" harness.`,
  };
}
