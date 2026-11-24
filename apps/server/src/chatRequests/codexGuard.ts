/**
 * A Codex chat held to the rules of this computer (a chat started at a cloud
 * chat's request, Misha 23.11: "Codex on the Mac, now"), the Codex way of
 * what the Claude hook does (commandGuard.ts):
 *
 * - every command runs in Codex's own sandbox (Seatbelt on a Mac, Landlock on
 *   Linux), whatever the chat's mode: no network; it reads only the chat's
 *   folder, the project folders and the toolchains (plus the system's own);
 *   it writes only the chat's folder and temp. `~/.ssh`, `~/.uno`, the
 *   sign-ins and Uno Work's own data aren't readable at all;
 * - a command that asks to leave the sandbox (a push, an install, anything
 *   that needs the network) goes through the same tiers as the Claude hook:
 *   refused ones are declined without a card; a push or an install always
 *   asks the person; the rest asks too, unless the chat's mode is Full access;
 * - the person's own MCP servers are not there (CodexAdapter: `sandboxed`);
 *   uno-work holds the chat to a few tools (unoWork/tools.ts).
 *
 * Left open: a `.env` inside the project folder is readable from the sandbox
 * (the Claude hook refuses it by name).
 *
 * @module chatRequests/codexGuard
 */
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";

import type { RuntimeMode } from "@t3tools/contracts";

import { DEFAULT_ALLOWED_FOLDERS, isInside } from "../myComputer/trust/pathPolicy.ts";
import type { CodexCommandGuard } from "../provider/Layers/CodexSessionRuntime.ts";
import type { CommandGuardPlan } from "../provider/Services/CommandGuardPolicy.ts";
import { makeCommandGuard, type CommandGuard } from "./commandGuard.ts";

/** Where compilers, package managers and their caches live; read-only. */
const TOOLCHAINS = [
  "/opt/homebrew",
  "/usr/local",
  "~/.nvm",
  "~/.bun",
  "~/.cargo",
  "~/.rustup",
  "~/.npm",
  "~/.pyenv",
  "~/.rbenv",
  "~/.local/bin",
  "~/.local/lib",
  "~/.local/share/uv",
  "~/go",
  "~/Library/pnpm",
  "~/.gitconfig",
  "~/.config/git",
];

/** Allowed folders that are sign-ins, not projects: never readable here. */
const NOT_READABLE = new Set(["~/.claude", "~/.codex"]);

/** What the agent reads before every turn of such a chat. */
export const CODEX_GUARD_INSTRUCTIONS = [
  "This chat was started at a cloud chat's request, so on this computer it is held to the person's rules:",
  "commands run in a sandbox without network that sees only the project folders;",
  "ssh to other machines, deploys, sudo and secrets are refused; git push and installs ask the person each time.",
  "When a command is declined, don't look for another way: say what is needed and stop, so the person can do it.",
].join(" ");

const expand = (raw: string, home: string) =>
  raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;

export function codexGuardRoots(input: {
  readonly plan: CommandGuardPlan;
  readonly cwd: string;
  readonly home?: string;
  readonly exists?: (absolute: string) => boolean;
}): Pick<CodexCommandGuard, "readableRoots" | "writableRoots"> {
  const home = input.home ?? os.homedir();
  const exists = input.exists ?? ((absolute: string) => fs.existsSync(absolute));
  const blocked = input.plan.blockedRoots.map((root) => path.resolve(root));
  const caseInsensitive = process.platform !== "linux";
  const holdsBlocked = (root: string) =>
    blocked.some((b) => isInside(b, root, caseInsensitive) || isInside(root, b, caseInsensitive));
  const cwd = path.resolve(input.cwd);
  const readable: Array<string> = [cwd];
  for (const raw of [...DEFAULT_ALLOWED_FOLDERS, ...TOOLCHAINS]) {
    if (NOT_READABLE.has(raw)) continue;
    const absolute = path.resolve(expand(raw, home));
    if (absolute === home || readable.includes(absolute)) continue;
    if (holdsBlocked(absolute) || !exists(absolute)) continue;
    readable.push(absolute);
  }
  return { readableRoots: readable, writableRoots: [] };
}

export function makeCodexCommandGuard(input: {
  readonly plan: CommandGuardPlan;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly guard?: CommandGuard;
  readonly home?: string;
  readonly exists?: (absolute: string) => boolean;
}): CodexCommandGuard {
  const guard = input.guard ?? makeCommandGuard(input.plan);
  return {
    ...codexGuardRoots(input),
    check: async ({ command, cwd }) => {
      // T51: a chat that only reads never leaves the sandbox.
      if (input.plan.readOnly === true) return "decline";
      if (command.trim().length === 0) return "ask";
      const verdict = await guard.check({
        toolName: "Bash",
        toolInput: { command },
        cwd,
      });
      if (verdict === null) return input.runtimeMode === "full-access" ? "accept" : "ask";
      return "deny" in verdict ? "decline" : "ask";
    },
  };
}
