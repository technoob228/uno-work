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
      return {
        kind: "unsupported",
        reason:
          "Hermes is installed with uv, which is not available on this machine. Install uv first (https://docs.astral.sh/uv/).",
      };
    }
    const args = ["tool", "install", "hermes-agent[acp]", "--with", "mcp>=1.9"];
    return {
      kind: "command",
      command: "uv",
      args,
      env: {},
      display: `uv tool install "hermes-agent[acp]" --with "mcp>=1.9"`,
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
