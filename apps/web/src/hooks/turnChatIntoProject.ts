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

export function chatProjectOffer(input: {
  readonly worktreePath: string | null;
  /** The git branch of a separate copy: that stays a copy of its project. */
  readonly branch: string | null;
  readonly projectRoot: string | null;
  readonly homeFolder: string | null;
  readonly isAssistantChat: boolean;
}): ChatProjectOffer | null {
  if (input.isAssistantChat || input.projectRoot === null) return null;
  const inOwnFolder =
    input.worktreePath !== null &&
    input.worktreePath !== input.projectRoot &&
    input.worktreePath !== input.homeFolder;
  if (inOwnFolder) return input.branch ? null : { kind: "own-folder", folder: input.worktreePath! };
  return input.projectRoot === input.homeFolder ? { kind: "pick-folder" } : null;
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
