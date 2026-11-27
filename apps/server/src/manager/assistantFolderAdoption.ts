/**
 * Pieces of assistant folder adoption (`~/UnoWork/Assistants/<folder>` →
 * an assistant project) kept apart from the service so they can be tested:
 * the project id a folder maps to, the "project already exists" outcome
 * adoption treats as settled, and the limiter that keeps one stuck folder
 * from logging a full stack on every scan.
 */
import { ASSISTANT_PROJECT_ID_PREFIX } from "@t3tools/contracts";
import { Schema } from "effect";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";

/**
 * The id base for a folder already slugified: a folder named by an older
 * convention already carries the project id prefix (`assistant-a4e99f`, from
 * before `defaultWorkspaceRootFor` stripped it). Re-prefixing such a name
 * doubled it into `assistant-assistant-a4e99f`.
 */
export function assistantFolderIdBase(slugifiedFolderName: string): string {
  return slugifiedFolderName.startsWith(ASSISTANT_PROJECT_ID_PREFIX)
    ? slugifiedFolderName.slice(ASSISTANT_PROJECT_ID_PREFIX.length)
    : slugifiedFolderName;
}

const isInvariant = Schema.is(OrchestrationCommandInvariantError);

/**
 * True when `project.create` was refused because a project under this id is
 * already in the orchestration read model — including a deleted one, which
 * `getProjectShellById` does not see. Looks one `cause` deep: the assistant
 * service wraps what it can't name in its own error.
 */
export function isProjectAlreadyExists(cause: unknown, projectId: string): boolean {
  const matches = (value: unknown) =>
    isInvariant(value) &&
    value.commandType === "project.create" &&
    value.detail.includes(`'${projectId}' already exists`);
  if (matches(cause)) return true;
  const inner =
    typeof cause === "object" && cause !== null && "cause" in cause
      ? (cause as { readonly cause?: unknown }).cause
      : undefined;
  return matches(inner);
}

export const ADOPTION_FAILURE_LOG_INTERVAL_MS = 30 * 60_000;

/**
 * A folder whose adoption keeps failing the same way is retried on every
 * scan (scans ride on every `listAssistants` call, several a minute). Log it
 * in full once per interval, with how many failures were not logged since.
 */
export function makeAdoptionFailureLimiter(intervalMs = ADOPTION_FAILURE_LOG_INTERVAL_MS) {
  const seen = new Map<string, { count: number; lastLoggedAt: number }>();
  return (
    dir: string,
    now: number,
  ): { readonly log: true; readonly failuresSinceLastLog: number } | { readonly log: false } => {
    const entry = seen.get(dir);
    const failuresSinceLastLog = (entry?.count ?? 0) + 1;
    if (entry && now - entry.lastLoggedAt < intervalMs) {
      seen.set(dir, { count: failuresSinceLastLog, lastLoggedAt: entry.lastLoggedAt });
      return { log: false };
    }
    seen.set(dir, { count: 0, lastLoggedAt: now });
    return { log: true, failuresSinceLastLog };
  };
}
