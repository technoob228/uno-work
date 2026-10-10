/**
 * One scheduled turn of an assistant (`uno-work assistant-turn`, run by the
 * console on a schedule after it woke the computer).
 *
 * Where the turn runs: the default assistant's main conversation (the pinned
 * "Uno" chat — where the person's personal Telegram chat talks too, so a
 * reply in Telegram continues the same context); any other assistant gets
 * one "Scheduled tasks" thread of its own. The prompt is wrapped so the
 * assistant knows nobody is watching, waits until the thread is idle, runs,
 * and the final answer goes to the person's chats (Telegram, Slack) through
 * the same notify path as `notify` with `alsoMessenger`. An answer of exactly
 * NO_REPLY stays silent.
 *
 * The caller is the assistant's own manager token (`assistant:<projectId>`):
 * the project comes from the token, never from the request body.
 *
 * @module assistants/scheduledTurn
 */
import {
  ASSISTANT_PROJECT_ID,
  ASSISTANT_SCHEDULE_DEFAULT_MINUTES,
  ASSISTANT_TURN_NO_REPLY,
  CommandId,
  MessageId,
  ThreadId,
  type ManagerAssistantTurnInput,
  type ManagerAssistantTurnResult,
  type ProjectId,
} from "@t3tools/contracts";
import { findMarkedAssistantChat } from "@t3tools/shared/assistantChat";
import { Context, Data, Effect, Layer, Option } from "effect";

import { currentAssistantModelSelection } from "../manager/assistantEngineSelection.ts";
import { ASSISTANT_THREAD_RUNTIME_MODE } from "../manager/connectorBindings.ts";
import { decidePendingReply, stoppedText } from "../manager/connectorReplies.ts";
import { ConnectorNotifyService } from "../manager/Services/ConnectorNotify.ts";
import type { ManagerCaller } from "../manager/Services/ManagerToolService.ts";
import { assistantCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { assistantProjectOfCaller } from "./schedules.ts";

/** Title of the thread scheduled turns run in for a non-default assistant. */
export const SCHEDULED_THREAD_TITLE = "Scheduled tasks";
/** How long a scheduled turn waits for a busy thread before giving up. */
const BUSY_WAIT_MS = 5 * 60_000;
const POLL_MS = 2_000;

export class AssistantTurnError extends Data.TaggedError("AssistantTurnError")<{
  readonly message: string;
  readonly status: number;
}> {}

/** What the assistant reads: the schedule's instruction, framed. */
export function wrapScheduledPrompt(input: { readonly name?: string; readonly prompt: string }) {
  const title = input.name ? `"${input.name}"` : "";
  return [
    `[Scheduled task ${title}— it runs on its own: the person is not in this chat right now.`,
    "Your final message reaches them in their Inbox (and Telegram/Slack when connected), so make it short and useful.",
    `If there is nothing worth telling them, answer exactly ${ASSISTANT_TURN_NO_REPLY}.]`,
    "",
    input.prompt,
  ].join("\n");
}

/** NO_REPLY (any case, optional trailing dot) means: say nothing. */
export function isNoReply(text: string): boolean {
  return text.trim().replace(/\.$/, "").toUpperCase() === ASSISTANT_TURN_NO_REPLY;
}

export interface AssistantScheduledTurnsShape {
  readonly run: (
    caller: ManagerCaller,
    input: ManagerAssistantTurnInput,
  ) => Effect.Effect<ManagerAssistantTurnResult, AssistantTurnError>;
}

export class AssistantScheduledTurns extends Context.Service<
  AssistantScheduledTurns,
  AssistantScheduledTurnsShape
>()("t3/assistants/AssistantScheduledTurns") {}

const turnError = (status: number, message: string) => new AssistantTurnError({ status, message });

export const makeAssistantScheduledTurns = (options?: { readonly pollMs?: number }) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    const turns = yield* ProjectionTurnRepository;
    const engine = yield* OrchestrationEngineService;
    const notify = yield* ConnectorNotifyService;
    const pollMs = options?.pollMs ?? POLL_MS;

    /** The thread a scheduled turn of `projectId` runs in (created if needed). */
    const targetThread = (projectId: ProjectId, tokenId: string) =>
      Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot();
        if (projectId === ASSISTANT_PROJECT_ID) {
          const main = findMarkedAssistantChat(snapshot.threads);
          if (main !== null) return main.id;
        }
        const existing = snapshot.threads.find(
          (thread) =>
            thread.projectId === projectId &&
            thread.title === SCHEDULED_THREAD_TITLE &&
            thread.archivedAt === null,
        );
        if (existing !== undefined) return existing.id;
        if (!snapshot.projects.some((project) => project.id === projectId)) {
          return yield* turnError(404, `The assistant ${projectId} has no workspace here.`);
        }
        const threadId = ThreadId.make(crypto.randomUUID());
        yield* engine.dispatch(
          {
            type: "thread.create",
            commandId: CommandId.make(`assistant-schedule:${crypto.randomUUID()}`),
            threadId,
            projectId,
            title: SCHEDULED_THREAD_TITLE,
            modelSelection: yield* currentAssistantModelSelection(projections),
            runtimeMode: ASSISTANT_THREAD_RUNTIME_MODE,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
          { origin: assistantCommandOrigin({ assistantKey: projectId, tokenId }) },
        );
        return threadId;
      });

    const sessionBusy = (threadId: ThreadId) =>
      projections.getThreadDetailById(threadId).pipe(
        Effect.map((detail) => {
          if (Option.isNone(detail)) return false;
          const session = detail.value.session;
          return session?.status === "running" && (session.activeTurnId ?? null) !== null;
        }),
        Effect.orElseSucceed(() => false),
      );

    const waitUntilIdle = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const deadline = Date.now() + BUSY_WAIT_MS;
        while (yield* sessionBusy(threadId)) {
          if (Date.now() >= deadline) {
            return yield* turnError(
              409,
              "The assistant was busy with another turn for 5 minutes; the scheduled run was skipped.",
            );
          }
          yield* Effect.sleep(pollMs);
        }
      });

    // The answer of the turn THIS message started (see `decidePendingReply`):
    // a Telegram message landing meanwhile has a turn — and an answer — of
    // its own.
    const awaitReply = (
      threadId: ThreadId,
      messageId: MessageId,
      requestedAtIso: string,
      deadlineMs: number,
    ) =>
      Effect.gen(function* () {
        let knownTurnId: string | null = null;
        while (Date.now() < deadlineMs) {
          yield* Effect.sleep(pollMs);
          const detail = yield* projections
            .getThreadDetailById(threadId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(detail)) continue;
          const turnRows = yield* turns
            .listByThreadId({ threadId })
            .pipe(Effect.orElseSucceed(() => []));
          const verdict = decidePendingReply({
            userMessageId: messageId,
            requestedAt: requestedAtIso,
            knownTurnId,
            claimedTurnIds: new Set(),
            messages: detail.value.messages,
            turns: turnRows,
            session: detail.value.session,
            activities: detail.value.activities,
            nowMs: Date.now(),
          });
          knownTurnId = verdict.turnId;
          switch (verdict.kind) {
            case "wait":
              continue;
            case "answer":
              return { text: verdict.text };
            case "stopped":
              return { text: verdict.partial ?? stoppedText("en") };
            case "lost":
            case "failed":
              return { text: `The scheduled task could not finish: ${verdict.reason}` };
          }
        }
        return null;
      });

    const run: AssistantScheduledTurnsShape["run"] = (caller, input) =>
      Effect.gen(function* () {
        const projectId = assistantProjectOfCaller(caller);
        if (projectId === null) {
          return yield* turnError(403, "Only an assistant's own token can run its schedule.");
        }
        const timeoutMs = (input.timeoutSec ?? ASSISTANT_SCHEDULE_DEFAULT_MINUTES * 60) * 1_000;
        const deadlineMs = Date.now() + timeoutMs;
        const threadId = yield* targetThread(projectId, caller.tokenId);
        yield* waitUntilIdle(threadId);
        const shell = yield* projections
          .getThreadShellById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const requestedAtIso = new Date().toISOString();
        const messageId = MessageId.make(crypto.randomUUID());
        yield* engine.dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(`assistant-schedule:${crypto.randomUUID()}`),
            threadId,
            message: {
              messageId,
              role: "user",
              text: wrapScheduledPrompt({
                ...(input.name ? { name: input.name } : {}),
                prompt: input.prompt,
              }),
              attachments: [],
            },
            // The assistant's own mode (full access by Misha's decision for
            // assistants) — never widened here.
            runtimeMode: Option.isSome(shell)
              ? shell.value.runtimeMode
              : ASSISTANT_THREAD_RUNTIME_MODE,
            interactionMode: Option.isSome(shell) ? shell.value.interactionMode : "default",
            createdAt: requestedAtIso,
          },
          { origin: assistantCommandOrigin({ assistantKey: projectId, tokenId: caller.tokenId }) },
        );
        yield* Effect.logInfo("assistant scheduled turn started").pipe(
          Effect.annotateLogs({ projectId, threadId, name: input.name ?? null }),
        );

        const reply = yield* awaitReply(threadId, messageId, requestedAtIso, deadlineMs);
        if (reply === null) {
          return { status: "timeout" as const, threadId, delivered: 0 };
        }
        if (isNoReply(reply.text)) {
          return { status: "no_reply" as const, threadId, delivered: 0 };
        }
        const text = reply.text.trim().length > 0 ? reply.text : "Done.";
        const chats = yield* notify.resolveChats({
          threadId,
          projectId,
          includeAssistantFallback: true,
          includeSlack: true,
        });
        const header = input.name ? `⏰ ${input.name}\n\n` : "";
        const sent = yield* notify.sendToChats(chats, `${header}${text}`);
        yield* Effect.logInfo("assistant scheduled turn answered").pipe(
          Effect.annotateLogs({ projectId, threadId, delivered: sent.delivered }),
        );
        return {
          status: sent.delivered > 0 ? ("delivered" as const) : ("undelivered" as const),
          threadId,
          delivered: sent.delivered,
        };
      }).pipe(
        // Engine / projection failures are the daemon's, not the request's.
        Effect.mapError((error) =>
          error instanceof AssistantTurnError
            ? error
            : turnError(
                500,
                `The scheduled turn could not start: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
        ),
      );

    return { run } satisfies AssistantScheduledTurnsShape;
  });

export const AssistantScheduledTurnsLive = Layer.effect(
  AssistantScheduledTurns,
  makeAssistantScheduledTurns(),
);
