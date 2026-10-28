import { describe, expect, it } from "vitest";

import { connectorAccessDecision } from "../assistants/localAssistantStore.ts";
import { remoteStarterOf, type IncomingRemoteChat } from "./remoteChatStore.ts";

const incoming: IncomingRemoteChat = {
  threadId: "remote-1",
  assistantName: "Ada",
  assistantProjectId: "assistant-ada",
  fromComputerName: "MacBook",
  fromBoxId: null,
  fromThreadId: "thread-ada",
  startedAt: "2026-10-28T12:00:00.000Z",
  apps: { restricted: true, permissions: { gmail: "read", notion: "none" } },
  preset: "helper",
};

const parents: Record<string, string | null> = {
  "remote-1": null,
  "child-1": "remote-1",
  "grandchild-1": "child-1",
  "mine-1": null,
};
const threadById = (id: string) =>
  id in parents ? { spawnedByThreadId: parents[id] ?? null } : undefined;

describe("remote starter of a chat", () => {
  it("the chat itself or a chat it started acts for the remote assistant", () => {
    expect(remoteStarterOf("remote-1", threadById, [incoming])).toBe(incoming);
    expect(remoteStarterOf("grandchild-1", threadById, [incoming])).toBe(incoming);
  });

  it("the person's own chats here are not limited", () => {
    expect(remoteStarterOf("mine-1", threadById, [incoming])).toBeNull();
    expect(remoteStarterOf("unknown", threadById, [incoming])).toBeNull();
  });

  it("its app levels hold here: read-only stays read-only, none stays none", () => {
    const apps = remoteStarterOf("child-1", threadById, [incoming])!.apps!;
    expect(connectorAccessDecision(apps, "gmail", false, "helper")).toBe("allow");
    expect(connectorAccessDecision(apps, "gmail", true, "helper")).not.toBe("allow");
    expect(connectorAccessDecision(apps, "notion", false, "helper")).not.toBe("allow");
    // A provider the person never set stays full access (decision 02.10).
    expect(connectorAccessDecision(apps, "github", true, "helper")).toBe("allow");
    // An Observer reads only, here too.
    expect(connectorAccessDecision(apps, "github", true, "observer")).toBe("read-only");
  });
});
