/**
 * The folder of a chat without a project: one per chat under `~/chats`, made
 * when the chat starts. A non-recursive mkdir claims the name, so two chats
 * can't end up sharing one.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { chatFolderName } from "@t3tools/shared/noProject";

const MAX_ATTEMPTS = 20;

const isTaken = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "EEXIST";

export async function claimChatFolder(input: {
  readonly root: string;
  readonly threadId: string;
  readonly text: string;
  readonly date?: string;
}): Promise<string> {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  await mkdir(input.root, { recursive: true });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const folder = path.join(
      input.root,
      chatFolderName({
        date,
        text: input.text,
        threadId: input.threadId,
        ...(attempt > 1 ? { extra: String(attempt) } : {}),
      }),
    );
    try {
      await mkdir(folder);
      return folder;
    } catch (error) {
      if (!isTaken(error)) throw error;
    }
  }
  throw new Error(`Every folder name for this chat is taken in ${input.root}.`);
}
