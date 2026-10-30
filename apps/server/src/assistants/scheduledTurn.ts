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
import { SCHEDULED_TASK_PREFIX } from "@t3tools/shared/secretRequestCopy";
import { Context, Data, Effect, Layer, Option } from "effect";

import { currentAssistantModelSelection } from "../manager/assistantEngineSelection.ts";
import { ASSISTANT_THREAD_RUNTIME_MODE } from "../manager/connectorBindings.ts";
import { decidePendingReply, isNoReply, stoppedText } from "../manager/connectorReplies.ts";
import { ConnectorNotifyService } from "../manager/Services/ConnectorNotify.ts";
import type { ManagerCaller } from "../manager/Services/ManagerToolService.ts";
import { assistantCommandOrigin, systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { assistantAccessDepsOption, readAssistantRuntimeMode } from "./assistantAccess.ts";
import { assistantProjectOfCaller } from "./schedules.ts";

/** Title of the thread scheduled turns run in for a non-default assistant. */
export const SCHEDULED_THREAD_TITLE = "Scheduled tasks";
/** How long a scheduled turn waits for a busy thread before giving up. */
const BUSY_WAIT_MS = 5 * 60_000;
const POLL_MS = 2_000;
/** How long a "lost" turn may come back before the run counts as cut off. */
const LOST_GRACE_MS = 90_000;

export class AssistantTurnError extends Data.TaggedError("AssistantTurnError")<{
  readonly message: string;
  readonly status: number;
}> {}

/** What the assistant reads: the schedule's instruction, framed. */
export function wrapScheduledPrompt(input: { readonly name?: string; readonly prompt: string }) {
  const title = input.name ? `"${input.name}"` : "";
  return [
    `${SCHEDULED_TASK_PREFIX}${title}— it runs on its own: the person is not in this chat right now.`,
    "Your final message is sent to them in Telegram/Slack, so make it short and useful.",
    `If there is nothing worth telling them, answer exactly ${ASSISTANT_TURN_NO_REPLY}.]`,
    "",
    input.prompt,
  ].join("\n");
}

export { isNoReply };

/**
 * A turn the daemon itself starts for an assistant on an event (the notes
 * of a call it sent the notetaker to — assistants/assistantCalls.ts): the
 * same thread rules, waiting, mode and delivery as a scheduled turn, with its
 * own thread title for assistants other than Uno and the prompt as given.
 */
export interface AssistantEventTurnInput {
  readonly projectId: ProjectId;
  readonly prompt: string;
  /** Put before the answer in Telegram/Slack ("📝 Pilot sync"). */
  readonly header: string;
  /** The thread of a non-default assistant ("Meetings"). */
  readonly threadTitle: string;
  readonly timeoutSec?: number;
  /** Who started it, for the command origin ("notetaker"). */
  readonly source: string;
}

/**
 * An event turn's outcome, plus the answer itself (automations keep it as
 * the run's summary): null on a timeout, `NO_REPLY` as it came.
 */
export type AssistantEventTurnResult = ManagerAssistantTurnResult & {
  readonly reply: string | null;
};

/**
 * A turn the daemon starts in a chat of the person (automations whose
 * executor is a chat, 29.10): "this chat" — a new message in that chat, with
 * its context, its own model and mode; "a new chat" — a new chat in the
 * project, copying the model and mode of the chat it was set up from. The
 * answer stays in the chat (no Telegram/Slack): the run's summary is it.
 */
export type ChatTurnTarget =
  | { readonly kind: "chat"; readonly threadId: string }
  | {
      readonly kind: "new_chat";
      readonly projectId: string;
      readonly fromThreadId?: string | undefined;
      readonly title: string;
    };

export interface ChatTurnInput {
  readonly target: ChatTurnTarget;
  readonly prompt: string;
  readonly timeoutSec?: number;
  /** Who started it, for the command origin ("automation 12"). */
  readonly reason: string;
  /**
   * The message carries a stranger's text (a site form, a webhook): the chat
   * goes to Ask mode, whatever its mode was, and stays there until the person
   * changes it. `onThread` runs before the turn starts.
   */
  readonly ask?: boolean;
  readonly onThread?: (threadId: string) => Effect.Effect<void>;
  /** How long to wait for a busy chat (default 5 minutes). */
  readonly busyWaitMs?: number;
}

export interface ChatTurnResult {
  readonly status: "answered" | "timeout";
  readonly threadId: string;
  readonly reply: string | null;
}

export interface AssistantScheduledTurnsShape {
  readonly run: (
    caller: ManagerCaller,
    input: ManagerAssistantTurnInput,
  ) => Effect.Effect<ManagerAssistantTurnResult, AssistantTurnError>;
  readonly runEvent: (
    input: AssistantEventTurnInput,
  ) => Effect.Effect<AssistantEventTurnResult, AssistantTurnError>;
  /** Optional: older wiring and tests without chats. */
  readonly runInChat?: (input: ChatTurnInput) => Effect.Effect<ChatTurnResult, AssistantTurnError>;
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
    const accessDeps = yield* assistantAccessDepsOption;
    /** The assistant's own mode: "Cautious" runs narrower than full access. */
    const ownRuntimeMode = (projectId: ProjectId) =>
      accessDeps === null
        ? Effect.succeed(ASSISTANT_THREAD_RUNTIME_MODE)
        : readAssistantRuntimeMode(accessDeps, projectId);
    const pollMs = options?.pollMs ?? POLL_MS;

    /** The thread a scheduled turn of `projectId` runs in (created if needed). */
    const targetThread = (projectId: ProjectId, tokenId: string, title = SCHEDULED_THREAD_TITLE) =>
      Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot();
        if (projectId === ASSISTANT_PROJECT_ID) {
          const main = findMarkedAssistantChat(snapshot.threads);
          if (main !== null) return main.id;
        }
        const existing = snapshot.threads.find(
          (thread) =>
            thread.projectId === projectId && thread.title === title && thread.archivedAt === null,
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
            title,
            modelSelection: yield* currentAssistantModelSelection(projections),
            runtimeMode: yield* ownRuntimeMode(projectId),
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

    const waitUntilIdle = (threadId: ThreadId, busyWaitMs = BUSY_WAIT_MS) =>
      Effect.gen(function* () {
        const deadline = Date.now() + busyWaitMs;
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
      failurePrefix = "The scheduled task could not finish",
    ) =>
      Effect.gen(function* () {
        let knownTurnId: string | null = null;
        // A harness session can show "stopped" for a moment mid-turn (Uno's
        // hermes between steps — live on stage 28.10): a "lost" verdict gets
        // a grace before it counts, the turn usually comes back with its answer.
        let lostSinceMs: number | null = null;
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
              lostSinceMs = null;
              continue;
            case "answer":
              return { text: verdict.text };
            case "stopped":
              return { text: verdict.partial ?? stoppedText("en") };
            case "lost":
              lostSinceMs ??= Date.now();
              if (Date.now() - lostSinceMs < LOST_GRACE_MS && Date.now() < deadlineMs) continue;
              return { text: `${failurePrefix}: ${verdict.reason}` };
            case "failed":
              return { text: `${failurePrefix}: ${verdict.reason}` };
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
        return yield* runIn({
          projectId,
          tokenId: caller.tokenId,
          threadTitle: SCHEDULED_THREAD_TITLE,
          text: wrapScheduledPrompt({
            ...(input.name ? { name: input.name } : {}),
            prompt: input.prompt,
          }),
          header: input.name ? `⏰ ${input.name}\n\n` : "",
          timeoutSec: input.timeoutSec ?? ASSISTANT_SCHEDULE_DEFAULT_MINUTES * 60,
          logName: input.name ?? null,
          failurePrefix: "The scheduled task could not finish",
        }).pipe(
          // The CLI's answer stays what it was: the status, not the text.
          Effect.map(({ reply: _reply, ...result }) => result),
        );
      });

    const runEvent: AssistantScheduledTurnsShape["runEvent"] = (input) =>
      runIn({
        projectId: input.projectId,
        tokenId: input.source,
        threadTitle: input.threadTitle,
        text: input.prompt,
        header: input.header,
        timeoutSec: input.timeoutSec ?? ASSISTANT_SCHEDULE_DEFAULT_MINUTES * 60,
        logName: input.source,
        failurePrefix: "The assistant could not finish",
      });

    const runIn = (input: {
      readonly projectId: ProjectId;
      readonly tokenId: string;
      readonly threadTitle: string;
      readonly text: string;
      readonly header: string;
      readonly timeoutSec: number;
      readonly logName: string | null;
      readonly failurePrefix: string;
    }) =>
      Effect.gen(function* () {
        const { projectId } = input;
        const caller = { tokenId: input.tokenId };
        const deadlineMs = Date.now() + input.timeoutSec * 1_000;
        const threadId = yield* targetThread(projectId, caller.tokenId, input.threadTitle);
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
              text: input.text,
              attachments: [],
            },
            // The assistant's own mode ("Autonomous" = full access,
            // "Cautious" = auto-accept-edits) — never widened here.
            runtimeMode: yield* ownRuntimeMode(projectId),
            interactionMode: Option.isSome(shell) ? shell.value.interactionMode : "default",
            createdAt: requestedAtIso,
          },
          { origin: assistantCommandOrigin({ assistantKey: projectId, tokenId: caller.tokenId }) },
        );
        yield* Effect.logInfo("assistant scheduled turn started").pipe(
          Effect.annotateLogs({ projectId, threadId, name: input.logName }),
        );

        const reply = yield* awaitReply(
          threadId,
          messageId,
          requestedAtIso,
          deadlineMs,
          input.failurePrefix,
        );
        if (reply === null) {
          return { status: "timeout" as const, threadId, delivered: 0, reply: null };
        }
        if (isNoReply(reply.text)) {
          return { status: "no_reply" as const, threadId, delivered: 0, reply: reply.text };
        }
        const text = reply.text.trim().length > 0 ? reply.text : "Done.";
        const chats = yield* notify.resolveChats({
          threadId,
          projectId,
          includeAssistantFallback: true,
          includeSlack: true,
        });
        const sent = yield* notify.sendToChats(chats, `${input.header}${text}`);
        yield* Effect.logInfo("assistant scheduled turn answered").pipe(
          Effect.annotateLogs({ projectId, threadId, delivered: sent.delivered }),
        );
        return {
          status: sent.delivered > 0 ? ("delivered" as const) : ("undelivered" as const),
          threadId,
          delivered: sent.delivered,
          reply: text,
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

    /** The chat a run of `target` goes into (a new one is created here). */
    const chatOf = (target: ChatTurnTarget, reason: string, ask: boolean) =>
      Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot();
        if (target.kind === "chat") {
          const thread = snapshot.threads.find((t) => t.id === target.threadId);
          if (thread === undefined || thread.archivedAt !== null) {
            return yield* turnError(
              404,
              "The chat this automation runs in was deleted or archived — pick another chat for it or delete it.",
            );
          }
          return thread.id;
        }
        const project = snapshot.projects.find((p) => p.id === target.projectId);
        if (project === undefined) {
          return yield* turnError(
            404,
            "The project this automation opens chats in isn't on this computer any more.",
          );
        }
        // Model and mode: the chat it was set up from, else the project's
        // newest chat, else the project's default model.
        const template =
          snapshot.threads.find((t) => t.id === target.fromThreadId) ??
          snapshot.threads
            .filter((t) => t.projectId === project.id && t.archivedAt === null)
            .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        const modelSelection = template?.modelSelection ?? project.defaultModelSelection;
        if (modelSelection === null || modelSelection === undefined) {
          return yield* turnError(
            409,
            "The project has no chat to copy a model from: open one chat in it first.",
          );
        }
        const threadId = ThreadId.make(crypto.randomUUID());
        yield* engine.dispatch(
          {
            type: "thread.create",
            commandId: CommandId.make(`automation:${crypto.randomUUID()}`),
            threadId,
            projectId: project.id,
            title: target.title,
            modelSelection,
            runtimeMode: ask ? "approval-required" : (template?.runtimeMode ?? "approval-required"),
            interactionMode: template?.interactionMode ?? "default",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
          { origin: systemCommandOrigin("automations", reason) },
        );
        return threadId;
      });

    const runInChat = (input: ChatTurnInput) =>
      Effect.gen(function* () {
        const deadlineMs = Date.now() + (input.timeoutSec ?? 30 * 60) * 1_000;
        const ask = input.ask === true;
        const threadId = yield* chatOf(input.target, input.reason, ask);
        if (input.onThread) yield* input.onThread(threadId);
        yield* waitUntilIdle(threadId, input.busyWaitMs);
        const shell = yield* projections
          .getThreadShellById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(shell)) {
          return yield* turnError(404, "The chat this automation runs in isn't there any more.");
        }
        const requestedAtIso = new Date().toISOString();
        const messageId = MessageId.make(crypto.randomUUID());
        yield* engine.dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(`automation:${crypto.randomUUID()}`),
            threadId,
            message: { messageId, role: "user", text: input.prompt, attachments: [] },
            // The chat's own mode — what the person chose for it; never
            // widened. A stranger's text narrows it to Ask.
            runtimeMode: ask ? "approval-required" : shell.value.runtimeMode,
            interactionMode: shell.value.interactionMode,
            createdAt: requestedAtIso,
          },
          { origin: systemCommandOrigin("automations", input.reason) },
        );
        yield* Effect.logInfo("automation chat turn started").pipe(
          Effect.annotateLogs({ threadId, target: input.target.kind, reason: input.reason }),
        );
        const reply = yield* awaitReply(
          threadId,
          messageId,
          requestedAtIso,
          deadlineMs,
          "The chat could not finish",
        );
        return reply === null
          ? { status: "timeout" as const, threadId, reply: null }
          : { status: "answered" as const, threadId, reply: reply.text };
      }).pipe(
        Effect.mapError((error) =>
          error instanceof AssistantTurnError
            ? error
            : turnError(
                500,
                `The automation could not start in the chat: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
        ),
      );

    return { run, runEvent, runInChat } satisfies AssistantScheduledTurnsShape;
  });

export const AssistantScheduledTurnsLive = Layer.effect(
  AssistantScheduledTurns,
  makeAssistantScheduledTurns(),
);
