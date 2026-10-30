/**
 * Chats that hold a stranger's text: a site visitor's form or a webhook's body
 * that came in Ask mode. The text stays in the chat's context after the run,
 * so from then on the chat's `uno-work` tools ask first, except the few that
 * only read this computer or tell the person (`outsideTextAsks`,
 * `unoWork/policy.ts`) — whatever mode the chat is put back in.
 *
 * A file in the state dir: a restart in the middle of a run must not open the
 * gate. It fails closed: a file that can't be read gates every chat until the
 * next write, and a mark that can't be written stops the run. The console caps
 * outside runs at 100 a day, so the last 50,000 chats are over a year of them.
 *
 * @module automations/outsideThreads
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { Context, Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";

export const OUTSIDE_THREADS_FILE = "automations-outside-threads.json";
export const OUTSIDE_THREADS_KEEP = 50_000;

export interface OutsideThreadsShape {
  readonly has: (threadId: string) => Effect.Effect<boolean>;
  readonly mark: (threadId: string) => Effect.Effect<void>;
}

export class OutsideThreads extends Context.Service<OutsideThreads, OutsideThreadsShape>()(
  "t3/automations/OutsideThreads",
) {}

/** Ids from the file (the last `keep`), or none. */
export function parseOutsideThreads(raw: unknown, keep = OUTSIDE_THREADS_KEEP): string[] {
  const ids =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["threads"] : null;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id !== "").slice(-keep);
}

export const makeOutsideThreads = (file: string, keep = OUTSIDE_THREADS_KEEP) =>
  Effect.gen(function* () {
    const read = yield* Effect.promise(async () => {
      try {
        const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
        const shaped = typeof raw === "object" && raw !== null && "threads" in raw;
        return { ids: parseOutsideThreads(raw, keep), unreadable: !shaped };
      } catch (error) {
        const missing = (error as { code?: string }).code === "ENOENT";
        return { ids: [] as string[], unreadable: !missing };
      }
    });
    const { ids } = read;
    let unreadable = read.unreadable;
    if (unreadable) {
      yield* Effect.logError("outside threads file unreadable: every chat asks first").pipe(
        Effect.annotateLogs({ file }),
      );
    }
    const set = new Set(ids);
    const lock = yield* Semaphore.make(1);
    const shape: OutsideThreadsShape = {
      has: (threadId) => Effect.sync(() => unreadable || set.has(threadId)),
      mark: (threadId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (set.has(threadId) && !unreadable) return;
            ids.push(threadId);
            set.add(threadId);
            while (ids.length > keep) set.delete(ids.shift()!);
            const snapshot = JSON.stringify({ threads: ids });
            yield* Effect.promise(async () => {
              await fs.mkdir(path.dirname(file), { recursive: true });
              const tmp = `${file}.${process.pid}.tmp`;
              await fs.writeFile(tmp, snapshot, { mode: 0o600 });
              await fs.rename(tmp, file);
            });
            unreadable = false;
          }),
        ),
    };
    return shape;
  });

export const OutsideThreadsLive = Layer.effect(
  OutsideThreads,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeOutsideThreads(path.join(config.stateDir, OUTSIDE_THREADS_FILE));
  }),
);
