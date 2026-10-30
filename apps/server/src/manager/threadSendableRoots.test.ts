import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { childFolders } from "./threadSendableRoots.ts";

const thread = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  projectId: "shop",
  updatedAt: "2026-10-30T10:00:00.000Z",
  worktreePath: null,
  spawnedByThreadId: null,
  assistantRole: null,
  ...over,
});

const snapshot = (threads: ReadonlyArray<unknown>) =>
  ({
    threads,
    projects: [
      { id: "shop", workspaceRoot: "/home/me/projects/shop" },
      { id: "assistant", workspaceRoot: "/home/me/.uno/assistant" },
    ],
  }) as never;

describe("childFolders", () => {
  const me = "me" as ThreadId;

  it("gives a chat the folders of the chats it started, newest first", () => {
    const folders = childFolders({
      snapshot: snapshot([
        thread("old", { spawnedByThreadId: "me" }),
        thread("new", {
          spawnedByThreadId: "me",
          worktreePath: "/home/me/wt/new",
          updatedAt: "2026-10-30T11:00:00.000Z",
        }),
        thread("other"),
      ]),
      threadId: me,
      assistantProjectId: null,
      startedBy: new Map(),
    });
    expect(folders).toEqual(["/home/me/wt/new", "/home/me/projects/shop"]);
  });

  it("gives an assistant's conversation every chat the assistant started", () => {
    const folders = childFolders({
      snapshot: snapshot([thread("mine", { assistantRole: "spawned" }), thread("person's own")]),
      threadId: me,
      assistantProjectId: "assistant",
      startedBy: new Map([["mine", "assistant"]]),
    });
    expect(folders).toEqual(["/home/me/projects/shop"]);
  });
});
