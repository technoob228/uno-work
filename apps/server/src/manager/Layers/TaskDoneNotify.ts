/**
 * TaskDoneNotify — "your agent finished" for a person who isn't looking
 * (agent-flow pass 25.10, item 9; rules in taskDoneNotify.ts).
 *
 * Subscribes to the orchestration domain events. When a task the person
 * started in the app ends after 2+ minutes and no Uno Work client is connected
 * at that moment (no tab, no desktop app), Uno's own bot tells them — or,
 * without a linked Telegram, the console mails the account address. A chat
 * bound to the thread that already hears "turn completed" is left to that.
 * The assistant's chats are not tasks here: it answers in its own bot.
 *
 * Off a cloud computer (no machine identity) nothing is sent.
 */
import { isAssistantProjectId, type OrchestrationEvent } from "@t3tools/contracts";
import { Effect, Layer, Option, Ref, Stream } from "effect";

import { SessionCredentialService } from "../../auth/Services/SessionCredentialService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  formatTaskDoneEmailSubject,
  formatTaskDoneText,
  INITIAL_TASK_DONE_STATE,
  trackTaskDone,
  type TaskDoneState,
} from "../taskDoneNotify.ts";
import { sendUnoServiceNotification } from "../unoServiceNotify.ts";
import { readWorkMachineIdentity } from "../workConsole.ts";
import { ConnectorNotifyService } from "../Services/ConnectorNotify.ts";

const makeTaskDoneNotify = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const notifyService = yield* ConnectorNotifyService;
  const sessions = Option.getOrNull(yield* Effect.serviceOption(SessionCredentialService));
  const serverSettings = Option.getOrNull(yield* Effect.serviceOption(ServerSettingsService));

  const stateRef = yield* Ref.make<TaskDoneState>(INITIAL_TASK_DONE_STATE);

  /** Someone has Uno Work open right now (a tab or the desktop app). */
  const someoneIsLooking = sessions
    ? sessions.listActive().pipe(
        Effect.map((rows) => rows.some((row) => row.connected)),
        // Unknown: don't push — a missed notice is better than a wrong one.
        Effect.orElseSucceed(() => true),
      )
    : Effect.succeed(true);

  const handleEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const done = yield* Ref.modify(stateRef, (state) => {
        const next = trackTaskDone(state, event);
        return [next.done, next.state] as const;
      });
      if (done === null) return;
      if (yield* someoneIsLooking) return;
      const shell = yield* projectionSnapshotQuery
        .getThreadShellById(done.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(shell)) return;
      if (isAssistantProjectId(shell.value.projectId)) return;
      // A chat bound to this thread with "tell me when a turn completes"
      // already hears it (ConnectorEventsForwarder).
      const bound = yield* notifyService.resolveChats({
        threadId: done.threadId,
        projectId: shell.value.projectId,
        includeAssistantFallback: false,
      });
      if (bound.some((chat) => chat.notifyOnComplete)) return;
      const settings = serverSettings
        ? yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null))
        : null;
      const { delivered } = yield* sendUnoServiceNotification({
        identity: readWorkMachineIdentity(settings?.uno),
        text: formatTaskDoneText({
          threadTitle: shell.value.title,
          durationMs: done.durationMs,
        }),
        emailSubject: formatTaskDoneEmailSubject(shell.value.title),
      });
      yield* Effect.logInfo("task done: owner notified").pipe(
        Effect.annotateLogs({
          threadId: done.threadId,
          durationMs: done.durationMs,
          delivered,
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("task done notify failed on an event").pipe(
          Effect.annotateLogs({ eventType: event.type, cause }),
        ),
      ),
    );

  yield* Effect.forkScoped(
    orchestrationEngine.streamDomainEvents.pipe(Stream.runForEach(handleEvent)),
  );
});

export const TaskDoneNotifyLive = Layer.effectDiscard(makeTaskDoneNotify);
