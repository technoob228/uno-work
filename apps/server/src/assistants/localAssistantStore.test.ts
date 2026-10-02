import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { connectorMcpTool, type UnoWorkToolDeps } from "../unoWork/tools.ts";
import {
  connectorAccessDecision,
  dropDeletedAssistant,
  isPastKeep,
  keepUntil,
  normalizePermissions,
  owningAssistant,
  putDeletedAssistant,
  readAppAccess,
  readDeletedAssistants,
  readProfile,
  readStartedChats,
  recordStartedChat,
  writeAppAccess,
  writeProfile,
  type OwnedThread,
} from "./localAssistantStore.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "uno-local-assistants-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("apps an assistant of this computer may open", () => {
  it("allows everything until the person sets anything (full access by default)", async () => {
    const stateDir = tempDir();
    const access = await readAppAccess(stateDir, "assistant-ana");
    expect(access).toEqual({ permissions: {}, restricted: false });
    expect(connectorAccessDecision(access, "gmail", true)).toBe("allow");
  });

  it("stores the person's levels and decides per call", async () => {
    const stateDir = tempDir();
    await writeAppAccess(stateDir, "assistant-ana", {
      gmail: "none",
      notion: "read",
      github: "write",
    });
    const access = await readAppAccess(stateDir, "assistant-ana");
    expect(access.restricted).toBe(true);
    expect(connectorAccessDecision(access, "gmail", false)).toBe("none");
    expect(connectorAccessDecision(access, "notion", false)).toBe("allow");
    expect(connectorAccessDecision(access, "notion", true)).toBe("read-only");
    expect(connectorAccessDecision(access, "github", true)).toBe("allow");
    // A provider the person didn't set stays allowed.
    expect(connectorAccessDecision(access, "google-drive", true)).toBe("allow");
    // Another assistant of the computer has its own file.
    expect((await readAppAccess(stateDir, "assistant-bob")).restricted).toBe(false);
  });

  it("drops unknown levels and odd provider names", () => {
    expect(
      normalizePermissions({ gmail: "read", "../x": "none", notion: "admin", github: 3 }),
    ).toEqual({ gmail: "read" });
  });
});

describe("which assistant a chat belongs to", () => {
  const threads: ReadonlyArray<OwnedThread> = [
    { id: "ana-chat", projectId: "assistant-ana" },
    { id: "spawned-by-ana", projectId: "project-site", assistantRole: "spawned" },
    { id: "legacy-spawned", projectId: "project-site", assistantRole: "spawned" },
    { id: "child-of-ana", projectId: "project-site", spawnedByThreadId: "ana-chat" },
    { id: "grandchild", projectId: "project-api", spawnedByThreadId: "spawned-by-ana" },
    { id: "mine", projectId: "project-site" },
  ];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const find = (id: string) => byId.get(id);
  const ledger = new Map([["spawned-by-ana", "assistant-ana"]]);
  const owner = (id: string) => owningAssistant(byId.get(id)!, find, ledger);

  it("follows the workspace, the ledger and the parent chain", () => {
    expect(owner("ana-chat")).toBe("assistant-ana");
    expect(owner("spawned-by-ana")).toBe("assistant-ana");
    // Before the ledger only the default assistant started chats.
    expect(owner("legacy-spawned")).toBe("assistant-home");
    expect(owner("child-of-ana")).toBe("assistant-ana");
    expect(owner("grandchild")).toBe("assistant-ana");
    expect(owner("mine")).toBeNull();
  });

  it("keeps the ledger on disk", async () => {
    const stateDir = tempDir();
    await Promise.all([
      recordStartedChat(stateDir, "t1", "assistant-ana"),
      recordStartedChat(stateDir, "t2", "assistant-bob"),
    ]);
    expect([...(await readStartedChats(stateDir)).entries()].toSorted()).toEqual([
      ["t1", "assistant-ana"],
      ["t2", "assistant-bob"],
    ]);
  });
});

describe("deleted assistants and profiles", () => {
  it("keeps a deleted assistant 7 days", async () => {
    const stateDir = tempDir();
    const deletedAt = "2026-10-02T10:00:00.000Z";
    await putDeletedAssistant(stateDir, {
      projectId: "assistant-ana",
      title: "Ana",
      emoji: "🦊",
      deletedAt,
      workspaceRoot: "/home/u/UnoWork/Assistants/ana",
      trashPath: "/home/u/UnoWork/Assistants/.trash/ana__x",
      connectorRows: [],
      bindings: [],
      archivedThreadIds: ["t1"],
    });
    expect((await readDeletedAssistants(stateDir)).map((record) => record.title)).toEqual(["Ana"]);
    expect(keepUntil(deletedAt)).toBe("2026-10-09T10:00:00.000Z");
    expect(isPastKeep({ deletedAt }, new Date("2026-10-09T09:59:00.000Z"))).toBe(false);
    expect(isPastKeep({ deletedAt }, new Date("2026-10-09T10:00:00.000Z"))).toBe(true);
    await dropDeletedAssistant(stateDir, "assistant-ana");
    expect(await readDeletedAssistants(stateDir)).toEqual([]);
  });

  it("round-trips the profile in the assistant's folder", async () => {
    const root = tempDir();
    expect(await readProfile(root)).toBeNull();
    await writeProfile(root, { emoji: "📣", template: "marketing", createdAt: "2026-10-02" });
    expect(await readProfile(root)).toEqual({
      emoji: "📣",
      template: "marketing",
      createdAt: "2026-10-02",
    });
  });
});

describe("Work refuses an app the assistant may not open", () => {
  const gmailSend = connectorMcpTool({
    name: "gmail_send",
    description: "Send an email",
    inputSchema: { type: "object" },
    provider: "gmail",
    providerName: "Gmail & Calendar",
  });
  const depsWith = (decision: "allow" | "none" | "read-only", calls: string[]) =>
    ({
      caller: {
        threadId: "ana-chat",
        threadTitle: "Ana",
        runtimeMode: "full-access",
        cwd: undefined,
      },
      connectors: {
        call: (input: { tool: string }) =>
          Effect.sync(() => {
            calls.push(input.tool);
            return { content: [{ type: "text", text: "sent" }], isError: false };
          }),
        access: () => Effect.succeed({ decision, assistant: "Ana" }),
      },
    }) as unknown as UnoWorkToolDeps;

  it("never reaches the console for a forbidden app", async () => {
    const calls: string[] = [];
    const error = await Effect.runPromise(Effect.flip(gmailSend.run(depsWith("none", calls), {})));
    expect(error.message).toContain("Ana isn't allowed to open Gmail & Calendar");
    expect(calls).toEqual([]);
  });

  it("lets only reading through on read access", async () => {
    const calls: string[] = [];
    const error = await Effect.runPromise(
      Effect.flip(gmailSend.run(depsWith("read-only", calls), {})),
    );
    expect(error.message).toContain("may only read");
    expect(calls).toEqual([]);
  });

  it("calls the app when allowed", async () => {
    const calls: string[] = [];
    await Effect.runPromise(gmailSend.run(depsWith("allow", calls), {}));
    expect(calls).toEqual(["gmail_send"]);
  });
});
