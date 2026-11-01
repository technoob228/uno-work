/**
 * What the import needs from a computer, and nothing else. The scan and the
 * history go through this, so the allow-list can't be forgotten: `read` refuses
 * any path that isn't a session file. Calls are quiet: a scan of a thousand
 * files is one journal line, written by whoever starts it.
 *
 * @module myComputer/import/computerAccess
 */
import { MyComputerFailure, type ExecResult, type MyComputerCore } from "../myComputerCore.ts";
import { assertChatFilePath } from "./chatPaths.ts";

export interface ListEntry {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly mtime: string | null;
}

export interface ComputerAccess {
  readonly exec: (input: {
    readonly cmd: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  }) => Promise<ExecResult>;
  readonly read: (input: {
    readonly path: string;
    readonly offset: number;
    readonly maxBytes: number;
  }) => Promise<{ readonly data: Buffer; readonly eof: boolean }>;
  readonly list: (
    path: string,
  ) => Promise<{ readonly entries: ReadonlyArray<ListEntry>; readonly truncated: boolean }>;
  readonly stat: (path: string) => Promise<{
    readonly exists: boolean;
    readonly kind: string | null;
    readonly size: number;
    readonly mtime: string | null;
  }>;
  readonly info: () => Promise<{ readonly os: string; readonly home: string }>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number => (typeof value === "number" ? value : 0);
const when = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export function computerAccess(core: MyComputerCore, computerId: string): ComputerAccess {
  return {
    exec: (input) => core.exec({ computerId, ...input, quiet: true }),
    read: async (input) => {
      assertChatFilePath(input.path);
      const answer = await core.read({ computerId, ...input, quiet: true });
      return { data: answer.data, eof: answer.eof };
    },
    list: async (path) => {
      const answer = await core.list({ computerId, path, quiet: true });
      const entries = Array.isArray(answer["entries"]) ? (answer["entries"] as Array<unknown>) : [];
      return {
        truncated: answer["truncated"] === true,
        entries: entries.flatMap((entry): Array<ListEntry> => {
          if (typeof entry !== "object" || entry === null) return [];
          const row = entry as Readonly<Record<string, unknown>>;
          return [
            {
              name: text(row["name"]),
              type: text(row["type"]),
              size: count(row["size"]),
              mtime: when(row["mtime"]),
            },
          ];
        }),
      };
    },
    stat: async (path) => {
      const answer = await core.stat({ computerId, path });
      return {
        exists: answer["exists"] === true,
        kind: when(answer["kind"]),
        size: count(answer["size"]),
        mtime: when(answer["mtime"]),
      };
    },
    info: async () => {
      const answer = await core.info(computerId);
      return { os: text(answer["os"]), home: text(answer["home"]) };
    },
  };
}

/**
 * A file the computer couldn't give (gone, no permission): one chat is skipped.
 * Anything else (asleep, tunnel down) stops the scan: the rest would fail too.
 */
export function isFileFailure(cause: unknown): boolean {
  return (
    cause instanceof MyComputerFailure &&
    cause.kind === "remote" &&
    cause.message.startsWith("The computer answered:")
  );
}

export function isMissingFile(cause: unknown): boolean {
  return isFileFailure(cause) && /no such file|not.?found/i.test((cause as Error).message);
}
