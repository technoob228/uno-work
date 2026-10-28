/**
 * The rules of the assistant sandbox (assistantSandboxPolicy.ts runs them):
 * who is sandboxed, what the sandbox lets in, what is refused and how it is
 * said. Pure — no I/O, unit-tested directly.
 *
 * @module assistants/assistantSandboxRules
 */
import * as nodePath from "node:path";

import type { ManagerProjectAllowlist } from "@t3tools/contracts";

import type { HarnessSandboxDecision } from "../provider/Services/HarnessSandboxPolicy.ts";
import { isSameOrInside, isStrictlyInside } from "../sandbox/harnessSandbox.ts";
import type { AssistantSandboxCapability } from "../sandbox/sandboxCapability.ts";
import type { AssistantAccessView } from "./assistantAccess.ts";

/** Said when "Only selected projects" is set where the sandbox can't run. */
export const ASSISTANT_SANDBOX_REQUIRED_MESSAGE =
  "Only selected projects needs its own computer or a cloud computer. On this computer an assistant works with All projects.";

/** Said when a restricted assistant's chat would run where the sandbox can't. */
export const ASSISTANT_SANDBOX_UNAVAILABLE_RUN_MESSAGE =
  "This assistant works only in its selected projects, and this computer can't hold it to them (Only selected projects needs its own computer or a cloud computer). Give it All projects on its page, or move it to a cloud computer.";

export const ASSISTANT_SANDBOX_PROJECT_GONE_MESSAGE =
  "This chat is in a project the assistant may no longer use. Add the project to the assistant's projects, or continue in another chat.";

export const ASSISTANT_SANDBOX_UNSAFE_FOLDER_MESSAGE =
  "One of this assistant's projects is a folder that holds the whole home folder or Uno Work's own data, so it can't be limited to it. Remove that project from the assistant, or give it All projects.";

export const ASSISTANT_SANDBOX_CHECK_FAILED_MESSAGE =
  "Couldn't check what this assistant may see, so the chat didn't start. Try again in a moment.";

/** Restricted = anything but "all" (its own folder is always in the list). */
export function isRestrictedAllowlist(allowlist: ManagerProjectAllowlist | "all"): boolean {
  return allowlist !== "all";
}

/** The grant-time check: restricted projects only where the sandbox runs. */
export function assistantSandboxGrantDenial(
  projects: "all" | ReadonlyArray<string>,
  sandboxAvailable: boolean,
): string | null {
  return projects !== "all" && !sandboxAvailable ? ASSISTANT_SANDBOX_REQUIRED_MESSAGE : null;
}

export interface SandboxDecisionInput {
  /** The assistant the chat belongs to, or null for the person's own chats. */
  readonly owner: Pick<AssistantAccessView, "projectId" | "allowlist"> | null;
  /** The chat's project. */
  readonly threadProjectId: string | null;
  /** The chat's working folder (its project folder or worktree). */
  readonly cwd: string | undefined;
  /** Every project on this computer (assistants' folders included). */
  readonly projects: ReadonlyArray<{ readonly id: string; readonly workspaceRoot: string }>;
  readonly home: string;
  /** Uno Work's own data (state dir, base dir): never a writable folder. */
  readonly daemonDirs: ReadonlyArray<string>;
  /** Where chats' worktrees live (inside the daemon's data, but the chat's own). */
  readonly worktreesDir: string;
  readonly capability: AssistantSandboxCapability;
  /** Host folder for the assistant's private /tmp. */
  readonly tmpRoot: string;
}

/**
 * A writable folder that would open up more than a project: the root, the
 * home (or a folder holding it), Uno Work's own data (except worktrees).
 */
export function isUnsafeWritableDir(
  dir: string,
  input: Pick<SandboxDecisionInput, "home" | "daemonDirs" | "worktreesDir">,
): boolean {
  const resolved = nodePath.resolve(dir);
  if (resolved === nodePath.parse(resolved).root) return true;
  if (isSameOrInside(input.home, resolved)) return true;
  for (const daemonDir of input.daemonDirs) {
    if (isSameOrInside(daemonDir, resolved)) return true;
    if (isSameOrInside(resolved, daemonDir) && !isStrictlyInside(resolved, input.worktreesDir)) {
      return true;
    }
  }
  return false;
}

/** The decision for one chat. Pure: everything it reads is in `input`. */
export function decideAssistantSandbox(input: SandboxDecisionInput): HarnessSandboxDecision {
  const { owner } = input;
  if (owner === null || !isRestrictedAllowlist(owner.allowlist)) return { _tag: "none" };
  if (!input.capability.available || input.capability.bwrapPath === null) {
    return { _tag: "refuse", message: ASSISTANT_SANDBOX_UNAVAILABLE_RUN_MESSAGE };
  }
  const allowed = new Set<string>([
    owner.projectId,
    ...(owner.allowlist === "all" ? [] : owner.allowlist),
  ]);
  if (input.threadProjectId === null || !allowed.has(input.threadProjectId)) {
    return { _tag: "refuse", message: ASSISTANT_SANDBOX_PROJECT_GONE_MESSAGE };
  }
  const rootOf = new Map(input.projects.map((project) => [project.id, project.workspaceRoot]));
  const assistantDir = rootOf.get(owner.projectId);
  const threadRoot = rootOf.get(input.threadProjectId);
  if (assistantDir === undefined || threadRoot === undefined) {
    return { _tag: "refuse", message: ASSISTANT_SANDBOX_PROJECT_GONE_MESSAGE };
  }
  const cwd = nodePath.resolve(input.cwd ?? threadRoot);
  const allowedRoots = [...allowed].flatMap((id) => {
    const root = rootOf.get(id);
    return root === undefined ? [] : [nodePath.resolve(root)];
  });
  const writableDirs = [...new Set([nodePath.resolve(assistantDir), ...allowedRoots, cwd])];
  if (writableDirs.some((dir) => isUnsafeWritableDir(dir, input))) {
    return { _tag: "refuse", message: ASSISTANT_SANDBOX_UNSAFE_FOLDER_MESSAGE };
  }
  // Only the hidden folders that matter: nested inside a writable one.
  const hiddenDirs = [
    ...new Set(
      input.projects
        .filter((project) => !allowed.has(project.id))
        .map((project) => nodePath.resolve(project.workspaceRoot))
        .filter(
          (root) =>
            !writableDirs.includes(root) && writableDirs.some((dir) => isStrictlyInside(root, dir)),
        ),
    ),
  ].toSorted();
  return {
    _tag: "sandbox",
    plan: {
      bwrapPath: input.capability.bwrapPath,
      ...(input.capability.launcher && input.capability.launcher.length > 0
        ? { launcher: input.capability.launcher }
        : {}),
      home: nodePath.resolve(input.home),
      cwd,
      writableDirs,
      hiddenDirs,
      tmpDir: nodePath.join(input.tmpRoot, encodeURIComponent(owner.projectId)),
      assistantProjectId: owner.projectId,
    },
  };
}
