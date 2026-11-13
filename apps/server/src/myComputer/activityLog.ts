/**
 * The journal of what agents did on the person's computer, kept on the disk of
 * Uno Work (the helper keeps its own on the computer):
 * `<stateDir>/my-computer/<computerId>.activity.jsonl`, 0600, one line per
 * action, the newest 500 kept. Summaries only: never a file's content or a
 * command's output. Plain async I/O, one write at a time per file.
 *
 * A line is written BEFORE the action (a crash mid-way still leaves it), with
 * the tier the call was judged at and the chat's title; when the action ends,
 * a short line with the same `id` adds how it ended (exit code, duration),
 * and reading folds it into its line. A call refused by policy is one line
 * with `outcome: "refused"`.
 *
 * @module myComputer/activityLog
 */
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import type {
  MyComputerActivity,
  MyComputerActivityEntry,
  MyComputerActivityKind,
  MyComputerActivityOutcome,
  MyComputerTier,
} from "@t3tools/contracts";

import { summarize } from "./activitySummary.ts";

export const ACTIVITY_KEEP_ENTRIES = 500;
export const ACTIVITY_DEFAULT_LIMIT = 50;
/** Trim once the file is past this: ~500 long lines. */
const TRIM_ABOVE_BYTES = 256 * 1024;

const KINDS: ReadonlySet<string> = new Set(["run", "read", "write", "list"]);

const TIERS: ReadonlySet<string> = new Set(["free", "chat", "ask", "always", "blocked"]);
const OUTCOMES: ReadonlySet<string> = new Set(["ran", "failed", "stopped", "refused"]);

/** How an action ended: the fields a finish line adds. */
export interface ActivityFinish {
  readonly outcome: MyComputerActivityOutcome;
  readonly exitCode?: number | null | undefined;
  readonly durationMs?: number | undefined;
}

type Line =
  | { readonly type: "entry"; readonly id: string | null; readonly entry: MyComputerActivityEntry }
  | { readonly type: "finish"; readonly id: string; readonly finish: ActivityFinish };

const finishFields = (raw: Record<string, unknown>): Partial<MyComputerActivityEntry> => ({
  ...(typeof raw.outcome === "string" && OUTCOMES.has(raw.outcome)
    ? { outcome: raw.outcome as MyComputerActivityOutcome }
    : {}),
  ...(raw.exitCode === null || (typeof raw.exitCode === "number" && Number.isInteger(raw.exitCode))
    ? { exitCode: raw.exitCode as number | null }
    : {}),
  ...(typeof raw.durationMs === "number" && Number.isInteger(raw.durationMs) && raw.durationMs >= 0
    ? { durationMs: raw.durationMs }
    : {}),
});

const parseLine = (line: string): Line | null => {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw.done === true && typeof raw.id === "string") {
      const fields = finishFields(raw);
      if (fields.outcome === undefined) return null;
      return { type: "finish", id: raw.id, finish: fields as ActivityFinish };
    }
    if (
      typeof raw.at !== "string" ||
      typeof raw.summary !== "string" ||
      typeof raw.kind !== "string" ||
      !KINDS.has(raw.kind)
    ) {
      return null;
    }
    return {
      type: "entry",
      id: typeof raw.id === "string" ? raw.id : null,
      entry: {
        at: raw.at,
        kind: raw.kind as MyComputerActivityKind,
        summary: raw.summary,
        ...(typeof raw.threadId === "string" ? { threadId: raw.threadId } : {}),
        ...(typeof raw.threadTitle === "string" ? { threadTitle: raw.threadTitle } : {}),
        ...(typeof raw.tier === "string" && TIERS.has(raw.tier)
          ? { tier: raw.tier as MyComputerTier }
          : {}),
        ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
        ...finishFields(raw),
      },
    };
  } catch {
    return null;
  }
};

/** Lines in file order → entries, each finish folded into its entry. */
const fold = (
  lines: ReadonlyArray<Line>,
): Array<{ readonly id: string | null; readonly entry: MyComputerActivityEntry }> => {
  const finishes = new Map<string, ActivityFinish>();
  for (const line of lines) if (line.type === "finish") finishes.set(line.id, line.finish);
  const entries: Array<{ readonly id: string | null; readonly entry: MyComputerActivityEntry }> =
    [];
  for (const line of lines) {
    if (line.type !== "entry") continue;
    const finish = line.id === null ? undefined : finishes.get(line.id);
    entries.push({
      id: line.id,
      entry:
        finish === undefined
          ? line.entry
          : {
              ...line.entry,
              outcome: finish.outcome,
              ...(finish.exitCode !== undefined ? { exitCode: finish.exitCode } : {}),
              ...(finish.durationMs !== undefined ? { durationMs: finish.durationMs } : {}),
            },
    });
  }
  return entries;
};

export interface ActivityEntryInput {
  readonly kind: MyComputerActivityKind;
  readonly summary: string;
  readonly threadId?: string | undefined;
  readonly threadTitle?: string | undefined;
  readonly tier?: MyComputerTier | undefined;
  /** Refused by policy: the line is the whole story. */
  readonly refused?: { readonly reason: string } | undefined;
}

export interface ActivityLog {
  /** The line's id, for `finish`. */
  readonly record: (computerId: string, entry: ActivityEntryInput) => Promise<string>;
  readonly finish: (computerId: string, id: string, finish: ActivityFinish) => Promise<void>;
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

  const readEntries = async (file: string) => {
    const text = await fsp.readFile(file, "utf8").catch(() => "");
    return fold(
      text
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseLine)
        .filter((line): line is Line => line !== null),
    );
  };

  const trim = async (file: string) => {
    const { size } = await fsp.stat(file);
    if (size <= TRIM_ABOVE_BYTES) return;
    // Folded: a kept line keeps how it ended, and its id for a finish to come.
    const kept = (await readEntries(file)).slice(-ACTIVITY_KEEP_ENTRIES);
    const temporary = `${file}.tmp`;
    await fsp.writeFile(
      temporary,
      kept
        .map(({ id, entry }) => `${JSON.stringify(id === null ? entry : { id, ...entry })}\n`)
        .join(""),
      { mode: 0o600 },
    );
    await fsp.rename(temporary, file);
  };

  const append = (computerId: string, line: string) => {
    const file = fileOf(computerId);
    const write = async () => {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await fsp.appendFile(file, `${line}\n`, { mode: 0o600 });
      await trim(file);
    };
    const next = (queues.get(file) ?? Promise.resolve()).then(write, write);
    queues.set(file, next);
    return next;
  };

  return {
    record: async (computerId, entry) => {
      const id = randomUUID();
      const line = JSON.stringify({
        id,
        at: now().toISOString(),
        kind: entry.kind,
        // Whoever calls this: nothing reaches the disk unmasked.
        summary: summarize(entry.summary),
        ...(entry.threadId ? { threadId: entry.threadId } : {}),
        ...(entry.threadTitle ? { threadTitle: summarize(entry.threadTitle, 120) } : {}),
        ...(entry.tier ? { tier: entry.tier } : {}),
        ...(entry.refused
          ? { outcome: "refused", reason: summarize(entry.refused.reason, 300) }
          : {}),
      });
      await append(computerId, line);
      return id;
    },
    finish: (computerId, id, finish) =>
      append(
        computerId,
        JSON.stringify({
          id,
          done: true,
          outcome: finish.outcome,
          ...(finish.exitCode !== undefined ? { exitCode: finish.exitCode } : {}),
          ...(finish.durationMs !== undefined
            ? { durationMs: Math.max(0, Math.round(finish.durationMs)) }
            : {}),
        }),
      ),
    read: async (computerId, limit = ACTIVITY_DEFAULT_LIMIT) => {
      const entries = await readEntries(fileOf(computerId));
      return entries
        .slice(-limit)
        .map(({ entry }) => entry)
        .toReversed();
    },
  };
}
