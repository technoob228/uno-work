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

const NPM_PACKAGE_BY_DRIVER: Readonly<Record<string, string>> = {
  codex: "@openai/codex",
  claudeAgent: "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
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

  const npmPackage = NPM_PACKAGE_BY_DRIVER[driver];
  if (npmPackage) {
    const env = context.npmGlobalWritable
      ? {}
      : { npm_config_prefix: userLocalNpmPrefix(context.homeDir) };
    const args = ["install", "-g", npmPackage];
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
      const uvArgs = HERMES_UV_TOOL_ARGS.map((arg) => `'${arg}'`).join(" ");
      // Download first: `curl … | sh` would hide a failed download (sh of an
      // empty script exits 0) and the error would read "uv: not found".
      const script = `uv_installer="$(curl -LsSf https://astral.sh/uv/install.sh)" && printf '%s\n' "$uv_installer" | env UV_NO_MODIFY_PATH=1 sh && '${uvBin}' ${uvArgs}`;
      return {
        kind: "command",
        command: "sh",
        args: ["-c", script],
        env: {},
        display: `install uv, then ${HERMES_INSTALL_DISPLAY}`,
      };
    }
    return {
      kind: "command",
      command: "uv",
      args: HERMES_UV_TOOL_ARGS,
      env: {},
      display: HERMES_INSTALL_DISPLAY,
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
