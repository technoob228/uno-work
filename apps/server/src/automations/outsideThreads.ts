/**
 * Chats that hold a stranger's text: a site visitor's form or a webhook's body
 * that came in Ask mode. The text stays in the chat's context after the run,
 * so from then on the chat's `uno-work` tools ask first, except the few that
 * only read this computer or tell the person (`outsideTextAsks`,
 * `unoWork/policy.ts`) — whatever mode the chat is put back in.
 *
 * A file in the state dir (the last 500 chats): a restart in the middle of a
 * run must not open the gate.
 *
 * @module automations/outsideThreads
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { Context, Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";

export const OUTSIDE_THREADS_FILE = "automations-outside-threads.json";
export const OUTSIDE_THREADS_KEEP = 500;

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
    const ids = yield* Effect.promise(async () => {
      try {
        return parseOutsideThreads(JSON.parse(await fs.readFile(file, "utf8")), keep);
      } catch {
        return [];
      }
    });
    const set = new Set(ids);
    const lock = yield* Semaphore.make(1);
    const shape: OutsideThreadsShape = {
      has: (threadId) => Effect.sync(() => set.has(threadId)),
      mark: (threadId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (set.has(threadId)) return;
            ids.push(threadId);
            set.add(threadId);
            while (ids.length > keep) set.delete(ids.shift()!);
            const snapshot = JSON.stringify({ threads: ids });
            yield* Effect.promise(async () => {
              await fs.mkdir(path.dirname(file), { recursive: true });
              const tmp = `${file}.${process.pid}.tmp`;
              await fs.writeFile(tmp, snapshot, { mode: 0o600 });
              await fs.rename(tmp, file);
            }).pipe(Effect.ignoreCause({ log: true }));
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
