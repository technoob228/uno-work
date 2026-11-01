import { zstdCompressSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { decompressZstd, scanComputer, type ScanResult } from "./chatScan.ts";
import {
  claudeSession,
  codexSession,
  fakeComputer,
  probeOutput,
  type FakeComputer,
} from "./fakeComputer.testkit.ts";

const HOME = "/Users/test";
const session = (n: number) => `${String(n).padStart(8, "0")}-2222-4333-8444-555555555555`;
const claudeFile = (folder: string, id: string) => `${HOME}/.claude/projects/${folder}/${id}.jsonl`;
const codexFile = (id: string, day = "2026/10/29") => {
  const stamp = `${day.replaceAll("/", "-")}T10-00-00`;
  return `${HOME}/.codex/sessions/${day}/rollout-${stamp}-${id}.jsonl`;
};

const scan = (computer: FakeComputer, onProgress = vi.fn()): Promise<ScanResult> =>
  scanComputer({ access: computer.access, known: () => null, onProgress });

const toolOf = (result: ScanResult, tool: string) =>
  result.tools.find((item) => item.tool === tool)!;

describe("scanComputer", () => {
  it("finds chats in the three programs' files and folders", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: {
        [claudeFile("-Users-test-alpha", session(1))]: claudeSession({ sessionId: session(1) }),
        [claudeFile("-Users-test-alpha", session(2))]: claudeSession({ sessionId: session(2) }),
        [codexFile(session(3))]: codexSession({ id: session(3) }),
      },
    });
    const result = await scan(computer);
    expect(toolOf(result, "claude").chats).toHaveLength(2);
    expect(toolOf(result, "codex").chats).toHaveLength(1);
    expect(toolOf(result, "codex").chats[0]).toMatchObject({
      sessionId: session(3),
      title: "Write the release notes",
      cwd: "/Users/test/projects/beta",
      titled: true,
    });
    expect(result.skipped).toEqual({ unreadable: 0, unknownFormat: 0 });
  });

  it("follows the folders the shell names", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: {
        [`/data/cc/projects/-x/${session(1)}.jsonl`]: claudeSession({ sessionId: session(1) }),
        [`/data/cx/sessions/2026/10/29/rollout-2026-10-29T10-00-00-${session(2)}.jsonl`]:
          codexSession({ id: session(2) }),
      },
    });
    computer.exec = () => ({
      exitCode: 0,
      text: probeOutput({ claude: "/data/cc", codex: "/data/cx" }),
    });
    const result = await scan(computer);
    expect(toolOf(result, "claude").chats).toHaveLength(1);
    expect(toolOf(result, "codex").chats).toHaveLength(1);
  });

  it("never touches logins or anything else next to the sessions", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: {
        [claudeFile("-a", session(1))]: claudeSession({ sessionId: session(1) }),
        [`${HOME}/.claude/.credentials.json`]: "SECRET",
        [`${HOME}/.claude/projects/-a/.credentials.json`]: "SECRET",
        [`${HOME}/.claude/projects/-a/memory/note.md`]: "private",
        [`${HOME}/.claude/projects/-a/${session(1)}/subagents/a.jsonl`]: "{}",
        [`${HOME}/.codex/auth.json`]: "SECRET",
        [`${HOME}/.local/share/opencode/auth.json`]: "SECRET",
      },
    });
    await scan(computer);
    expect(computer.reads.map((read) => read.path)).toEqual([claudeFile("-a", session(1))]);
  });

  it("skips a symlink dressed as a session", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: {
        [claudeFile("-a", session(1))]: {
          data: Buffer.from("SECRET"),
          type: "symlink",
        },
      },
    });
    const result = await scan(computer);
    expect(computer.reads).toEqual([]);
    expect(toolOf(result, "claude").chats).toEqual([]);
  });

  it("reads only the start and the end of a big file", async () => {
    const size = 40 * 1024 * 1024;
    const big = Buffer.alloc(size, "x");
    const start = claudeSession({ sessionId: session(1) });
    big.write(start, 0);
    big[start.length] = 10;
    const ending = `\n${JSON.stringify({
      type: "user",
      uuid: "u9",
      sessionId: session(1),
      timestamp: "2026-10-30T09:00:00.000Z",
      message: { content: "Last question" },
    })}\n`;
    big.write(ending, size - Buffer.byteLength(ending));
    const computer = fakeComputer({
      home: HOME,
      files: { [claudeFile("-a", session(1))]: big },
    });
    const result = await scan(computer);
    const bytes = computer.reads.reduce((sum, read) => sum + read.bytes, 0);
    expect(bytes).toBeLessThanOrEqual(96 * 1024);
    expect(toolOf(result, "claude").chats[0]?.lastActiveAt).toBe("2026-10-30T09:00:00.000Z");
  });

  it("counts broken and unknown files and goes on", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: {
        [claudeFile("-a", session(1))]: claudeSession({ sessionId: session(1) }),
        [claudeFile("-a", session(2))]: Buffer.from([0, 1, 2, 3, 255, 254]),
        [claudeFile("-a", session(3))]: '{"format":"from the future"}\n',
        [codexFile(session(4))]: "garbage",
        [claudeFile("-a", session(5))]: "",
      },
    });
    const result = await scan(computer);
    expect(toolOf(result, "claude").chats).toHaveLength(1);
    expect(result.skipped).toEqual({ unreadable: 3, unknownFormat: 1 });
  });

  it("reads a compressed Codex session, and counts a broken one", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: {
        [`${codexFile(session(1))}.zst`]: zstdCompressSync(
          Buffer.from(codexSession({ id: session(1) })),
        ),
        [`${codexFile(session(2))}.zst`]: Buffer.from("not zstd"),
      },
    });
    const result = await scan(computer);
    expect(toolOf(result, "codex").chats.map((chat) => chat.sessionId)).toEqual([session(1)]);
    expect(result.skipped.unreadable).toBe(1);
    await expect(decompressZstd(zstdCompressSync(Buffer.from("round trip")))).resolves.toEqual(
      Buffer.from("round trip"),
    );
  });

  it("keeps the newest file of a resumed Codex thread", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: {
        [codexFile(session(1), "2026/10/28")]: codexSession({ id: session(1), prompt: "Old" }),
      },
    });
    computer.files.set(codexFile(session(1), "2026/10/29"), {
      data: Buffer.from(codexSession({ id: session(1), prompt: "New" })),
      mtime: "2026-10-31T10:00:00Z",
    });
    const result = await scan(computer);
    expect(toolOf(result, "codex").chats.map((chat) => chat.title)).toEqual(["New"]);
  });

  it("does not read again what hasn't changed", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: { [claudeFile("-a", session(1))]: claudeSession({ sessionId: session(1) }) },
    });
    const first = await scan(computer);
    computer.reads.length = 0;
    const held = toolOf(first, "claude").chats[0]!;
    const second = await scanComputer({
      access: computer.access,
      known: ({ fingerprint }) => (fingerprint === held.fingerprint ? held : null),
      onProgress: () => undefined,
    });
    expect(computer.reads).toEqual([]);
    expect(toolOf(second, "claude").chats).toEqual([held]);
  });

  it("reports progress in portions, to the end", async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n < 40; n += 1) {
      files[claudeFile("-a", session(n))] = claudeSession({ sessionId: session(n) });
    }
    const onProgress = vi.fn();
    await scan(fakeComputer({ home: HOME, files }), onProgress);
    expect(onProgress).toHaveBeenLastCalledWith(40, 40);
    expect(onProgress.mock.calls.length).toBeGreaterThan(40);
  });

  it("stops when the computer goes to sleep", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: { [claudeFile("-a", session(1))]: claudeSession({ sessionId: session(1) }) },
    });
    computer.asleep = true;
    await expect(scan(computer)).rejects.toThrow(/didn't answer/);
  });

  it("names the apps it finds next to the programs", async () => {
    const computer = fakeComputer({
      home: HOME,
      files: {
        [`${HOME}/.t3/userdata/state.db`]: "x",
        [`${HOME}/.bb`]: "x",
        "/Applications/Orca.app": "x",
      },
    });
    computer.files.delete(`${HOME}/.t3/userdata/state.db`);
    computer.files.set(`${HOME}/.t3`, { data: Buffer.from("x"), mtime: "2026-10-29T00:00:00Z" });
    expect((await scan(computer)).alsoFound).toEqual(["T3 Code", "Orca", "bb"]);
  });
});

describe("OpenCode through the computer's own commands", () => {
  const db = `${HOME}/.local/share/opencode/opencode.db`;
  const tables = {
    session: [
      "id",
      "directory",
      "title",
      "time_created",
      "time_updated",
      "parent_id",
      "time_archived",
    ],
    message: ["id", "session_id", "time_created", "data"],
    part: ["message_id", "session_id", "time_created", "data"],
  };
  const answerSql = (cmd: string): string => {
    const table = /pragma_table_info\(.*?(session|message|part).*?\)/.exec(cmd)?.[1];
    if (table !== undefined) {
      return JSON.stringify(tables[table as keyof typeof tables].map((name) => ({ name })));
    }
    if (cmd.includes("OFFSET 0")) {
      return JSON.stringify([
        {
          id: "ses_one",
          directory: "/Users/test/projects/gamma",
          title: "New session - 2026",
          time_created: 1_790_000_000_000,
          time_updated: 1_790_000_100_000,
        },
        { id: "ses_broken", directory: "/x", title: "No dates" },
      ]);
    }
    return "";
  };

  it("reads through sqlite3 and never moves the database", async () => {
    const computer = fakeComputer({ home: HOME, files: { [db]: "binary" } });
    computer.exec = (cmd) => {
      if (cmd.startsWith("printf")) {
        return { exitCode: 0, text: probeOutput({ sqlite3: "/usr/bin/sqlite3" }) };
      }
      return { exitCode: 0, text: answerSql(cmd) };
    };
    const result = await scan(computer);
    const openCode = toolOf(result, "opencode");
    expect(openCode.available).toBe(true);
    expect(openCode.chats).toHaveLength(1);
    expect(openCode.chats[0]).toMatchObject({
      sessionId: "ses_one",
      titled: false,
      path: db,
      cwd: "/Users/test/projects/gamma",
    });
    expect(result.skipped.unknownFormat).toBe(1);
    expect(computer.reads).toEqual([]);
    expect(computer.commands.join("\n")).not.toMatch(/credential|account/);
  });

  it("falls back to opencode db when sqlite3 can't do JSON", async () => {
    const computer = fakeComputer({ home: HOME, files: { [db]: "binary" } });
    computer.exec = (cmd) => {
      if (cmd.startsWith("printf")) {
        return {
          exitCode: 0,
          text: probeOutput({ sqlite3: "/usr/bin/sqlite3", opencode: "/usr/bin/opencode" }),
        };
      }
      if (cmd.startsWith("sqlite3")) return { exitCode: 1, text: "unknown option: -json" };
      return { exitCode: 0, text: answerSql(cmd) || "[]" };
    };
    expect(toolOf(await scan(computer), "opencode").chats).toHaveLength(1);
  });

  it("says so honestly when there is no way to read it", async () => {
    const computer = fakeComputer({ home: HOME, files: { [db]: "binary" } });
    computer.exec = (cmd) =>
      cmd.startsWith("printf")
        ? { exitCode: 0, text: probeOutput({}) }
        : { exitCode: 127, text: "" };
    const openCode = toolOf(await scan(computer), "opencode");
    expect(openCode.available).toBe(false);
    expect(openCode.unavailableReason).toMatch(/sqlite3/);
    expect(computer.reads).toEqual([]);
  });

  it("gives up on a schema it doesn't know, without failing the scan", async () => {
    const computer = fakeComputer({ home: HOME, files: { [db]: "binary" } });
    computer.exec = (cmd) =>
      cmd.startsWith("printf")
        ? { exitCode: 0, text: probeOutput({ sqlite3: "/usr/bin/sqlite3" }) }
        : { exitCode: 0, text: "[]" };
    const openCode = toolOf(await scan(computer), "opencode");
    expect(openCode.available).toBe(false);
    expect(openCode.unavailableReason).toMatch(/version/);
  });
});
