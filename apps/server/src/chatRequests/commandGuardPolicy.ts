/**
 * CommandGuardPolicy (provider/Services/CommandGuardPolicy.ts) from the
 * record of chat requests: a chat started here at a cloud chat's request is
 * held to the rules for good; T51: one a colleague's agent asked for too, and
 * one answering their question reads only. Read from the file (cached by its mtime), not
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
import { teamThreadIds } from "./hostLogic.ts";
import { readHostStore, spoolPaths, storePaths } from "./spool.ts";

export interface GuardedChats {
  readonly ids: ReadonlySet<string>;
  /** T51: of those, the chats started at a colleague's request. */
  readonly team: ReadonlySet<string>;
  /** T51: of those, the ones that only read. */
  readonly readOnly: ReadonlySet<string>;
}

const NONE: GuardedChats = { ids: new Set(), team: new Set(), readOnly: new Set() };

export function makeGuardedReader(stateDir: string) {
  const file = storePaths(stateDir).store;
  let cached: { readonly mtimeMs: number; readonly chats: GuardedChats } | null = null;
  return async (): Promise<GuardedChats> => {
    const stat = await fsp.stat(file).catch(() => null);
    if (stat === null) return NONE;
    if (cached !== null && cached.mtimeMs === stat.mtimeMs) return cached.chats;
    const store = await readHostStore(stateDir);
    const chats: GuardedChats = {
      ids: new Set(store.guarded),
      team: teamThreadIds(store),
      readOnly: new Set(store.readOnly ?? []),
    };
    cached = { mtimeMs: stat.mtimeMs, chats };
    return chats;
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
    const chats = Effect.promise(() => guarded().catch(() => NONE));
    const isGuarded = (threadId: string) =>
      chats.pipe(Effect.map((read) => read.ids.has(threadId)));
    return {
      isGuarded,
      decide: ({ threadId }) =>
        chats.pipe(
          Effect.map((read): CommandGuardPlan | null =>
            !read.ids.has(threadId)
              ? null
              : read.team.has(threadId) || read.readOnly.has(threadId)
                ? {
                    ...plan,
                    why: "started at a colleague's request",
                    ...(read.readOnly.has(threadId) ? { readOnly: true } : {}),
                  }
                : plan,
          ),
        ),
    };
  }),
);
