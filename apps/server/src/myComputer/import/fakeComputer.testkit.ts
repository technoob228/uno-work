/**
 * A computer in memory for the import's tests: files, folders, commands. Every
 * read is written down, so a test can say what was never touched.
 */
import { MyComputerFailure, type ExecResult } from "../myComputerCore.ts";
import type { ComputerAccess, ListEntry } from "./computerAccess.ts";

export interface FakeFile {
  readonly data: Buffer;
  readonly mtime: string;
  readonly type?: "file" | "symlink";
}

export interface FakeComputer {
  readonly access: ComputerAccess;
  readonly files: Map<string, FakeFile>;
  readonly reads: Array<{ path: string; offset: number; bytes: number }>;
  readonly commands: Array<string>;
  /** Answers a command; absent means "command not found". */
  exec: (cmd: string) => { readonly exitCode: number; readonly text: string };
  /** From now on every call fails the way a sleeping computer does. */
  asleep: boolean;
}

const notFound = (path: string) =>
  new MyComputerFailure("remote", `The computer answered: No such file or folder: ${path}`);

const answer = (exitCode: number, text: string): ExecResult => ({
  exitCode,
  signal: null,
  timedOut: false,
  durationMs: 1,
  text,
  cutBytes: 0,
});

export function fakeComputer(options: {
  readonly os?: string;
  readonly home: string;
  readonly files?: Readonly<Record<string, string | Buffer | Omit<FakeFile, "mtime">>>;
  readonly mtime?: string;
}): FakeComputer {
  const mtime = options.mtime ?? "2026-10-30T10:00:00Z";
  const files = new Map<string, FakeFile>();
  for (const [path, value] of Object.entries(options.files ?? {})) {
    const file =
      typeof value === "string"
        ? { data: Buffer.from(value) }
        : Buffer.isBuffer(value)
          ? { data: value }
          : value;
    files.set(path, { mtime, ...file });
  }
  const check = () => {
    if (computer.asleep) {
      throw new MyComputerFailure("timeout", "The computer didn't answer in time.");
    }
  };
  const access: ComputerAccess = {
    exec: async ({ cmd }) => {
      check();
      computer.commands.push(cmd);
      const result = computer.exec(cmd);
      return answer(result.exitCode, result.text);
    },
    read: async ({ path, offset, maxBytes }) => {
      check();
      const file = files.get(path);
      if (file === undefined) throw notFound(path);
      const data = file.data.subarray(offset, offset + maxBytes);
      computer.reads.push({ path, offset, bytes: data.length });
      return { data, eof: offset + data.length >= file.data.length };
    },
    list: async (path) => {
      check();
      const prefix = `${path.replace(/[\\/]+$/, "")}${path.includes("\\") ? "\\" : "/"}`;
      const entries = new Map<string, ListEntry>();
      for (const [filePath, file] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const [name, ...deeper] = rest.split(/[\\/]/);
        if (name === undefined) continue;
        entries.set(name, {
          name,
          type: deeper.length > 0 ? "dir" : (file.type ?? "file"),
          size: deeper.length > 0 ? 0 : file.data.length,
          mtime: file.mtime,
        });
      }
      if (entries.size === 0) throw notFound(path);
      return { entries: [...entries.values()], truncated: false };
    },
    stat: async (path) => {
      check();
      const file = files.get(path);
      if (file === undefined) return { exists: false, kind: null, size: 0, mtime: null };
      return { exists: true, kind: file.type ?? "file", size: file.data.length, mtime: file.mtime };
    },
    info: async () => {
      check();
      return { os: options.os ?? "darwin", home: options.home };
    },
  };
  const computer: FakeComputer = {
    access,
    files,
    reads: [],
    commands: [],
    exec: () => ({ exitCode: 127, text: "" }),
    asleep: false,
  };
  return computer;
}

/** The environment a computer's shell reports. */
export const probeOutput = (values: {
  readonly claude?: string;
  readonly codex?: string;
  readonly xdg?: string;
  readonly sqlite3?: string;
  readonly opencode?: string;
}) =>
  [
    `claude=${values.claude ?? ""}`,
    `codex=${values.codex ?? ""}`,
    `xdg=${values.xdg ?? ""}`,
    `sqlite3=${values.sqlite3 ?? ""}`,
    `opencode=${values.opencode ?? ""}`,
  ].join("\n");

const line = (row: unknown) => `${JSON.stringify(row)}\n`;

const SESSION = "11111111-2222-4333-8444-555555555555";

/** A Claude Code session the shape of 2.1.316's, with made-up words. */
export function claudeSession(options: {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly prompt?: string;
  readonly reply?: string;
  readonly at?: string;
  readonly extra?: ReadonlyArray<unknown>;
}): string {
  const sessionId = options.sessionId ?? SESSION;
  const at = options.at ?? "2026-10-29T10:00:00.000Z";
  const base = {
    sessionId,
    cwd: options.cwd ?? "/Users/test/projects/alpha",
    version: "2.1.316",
    gitBranch: "main",
    isSidechain: false,
    userType: "external",
  };
  return [
    line({ type: "queue-operation", operation: "enqueue", timestamp: at, sessionId }),
    line({
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "u1",
      timestamp: at,
      message: { role: "user", content: options.prompt ?? "Fix the login page" },
    }),
    line({ type: "attachment", uuid: "a1", parentUuid: "u1", sessionId, timestamp: at }),
    line({ type: "api-request-blob", hash: "x", message: { role: "user", content: [] } }),
    line({
      ...base,
      parentUuid: "a1",
      type: "assistant",
      uuid: "r1",
      timestamp: at,
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: options.reply ?? "Done." }],
      },
    }),
    ...(options.extra ?? []).map(line),
    line({ type: "last-prompt", lastPrompt: "Fix the login page", leafUuid: "r1", sessionId }),
  ].join("");
}

/** A Codex rollout the shape of 0.166's, with made-up words. */
export function codexSession(options: {
  readonly id?: string;
  readonly cwd?: string;
  readonly prompt?: string;
  readonly reply?: string;
  readonly at?: string;
  readonly source?: unknown;
  readonly instructions?: string;
}): string {
  const id = options.id ?? "01a19237-82b4-71d2-8602-4e3bf595f562";
  const at = options.at ?? "2026-10-29T10:00:00.000Z";
  const message = (role: string, type: string, text: string) => ({
    timestamp: at,
    type: "response_item",
    payload: { type: "message", id: "m", role, content: [{ type, text }] },
  });
  return [
    line({
      timestamp: at,
      type: "session_meta",
      payload: {
        session_id: id,
        id,
        timestamp: at,
        cwd: options.cwd ?? "/Users/test/projects/beta",
        ...(options.source === undefined ? {} : { source: options.source }),
        base_instructions: options.instructions ?? "You are Codex.",
      },
    }),
    line(message("developer", "input_text", "<permissions instructions>...")),
    line(message("user", "input_text", "<environment_context>cwd</environment_context>")),
    line({ timestamp: at, type: "event_msg", payload: { type: "task_started" } }),
    line(message("user", "input_text", options.prompt ?? "Write the release notes")),
    line({
      timestamp: at,
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "UserMessage",
          content: [{ type: "text", text: options.prompt ?? "Write the release notes" }],
        },
      },
    }),
    line(message("assistant", "output_text", options.reply ?? "Here they are.")),
  ].join("");
}
