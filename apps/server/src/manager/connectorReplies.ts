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
  ASSISTANT_PROJECT_ID,
  ASSISTANT_TURN_NO_REPLY,
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
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { connectorCommandOrigin, systemCommandOrigin } from "../orchestration/commandOrigin.ts";
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
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveConnectorOutgoingFile } from "./connectorOutgoingFiles.ts";
import { driveLinkForFile, largeFileCloudDeps, largeFileText } from "./largeFileLink.ts";
import { queueOutgoingFile, takeOutgoingFiles } from "./outgoingFileQueue.ts";
import { makeThreadSendableRoots } from "./threadSendableRoots.ts";
import { assistantAccessDepsOption } from "../assistants/assistantAccess.ts";
import {
  fitReplyToScreen,
  progressNoteDueAfterMs,
  progressNoteText,
  splitReplyText,
  type ReplyLanguage,
} from "./connectorReplyText.ts";
import { UNO_WORK_OPEN_URL } from "./taskDoneNotify.ts";
import { currentWorkAddress } from "../workAddress.ts";
import { extractOutgoingFiles } from "./telegramMedia.ts";
import { decideLaunchTruth, launchCheckPromptText, notLaunchedText } from "./launchTruth.ts";
import {
  localDocumentsIn,
  REPORT_CHECK_MAX,
  reportCheckPromptText,
  withReportLink,
} from "./reportCheck.ts";
import { isReportSource, readReports, reportOfSource } from "../sites/reports.ts";

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
/**
 * How long the loop sleeps before a ready answer's quiet window ends: just
 * past it (the clock check is strict), never busy-spinning, never longer than
 * a normal round.
 */
export const replyPauseMs = (untilReadyMs: number): number =>
  Math.min(Duration.toMillis(REPLY_TICK), Math.max(50, Math.ceil(untilReadyMs) + 25));
/** A restart (or a harness crash) cuts a turn off: re-run it at most this often. */
export const MAX_RESUME_ATTEMPTS = 2;
/** A message queued behind a turn running this long hears that it is queued. */
export const QUEUED_NOTE_AFTER_MS = 20_000;
/**
 * The Uno chat (the pinned assistant, `assistant-home`) answers in seconds:
 * it is a dispatcher with no tools of its own to dig with. A turn of it
 * running this long is stopped ({@link watchdogPromptText}): the person's
 * next message never waits behind a quarter-hour of work again (Misha 29.10:
 * "Получил. Отвечу, как закончу с предыдущим" for 45 minutes).
 */
export const DISPATCHER_TURN_WATCHDOG_MS = 45_000;
/** After the watchdog's stop, the session gets this long to settle before the retry goes in. */
export const DISPATCHER_STOP_SETTLE_MS = 12_000;
/** Watchdog stops of one message before it is answered with {@link watchdogGiveUpText}. */
export const DISPATCHER_WATCHDOG_RETRIES = 1;

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
  | {
      readonly kind: "wait";
      readonly turnId: string | null;
      /** The answer is ready and only sitting out the quiet window: look again in this long. */
      readonly readyInMs?: number;
    }
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

/** The harness session went away under the start (it was being restarted): a new run starts one. */
const isSessionGone = (detail: string): boolean =>
  /ProviderAdapterSession(?:NotFound|Closed)Error|Unknown \S+ adapter thread/.test(detail);

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
    return { kind: isSessionGone(startFailure) ? "lost" : "failed", turnId, reason: startFailure };
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
      // The harness itself marked the turn completed (Uno's harness stops
      // its session a moment after the last message — live on stage 28.10):
      // the last text after the last tool is the answer, however soon the
      // session went away.
      const completed = turnRow?.state === "completed";
      if (finalMs >= lastWorkMs && (completed || toMs(session.updatedAt) - finalMs >= 10_000)) {
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
    const quietForMs = probe.nowMs - Math.max(settledAtMs, toMs(final.updatedAt));
    if (quietForMs < SETTLE_QUIET_MS) {
      return { kind: "wait", turnId, readyInMs: SETTLE_QUIET_MS - quietForMs };
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

const FAILURE_REASON_MAX = 300;

export const doneText = (language: ReplyLanguage) => say(language, "Готово.", "Done.");

export const stoppedText = (language: ReplyLanguage) =>
  say(language, "Остановлено в Uno Work.", "Stopped in Uno Work.");

/** What of a failure a person can read: no stack, no class names. Null: nothing. */
export const readableFailure = (reason: string): string | null => {
  const line = (reason.split("\n")[0] ?? "")
    .replace(/\s+at\s+\S+\s+\((?:file|node):.*$/, "")
    .trim();
  if (line.length === 0 || /^[A-Za-z]+Error\b/.test(line)) return null;
  return line.length > FAILURE_REASON_MAX ? `${line.slice(0, FAILURE_REASON_MAX)}…` : line;
};

export const failedText = (language: ReplyLanguage, reason: string) => {
  const readable = readableFailure(reason);
  return say(
    language,
    `Не получилось ответить на это сообщение${readable === null ? "." : `: ${readable}`}\nНапишите ещё раз — попробую снова.`,
    `I couldn't finish this one${readable === null ? "." : `: ${readable}`}\nSend it again and I'll retry.`,
  );
};

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

/** A big file over a slow line still ends in a line to the person. */
const LARGE_FILE_LINK_TIMEOUT = Duration.minutes(15);

export const fileRefusedText = (language: ReplyLanguage, name: string, reason: string) =>
  say(language, `Не могу отправить ${name}: ${reason}.`, `Could not send ${name}: ${reason}.`);

/** The re-run of a Uno turn the watchdog stopped: hand it off now, one line. */
export const watchdogPromptText = (original: string) =>
  [
    "[Uno Work: your turn on this message ran past 45 seconds and was stopped — the person " +
      "waits. Do not do the work yourself. In THIS turn, with at most one tool call: either " +
      "answer in one short line from what you already know, or hand the task off with ONE " +
      "chat_create (the project's folder as cwd) and answer one line: what you started.]",
    "",
    original,
  ].join("\n");

/** The watchdog stopped Uno twice on one message. */
export const watchdogGiveUpText = (language: ReplyLanguage) =>
  say(
    language,
    "Не успел ответить быстро и остановился, чтобы не держать чат. Напиши, в какой папке это сделать, — запущу отдельным чатом.",
    "I couldn't answer this quickly, so I stopped to keep the chat free. Tell me which folder it's for and I'll start it in a separate chat.",
  );

/** The re-run of a turn a restart cut off: the original message, framed. */
export const resumePromptText = (original: string) =>
  [
    "[Uno Work restarted while you were working on this message, so that work was cut off. " +
      "Continue from where it stopped (check what is already done) and send the full answer.]",
    "",
    original,
  ].join("\n");

/** NO_REPLY (any case, optional trailing dot) means: say nothing. */
export function isNoReply(text: string): boolean {
  return text.trim().replace(/\.$/, "").toUpperCase() === ASSISTANT_TURN_NO_REPLY;
}

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
  /** The watchdog stopped the row's current Uno turn at this time (cleared on the retry). */
  readonly watchdogStoppedAt?: string;
  /** Uno turns of this row the watchdog stopped and ran again. */
  readonly watchdogRetries?: number;
  /**
   * Hidden launch checks made for this row: Uno's answer said it started a
   * chat and its turn started none (`launchTruth.ts`). After one, a claim
   * with no call reaches the person as {@link notLaunchedText}.
   */
  readonly launchChecks?: number;
  /** Hidden report checks made for this row (`reportCheck.ts`). */
  readonly reportChecks?: number;
  /** When the row's turn was first dispatched (a queued row waited before). */
  readonly dispatchedAt?: string;
  /**
   * A turn the daemon started in the chat's conversation, not the person
   * (the assistant's work update, `assistantPush.ts`): system origin, no
   * "queued"/progress notes, NO_REPLY stays silent, and when the turn fails
   * the person gets {@link PendingReplyMeta.fallbackText} instead of
   * "send it again".
   */
  readonly systemTurn?: boolean;
  readonly fallbackText?: string;
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
  /** Bytes per file; a bigger file goes as a link (`largeFileLink.ts`). */
  readonly fileLimitBytes: number;
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

/** Origin component of a system turn's dispatch (`systemCommandOrigin`). */
export const SYSTEM_TURN_ORIGIN_COMPONENT = "assistant-push";

export interface SystemTurnInput {
  /** A row of the chat the turn answers to (its newest). */
  readonly from: ConnectorPendingReply;
  /** Unique per turn, e.g. `push:<uuid>`. */
  readonly replyKey: string;
  readonly text: string;
  /** Sent to the chat when the turn fails or says nothing. */
  readonly fallbackText: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

interface SendState {
  readonly failures: number;
  readonly retryAtMs: number;
}

const rowId = (row: ConnectorPendingReply) =>
  `${row.kind}:${row.connectorProjectId}:${row.replyKey}`;

/**
 * Whether a thread can take a new turn: no reply of it in flight ahead of
 * this one (`selfRowId` / `selfCreatedAt`: the row asking; null: anyone
 * else, e.g. the assistant's work update — then every open row is ahead),
 * and the harness is not busy with someone else's turn (the person typing
 * in the app, a scheduled turn).
 */
export const isThreadBusyForNewTurn = (input: {
  readonly rows: ReadonlyArray<ConnectorPendingReply>;
  readonly selfRowId: string | null;
  readonly selfCreatedAt: string | null;
  readonly session: { readonly status: string; readonly updatedAt: string } | null;
  readonly turns: ReadonlyArray<Pick<ProjectionTurn, "turnId" | "state" | "requestedAt">>;
  /** The thread's activities: a turn whose start failed is not on its way. */
  readonly activities?: ReadonlyArray<{ readonly kind: string; readonly createdAt: string }>;
  readonly nowMs: number;
}): { readonly busy: boolean; readonly sinceMs: number } => {
  const ahead = input.rows.find(
    (other) =>
      rowId(other) !== input.selfRowId &&
      (other.status === "waiting" ||
        (other.status === "queued" &&
          (input.selfCreatedAt === null || other.createdAt < input.selfCreatedAt))),
  );
  if (ahead !== undefined) return { busy: true, sinceMs: toMs(ahead.requestedAt) };
  const session = input.session;
  if (session !== null && ACTIVE_SESSION_STATUSES.has(session.status)) {
    return { busy: true, sinceMs: toMs(session.updatedAt) };
  }
  const startFailures = (input.activities ?? []).filter(
    (activity) => activity.kind === "provider.turn.start.failed",
  );
  const pendingStart = input.turns.find(
    (turn) =>
      turn.turnId === null &&
      turn.state === "pending" &&
      input.nowMs - toMs(turn.requestedAt) < LOST_TURN_MS &&
      !startFailures.some((failure) => failure.createdAt >= turn.requestedAt),
  );
  if (pendingStart !== undefined) return { busy: true, sinceMs: toMs(pendingStart.requestedAt) };
  return { busy: false, sinceMs: 0 };
};

/**
 * Start the watcher loop for one connector kind. Returns `enqueue`, which
 * stores a pending reply and dispatches its turn when the thread is free.
 */
export const makeConnectorReplies = (transport: ReplyTransport) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorPendingReplyRepository;
    const serverSettings = Option.getOrNull(yield* Effect.serviceOption(ServerSettingsService));
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const turnRepository = yield* ProjectionTurnRepository;
    const sendableRootsOf = makeThreadSendableRoots({
      projections,
      home: os.homedir(),
      access: yield* assistantAccessDepsOption,
    });

    const typingAtRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const sendStateRef = yield* Ref.make<ReadonlyMap<string, SendState>>(new Map());
    const missingSinceRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const lastPruneRef = yield* Ref.make(0);
    // An answer only sitting out SETTLE_QUIET_MS: the loop wakes for it right
    // then, not on its next 2 s round (up to 2 s off every Telegram reply).
    const nextWakeAtRef = yield* Ref.make<number | null>(null);
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

    // Whether a thread is the Uno chat's (project `assistant-home`): its
    // turns are short, so no "still working"/"queued" notes and a watchdog.
    const dispatcherRef = yield* Ref.make<ReadonlyMap<string, boolean>>(new Map());
    const isDispatcherThread = (
      threadId: ThreadId,
      detail: Pick<OrchestrationThread, "projectId"> | null,
    ) =>
      Effect.gen(function* () {
        const known = (yield* Ref.get(dispatcherRef)).get(threadId);
        if (known !== undefined) return known;
        if (detail === null) return false;
        const value = detail.projectId === ASSISTANT_PROJECT_ID;
        yield* Ref.update(dispatcherRef, (map) => new Map(map).set(threadId, value));
        return value;
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
          {
            origin:
              meta.systemTurn === true
                ? systemCommandOrigin(SYSTEM_TURN_ORIGIN_COMPONENT)
                : connectorCommandOrigin(transport.kind, row.chatId),
          },
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
        const { detail, turns } = yield* loadThread(row.threadId);
        const busy = isThreadBusyForNewTurn({
          rows,
          selfRowId: rowId(row),
          selfCreatedAt: row.createdAt,
          session: detail?.session ?? null,
          turns,
          ...(detail ? { activities: detail.activities } : {}),
          nowMs: yield* Clock.currentTimeMillis,
        });
        return { ...busy, dispatcher: yield* isDispatcherThread(row.threadId, detail) };
      });

    const tryDispatchQueued = (row: ConnectorPendingReply) =>
      Effect.gen(function* () {
        const busy = yield* threadBusy(row);
        const nowMs = yield* Clock.currentTimeMillis;
        if (busy.busy) {
          const meta = readMeta(row);
          // The Uno chat's turn ends within the watchdog: "typing…" says enough.
          if (
            meta.systemTurn !== true &&
            !busy.dispatcher &&
            meta.queuedNoteSent !== true &&
            nowMs - busy.sinceMs >= QUEUED_NOTE_AFTER_MS
          ) {
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
        const roots = yield* sendableRootsOf(row.threadId);
        const resolved = yield* Effect.promise(() =>
          resolveConnectorOutgoingFile(rawPath, roots, os.homedir()),
        );
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
        const size = yield* Effect.promise(() =>
          fsPromises.stat(resolved.path).then(
            (stat) => stat.size,
            () => 0,
          ),
        );
        if (size <= transport.fileLimitBytes) return yield* transport.sendFile(row, resolved.path);
        // Copying takes minutes: the reply loop goes on, the link comes after.
        yield* sendAsLink(row, resolved.path, size).pipe(Effect.forkDetach);
        return "ok" as const;
      });

    /** The file through Uno Drive, one line for the person. Never fails. */
    const sendAsLink = (row: ConnectorPendingReply, file: string, sizeBytes: number) =>
      Effect.gen(function* () {
        const current =
          serverSettings === null
            ? null
            : yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
        const cloud = current === null ? null : largeFileCloudDeps(current);
        const url =
          cloud === null
            ? null
            : yield* Effect.tryPromise(() => driveLinkForFile(cloud, file)).pipe(
                Effect.timeoutOption(LARGE_FILE_LINK_TIMEOUT),
                Effect.map(Option.getOrNull),
                Effect.tapError((cause) =>
                  Effect.logWarning(`${transport.logPrefix} large file link failed`).pipe(
                    Effect.annotateLogs({ chatId: row.chatId, cause: String(cause) }),
                  ),
                ),
                Effect.orElseSucceed(() => null),
              );
        yield* transport.sendText(
          row,
          largeFileText({
            language: row.language,
            name: nodePath.basename(file),
            sizeBytes,
            chat: transport.kind === "telegram" ? "Telegram" : "Slack",
            url,
            moreUrl: currentWorkAddress() ?? UNO_WORK_OPEN_URL,
          }),
          { asReply: false, newerInChat: false },
        );
      }).pipe(Effect.ignore);

    const answerParts = (
      text: string,
      files: ReadonlyArray<string>,
      language: ReplyLanguage,
      /** The Uno chat: one phone screen at most ({@link fitReplyToScreen}). */
      screen = false,
    ) => {
      const fitted = screen
        ? fitReplyToScreen(text, {
            language,
            moreUrl: currentWorkAddress() ?? UNO_WORK_OPEN_URL,
          }).text
        : text;
      const textParts = splitReplyText(fitted, transport.limit);
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

    // ── the Uno chat's watchdog ──

    /** Stop the row's running Uno turn; the next ticks settle it ({@link afterWatchdogStop}). */
    const watchdogStop = (row: ConnectorPendingReply, turnId: string | null) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* Effect.logInfo(
          `${transport.logPrefix} Uno turn ran past the watchdog; stopping it`,
        ).pipe(Effect.annotateLogs({ threadId: row.threadId, replyKey: row.replyKey, turnId }));
        yield* engine
          .dispatch(
            {
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`${transport.kind}:watchdog:${crypto.randomUUID()}`),
              threadId: row.threadId,
              ...(turnId !== null ? { turnId: TurnId.make(turnId) } : {}),
              createdAt,
            },
            { origin: systemCommandOrigin(SYSTEM_TURN_ORIGIN_COMPONENT) },
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`${transport.logPrefix} watchdog interrupt failed`).pipe(
                Effect.annotateLogs({ threadId: row.threadId, cause }),
              ),
            ),
          );
        return yield* save({ ...row, meta: { ...readMeta(row), watchdogStoppedAt: createdAt } });
      });

    /**
     * The stopped turn has settled: run the message once more, told to hand
     * it off in one line; stopped again → one line to the person. A work
     * update (system turn) gets its facts instead.
     */
    const afterWatchdogStop = (row: ConnectorPendingReply) =>
      Effect.gen(function* () {
        const meta = readMeta(row);
        if (meta.systemTurn === true) {
          return yield* deliver(row, fallbackParts(row), "delivered", "watchdog");
        }
        const retries = meta.watchdogRetries ?? 0;
        if (retries >= DISPATCHER_WATCHDOG_RETRIES) {
          return yield* deliver(
            row,
            [{ kind: "text", text: watchdogGiveUpText(row.language) }],
            "delivered",
            "watchdog",
          );
        }
        const messageId = MessageId.make(crypto.randomUUID());
        const requestedAt = yield* dispatchTurn(
          row,
          watchdogPromptText(meta.dispatch.text),
          messageId,
        );
        const { watchdogStoppedAt: _stopped, ...rest } = meta;
        return yield* save({
          ...row,
          userMessageId: messageId,
          requestedAt,
          turnId: null,
          meta: { ...rest, watchdogRetries: retries + 1 },
        });
      });

    // ── the Uno chat's launch check ──

    /**
     * Uno answered "запустил" and its turn started no chat: before anything
     * reaches the person, ask it once (a quiet "(Uno Work)" note in the app)
     * to call chat_create now or say it did not start it.
     */
    const launchCheck = (row: ConnectorPendingReply, turnId: string | null) =>
      Effect.gen(function* () {
        const meta = readMeta(row);
        yield* Effect.logInfo(
          `${transport.logPrefix} Uno said it started a chat but started none; asking it once`,
        ).pipe(Effect.annotateLogs({ threadId: row.threadId, replyKey: row.replyKey, turnId }));
        const messageId = MessageId.make(crypto.randomUUID());
        const requestedAt = yield* dispatchTurn(
          row,
          launchCheckPromptText(meta.dispatch.text),
          messageId,
        );
        return yield* save({
          ...row,
          userMessageId: messageId,
          requestedAt,
          turnId: null,
          meta: { ...meta, launchChecks: (meta.launchChecks ?? 0) + 1 },
        });
      });

    /**
     * Uno's answer names a local document and has no link: the report's link
     * when there is one, else one hidden "(Uno Work)" question to publish it
     * (`reportCheck.ts`). True: the answer waits for that turn.
     */
    const reportNet = (row: ConnectorPendingReply, text: string, nowMs: number) =>
      Effect.gen(function* () {
        const documents = localDocumentsIn(text);
        if (documents.length === 0) return { checking: false, text };
        const roots = yield* sendableRootsOf(row.threadId);
        for (const document of documents) {
          const resolved = yield* Effect.promise(() =>
            resolveConnectorOutgoingFile(document, roots, os.homedir()),
          );
          if (!resolved.ok || !isReportSource(resolved.path)) continue;
          const reports = yield* Effect.promise(() => readReports(os.homedir()));
          const report = reportOfSource(reports, resolved.path, nowMs);
          if (report !== null) {
            return { checking: false, text: withReportLink(text, report.url, row.language) };
          }
          const meta = readMeta(row);
          if ((meta.reportChecks ?? 0) >= REPORT_CHECK_MAX) continue;
          yield* Effect.logInfo(
            `${transport.logPrefix} Uno named a file with no link; asking it once to publish`,
          ).pipe(Effect.annotateLogs({ threadId: row.threadId, replyKey: row.replyKey }));
          const messageId = MessageId.make(crypto.randomUUID());
          const requestedAt = yield* dispatchTurn(row, reportCheckPromptText(document), messageId);
          yield* save({
            ...row,
            userMessageId: messageId,
            requestedAt,
            turnId: null,
            meta: { ...meta, reportChecks: (meta.reportChecks ?? 0) + 1 },
          });
          return { checking: true, text };
        }
        return { checking: false, text };
      });

    const typingIfDue = (row: ConnectorPendingReply, nowMs: number) =>
      Effect.gen(function* () {
        const key = rowId(row);
        const last = (yield* Ref.get(typingAtRef)).get(key) ?? 0;
        if (nowMs - last < TYPING_RENEW_MS) return;
        yield* Ref.update(typingAtRef, (map) => new Map(map).set(key, nowMs));
        yield* transport.typing(row);
      });

    /** The person's copy of a system turn's facts, when the assistant could not answer. */
    const fallbackParts = (row: ConnectorPendingReply): ReadonlyArray<Part> => {
      const text = readMeta(row).fallbackText?.trim() ?? "";
      return text.length > 0 ? [{ kind: "text", text }] : [];
    };

    /** A system turn (see {@link PendingReplyMeta.systemTurn}): nobody wrote, nobody waits. */
    const handleSystemVerdict = (
      row: ConnectorPendingReply,
      verdict: ReplyVerdict,
      nowMs: number,
      screen: boolean,
    ) =>
      Effect.gen(function* () {
        switch (verdict.kind) {
          case "wait":
            yield* typingIfDue(row, nowMs);
            return;
          case "answer":
            if (verdict.files.length === 0 && isNoReply(verdict.text)) {
              yield* settle(row, "delivered", "no reply");
              return;
            }
            yield* deliver(
              row,
              verdict.text.trim().length === 0 && verdict.files.length === 0
                ? fallbackParts(row)
                : answerParts(verdict.text, verdict.files, row.language, screen),
              "delivered",
              null,
            );
            return;
          case "stopped":
            yield* settle(row, "delivered", "stopped in the app");
            return;
          case "lost":
            if (row.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
              yield* deliver(row, fallbackParts(row), "failed", verdict.reason);
              return;
            }
            yield* resume(row, verdict.reason);
            return;
          case "failed":
            yield* deliver(row, fallbackParts(row), "failed", verdict.reason);
            return;
        }
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
            readMeta(row).systemTurn === true
              ? []
              : [{ kind: "text", text: threadGoneText(row.language) }],
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
        const decided = decidePendingReply({
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
        // Files `send_file` queued in this turn go with its answer.
        const queuedFiles = decided.kind === "answer" ? takeOutgoingFiles(row.threadId) : [];
        let verdict: ReplyVerdict =
          decided.kind === "answer" && queuedFiles.length > 0
            ? { ...decided, files: [...new Set([...decided.files, ...queuedFiles])] }
            : decided;
        if (verdict.kind === "wait" && verdict.readyInMs !== undefined) {
          const wakeAt = nowMs + verdict.readyInMs;
          yield* Ref.update(nextWakeAtRef, (at) => (at === null ? wakeAt : Math.min(at, wakeAt)));
        }
        let current = row;
        if (verdict.turnId !== null && verdict.turnId !== row.turnId) {
          current = yield* save({ ...current, turnId: TurnId.make(verdict.turnId) });
        }
        const dispatcher = yield* isDispatcherThread(row.threadId, detail);
        if (dispatcher) {
          const stoppedAt = readMeta(current).watchdogStoppedAt;
          if (stoppedAt !== undefined) {
            // Stopped by the watchdog: the projection says "ready" at once,
            // while the adapter may still drop a stuck prompt and restart the
            // session ~10 s later. A retry sent before that dies with it.
            if (nowMs - toMs(stoppedAt) < DISPATCHER_STOP_SETTLE_MS) {
              if (readMeta(current).systemTurn !== true) yield* typingIfDue(current, nowMs);
              return;
            }
            return yield* afterWatchdogStop(current);
          }
          if (verdict.kind === "wait" && verdict.turnId !== null) {
            const turn = turns.find((entry) => entry.turnId === verdict.turnId);
            const startedMs = toMs(turn?.startedAt ?? current.requestedAt);
            if (nowMs - startedMs >= DISPATCHER_TURN_WATCHDOG_MS) {
              yield* watchdogStop(current, verdict.turnId);
              return;
            }
          }
        }
        // The person never gets a "started" that started nothing (launchTruth.ts).
        if (dispatcher && verdict.kind === "answer") {
          const truth = decideLaunchTruth({
            text: verdict.text,
            activities: detail.activities,
            turnId: verdict.turnId,
            checksMade: readMeta(current).launchChecks ?? 0,
          });
          if (truth.kind === "check") {
            // Files queued for this answer go with the answer after the check.
            for (const file of queuedFiles) queueOutgoingFile(row.threadId, file);
            yield* launchCheck(current, verdict.turnId);
            return;
          }
          if (truth.kind === "correct") {
            yield* Effect.logWarning(
              `${transport.logPrefix} Uno claimed a launch again without one; telling the person it did not start`,
            ).pipe(Effect.annotateLogs({ threadId: row.threadId, replyKey: row.replyKey }));
            verdict = { ...verdict, text: notLaunchedText(current.language) };
          }
          if (verdict.files.length === 0) {
            const net = yield* reportNet(current, verdict.text, nowMs);
            if (net.checking) return;
            verdict = { ...verdict, text: net.text };
          }
        }
        if (readMeta(current).systemTurn === true) {
          return yield* handleSystemVerdict(current, verdict, nowMs, dispatcher);
        }
        switch (verdict.kind) {
          case "wait": {
            yield* typingIfDue(current, nowMs);
            // The Uno chat never says "still working": its watchdog ends the turn.
            if (!dispatcher) {
              yield* progressIfDue(current, nowMs);
            }
            return;
          }
          case "answer":
            // It already wrote to the person itself (messenger_send with
            // buttons) and says nothing more.
            if (verdict.files.length === 0 && isNoReply(verdict.text)) {
              yield* settle(current, "delivered", "no reply");
              return;
            }
            yield* deliver(
              current,
              answerParts(verdict.text, verdict.files, current.language, dispatcher),
              "delivered",
              null,
            );
            return;
          case "stopped":
            yield* deliver(
              current,
              verdict.partial === null
                ? [{ kind: "text", text: stoppedText(current.language) }]
                : answerParts(verdict.partial, [], current.language, dispatcher),
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
          // A system turn waiting its place: nobody wrote, so no "typing…".
          if (next.status === "queued" && readMeta(next).systemTurn !== true) {
            yield* typingIfDue(next, nowMs);
          }
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

    const pause = Effect.gen(function* () {
      const wakeAt = yield* Ref.getAndSet(nextWakeAtRef, null);
      if (wakeAt === null) return yield* Effect.sleep(REPLY_TICK);
      const nowMs = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Duration.millis(replyPauseMs(wakeAt - nowMs)));
    });

    yield* Effect.forkScoped(Effect.forever(tick.pipe(Effect.andThen(pause))));

    /** Whether a message already has its pending reply (a replayed update). */
    const isKnown = (connectorProjectId: ProjectId, replyKey: string) =>
      repository.get({ kind: transport.kind, connectorProjectId, replyKey }).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      );

    /**
     * A turn the daemon starts in a chat's conversation (the assistant's work
     * update): queued like a message of that chat, answered to that chat —
     * `from` is a row of it (where it lives, its language, thread and
     * identity). Never quotes a message: the person did not write one.
     */
    const enqueueSystemTurn = (input: SystemTurnInput) =>
      enqueue({
        connectorProjectId: input.from.connectorProjectId,
        replyKey: input.replyKey,
        chatId: input.from.chatId,
        replyTo: null,
        replyThread: input.from.replyThread,
        threadId: input.from.threadId,
        language: input.from.language,
        dispatch: {
          text: input.text,
          attachments: [],
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
        },
        extraMeta: {
          ...(typeof readMeta(input.from).identityProjectId === "string"
            ? { identityProjectId: readMeta(input.from).identityProjectId }
            : {}),
          systemTurn: true,
          fallbackText: input.fallbackText,
        },
      });

    return { enqueue, enqueueSystemTurn, isKnown };
  });
