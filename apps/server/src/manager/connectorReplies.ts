/**
 * Replies to Telegram / Slack messages — the part both connectors share.
 *
 * A chat message that reaches an assistant becomes a pending reply
 * (`manager_connector_pending_replies`) BEFORE its turn is dispatched. A
 * single watcher loop per connector then owns every open row until the
 * person has the answer:
 *
 * - **Bound to its turn, not to the clock.** The answer is the final
 *   assistant message of the turn the row's own user message started
 *   (`projection_turns.pendingMessageId`, else the session's active turn
 *   right after the dispatch). It never reads "the newest message after
 *   time T", which used to hand one message's answer to the next one.
 * - **One turn per thread at a time.** A message that arrives while the
 *   thread is busy waits as `queued` and is dispatched once the thread is
 *   free, so every message gets its own turn and its own answer. Harnesses
 *   serialize prompts anyway (hermes holds a prompt lock); queueing here
 *   keeps the turn ↔ message link the projections lose on overlap.
 * - **No deadline.** A turn may run for hours: the chat sees the native
 *   "typing…" every few seconds and, rarely, one short human note that the
 *   work goes on ({@link progressNoteText}). Never "check the app".
 * - **Survives restarts.** Rows are on disk; the loop picks every open row
 *   up on start. A turn the restart cut off is dispatched again (with the
 *   original message) at most {@link MAX_RESUME_ATTEMPTS} times; a long
 *   answer half sent when the daemon died continues at the next part.
 * - **Nothing lost.** Long answers go out in parts ({@link splitReplyText});
 *   `[[send-file: …]]` files follow the text.
 *
 * The decision itself is the pure {@link decidePendingReply}; the transport
 * (how to type, send, upload) is the connector's {@link ReplyTransport}.
 *
 * @module manager/connectorReplies
 */
import {
  CommandId,
  MessageId,
  type ChatAttachment,
  type OrchestrationThread,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { cleanUnoFinalAnswerText } from "@t3tools/shared/unoFinalAnswer";
import { Clock, Duration, Effect, Option, Ref, Semaphore } from "effect";
import * as crypto from "node:crypto";
import * as nodePath from "node:path";

import { connectorCommandOrigin } from "../orchestration/commandOrigin.ts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "../orchestration/orphanedSession.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ManagerConnectorPendingReplyRepository,
  type ConnectorPendingReply,
} from "../persistence/Services/ManagerConnectorPendingReplies.ts";
import type { ManagerConnectorKind } from "../persistence/Services/ManagerConnectors.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import { resolveConnectorOutgoingFile } from "./connectorOutgoingFiles.ts";
import {
  progressNoteDueAfterMs,
  progressNoteText,
  splitReplyText,
  type ReplyLanguage,
} from "./connectorReplyText.ts";
import { extractOutgoingFiles } from "./telegramMedia.ts";

// ── Timings ─────────────────────────────────────────────────────────────

/** How often the loop looks at open rows. */
export const REPLY_TICK = Duration.seconds(2);
/** Telegram's "typing…" lasts ~5 s; renew it this often while a turn runs. */
export const TYPING_RENEW_MS = 4_000;
/**
 * A settled turn's final message must sit still this long before it goes
 * out: hermes resolves the prompt a moment before the last text lands.
 */
export const SETTLE_QUIET_MS = 3_000;
/**
 * A settled turn with no text at all waits this long for a late message
 * before it is answered with "Done." (hermes writes its answer after the
 * turn already ended).
 */
export const NO_TEXT_GRACE_MS = 45_000;
/** No sign of the dispatched turn this long while the thread is idle: it is lost. */
export const LOST_TURN_MS = 3 * 60_000;
/** A thread that vanished (deleted) this long ago is given up. */
export const MISSING_THREAD_MS = 2 * 60_000;
/** A restart (or a harness crash) cuts a turn off: re-run it at most this often. */
export const MAX_RESUME_ATTEMPTS = 2;
/** A message queued behind a turn running this long hears that it is queued. */
export const QUEUED_NOTE_AFTER_MS = 20_000;
/** A send that failed for a passing reason is retried after this long. */
export const SEND_RETRY_MS = 30_000;
/** ...and given up after this many failed ticks in a row. */
export const SEND_MAX_FAILURES = 40;
/** Settled rows stay this long (dedupe of replayed updates), then are pruned. */
export const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60_000;

const ACTIVE_SESSION_STATUSES: ReadonlySet<string> = new Set(["starting", "running"]);
const DEAD_SESSION_STATUSES: ReadonlySet<string> = new Set(["stopped", "error"]);

const toMs = (iso: string | null | undefined): number =>
  iso === null || iso === undefined ? 0 : new Date(iso).getTime();

// ── The decision ────────────────────────────────────────────────────────

export interface ReplyProbeMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReplyProbe {
  /** The user message the row dispatched. */
  readonly userMessageId: string;
  readonly requestedAt: string;
  /** The turn already attributed to the row (persisted), if any. */
  readonly knownTurnId: string | null;
  /** Turns other rows of the thread answer with: never this row's answer. */
  readonly claimedTurnIds: ReadonlySet<string>;
  readonly messages: ReadonlyArray<ReplyProbeMessage>;
  readonly turns: ReadonlyArray<
    Pick<ProjectionTurn, "turnId" | "pendingMessageId" | "state" | "requestedAt" | "completedAt">
  >;
  readonly session: {
    readonly status: string;
    readonly activeTurnId: string | null;
    readonly updatedAt: string;
    readonly lastError: string | null;
  } | null;
  readonly activities: ReadonlyArray<{
    readonly kind: string;
    readonly turnId: string | null;
    readonly createdAt: string;
    readonly payload: unknown;
  }>;
  readonly nowMs: number;
}

export type ReplyVerdict =
  | { readonly kind: "wait"; readonly turnId: string | null }
  | {
      readonly kind: "answer";
      readonly turnId: string | null;
      /** Clean text (marker and send-file lines stripped), not truncated; may be empty. */
      readonly text: string;
      readonly files: ReadonlyArray<string>;
    }
  /** The turn was cut off (restart, harness crash) or never started: run it again. */
  | { readonly kind: "lost"; readonly turnId: string | null; readonly reason: string }
  /** The person stopped the turn in Uno Work; `partial` is what it had said. */
  | { readonly kind: "stopped"; readonly turnId: string | null; readonly partial: string | null }
  /** The turn failed for a reason a re-run would not fix (billing, provider). */
  | { readonly kind: "failed"; readonly turnId: string | null; readonly reason: string };

const turnStartFailure = (probe: ReplyProbe): string | null => {
  const failure = probe.activities.findLast(
    (activity) =>
      activity.kind === "provider.turn.start.failed" && activity.createdAt >= probe.requestedAt,
  );
  if (failure === undefined) return null;
  const detail = (failure.payload as { readonly detail?: unknown } | null)?.detail;
  return typeof detail === "string" && detail.trim().length > 0
    ? detail.trim()
    : "the assistant could not start";
};

/** The turn answering the row's message, if it can be told yet. */
const attributeTurn = (probe: ReplyProbe): string | null => {
  if (probe.knownTurnId !== null) return probe.knownTurnId;
  const byMessage = probe.turns.find(
    (turn) => turn.turnId !== null && turn.pendingMessageId === probe.userMessageId,
  );
  if (byMessage?.turnId != null) return byMessage.turnId;
  const session = probe.session;
  const active = session?.activeTurnId ?? null;
  if (
    session !== null &&
    session.status === "running" &&
    active !== null &&
    !probe.claimedTurnIds.has(active) &&
    session.updatedAt >= probe.requestedAt &&
    probe.messages.some((message) => message.id === probe.userMessageId)
  ) {
    // A turn row that names another message is someone else's turn.
    const row = probe.turns.find((turn) => turn.turnId === active);
    if (
      row === undefined ||
      row.pendingMessageId === null ||
      row.pendingMessageId === probe.userMessageId
    ) {
      return active;
    }
  }
  return null;
};

/** Activities that mean the turn is doing work (not bookkeeping like token usage). */
const isWorkActivity = (kind: string) =>
  kind.startsWith("tool.") ||
  kind.startsWith("task.") ||
  kind.startsWith("approval.") ||
  kind.startsWith("user-input.");

const cleanAnswer = (text: string) => extractOutgoingFiles(cleanUnoFinalAnswerText(text));

/**
 * What to do for one pending reply right now. Pure: every input is in the
 * probe, so it is replayed in tests exactly as the loop sees it.
 */
export const decidePendingReply = (probe: ReplyProbe): ReplyVerdict => {
  const turnId = attributeTurn(probe);
  const session = probe.session;
  const requestedMs = toMs(probe.requestedAt);

  const ownAssistant = probe.messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.text.trim().length > 0 &&
      (turnId !== null
        ? message.turnId === turnId
        : message.createdAt >= probe.requestedAt &&
          (message.turnId === null || !probe.claimedTurnIds.has(message.turnId))),
  );
  const streaming = ownAssistant.some((message) => message.streaming);
  const final = ownAssistant.findLast((message) => !message.streaming) ?? null;
  const turnRow = turnId === null ? undefined : probe.turns.find((turn) => turn.turnId === turnId);

  // When the turn last did something (a tool, a task) — a message older
  // than that is a pre-tool chunk, not the answer.
  const lastWorkMs = Math.max(
    0,
    ...probe.activities
      .filter(
        (activity) =>
          isWorkActivity(activity.kind) &&
          (turnId !== null ? activity.turnId === turnId : activity.createdAt >= probe.requestedAt),
      )
      .map((activity) => toMs(activity.createdAt)),
  );

  const startFailure = turnStartFailure(probe);
  if (startFailure !== null && turnId === null) {
    return { kind: "failed", turnId, reason: startFailure };
  }

  const sessionDied =
    session !== null &&
    DEAD_SESSION_STATUSES.has(session.status) &&
    session.updatedAt >= probe.requestedAt;
  if (sessionDied) {
    // Did the turn finish before the session went away? Its last message
    // came after everything else the turn did, and nothing followed it for
    // a while: a pre-tool chunk is always followed by the tool's activity.
    if (final !== null && session.lastError !== ORPHANED_PROVIDER_SESSION_ERROR) {
      const finalMs = toMs(final.updatedAt);
      if (finalMs >= lastWorkMs && toMs(session.updatedAt) - finalMs >= 10_000) {
        const { text, files } = cleanAnswer(final.text);
        return { kind: "answer", turnId, text, files };
      }
    }
    const cutOff =
      session.status === "stopped" || session.lastError === ORPHANED_PROVIDER_SESSION_ERROR;
    if (cutOff) {
      return {
        kind: "lost",
        turnId,
        reason: session.lastError ?? "the assistant stopped before finishing",
      };
    }
    return {
      kind: "failed",
      turnId,
      reason: session.lastError ?? "the assistant stopped with an error",
    };
  }

  if (session !== null && ACTIVE_SESSION_STATUSES.has(session.status)) {
    // Another turn running after ours ended means ours is settled.
    const runningAnother =
      turnId !== null && session.activeTurnId !== null && session.activeTurnId !== turnId;
    if (!runningAnother) return { kind: "wait", turnId };
  }

  if (streaming) return { kind: "wait", turnId };

  const settledAtMs = Math.max(requestedMs, toMs(session?.updatedAt));
  if (final !== null) {
    if (probe.nowMs - Math.max(settledAtMs, toMs(final.updatedAt)) < SETTLE_QUIET_MS) {
      return { kind: "wait", turnId };
    }
    // The turn worked on after its last message: the answer is still on its
    // way (hermes ends the prompt before the final text lands). Give it the
    // grace, then take what there is.
    if (toMs(final.updatedAt) < lastWorkMs && probe.nowMs - settledAtMs < NO_TEXT_GRACE_MS) {
      return { kind: "wait", turnId };
    }
    const { text, files } = cleanAnswer(final.text);
    if (turnRow?.state === "interrupted") {
      return { kind: "stopped", turnId, partial: text.length > 0 ? text : null };
    }
    return { kind: "answer", turnId, text, files };
  }

  if (turnId === null) {
    // Nothing of our turn yet and the thread is idle: give the dispatch a
    // few minutes (a cold harness start), then call it lost.
    if (probe.nowMs - settledAtMs < LOST_TURN_MS) return { kind: "wait", turnId };
    return { kind: "lost", turnId, reason: "the turn never started" };
  }

  const terminalMs = Math.max(settledAtMs, toMs(turnRow?.completedAt));
  if (probe.nowMs - terminalMs < NO_TEXT_GRACE_MS) return { kind: "wait", turnId };
  if (turnRow?.state === "interrupted") return { kind: "stopped", turnId, partial: null };
  if (turnRow?.state === "error") {
    return { kind: "failed", turnId, reason: session?.lastError ?? "the turn ended with an error" };
  }
  return { kind: "answer", turnId, text: "", files: [] };
};

// ── Texts the watcher itself says ───────────────────────────────────────

const say = (language: ReplyLanguage, ru: string, en: string) => (language === "ru" ? ru : en);

export const doneText = (language: ReplyLanguage) => say(language, "Готово.", "Done.");

export const stoppedText = (language: ReplyLanguage) =>
  say(language, "Остановлено в Uno Work.", "Stopped in Uno Work.");

export const failedText = (language: ReplyLanguage, reason: string) =>
  say(
    language,
    `Не получилось ответить на это сообщение: ${reason}\nНапишите ещё раз — попробую снова.`,
    `I couldn't finish this one: ${reason}\nSend it again and I'll retry.`,
  );

export const queuedText = (language: ReplyLanguage) =>
  say(
    language,
    "Получил. Отвечу на это, как закончу с предыдущим.",
    "Got it — I'll answer this right after the current task.",
  );

export const threadGoneText = (language: ReplyLanguage) =>
  say(
    language,
    "Этот чат удалили в Uno Work, поэтому ответа не будет. Напишите ещё раз — начну новый.",
    "This chat was deleted in Uno Work, so there is no answer. Write again to start a new one.",
  );

export const fileRefusedText = (language: ReplyLanguage, name: string, reason: string) =>
  say(language, `Не могу отправить ${name}: ${reason}.`, `Could not send ${name}: ${reason}.`);

/** The re-run of a turn a restart cut off: the original message, framed. */
export const resumePromptText = (original: string) =>
  [
    "[Uno Work restarted while you were working on this message, so that work was cut off. " +
      "Continue from where it stopped (check what is already done) and send the full answer.]",
    "",
    original,
  ].join("\n");

// ── The loop ────────────────────────────────────────────────────────────

/** What a row's `meta` holds for the loop (connectors may add their own keys). */
export interface PendingReplyMeta {
  readonly dispatch: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  };
  /** The queued note went out. */
  readonly queuedNoteSent?: boolean;
  /** When the row's turn was first dispatched (a queued row waited before). */
  readonly dispatchedAt?: string;
  readonly [key: string]: unknown;
}

export const readMeta = (row: ConnectorPendingReply): PendingReplyMeta =>
  (row.meta ?? {}) as PendingReplyMeta;

/** `ok`: sent; `retry`: a passing failure (network, 5xx, not connected); `gone`: never will. */
export type SendOutcome = "ok" | "retry" | "gone";

export interface ReplyTransport {
  readonly kind: ManagerConnectorKind;
  /** Characters per message. */
  readonly limit: number;
  /** Renew the "typing…" signal (best effort; called every few seconds per row). */
  readonly typing: (row: ConnectorPendingReply) => Effect.Effect<void>;
  /**
   * Send one text part. `asReply` marks the first part of an answer or a
   * note (Telegram quotes the person's message); `newerInChat` says the
   * person wrote more in this chat since (a flat Slack DM threads the
   * answer under its own message then).
   */
  readonly sendText: (
    row: ConnectorPendingReply,
    text: string,
    options: { readonly asReply: boolean; readonly newerInChat: boolean },
  ) => Effect.Effect<SendOutcome>;
  readonly sendFile: (row: ConnectorPendingReply, path: string) => Effect.Effect<SendOutcome>;
  /** The row is settled; `delivered`: the answer is out (opens the addressing hot window). */
  readonly onSettled: (row: ConnectorPendingReply, delivered: boolean) => Effect.Effect<void>;
  readonly logPrefix: string;
}

export interface NewPendingReply {
  readonly connectorProjectId: ProjectId;
  readonly replyKey: string;
  readonly chatId: string;
  readonly replyTo: string | null;
  readonly replyThread: string | null;
  readonly threadId: ThreadId;
  readonly language: ReplyLanguage;
  readonly dispatch: PendingReplyMeta["dispatch"];
  /** Extra connector bits kept with the row. */
  readonly extraMeta?: Readonly<Record<string, unknown>>;
}

export type EnqueueOutcome = "dispatched" | "queued" | "duplicate";

interface SendState {
  readonly failures: number;
  readonly retryAtMs: number;
}

const rowId = (row: ConnectorPendingReply) =>
  `${row.kind}:${row.connectorProjectId}:${row.replyKey}`;

/**
 * Start the watcher loop for one connector kind. Returns `enqueue`, which
 * stores a pending reply and dispatches its turn when the thread is free.
 */
export const makeConnectorReplies = (transport: ReplyTransport) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorPendingReplyRepository;
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const turnRepository = yield* ProjectionTurnRepository;

    const typingAtRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const sendStateRef = yield* Ref.make<ReadonlyMap<string, SendState>>(new Map());
    const missingSinceRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const lastPruneRef = yield* Ref.make(0);
    // The loop and a fresh message both act on rows: one at a time, or a
    // queued row could be dispatched (or told it waits) twice.
    const rowsLock = yield* Semaphore.make(1);
    const exclusive = rowsLock.withPermits(1);

    const nowIso = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));

    const save = (row: ConnectorPendingReply) =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const next = { ...row, updatedAt };
        yield* repository.save(next);
        return next;
      });

    const loadThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const detail = yield* projections
          .getThreadDetailById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));
        const turns = yield* turnRepository
          .listByThreadId({ threadId })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<ProjectionTurn> => []));
        return { detail: Option.getOrNull(detail), turns };
      });

    // ── dispatch ──

    const dispatchTurn = (row: ConnectorPendingReply, text: string, messageId: MessageId) =>
      Effect.gen(function* () {
        const meta = readMeta(row);
        const createdAt = yield* nowIso;
        yield* engine.dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(`${transport.kind}:${crypto.randomUUID()}`),
            threadId: row.threadId,
            message: {
              messageId,
              role: "user",
              text,
              attachments: [...meta.dispatch.attachments],
            },
            runtimeMode: meta.dispatch.runtimeMode,
            interactionMode: meta.dispatch.interactionMode,
            createdAt,
          },
          { origin: connectorCommandOrigin(transport.kind, row.chatId) },
        );
        return createdAt;
      });

    /**
     * Whether the thread can take a new turn for `row`: no other reply of
     * it is in flight and the harness is not busy with someone else's turn
     * (the person typing in the app, a scheduled turn).
     */
    const threadBusy = (row: ConnectorPendingReply) =>
      Effect.gen(function* () {
        const rows = yield* repository.listByThread({ threadId: row.threadId, limit: 50 });
        const ahead = rows.find(
          (other) =>
            rowId(other) !== rowId(row) &&
            (other.status === "waiting" ||
              (other.status === "queued" && other.createdAt < row.createdAt)),
        );
        if (ahead !== undefined) {
          return { busy: true as const, sinceMs: toMs(ahead.requestedAt) };
        }
        const { detail, turns } = yield* loadThread(row.threadId);
        const nowMs = yield* Clock.currentTimeMillis;
        const session = detail?.session ?? null;
        if (session !== null && ACTIVE_SESSION_STATUSES.has(session.status)) {
          return { busy: true as const, sinceMs: toMs(session.updatedAt) };
        }
        const pendingStart = turns.find(
          (turn) =>
            turn.turnId === null &&
            turn.state === "pending" &&
            nowMs - toMs(turn.requestedAt) < LOST_TURN_MS,
        );
        if (pendingStart !== undefined) {
          return { busy: true as const, sinceMs: toMs(pendingStart.requestedAt) };
        }
        return { busy: false as const, sinceMs: 0 };
      });

    const tryDispatchQueued = (row: ConnectorPendingReply) =>
      Effect.gen(function* () {
        const busy = yield* threadBusy(row);
        const nowMs = yield* Clock.currentTimeMillis;
        if (busy.busy) {
          const meta = readMeta(row);
          if (meta.queuedNoteSent !== true && nowMs - busy.sinceMs >= QUEUED_NOTE_AFTER_MS) {
            const outcome = yield* transport.sendText(row, queuedText(row.language), {
              asReply: true,
              newerInChat: false,
            });
            if (outcome !== "retry") {
              return yield* save({ ...row, meta: { ...meta, queuedNoteSent: true } });
            }
          }
          return row;
        }
        // A crash between dispatch and the status write left it `queued`:
        // the message is in the thread already, do not send it twice.
        const { detail } = yield* loadThread(row.threadId);
        const alreadyIn =
          detail?.messages.some((message) => message.id === row.userMessageId) ?? false;
        const requestedAt = alreadyIn
          ? row.requestedAt
          : yield* dispatchTurn(row, readMeta(row).dispatch.text, row.userMessageId);
        return yield* save({
          ...row,
          status: "waiting",
          requestedAt,
          meta: { ...readMeta(row), dispatchedAt: readMeta(row).dispatchedAt ?? requestedAt },
        });
      });

    const enqueue = (input: NewPendingReply) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const row: ConnectorPendingReply = {
          kind: transport.kind,
          connectorProjectId: input.connectorProjectId,
          replyKey: input.replyKey,
          chatId: input.chatId,
          replyTo: input.replyTo,
          replyThread: input.replyThread,
          threadId: input.threadId,
          userMessageId: MessageId.make(crypto.randomUUID()),
          turnId: null,
          requestedAt: createdAt,
          language: input.language,
          meta: { ...input.extraMeta, dispatch: input.dispatch } satisfies PendingReplyMeta,
          status: "queued",
          progressNotes: 0,
          resumeAttempts: 0,
          deliveredParts: 0,
          error: null,
          createdAt,
          updatedAt: createdAt,
        };
        return yield* exclusive(
          Effect.gen(function* () {
            const inserted = yield* repository.insertIfAbsent(row);
            if (!inserted) return "duplicate" as const;
            const next = yield* tryDispatchQueued(row);
            return next.status === "waiting" ? ("dispatched" as const) : ("queued" as const);
          }),
        );
      });

    // ── delivery ──

    /** The person wrote more in the same chat after this row's message. */
    const hasNewerInChat = (row: ConnectorPendingReply) =>
      repository.listByThread({ threadId: row.threadId, limit: 50 }).pipe(
        Effect.map((rows) =>
          rows.some(
            (other) =>
              other.kind === row.kind &&
              other.connectorProjectId === row.connectorProjectId &&
              other.chatId === row.chatId &&
              other.createdAt > row.createdAt,
          ),
        ),
        Effect.orElseSucceed(() => false),
      );

    const recordSendFailure = (row: ConnectorPendingReply, nowMs: number) =>
      Ref.modify(sendStateRef, (map) => {
        const failures = (map.get(rowId(row))?.failures ?? 0) + 1;
        const next = new Map(map);
        next.set(rowId(row), { failures, retryAtMs: nowMs + SEND_RETRY_MS });
        return [failures, next] as const;
      });

    const clearSendState = (row: ConnectorPendingReply) =>
      Ref.update(sendStateRef, (map) => {
        if (!map.has(rowId(row))) return map;
        const next = new Map(map);
        next.delete(rowId(row));
        return next;
      });

    const settle = (
      row: ConnectorPendingReply,
      status: "delivered" | "failed",
      error: string | null,
    ) =>
      Effect.gen(function* () {
        yield* clearSendState(row);
        const forget = <V>(map: ReadonlyMap<string, V>) => {
          const next = new Map(map);
          next.delete(rowId(row));
          return next;
        };
        yield* Ref.update(typingAtRef, forget);
        yield* Ref.update(missingSinceRef, forget);
        const next = yield* save({ ...row, status, error });
        yield* transport.onSettled(next, status === "delivered");
        return next;
      });

    type Part =
      | { readonly kind: "text"; readonly text: string }
      | { readonly kind: "file"; readonly path: string };

    /**
     * Send `parts` from `row.deliveredParts` on, persisting progress after
     * each part, then settle the row. A passing failure leaves the row as is
     * for a later tick.
     */
    const deliver = (
      row: ConnectorPendingReply,
      parts: ReadonlyArray<Part>,
      finalStatus: "delivered" | "failed",
      error: string | null,
    ) =>
      Effect.gen(function* () {
        let current = row;
        const newerInChat = yield* hasNewerInChat(row);
        for (let index = current.deliveredParts; index < parts.length; index += 1) {
          const part = parts[index]!;
          let outcome: SendOutcome;
          if (part.kind === "text") {
            outcome = yield* transport.sendText(current, part.text, {
              asReply: index === 0,
              newerInChat,
            });
          } else {
            outcome = yield* sendOneFile(current, part.path, newerInChat);
          }
          if (outcome === "retry") {
            const nowMs = yield* Clock.currentTimeMillis;
            const failures = yield* recordSendFailure(current, nowMs);
            if (failures < SEND_MAX_FAILURES) return current;
            yield* Effect.logWarning(`${transport.logPrefix} reply delivery gave up`).pipe(
              Effect.annotateLogs({ chatId: current.chatId, replyKey: current.replyKey }),
            );
            return yield* settle(current, "failed", "delivery kept failing");
          }
          if (outcome === "gone") {
            return yield* settle(current, "failed", "the chat refused the message");
          }
          current = yield* save({ ...current, deliveredParts: index + 1 });
        }
        return yield* settle(current, finalStatus, error);
      });

    const sendOneFile = (row: ConnectorPendingReply, rawPath: string, newerInChat: boolean) =>
      Effect.gen(function* () {
        const context = yield* projections
          .getThreadCheckpointContext(row.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const roots = Option.isSome(context)
          ? [context.value.worktreePath ?? context.value.workspaceRoot]
          : [];
        const resolved = yield* Effect.promise(() => resolveConnectorOutgoingFile(rawPath, roots));
        if (!resolved.ok) {
          yield* Effect.logWarning(`${transport.logPrefix} send-file refused`).pipe(
            Effect.annotateLogs({ chatId: row.chatId, filePath: rawPath, reason: resolved.reason }),
          );
          return yield* transport.sendText(
            row,
            fileRefusedText(row.language, nodePath.basename(rawPath), resolved.reason),
            { asReply: false, newerInChat },
          );
        }
        return yield* transport.sendFile(row, resolved.path);
      });

    const answerParts = (text: string, files: ReadonlyArray<string>, language: ReplyLanguage) => {
      const textParts = splitReplyText(text, transport.limit);
      const parts: Array<Part> = textParts.map((part) => ({ kind: "text", text: part }));
      if (parts.length === 0 && files.length === 0)
        parts.push({ kind: "text", text: doneText(language) });
      for (const path of files) parts.push({ kind: "file", path });
      return parts;
    };

    // ── one row ──

    const resume = (row: ConnectorPendingReply, reason: string) =>
      Effect.gen(function* () {
        if (row.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
          return yield* deliver(
            row,
            [{ kind: "text", text: failedText(row.language, reason) }],
            "failed",
            reason,
          );
        }
        yield* Effect.logInfo(`${transport.logPrefix} turn cut off; running it again`).pipe(
          Effect.annotateLogs({ threadId: row.threadId, replyKey: row.replyKey, reason }),
        );
        const messageId = MessageId.make(crypto.randomUUID());
        const requestedAt = yield* dispatchTurn(
          row,
          resumePromptText(readMeta(row).dispatch.text),
          messageId,
        );
        return yield* save({
          ...row,
          userMessageId: messageId,
          requestedAt,
          turnId: null,
          resumeAttempts: row.resumeAttempts + 1,
        });
      });

    const progressIfDue = (row: ConnectorPendingReply, nowMs: number) =>
      Effect.gen(function* () {
        // Due from when its turn started (a queued message already heard
        // why it waits); the note itself tells how long the person waits.
        const startedMs = toMs(readMeta(row).dispatchedAt ?? row.createdAt);
        if (nowMs - startedMs < progressNoteDueAfterMs(row.progressNotes)) return row;
        const elapsedMs = nowMs - toMs(row.createdAt);
        const outcome = yield* transport.sendText(
          row,
          progressNoteText({ language: row.language, elapsedMs, first: row.progressNotes === 0 }),
          { asReply: true, newerInChat: yield* hasNewerInChat(row) },
        );
        if (outcome === "retry") return row;
        return yield* save({ ...row, progressNotes: row.progressNotes + 1 });
      });

    const typingIfDue = (row: ConnectorPendingReply, nowMs: number) =>
      Effect.gen(function* () {
        const key = rowId(row);
        const last = (yield* Ref.get(typingAtRef)).get(key) ?? 0;
        if (nowMs - last < TYPING_RENEW_MS) return;
        yield* Ref.update(typingAtRef, (map) => new Map(map).set(key, nowMs));
        yield* transport.typing(row);
      });

    const handleWaiting = (row: ConnectorPendingReply, nowMs: number) =>
      Effect.gen(function* () {
        const { detail, turns } = yield* loadThread(row.threadId);
        if (detail === null) {
          const since = (yield* Ref.get(missingSinceRef)).get(rowId(row));
          if (since === undefined) {
            yield* Ref.update(missingSinceRef, (map) => new Map(map).set(rowId(row), nowMs));
            return;
          }
          if (nowMs - since < MISSING_THREAD_MS) return;
          yield* deliver(
            row,
            [{ kind: "text", text: threadGoneText(row.language) }],
            "failed",
            "thread gone",
          );
          return;
        }
        const siblings = yield* repository.listByThread({ threadId: row.threadId, limit: 50 });
        const claimedTurnIds = new Set(
          siblings
            .filter((other) => rowId(other) !== rowId(row) && other.turnId !== null)
            .map((other) => String(other.turnId)),
        );
        const verdict = decidePendingReply({
          userMessageId: row.userMessageId,
          requestedAt: row.requestedAt,
          knownTurnId: row.turnId,
          claimedTurnIds,
          messages: detail.messages,
          turns,
          session: detail.session,
          activities: detail.activities,
          nowMs,
        });
        let current = row;
        if (verdict.turnId !== null && verdict.turnId !== row.turnId) {
          current = yield* save({ ...current, turnId: TurnId.make(verdict.turnId) });
        }
        switch (verdict.kind) {
          case "wait": {
            yield* typingIfDue(current, nowMs);
            yield* progressIfDue(current, nowMs);
            return;
          }
          case "answer":
            yield* deliver(
              current,
              answerParts(verdict.text, verdict.files, current.language),
              "delivered",
              null,
            );
            return;
          case "stopped":
            yield* deliver(
              current,
              verdict.partial === null
                ? [{ kind: "text", text: stoppedText(current.language) }]
                : answerParts(verdict.partial, [], current.language),
              "delivered",
              "stopped in the app",
            );
            return;
          case "lost":
            yield* resume(current, verdict.reason);
            return;
          case "failed":
            yield* deliver(
              current,
              [{ kind: "text", text: failedText(current.language, verdict.reason) }],
              "failed",
              verdict.reason,
            );
            return;
        }
      });

    const handleRow = (row: ConnectorPendingReply, nowMs: number) =>
      Effect.gen(function* () {
        const sendState = (yield* Ref.get(sendStateRef)).get(rowId(row));
        if (sendState !== undefined && nowMs < sendState.retryAtMs) return;
        if (row.status === "queued") {
          // Queued behind another turn: "typing…" only — the queued note
          // already said why it waits.
          const next = yield* tryDispatchQueued(row);
          if (next.status === "queued") yield* typingIfDue(next, nowMs);
          return;
        }
        yield* handleWaiting(row, nowMs);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`${transport.logPrefix} reply watcher failed on a row`).pipe(
            Effect.annotateLogs({ replyKey: row.replyKey, threadId: row.threadId, cause }),
          ),
        ),
      );

    const pruneIfDue = (nowMs: number) =>
      Effect.gen(function* () {
        if (nowMs - (yield* Ref.get(lastPruneRef)) < 60 * 60_000) return;
        yield* Ref.set(lastPruneRef, nowMs);
        yield* repository
          .prune({ before: new Date(nowMs - SETTLED_RETENTION_MS).toISOString() })
          .pipe(Effect.ignore);
      });

    const tick = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      yield* pruneIfDue(nowMs);
      const rows = yield* repository.listOpen(transport.kind);
      // One thread's rows in order; threads side by side.
      const byThread = new Map<string, Array<ConnectorPendingReply>>();
      for (const row of rows) {
        const list = byThread.get(row.threadId) ?? [];
        list.push(row);
        byThread.set(row.threadId, list);
      }
      yield* Effect.forEach(
        [...byThread.values()],
        (threadRows) =>
          Effect.forEach(threadRows, (row) => handleRow(row, nowMs), { discard: true }),
        { concurrency: 4, discard: true },
      );
    }).pipe(
      exclusive,
      Effect.catchCause((cause) =>
        Effect.logWarning(`${transport.logPrefix} reply watcher tick failed`).pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
    );

    yield* Effect.forkScoped(Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(REPLY_TICK)))));

    /** Whether a message already has its pending reply (a replayed update). */
    const isKnown = (connectorProjectId: ProjectId, replyKey: string) =>
      repository.get({ kind: transport.kind, connectorProjectId, replyKey }).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      );

    return { enqueue, isKnown };
  });
