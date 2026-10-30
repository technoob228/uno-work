/**
 * "Turn into project": a chat that outgrew the home folder (or has a folder of
 * its own) becomes a project. Nothing moves: the chat keeps working where it
 * did, with its history; new chats of the project start in the project's folder.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";

import { ensureEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import { ensureFolderProjectOn } from "./useFolderChats";

export type ChatProjectOffer =
  /** In the home folder: the person picks the folder with the chat's work. */
  | { readonly kind: "pick-folder" }
  /** Already in a folder of its own: that folder becomes the project. */
  | { readonly kind: "own-folder"; readonly folder: string };

const withoutTrailingSlash = (path: string): string => path.replace(/\/+$/, "") || "/";

/** The daemon may give a folder with a trailing slash, projects never have one. */
export function isSameFolder(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  return withoutTrailingSlash(left) === withoutTrailingSlash(right);
}

export function chatProjectOffer(input: {
  readonly worktreePath: string | null;
  /** The git branch of a separate copy: that stays a copy of its project. */
  readonly branch: string | null;
  readonly projectRoot: string | null;
  readonly homeFolder: string | null;
  readonly isAssistantChat: boolean;
}): ChatProjectOffer | null {
  if (input.isAssistantChat || input.projectRoot === null) return null;
  const { worktreePath, projectRoot, homeFolder } = input;
  if (
    worktreePath !== null &&
    !isSameFolder(worktreePath, projectRoot) &&
    !isSameFolder(worktreePath, homeFolder)
  ) {
    return input.branch ? null : { kind: "own-folder", folder: worktreePath };
  }
  return isSameFolder(projectRoot, homeFolder) ? { kind: "pick-folder" } : null;
}

export async function turnChatIntoProject(
  threadRef: ScopedThreadRef,
  folder: string,
): Promise<void> {
  const projectRef = await ensureFolderProjectOn(threadRef.environmentId, folder);
  await ensureEnvironmentApi(threadRef.environmentId).orchestration.dispatchCommand({
    type: "thread.project.adopt",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    projectId: projectRef.projectId,
  });
}
