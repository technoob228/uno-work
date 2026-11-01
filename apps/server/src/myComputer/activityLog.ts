/**
 * The journal of what agents did on the person's computer, kept on the disk of
 * Uno Work (the helper keeps its own on the computer):
 * `<stateDir>/my-computer/<computerId>.activity.jsonl`, 0600, one line per
 * action, the newest 500 kept. Summaries only: never a file's content or a
 * command's output. Plain async I/O, one write at a time per file.
 *
 * @module myComputer/activityLog
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import type {
  MyComputerActivity,
  MyComputerActivityEntry,
  MyComputerActivityKind,
} from "@t3tools/contracts";

import { summarize } from "./activitySummary.ts";

export const ACTIVITY_KEEP_ENTRIES = 500;
export const ACTIVITY_DEFAULT_LIMIT = 50;
/** Trim once the file is past this: ~500 long lines. */
const TRIM_ABOVE_BYTES = 256 * 1024;

const KINDS: ReadonlySet<string> = new Set(["run", "read", "write", "list"]);

const parseLine = (line: string): MyComputerActivityEntry | null => {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (
      typeof raw.at !== "string" ||
      typeof raw.summary !== "string" ||
      typeof raw.kind !== "string" ||
      !KINDS.has(raw.kind)
    ) {
      return null;
    }
    return {
      at: raw.at,
      kind: raw.kind as MyComputerActivityKind,
      summary: raw.summary,
      ...(typeof raw.threadId === "string" ? { threadId: raw.threadId } : {}),
    };
  } catch {
    return null;
  }
};

export interface ActivityLog {
  readonly record: (
    computerId: string,
    entry: {
      readonly kind: MyComputerActivityKind;
      readonly summary: string;
      readonly threadId?: string | undefined;
    },
  ) => Promise<void>;
  /** Newest first. */
  readonly read: (computerId: string, limit?: number) => Promise<MyComputerActivity>;
}

export function makeActivityLog(input: {
  readonly stateDir: string;
  readonly now?: () => Date;
}): ActivityLog {
  const dir = path.join(input.stateDir, "my-computer");
  const fileOf = (computerId: string) =>
    path.join(dir, `${encodeURIComponent(computerId)}.activity.jsonl`);
  const now = input.now ?? (() => new Date());
  /** The tail of each file's write queue. */
  const queues = new Map<string, Promise<void>>();

  const readEntries = async (file: string): Promise<ReadonlyArray<MyComputerActivityEntry>> => {
    const text = await fsp.readFile(file, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map(parseLine)
      .filter((entry): entry is MyComputerActivityEntry => entry !== null);
  };

  const trim = async (file: string) => {
    const { size } = await fsp.stat(file);
    if (size <= TRIM_ABOVE_BYTES) return;
    const kept = (await readEntries(file)).slice(-ACTIVITY_KEEP_ENTRIES);
    const temporary = `${file}.tmp`;
    await fsp.writeFile(temporary, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
      mode: 0o600,
    });
    await fsp.rename(temporary, file);
  };

  return {
    record: (computerId, entry) => {
      const file = fileOf(computerId);
      const line = JSON.stringify({
        at: now().toISOString(),
        kind: entry.kind,
        // Whoever calls this: nothing reaches the disk unmasked.
        summary: summarize(entry.summary),
        ...(entry.threadId ? { threadId: entry.threadId } : {}),
      });
      const write = async () => {
        await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
        await fsp.appendFile(file, `${line}\n`, { mode: 0o600 });
        await trim(file);
      };
      const next = (queues.get(file) ?? Promise.resolve()).then(write, write);
      queues.set(file, next);
      return next;
    },
    read: async (computerId, limit = ACTIVITY_DEFAULT_LIMIT) => {
      const entries = await readEntries(fileOf(computerId));
      return entries.slice(-limit).toReversed();
    },
  };
}
