/**
 * Keeps an assistant's own chats in the mode its preset allows.
 *
 * "Asks first" is enforced by the daemon (Misha 23.10): the harness of an
 * Asks-first assistant runs `auto-accept-edits` (files yes, commands and
 * everything outward ask), "Does it itself" runs `full-access`. New chats get
 * the mode when they are created (`readAssistantRuntimeMode`); when the person
 * switches the mode, the chats that already exist are realigned here, so the
 * next turn — from Telegram, Slack, a schedule or the app — already runs
 * narrower (or wider) without a restart.
 *
 * @module assistants/assistantThreadModes
 */
import { CommandId, type RuntimeMode } from "@t3tools/contracts";
import { Effect } from "effect";

import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export const ASSISTANT_MODE_ORIGIN = "assistant-mode";

/** Live chats of `projectId` not already in `mode` get it. Returns how many. */
export const realignAssistantThreadModes = (
  deps: {
    readonly projections: Pick<ProjectionSnapshotQueryShape, "getShellSnapshot">;
    readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  },
  projectId: string,
  mode: RuntimeMode,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const snapshot = yield* deps.projections
      .getShellSnapshot()
      .pipe(Effect.orElseSucceed(() => null));
    if (snapshot === null) return 0;
    const stale = snapshot.threads.filter(
      (thread) =>
        thread.projectId === projectId && thread.archivedAt === null && thread.runtimeMode !== mode,
    );
    let changed = 0;
    for (const thread of stale) {
      const done = yield* deps.engine
        .dispatch(
          {
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(`assistant-mode:${crypto.randomUUID()}`),
            threadId: thread.id,
            runtimeMode: mode,
            createdAt: new Date().toISOString(),
          },
          { origin: systemCommandOrigin(ASSISTANT_MODE_ORIGIN, "mode changed") },
        )
        .pipe(
          Effect.as(true),
          Effect.catch((cause) =>
            Effect.logWarning("assistant chat kept its old mode").pipe(
              Effect.annotateLogs({ threadId: thread.id, mode, cause: String(cause) }),
              Effect.as(false),
            ),
          ),
        );
      if (done) changed += 1;
    }
    if (changed > 0) {
      yield* Effect.logInfo("assistant chats realigned to the assistant's mode").pipe(
        Effect.annotateLogs({ projectId, mode, changed }),
      );
    }
    return changed;
  });
