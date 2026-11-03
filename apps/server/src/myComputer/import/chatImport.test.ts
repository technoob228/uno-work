import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  SNOOZED_UNTIL_OPENED,
  type MyComputerChatHistory,
  type ThreadComputerSource,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MyComputerFailure, type MyComputerCore } from "../myComputerCore.ts";
import {
  createChatImport,
  importedThreadId,
  projectTitle,
  type ChatImport,
  type ImportCommand,
} from "./chatImport.ts";
import * as Access from "./computerAccess.ts";
import { claudeSession, fakeComputer, type FakeComputer } from "./fakeComputer.testkit.ts";

const HOME = "/Users/test";
const COMPUTER = "computer-1";
const NOW = new Date("2026-10-31T12:00:00.000Z");
const session = (n: number) => `${String(n).padStart(8, "0")}-2222-4333-8444-555555555555`;
const file = (n: number) => `${HOME}/.claude/projects/-a/${session(n)}.jsonl`;

interface FakeThread {
  title: string;
  snoozedUntil: string | null;
  source: ThreadComputerSource | null;
  createdAt: string;
}

describe("chat import", () => {
  let stateDir: string;
  let computer: FakeComputer;
  let threads: Map<string, FakeThread>;
  let projects: Map<string, string>;
  let commands: Array<ImportCommand>;
  let online: boolean;
  let chats: ChatImport;
  let notes: Array<string>;

  const makeImport = () =>
    createChatImport({
      stateDir,
      baseDir: stateDir,
      core: {
        status: async () => ({
          enabled: true,
          computers: online
            ? [
                {
                  id: COMPUTER,
                  name: "Kate's MacBook",
                  online,
                  os: "darwin",
                  arch: "arm64",
                  lastSeenAt: null,
                  helperVersion: null,
                },
              ]
            : [],
        }),
        note: async (_id: string, _kind: string, summary: string) => {
          notes.push(summary);
        },
      } as unknown as MyComputerCore,
      now: () => NOW,
      dispatch: async (command) => {
        commands.push(command);
        switch (command.type) {
          case "project.create":
            projects.set(command.projectId, command.title);
            break;
          case "thread.create":
            threads.set(command.threadId, {
              title: command.title,
              snoozedUntil: null,
              source: command.source ?? null,
              createdAt: command.createdAt,
            });
            break;
          case "thread.snooze":
            threads.get(command.threadId)!.snoozedUntil = command.snoozedUntil;
            break;
          case "thread.unsnooze":
            threads.get(command.threadId)!.snoozedUntil = null;
            break;
          case "thread.source.update": {
            const thread = threads.get(command.threadId)!;
            thread.source = command.source;
            if (command.title !== undefined) thread.title = command.title;
            break;
          }
        }
      },
      getThread: async (threadId) => threads.get(threadId) ?? null,
      projectExists: async (projectId) => projects.has(projectId),
    });

  const settled = async (state: "ready" | "done" | "failed") => {
    await vi.waitFor(async () => {
      expect((await chats.status(COMPUTER)).state).toBe(state);
    });
    return chats.status(COMPUTER);
  };

  const scanned = async () => {
    await chats.scan(COMPUTER);
    return settled("ready");
  };

  const imported = async () => {
    await scanned();
    await chats.start(COMPUTER, ["claude", "codex", "opencode"]);
    return settled("done");
  };

  const put = (n: number, options: Parameters<typeof claudeSession>[0], mtime?: string) => {
    computer.files.set(file(n), {
      data: Buffer.from(claudeSession({ sessionId: session(n), ...options })),
      mtime: mtime ?? "2026-10-31T10:00:00Z",
    });
  };

  beforeEach(async () => {
    stateDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), "chat-import-"));
    computer = fakeComputer({ home: HOME });
    threads = new Map();
    projects = new Map();
    commands = [];
    notes = [];
    online = true;
    vi.spyOn(Access, "computerAccess").mockImplementation(() => computer.access);
    chats = makeImport();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Fs.rm(stateDir, { recursive: true, force: true });
  });

  it("offers what it found and imports nothing by itself", async () => {
    put(1, { at: "2026-10-31T10:00:00.000Z" });
    put(2, { at: "2026-10-20T10:00:00.000Z", cwd: "/Users/test/projects/other" });
    const status = await scanned();
    expect(status.tools).toEqual([
      {
        id: "claude",
        name: "Claude Code",
        chats: 2,
        newChats: 2,
        projects: 2,
        available: true,
        unavailableReason: null,
      },
    ]);
    expect(commands).toEqual([]);
    // Nothing on disk until the person agrees.
    await expect(
      Fs.access(Path.join(stateDir, "my-computer", COMPUTER, "import.json")),
    ).rejects.toThrow();
    expect(notes).toEqual([expect.stringContaining("session files")]);
  });

  it("imports through the ordinary commands, older chats Snoozed until opened", async () => {
    put(1, { at: "2026-10-31T10:00:00.000Z" });
    put(2, { at: "2026-10-20T10:00:00.000Z", prompt: "An old question" });
    put(3, { at: "2026-10-31T09:00:00.000Z", cwd: "/Users/test/projects/other" });
    const status = await imported();

    expect(status.result).toEqual({ imported: 3, recent: 2, snoozed: 1, failed: 0 });
    expect(status.importedChats).toBe(3);
    expect(status.importedProjects).toBe(2);
    expect([...projects.values()].toSorted()).toEqual(["alpha", "other"]);
    // Each project stands for its folder on the computer: new turns run there.
    expect(
      commands
        .flatMap((command) => (command.type === "project.create" ? [command.computer] : []))
        .toSorted((a, b) => (a?.path ?? "").localeCompare(b?.path ?? "")),
    ).toEqual([
      { computerId: COMPUTER, computerName: "Kate's MacBook", path: "/Users/test/projects/alpha" },
      { computerId: COMPUTER, computerName: "Kate's MacBook", path: "/Users/test/projects/other" },
    ]);

    const old = threads.get(importedThreadId(COMPUTER, "claude", session(2)))!;
    expect(old.title).toBe("An old question");
    expect(old.snoozedUntil).toBe(SNOOZED_UNTIL_OPENED);
    expect(old.createdAt).toBe("2026-10-20T10:00:00.000Z");
    expect(old.source).toMatchObject({
      kind: "computer",
      computerId: COMPUTER,
      computerName: "Kate's MacBook",
      tool: "claude",
      sessionId: session(2),
      path: file(2),
      cwd: "/Users/test/projects/alpha",
      lastActiveAt: "2026-10-20T10:00:00.000Z",
    });
    expect(threads.get(importedThreadId(COMPUTER, "claude", session(1)))?.snoozedUntil).toBeNull();
  });

  it("counts only the new chats and their projects in the next offer", async () => {
    put(1, { at: "2026-10-31T10:00:00.000Z" });
    await imported();
    put(2, { at: "2026-10-31T11:00:00.000Z", cwd: "/Users/test/projects/other" });
    const status = await scanned();

    expect(status.tools).toEqual([
      expect.objectContaining({ id: "claude", chats: 2, newChats: 1, projects: 1 }),
    ]);
  });

  it("imports only the programs the person chose", async () => {
    put(1, {});
    await scanned();
    await chats.start(COMPUTER, ["codex"]);
    const status = await settled("done");
    expect(status.result?.imported).toBe(0);
    expect(threads.size).toBe(0);
  });

  it("creates nothing twice, even from a fresh start of the daemon", async () => {
    put(1, { at: "2026-10-31T10:00:00.000Z" });
    await imported();
    const created = commands.length;

    chats = makeImport();
    const again = await scanned();
    expect(again.tools[0]).toMatchObject({ chats: 1, newChats: 0 });
    await chats.start(COMPUTER, ["claude"]);
    await settled("done");
    expect(commands.length).toBe(created);
  });

  it("finishes the job when the daemon died before saving", async () => {
    put(1, { at: "2026-10-31T10:00:00.000Z" });
    await imported();
    await Fs.rm(Path.join(stateDir, "my-computer"), { recursive: true });
    const created = commands.filter((command) => command.type === "thread.create").length;

    chats = makeImport();
    await imported();
    expect(commands.filter((command) => command.type === "thread.create")).toHaveLength(created);
  });

  it("does not read again what it already imported", async () => {
    put(1, {});
    await imported();
    computer.reads.length = 0;
    await scanned();
    expect(computer.reads).toEqual([]);
  });

  it("follows a chat that changed, and wakes it from Snoozed", async () => {
    put(1, { at: "2026-10-20T10:00:00.000Z", prompt: "Old title" });
    await imported();
    const id = importedThreadId(COMPUTER, "claude", session(1));
    expect(threads.get(id)?.snoozedUntil).toBe(SNOOZED_UNTIL_OPENED);

    put(1, { at: "2026-10-31T11:00:00.000Z", prompt: "New title" }, "2026-10-31T11:00:00Z");
    await scanned();
    expect(threads.get(id)).toMatchObject({ title: "New title", snoozedUntil: null });
    expect(threads.get(id)?.source?.lastActiveAt).toBe("2026-10-31T11:00:00.000Z");
    expect(threads.size).toBe(1);
  });

  it("keeps a title the person changed", async () => {
    put(1, { at: "2026-10-31T10:00:00.000Z", prompt: "Their title" });
    await imported();
    const id = importedThreadId(COMPUTER, "claude", session(1));
    threads.get(id)!.title = "My own name";

    put(1, { at: "2026-10-31T11:00:00.000Z", prompt: "Changed there" }, "2026-10-31T11:00:00Z");
    await scanned();
    expect(threads.get(id)?.title).toBe("My own name");
  });

  it("does not bring back a chat the person deleted", async () => {
    put(1, { at: "2026-10-31T10:00:00.000Z" });
    await imported();
    threads.clear();

    put(1, { at: "2026-10-31T11:00:00.000Z" }, "2026-10-31T11:00:00Z");
    const status = await scanned();
    expect(status.tools[0]?.newChats).toBe(0);
    await chats.start(COMPUTER, ["claude"]);
    await settled("done");
    expect(threads.size).toBe(0);
  });

  it("offers new chats on a second scan, and only those", async () => {
    put(1, { at: "2026-10-31T10:00:00.000Z" });
    await imported();
    put(2, { at: "2026-10-31T11:00:00.000Z" });
    const status = await scanned();
    expect(status.tools[0]).toMatchObject({ chats: 2, newChats: 1 });
    expect(threads.size).toBe(1);
    await chats.start(COMPUTER, ["claude"]);
    expect((await settled("done")).result?.imported).toBe(1);
    expect(threads.size).toBe(2);
  });

  it("remembers a no, and takes it back when the person imports", async () => {
    put(1, {});
    await scanned();
    expect((await chats.decline(COMPUTER)).declined).toBe(true);
    chats = makeImport();
    expect((await chats.status(COMPUTER)).declined).toBe(true);
    const status = await imported();
    expect(status.declined).toBe(false);
  });

  it("carries on past a chat that fails", async () => {
    put(1, { at: "2026-10-31T10:00:00.000Z" });
    put(2, { at: "2026-10-31T09:00:00.000Z" });
    const failing = createChatImport({
      stateDir,
      baseDir: stateDir,
      core: {
        status: async () => ({ enabled: true, computers: [] }),
        note: async () => undefined,
      } as unknown as MyComputerCore,
      now: () => NOW,
      dispatch: async (command) => {
        if (command.type === "thread.create" && command.title !== undefined) {
          throw new Error("refused");
        }
        if (command.type === "project.create") projects.set(command.projectId, command.title);
      },
      getThread: async () => null,
      projectExists: async (projectId) => projects.has(projectId),
    });
    chats = failing;
    const status = await imported();
    expect(status.result).toMatchObject({ imported: 0, failed: 2 });
  });

  it("tells the person when the computer stops answering", async () => {
    put(1, {});
    computer.asleep = true;
    await chats.scan(COMPUTER);
    const status = await settled("failed");
    expect(status.message).toMatch(/stopped answering/);
  });

  describe("history", () => {
    const history = async (n: number): Promise<MyComputerChatHistory> =>
      chats.history(importedThreadId(COMPUTER, "claude", session(n)));

    it("loads a chat when it is opened, and keeps a copy", async () => {
      put(1, { prompt: "My question", reply: "The answer" });
      await imported();
      computer.reads.length = 0;

      const first = await history(1);
      expect(first).toMatchObject({ kind: "ready", stale: false, truncated: false });
      expect(first.kind === "ready" && first.messages.map((message) => message.text)).toEqual([
        "My question",
        "The answer",
      ]);
      expect(computer.reads.length).toBeGreaterThan(0);

      computer.reads.length = 0;
      expect(await history(1)).toMatchObject({ kind: "ready", stale: false });
      expect(computer.reads).toEqual([]);

      const cache = Path.join(stateDir, "my-computer", COMPUTER, "history");
      const [name] = await Fs.readdir(cache);
      const { mode } = await Fs.stat(Path.join(cache, name!));
      expect(mode & 0o777).toBe(0o600);
    });

    it("reads again when the chat changed on the computer", async () => {
      put(1, { prompt: "First" });
      await imported();
      await history(1);
      put(1, { prompt: "Second" }, "2026-10-31T11:30:00Z");
      const next = await history(1);
      expect(next.kind === "ready" && next.messages[0]?.text).toBe("Second");
    });

    it("says the computer is offline, or shows the copy if there is one", async () => {
      put(1, {});
      put(2, {});
      await imported();
      await history(1);
      online = false;
      expect(await history(1)).toMatchObject({ kind: "ready", stale: true });
      expect(await history(2)).toEqual({ kind: "offline", computerName: "Kate's MacBook" });
    });

    it("says so when the computer falls asleep mid-way", async () => {
      put(1, {});
      await imported();
      computer.asleep = true;
      expect(await history(1)).toMatchObject({ kind: "offline" });
    });

    it("says the chat is gone when the file is", async () => {
      put(1, {});
      put(2, {});
      await imported();
      await history(1);
      computer.files.delete(file(1));
      computer.files.delete(file(2));
      expect(await history(2)).toEqual({ kind: "gone" });
      expect(await history(1)).toMatchObject({ kind: "ready", stale: true });
    });

    it("refuses a symlink put in a session's place", async () => {
      put(1, {});
      await imported();
      computer.files.set(file(1), { data: Buffer.from("x"), mtime: "x", type: "symlink" });
      expect(await history(1)).toEqual({ kind: "gone" });
    });

    it("does not read a path off the allow-list, whatever the record says", async () => {
      put(1, {});
      await imported();
      const id = importedThreadId(COMPUTER, "claude", session(1));
      threads.get(id)!.source = {
        ...threads.get(id)!.source!,
        path: `${HOME}/.claude/.credentials.json`,
      };
      computer.files.set(`${HOME}/.claude/.credentials.json`, {
        data: Buffer.from("SECRET"),
        mtime: "x",
      });
      computer.reads.length = 0;
      expect(await history(1)).toEqual({ kind: "gone" });
      expect(computer.reads).toEqual([]);
    });
  });
});

describe("projectTitle", () => {
  it("takes the last folder of any system's path", () => {
    expect(projectTitle("/Users/kate/projects/alpha")).toBe("alpha");
    expect(projectTitle("/Users/kate/projects/alpha/")).toBe("alpha");
    expect(projectTitle("C:\\Users\\kate\\beta")).toBe("beta");
    expect(projectTitle(null)).toBe("Other chats");
  });
});

describe("computer failures", () => {
  it("tell a missing file from a sleeping computer", () => {
    const missing = new MyComputerFailure(
      "remote",
      "The computer answered: No such file or folder: /x",
    );
    expect(Access.isMissingFile(missing)).toBe(true);
    expect(Access.isFileFailure(new MyComputerFailure("timeout", "No answer."))).toBe(false);
  });
});
