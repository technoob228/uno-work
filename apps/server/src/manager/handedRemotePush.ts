/**
 * "Hand to…" across computers (T63-C) — the chat's computer's half of the
 * push (`Layers/AssistantPush.ts` wires it): what goes to a handler on
 * another computer, and what comes back from it. See
 * `remoteComputers/handedRemote.ts` for the two sides and why this one does
 * all the calling.
 *
 * - **Letters** (the brief, "the person wrote", "taken back") and the
 *   chat's **work updates** (Ready, errors) go to the handler's computer as
 *   they would into a chat here, in order; a computer that doesn't answer
 *   is tried again a minute later (the console wakes a sleeping one).
 * - **Pull**: every {@link HANDED_PULL_EVERY_MS} while the handler's computer
 *   is up (or was just written to), this computer brings the chat's status
 *   there and takes what the handler wrote into the chat — each message
 *   becomes a turn here, as from the handler (the decider lets the handler
 *   into a chat closed to other agents), when the chat is free, once.
 * - **Gone**: the handler deleted or archived there (or no longer handling
 *   it) → the chat comes back to the person (Needs you: "… was removed");
 *   that computer refusing the chat (a loop, too deep, too old) → back too,
 *   with its reason.
 *
 * @module manager/handedRemotePush
 */
import {
  CommandId,
  MessageId,
  THREAD_HANDLER_MAX_DEPTH,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { Clock, Effect, Option } from "effect";
import * as crypto from "node:crypto";

import { lastAssistantMessage } from "../agentThreads/logic.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { capRuntimeMode } from "../orchestration/projectThreadModes.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { handlerHopsAbove, handlerHopsBelow } from "../orchestration/threadHandler.ts";
import type { RemoteComputersServiceShape } from "../remoteComputers/RemoteComputers.ts";
import {
  HANDED_STATUS_MESSAGE_CHARS,
  handledFromElsewhere,
  pullHanded,
  sendHandedLetter,
  type HandedChatStatus,
  type HandedDelivery,
  type HandedInLedger,
  type HandedLetterInput,
} from "../remoteComputers/handedRemote.ts";
import { remoteStateWord } from "../remoteComputers/remoteChatHost.ts";
import {
  clipMiddle,
  formatPushNotice,
  rememberSent,
  type HandlerComputer,
  type PushBatch,
  type PushLetter,
  type PushState,
} from "./assistantPush.ts";
import { workStatusState } from "./workStatus.ts";

/** A handed chat's messages are fetched this often from its handler's computer. */
export const HANDED_PULL_EVERY_MS = 20_000;
/** ...also from a computer that looks asleep this long after it was written to (it woke). */
export const HANDED_WOKEN_MS = 10 * 60_000;
/** A computer that didn't answer is left alone this long. */
export const HANDED_RETRY_MS = 60_000;
/** A letter that has no answer in this long is tried again later (logged). */
export const HANDED_SEND_TIMEOUT_MS = 30_000;
/** Component of the system origin of what this module dispatches. */
export const HANDED_REMOTE_ORIGIN_COMPONENT = "hand-to-remote";

const deliveredKey = (messageId: string) => `handed-msg:${messageId}`;
const minutesBetween = (fromMs: number, toMs: number) =>
  Math.round(Math.max(0, toMs - fromMs) / 6_000) / 10;

export interface HandedRemotePushDeps {
  readonly remote: Pick<RemoteComputersServiceShape, "request" | "self" | "computerAwake">;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getThreadDetailById" | "getShellSnapshot"
  >;
  readonly getState: Effect.Effect<PushState>;
  readonly commit: (state: PushState) => Effect.Effect<void>;
  /** The chat can take a turn now. */
  readonly chatFree: (threadId: ThreadId) => Effect.Effect<boolean>;
  /** This computer's ledger of chats of OTHER computers handled here. */
  readonly handledHere: Effect.Effect<HandedInLedger>;
}

/**
 * Why handing `threadId` (to `handler`) breaks a rule only this computer's
 * ledger of chats handled from elsewhere knows (T63-C), or null:
 * - to another computer, a chat that handles chats of other computers;
 * - here, a chain whose leaves on other computers make it too deep.
 */
export function crossComputerRefusal(input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly threadId: string;
  readonly handler: {
    readonly threadId: string;
    readonly computer?: HandlerComputer | null | undefined;
  };
  readonly ledger: HandedInLedger;
}): string | null {
  const fromElsewhere = handledFromElsewhere(input.ledger, input.threadId).length;
  if (fromElsewhere === 0) return null;
  if ((input.handler.computer ?? null) !== null) {
    return "It handles chats of other computers itself, so it stays on this computer: hand it to a chat here.";
  }
  const below = Math.max(handlerHopsBelow(input.threads, input.threadId), 1);
  const above = handlerHopsAbove(input.threads, input.handler.threadId);
  return below + 1 + above > THREAD_HANDLER_MAX_DEPTH
    ? `Chats can be handed at most ${THREAD_HANDLER_MAX_DEPTH} levels deep (it handles chats of other computers).`
    : null;
}

export function makeHandedRemotePush(deps: HandedRemotePushDeps) {
  const retryAt = new Map<number, number>();
  const wroteAt = new Map<number, number>();
  const pulledAt = new Map<string, number>();
  /** Per chat: ids of the handler's messages put into it, acked with the next pull. */
  const acks = new Map<string, ReadonlyArray<string>>();
  /** Chats given back because their handing was refused: no "taken back" letter for them. */
  const refused = new Set<string>();
  /** Per computer: since when a letter to it hasn't got through (for the log). */
  const undeliveredSince = new Map<number, number>();

  const shellOf = (threadId: string) =>
    deps.projections.getThreadShellById(ThreadId.make(threadId)).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );

  const waiting = (boxId: number, nowMs: number) => (retryAt.get(boxId) ?? 0) > nowMs;

  /** Status of the chat as its handler's computer sees it. */
  const statusOf = (shell: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const detail = Option.getOrNull(
        yield* deps.projections
          .getThreadDetailById(shell.id)
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
      const last = detail === null ? null : lastAssistantMessage(detail.messages);
      const turns = shell.latestTurn === null ? [] : [shell.latestTurn];
      return {
        title: shell.title,
        state: remoteStateWord(workStatusState(shell, turns)),
        lastMessage: last === null ? null : clipMiddle(last, HANDED_STATUS_MESSAGE_CHARS),
        runtimeMode: shell.runtimeMode,
        updatedAt: shell.updatedAt,
      } satisfies HandedChatStatus;
    });

  /** The chat back with the person: the handler is gone there, or that computer refused it. */
  const giveBack = (input: {
    readonly threadId: string;
    readonly handlerThreadId: string;
    readonly reason: { readonly kind: "gone" } | { readonly kind: "refused"; readonly why: string };
  }) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(input.threadId);
      if (shell === null || shell.handler?.threadId !== input.handlerThreadId) return;
      const at = new Date(yield* Clock.currentTimeMillis).toISOString();
      const computer = shell.handler.computer?.name ?? "the other computer";
      if (input.reason.kind === "refused") refused.add(input.threadId);
      yield* deps.engine.dispatch(
        {
          type: "thread.handler.set",
          commandId: CommandId.make(`hand-to-remote:back:${crypto.randomUUID()}`),
          threadId: shell.id,
          handler: null,
          reason: input.reason.kind === "gone" ? "handler-gone" : "taken-back",
          createdAt: at,
        },
        {
          origin: systemCommandOrigin(
            HANDED_REMOTE_ORIGIN_COMPONENT,
            input.reason.kind === "gone" ? `handler gone on ${computer}` : `refused by ${computer}`,
          ),
        },
      );
      if (input.reason.kind === "refused") {
        yield* deps.engine.dispatch(
          {
            type: "thread.person.call",
            commandId: CommandId.make(`hand-to-remote:refused:${crypto.randomUUID()}`),
            threadId: shell.id,
            reason: `Not handed — ${computer}: ${input.reason.why}`.slice(0, 280),
            createdAt: at,
          },
          { origin: systemCommandOrigin(HANDED_REMOTE_ORIGIN_COMPONENT, "hand to refused") },
        );
      }
      yield* Effect.logInfo("hand to: chat given back from another computer").pipe(
        Effect.annotateLogs({ threadId: input.threadId, reason: input.reason.kind, computer }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("hand to: could not give a chat back").pipe(
          Effect.annotateLogs({ threadId: input.threadId, cause }),
        ),
      ),
    );

  /** Whether a "taken back" letter is owed for this change (not for a refused handing). */
  const takeRefused = (threadId: string): boolean => refused.delete(threadId);

  const send = (
    computer: HandlerComputer,
    body: Omit<HandedLetterInput, "from" | "status">,
    nowMs: number,
  ): Effect.Effect<HandedDelivery | null> =>
    Effect.gen(function* () {
      if (waiting(computer.boxId, nowMs)) return null;
      const self = yield* deps.remote.self;
      const shell = yield* shellOf(body.chat.threadId);
      const status = shell === null ? undefined : yield* statusOf(shell);
      const since = undeliveredSince.get(computer.boxId) ?? nowMs;
      const notes = {
        boxId: computer.boxId,
        computer: computer.name,
        kind: body.kind,
        retryInSeconds: HANDED_RETRY_MS / 1000,
        undeliveredMinutes: minutesBetween(since, nowMs),
      };
      const delivery = yield* sendHandedLetter(deps.remote.request, computer, {
        ...body,
        from: { computerName: self.name, boxId: self.boxId },
        ...(status !== undefined ? { status } : {}),
      }).pipe(
        Effect.timeoutOption(`${HANDED_SEND_TIMEOUT_MS} millis`),
        Effect.flatMap((value) =>
          Option.isSome(value)
            ? Effect.succeed(value.value)
            : // A busy or waking computer: no error, just no answer in time.
              Effect.logInfo("hand to: the handler's computer didn't answer a letter; retrying").pipe(
                Effect.annotateLogs({ ...notes, waitedSeconds: HANDED_SEND_TIMEOUT_MS / 1000 }),
                Effect.as(null),
              ),
        ),
        Effect.catch((error) =>
          Effect.logInfo("hand to: the handler's computer didn't take a letter; retrying").pipe(
            Effect.annotateLogs({ ...notes, code: error.code }),
            Effect.as(null),
          ),
        ),
      );
      if (delivery === null) {
        undeliveredSince.set(computer.boxId, since);
        retryAt.set(computer.boxId, nowMs + HANDED_RETRY_MS);
        return null;
      }
      if (undeliveredSince.delete(computer.boxId)) {
        yield* Effect.logInfo("hand to: a letter got through after retries").pipe(
          Effect.annotateLogs({
            boxId: computer.boxId,
            computer: computer.name,
            kind: body.kind,
            undeliveredMinutes: minutesBetween(since, nowMs),
          }),
        );
      }
      wroteAt.set(computer.boxId, nowMs);
      return delivery;
    });

  /** What a delivery that didn't land means for the chat. */
  const settle = (threadId: string, handlerThreadId: string, delivery: HandedDelivery) =>
    delivery.kind === "delivered"
      ? Effect.void
      : giveBack({
          threadId,
          handlerThreadId,
          reason:
            delivery.kind === "gone"
              ? { kind: "gone" }
              : { kind: "refused", why: delivery.message },
        });

  /** One letter to a handler on another computer. True: done with it (out of the queue). */
  const deliverLetter = (letter: PushLetter, nowMs: number) =>
    Effect.gen(function* () {
      const remote = letter.remote!;
      const shell = yield* shellOf(remote.chatThreadId);
      const delivery = yield* send(
        remote.computer,
        {
          handlerThreadId: letter.conversationThreadId,
          chat: { threadId: remote.chatThreadId, title: shell?.title ?? "" },
          kind: remote.kind,
          key: letter.key,
          text: letter.text,
        },
        nowMs,
      );
      if (delivery === null) return false;
      // "Off" letters change nothing here whatever the answer.
      if (remote.kind !== "off") {
        yield* settle(remote.chatThreadId, letter.conversationThreadId, delivery);
      }
      return true;
    });

  /** A batch of work updates for a handler on another computer. True: out of the outbox. */
  const deliverBatch = (batch: PushBatch, nowMs: number) =>
    Effect.gen(function* () {
      const first = batch.notices[0]!;
      const computer = first.handlerComputer!;
      const delivery = yield* send(
        computer,
        {
          handlerThreadId: batch.conversationThreadId,
          chat: { threadId: first.threadId, title: first.title },
          kind: "update",
          key: batch.notices.map((notice) => notice.key).join("|"),
          text: formatPushNotice(batch.notices),
        },
        nowMs,
      );
      if (delivery === null) return false;
      for (const threadId of new Set(batch.notices.map((notice) => notice.threadId))) {
        yield* settle(threadId, batch.conversationThreadId, delivery);
      }
      return true;
    });

  /** One handed chat: bring its status, take the handler's messages. */
  const pullOne = (input: {
    readonly threadId: string;
    readonly handlerThreadId: string;
    readonly computer: HandlerComputer;
    readonly nowMs: number;
  }) =>
    Effect.gen(function* () {
      const shell = yield* shellOf(input.threadId);
      if (
        shell === null ||
        shell.archivedAt !== null ||
        shell.handler?.threadId !== input.handlerThreadId
      ) {
        return;
      }
      const state = yield* deps.getState;
      const sent = new Set(state.sentKeys);
      const ackable = acks.get(input.threadId) ?? [];
      const result = yield* pullHanded(deps.remote.request, input.computer, input.threadId, {
        handlerThreadId: input.handlerThreadId,
        ack: ackable,
        status: yield* statusOf(shell),
      }).pipe(
        Effect.timeoutOption("30 seconds"),
        Effect.map((value) => (Option.isSome(value) ? value.value : undefined)),
        Effect.catch((error) =>
          Effect.logDebug("hand to: the handler's computer didn't answer a pull").pipe(
            Effect.annotateLogs({ boxId: input.computer.boxId, code: error.code }),
            Effect.as(undefined),
          ),
        ),
      );
      if (result === undefined) {
        retryAt.set(input.computer.boxId, input.nowMs + HANDED_RETRY_MS);
        return;
      }
      // Too old there: nothing to fetch; letters say so when they go.
      if (result === null) return;
      if (result.handler === "gone") {
        yield* giveBack({
          threadId: input.threadId,
          handlerThreadId: input.handlerThreadId,
          reason: { kind: "gone" },
        });
        return;
      }
      const delivered = result.messages.filter((message) => sent.has(deliveredKey(message.id)));
      let next = state;
      let dispatched = false;
      for (const message of result.messages) {
        if (sent.has(deliveredKey(message.id))) continue;
        // One turn at a time: the next waits for this one to end.
        if (dispatched || !(yield* deps.chatFree(shell.id))) break;
        yield* deps.engine.dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(`hand-to-remote:msg:${crypto.randomUUID()}`),
            threadId: shell.id,
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text: message.text,
              attachments: [],
            },
            // Never wider than the handler runs there.
            runtimeMode: capRuntimeMode(shell.runtimeMode, message.runtimeMode),
            interactionMode: shell.interactionMode,
            createdAt: new Date(input.nowMs).toISOString(),
          },
          // As from the handler: it may write into a chat closed to other agents.
          { origin: { kind: "agent", threadId: ThreadId.make(input.handlerThreadId) } },
        );
        next = rememberSent(next, deliveredKey(message.id));
        delivered.push(message);
        dispatched = true;
        yield* Effect.logInfo("hand to: a message from the handler on another computer").pipe(
          Effect.annotateLogs({
            threadId: input.threadId,
            handler: input.handlerThreadId,
            boxId: input.computer.boxId,
          }),
        );
      }
      if (next !== state) yield* deps.commit(next);
      acks.set(
        input.threadId,
        delivered.map((message) => message.id),
      );
    });

  /** Every handed chat whose handler is on another computer, when it is due. */
  const pull = (nowMs: number) =>
    Effect.gen(function* () {
      const state = yield* deps.getState;
      const awake = new Map<number, boolean>();
      for (const watch of state.watches) {
        const computer = watch.handlerComputer;
        if (watch.handed !== true || computer === undefined) continue;
        if (nowMs - (pulledAt.get(watch.threadId) ?? 0) < HANDED_PULL_EVERY_MS) continue;
        if (waiting(computer.boxId, nowMs)) continue;
        if (!awake.has(computer.boxId)) {
          const woken = nowMs - (wroteAt.get(computer.boxId) ?? 0) < HANDED_WOKEN_MS;
          awake.set(computer.boxId, woken || (yield* deps.remote.computerAwake(computer.boxId)));
        }
        // Asleep: nothing new can be there (the handler runs on that computer).
        if (awake.get(computer.boxId) !== true) continue;
        pulledAt.set(watch.threadId, nowMs);
        yield* pullOne({
          threadId: watch.threadId,
          handlerThreadId: watch.conversationThreadId,
          computer,
          nowMs,
        });
      }
      const live = new Set(state.watches.map((watch) => watch.threadId));
      for (const key of pulledAt.keys()) if (!live.has(key)) pulledAt.delete(key);
      for (const key of acks.keys()) if (!live.has(key)) acks.delete(key);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("hand to: pulling from another computer failed").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
    );

  /** See {@link crossComputerRefusal}; reads this computer's ledger. */
  const refusalFor = (input: {
    readonly threads: ReadonlyArray<OrchestrationThreadShell>;
    readonly threadId: string;
    readonly handler: {
      readonly threadId: string;
      readonly computer?: HandlerComputer | null | undefined;
    };
  }) =>
    deps.handledHere.pipe(
      Effect.map((ledger) => crossComputerRefusal({ ...input, ledger })),
      Effect.orElseSucceed(() => null),
    );

  /** A handing this computer refuses after the fact: back to the person, with why. */
  const refuseHere = (threadId: string, handlerThreadId: string, why: string) =>
    Effect.gen(function* () {
      refused.add(threadId);
      const at = new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* deps.engine.dispatch(
        {
          type: "thread.handler.set",
          commandId: CommandId.make(`hand-to-remote:refuse:${crypto.randomUUID()}`),
          threadId: ThreadId.make(threadId),
          handler: null,
          reason: "taken-back",
          createdAt: at,
        },
        { origin: systemCommandOrigin(HANDED_REMOTE_ORIGIN_COMPONENT, "hand to refused") },
      );
      yield* deps.engine.dispatch(
        {
          type: "thread.person.call",
          commandId: CommandId.make(`hand-to-remote:refuse-call:${crypto.randomUUID()}`),
          threadId: ThreadId.make(threadId),
          reason: `Not handed: ${why}`.slice(0, 280),
          createdAt: at,
        },
        { origin: systemCommandOrigin(HANDED_REMOTE_ORIGIN_COMPONENT, "hand to refused") },
      );
      yield* Effect.logInfo("hand to: refused (chats of other computers)").pipe(
        Effect.annotateLogs({ threadId, handler: handlerThreadId }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("hand to: could not undo a refused handing").pipe(
          Effect.annotateLogs({ threadId, cause }),
        ),
      ),
    );

  return { deliverLetter, deliverBatch, pull, refusalFor, refuseHere, takeRefused };
}

export type HandedRemotePush = ReturnType<typeof makeHandedRemotePush>;
