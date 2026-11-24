/**
 * The rules a chat started at a cloud chat's request is held to on this
 * computer, by code, before each tool call runs (Claude: a PreToolUse hook,
 * which runs in every mode, Full access too):
 *
 * - commands and paths are judged by the same tiers as the cloud agents'
 *   calls on the person's computer (myComputer/trust/, T47), here with this
 *   computer's real paths; `blocked` (ssh to other machines, containers,
 *   full test runs) is refused; `always` that is only a git push or a
 *   package install asks the person with an Allow card each time, whatever
 *   the chat's mode (Misha 23.11); the rest of `always` (deploys, sudo,
 *   secrets, changing things outside the project folders) is refused; the
 *   rest goes on under the chat's own mode;
 * - Uno Work's own data here (its chats, settings and sign-ins) and the
 *   request folder are out of reach;
 * - MCP servers other than uno-work are refused (they carry the person's
 *   keys); uno-work itself holds such a chat to a few tools (unoWork/tools.ts).
 *
 * - T51: a chat that only reads (a colleague's agent's question answered
 *   here) may use the reading tools and nothing else.
 *
 * A command can still hide what it does (a script written first, then run):
 * the tiers read what is written. That is the T47 bar, not a sandbox.
 *
 * @module chatRequests/commandGuard
 */
import { execFile } from "node:child_process";
import * as os from "node:os";
import path from "node:path";

import type { MyComputerTier } from "@t3tools/contracts";

import { DEFAULT_ALLOWED_FOLDERS, isInside } from "../myComputer/trust/pathPolicy.ts";
import { makeTrustJudge, type TrustJudge, type TrustOperation } from "../myComputer/trust/judge.ts";
import type { CommandGuardPlan } from "../provider/Services/CommandGuardPolicy.ts";

const LOCAL = "this-computer";
const RESOLVER_TIMEOUT_MS = 10_000;
const RESOLVER_OUTPUT_BYTES = 256 * 1024;
const REFUSED_TIERS: ReadonlySet<MyComputerTier> = new Set(["always", "blocked"]);
const UNO_WORK_MCP_PREFIX = "mcp__uno-work__";
/** What a read-only chat may call: reading files, and its own to-do list. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
]);

/** The resolver (trust/resolver.ts) run here, as it runs on the person's computer through the tunnel. */
export const localResolver = (
  command: string,
  signal?: AbortSignal,
  home: string = os.homedir(),
): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        timeout: RESOLVER_TIMEOUT_MS,
        maxBuffer: RESOLVER_OUTPUT_BYTES,
        ...(signal ? { signal } : {}),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LC_ALL: "C" },
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });

/**
 * Null: the call goes on (under the chat's mode). `ask`: only with the
 * person's Allow, for this one call (a push, an install).
 */
export type GuardVerdict =
  | { readonly deny: string }
  | { readonly ask: string; readonly reason: string }
  | null;

export interface CommandGuard {
  /** Null: the call goes on (under the chat's mode). */
  readonly check: (input: {
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly cwd: string | undefined;
    readonly signal?: AbortSignal;
  }) => Promise<GuardVerdict>;
}

const str = (input: unknown, key: string): string | undefined => {
  if (input === null || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

/** The call as a trust operation; null: nothing on disk is touched. */
export function operationOf(
  toolName: string,
  toolInput: unknown,
  cwd: string | undefined,
): TrustOperation | null {
  const here = cwd ?? os.homedir();
  switch (toolName) {
    case "Bash": {
      const command = str(toolInput, "command");
      return command === undefined ? null : { kind: "run", command, cwd: here };
    }
    case "Read":
    case "NotebookRead":
      return {
        kind: "read",
        path: str(toolInput, "file_path") ?? str(toolInput, "notebook_path") ?? here,
      };
    case "LS":
      return { kind: "read", path: str(toolInput, "path") ?? here };
    case "Glob":
    case "Grep":
      return { kind: "read", path: str(toolInput, "path") ?? here, recursive: true };
    case "Write":
    case "Edit":
    case "MultiEdit":
      return { kind: "write", path: str(toolInput, "file_path") ?? here };
    case "NotebookEdit":
      return { kind: "write", path: str(toolInput, "notebook_path") ?? here };
    default:
      return null;
  }
}

const platformOs = () =>
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";

const absoluteFrom = (raw: string, cwd: string, home: string) => {
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  return path.resolve(cwd, expanded);
};

/** The sentence the agent reads, and acts on: say it and stop. */
export const guardDenial = (what: string, why = "started at a cloud chat's request") =>
  `Blocked here: ${what}. This chat was ${why}, so on this computer it can't ssh to other machines, deploy, use sudo, read secrets or change things outside the project folders${why.includes("colleague") ? " (nor push or install)" : " (git push and installs ask the person each time)"}. Don't look for another way: say what is needed and stop, so the person can do it.`;

/** T51: the sentence for a read-only chat. */
export const readOnlyDenial = (toolName: string) =>
  `Blocked here: ${toolName}. This chat only reads: it answers a colleague's agent's question, so it can't edit files, run commands or use other tools. Answer from what you can read; if the question needs more, say so in your answer and stop.`;

/** The card's line for a push or an install. */
export const guardAsk = (reason: string) =>
  `${reason[0]?.toUpperCase() ?? ""}${reason.slice(1)}: this chat was started at a cloud chat's request, so a push or an install asks you each time.`;

/** What the agent hears when the person said no to it. */
export const guardDeclined = (reason: string) =>
  `The person declined ${reason}. Don't try another way: say what is left to do and stop.`;

export function makeCommandGuard(
  plan: CommandGuardPlan,
  options?: {
    readonly judge?: TrustJudge;
    readonly home?: string;
    readonly os?: string;
    readonly allowedFolders?: ReadonlyArray<string>;
  },
): CommandGuard {
  const home = options?.home ?? os.homedir();
  const judge =
    options?.judge ??
    makeTrustJudge((_id, command, signal) => localResolver(command, signal, home));
  const system = options?.os ?? platformOs();
  const caseInsensitive = system !== "linux";
  const allowedFolders = options?.allowedFolders ?? DEFAULT_ALLOWED_FOLDERS;
  const blocked = plan.blockedRoots.map((root) => path.resolve(root));
  /** T51: a colleague's request (not the person's own cloud chat): pushes and installs stay refused. */
  const fromColleague = plan.why.includes("colleague");
  const shown = (root: string) =>
    root === home ? "~" : root.startsWith(`${home}/`) ? `~/${root.slice(home.length + 1)}` : root;
  const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);

  const touchesBlocked = (operation: TrustOperation, cwd: string): string | null => {
    if (operation.kind === "run") {
      const command = fold(operation.command);
      for (const root of blocked) {
        const forms = [root, shown(root), shown(root).replace(/^~/, "$HOME")];
        if (forms.some((form) => form.length > 1 && command.includes(fold(form))))
          return shown(root);
      }
      return null;
    }
    const target = absoluteFrom(operation.path, cwd, home);
    for (const root of blocked) {
      if (
        isInside(target, root, caseInsensitive) ||
        (operation.recursive === true && isInside(root, target, caseInsensitive))
      ) {
        return shown(root);
      }
    }
    return null;
  };

  return {
    check: async ({ toolName, toolInput, cwd, signal }) => {
      if (plan.readOnly === true && !READ_ONLY_TOOLS.has(toolName)) {
        return { deny: readOnlyDenial(toolName) };
      }
      if (toolName.startsWith("mcp__")) {
        return toolName.startsWith(UNO_WORK_MCP_PREFIX)
          ? null
          : { deny: guardDenial(`the tool ${toolName} (the person's own connections)`, plan.why) };
      }
      const here = cwd ?? home;
      const operation = operationOf(toolName, toolInput, here);
      if (operation === null) return null;
      const inBlocked = touchesBlocked(operation, here);
      if (inBlocked !== null) {
        return { deny: guardDenial(`Uno Work's own folder ${inBlocked}`, plan.why) };
      }
      const verdict = await judge.judge(
        {
          computerId: LOCAL,
          os: system,
          allowedFolders,
          allowedCommands: [],
          extraAllowed: [here],
          operation,
        },
        signal,
      );
      // A push or an install asks the person (Misha 23.11) — in a chat a
      // cloud chat of theirs asked for; a colleague's (T51) is refused them.
      if (verdict.tier === "always" && verdict.askable === true && !fromColleague) {
        return { ask: guardAsk(verdict.reason), reason: verdict.reason };
      }
      return REFUSED_TIERS.has(verdict.tier)
        ? { deny: guardDenial(verdict.reason, plan.why) }
        : null;
    },
  };
}

/** The person's answer to an Allow card the guard raised (the adapter shows it). */
export type GuardAskPerson = (input: {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly toolUseId: string | undefined;
  readonly detail: string;
  readonly signal: AbortSignal;
}) => Promise<"accept" | "decline" | "cancel">;

/**
 * The guard as a Claude Agent SDK PreToolUse hook (structurally typed: the
 * adapter passes it in `hooks`). A guard that fails refuses: never open.
 * A push or an install asks the person through `askPerson` (an Allow card
 * in that chat, for this one call); without it, it is refused.
 */
export function claudeGuardHook(guard: CommandGuard, askPerson?: GuardAskPerson) {
  return async (
    input: {
      readonly hook_event_name?: string;
      readonly tool_name?: string;
      readonly tool_input?: unknown;
      readonly cwd?: string;
    },
    toolUseId: string | undefined,
    options: { readonly signal: AbortSignal },
  ) => {
    if (input.hook_event_name !== "PreToolUse" || typeof input.tool_name !== "string") {
      return { continue: true };
    }
    const verdict = await guard
      .check({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        cwd: input.cwd,
        signal: options.signal,
      })
      .catch(() => ({ deny: guardDenial("a call that couldn't be checked") }));
    if (verdict === null) return { continue: true };
    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    });
    if ("deny" in verdict) return deny(verdict.deny);
    if (askPerson === undefined) return deny(guardDenial(verdict.reason));
    const answer = await askPerson({
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId,
      detail: verdict.ask,
      signal: options.signal,
    }).catch(() => "cancel" as const);
    if (answer !== "accept") return deny(guardDeclined(verdict.reason));
    // Allowed for this call: no second card from the chat's own mode.
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
        permissionDecisionReason: `The person allowed ${verdict.reason}.`,
      },
    };
  };
}
