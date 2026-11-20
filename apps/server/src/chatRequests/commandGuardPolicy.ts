/**
 * CommandGuardPolicy (provider/Services/CommandGuardPolicy.ts) from the
 * record of chat requests: a chat started here at a cloud chat's request is
 * held to the rules for good. Read from the file (cached by its mtime), not
 * from the chat-requests service: the provider layer sits below it.
 *
 * @module chatRequests/commandGuardPolicy
 */
import { promises as fsp } from "node:fs";

import { Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import {
  CommandGuardPolicy,
  type CommandGuardPlan,
} from "../provider/Services/CommandGuardPolicy.ts";
import { readHostStore, spoolPaths, storePaths } from "./spool.ts";

export function makeGuardedReader(stateDir: string) {
  const file = storePaths(stateDir).store;
  let cached: { readonly mtimeMs: number; readonly ids: ReadonlySet<string> } | null = null;
  return async (): Promise<ReadonlySet<string>> => {
    const stat = await fsp.stat(file).catch(() => null);
    if (stat === null) return new Set();
    if (cached !== null && cached.mtimeMs === stat.mtimeMs) return cached.ids;
    const ids = new Set((await readHostStore(stateDir)).guarded);
    cached = { mtimeMs: stat.mtimeMs, ids };
    return ids;
  };
}

export const CommandGuardPolicyLive = Layer.effect(
  CommandGuardPolicy,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const guarded = makeGuardedReader(config.stateDir);
    const plan: CommandGuardPlan = {
      why: "started at the request of a cloud chat",
      // Its chats, settings and sign-ins; not the whole base folder (chat copies live there).
      blockedRoots: [config.stateDir, spoolPaths().root],
    };
    const isGuarded = (threadId: string) =>
      Effect.promise(() => guarded().catch(() => new Set<string>())).pipe(
        Effect.map((ids) => ids.has(threadId)),
      );
    return {
      isGuarded,
      decide: ({ threadId }) =>
        isGuarded(threadId).pipe(Effect.map((held) => (held ? plan : null))),
    };
  }),
);
