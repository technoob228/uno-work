/**
 * "Hand to…" across computers (T63-C, Misha 26.11): a chat on one computer of
 * the account handed to a chat or an assistant on ANOTHER one — e.g. a chat
 * on the Mac handed to a coordinator on the cloud computer "uno-work".
 *
 * Two sides, one rule: **the chat's computer does all the calling.** It
 * reaches the handler's computer through the console's pairing (an owner
 * session, `remoteDaemonClient.ts`), exactly like starting a chat there; the
 * handler's computer never calls back. So a Mac (no box, not reachable) can
 * hand its chats to a cloud computer, no port opens anywhere, and nothing
 * new trusts anyone: only computers of the same account pair.
 *
 * On the HANDLER's computer (this module's host, `http.ts` routes):
 * - `POST /api/manager/handed-chats/letters` — a letter for the handler: the
 *   brief (registers the chat here), a work update (its Ready / errors), "the
 *   person wrote in it", or "off" (taken back, handed elsewhere, put away:
 *   unregisters). Queued as the handler's turn when it is free
 *   (AssistantPush letters). 410 `handler_gone`: the handler is deleted or
 *   archived — the chat's computer gives the chat back to the person.
 * - `POST /api/manager/handed-chats/:threadId/pull` — the chat's computer
 *   brings the chat's status (title, state, last answer, mode), acks what it
 *   delivered, and takes what the handler wrote into the chat since
 *   (`chat_message` from the handler lands in an outbox here, `chat_status`
 *   reads the status brought last).
 *
 * Loops can't cross computers: a chat handed to another computer handles
 * nothing itself, and a chat that handles chats of other computers is never
 * handed to another computer (`threadHandler.ts` `remoteHandlerRefusal`, the
 * host's own check below, AssistantPush's check with this ledger). The depth
 * limit is counted on the handler's side, where the whole chain is known.
 *
 * @module remoteComputers/handedRemote
 */
import * as crypto from "node:crypto";
import * as nodePath from "node:path";

import {
  RuntimeMode,
  THREAD_HANDLER_MAX_DEPTH,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";

import {
  assistantStoreDir,
  readStoreJson,
  updateStoreJson,
} from "../assistants/localAssistantStore.ts";
import { handlerHopsAbove } from "../orchestration/threadHandler.ts";
import { isRuntimeModeWider } from "../orchestration/projectThreadModes.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { remoteError, type RemoteComputerError } from "./remoteDaemonClient.ts";

export const HANDED_CHATS_PATH = "/api/manager/handed-chats";

/** Biggest letter / message that crosses (a brief is well under it). */
export const HANDED_TEXT_MAX_CHARS = 20_000;
/** Messages of the handler that wait for the chat's computer to fetch them. */
export const HANDED_OUTBOX_LIMIT = 20;
/** How much of the chat's last answer its status carries. */
export const HANDED_STATUS_MESSAGE_CHARS = 4_000;
/** A handed chat whose computer hasn't come for this long is forgotten here. */
export const HANDED_IN_STALE_MS = 14 * 24 * 60 * 60_000;

// ── wire shapes ──────────────────────────────────────────────────────────

export const HandedChatStatus = Schema.Struct({
  title: Schema.String,
  /** `ManagerRemoteChatStatus.state` words: running, idle, completed, failed, waiting-for-you, stopped. */
  state: Schema.String,
  lastMessage: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  updatedAt: Schema.String,
});
export type HandedChatStatus = typeof HandedChatStatus.Type;

export const HandedLetterKind = Schema.Literals(["brief", "update", "off"]);
export type HandedLetterKind = typeof HandedLetterKind.Type;

export const HandedLetterInput = Schema.Struct({
  handlerThreadId: Schema.String,
  chat: Schema.Struct({ threadId: Schema.String, title: Schema.String }),
  from: Schema.Struct({ computerName: Schema.String, boxId: Schema.NullOr(Schema.Number) }),
  kind: HandedLetterKind,
  /** Dedupe: a letter sent twice (a lost answer, a retry) is queued once. */
  key: Schema.String,
  text: Schema.String,
  status: Schema.optional(HandedChatStatus),
});
export type HandedLetterInput = typeof HandedLetterInput.Type;

export const HandedPullInput = Schema.Struct({
  handlerThreadId: Schema.String,
  /** Ids of the handler's messages the chat's computer has put into the chat. */
  ack: Schema.Array(Schema.String),
  status: Schema.optional(HandedChatStatus),
});
export type HandedPullInput = typeof HandedPullInput.Type;

export interface HandedOutMessage {
  readonly id: string;
  readonly text: string;
  readonly at: string;
  /** The handler's own mode: the turn there runs in no wider. */
  readonly runtimeMode: RuntimeMode;
}

export interface HandedPullResult {
  readonly handler: "active" | "gone";
  readonly handlerTitle: string | null;
  readonly messages: ReadonlyArray<HandedOutMessage>;
}

// ── the ledger on the handler's computer ─────────────────────────────────

export interface HandedInEntry {
  readonly chatThreadId: string;
  readonly title: string;
  readonly fromComputerName: string;
  readonly fromBoxId: number | null;
  readonly handlerThreadId: string;
  readonly handedAt: string;
  /** Last time the chat's computer wrote or came for messages. */
  readonly seenAt: string;
  readonly status: HandedChatStatus | null;
  readonly outbox: ReadonlyArray<HandedOutMessage>;
  /** Letter keys already queued (dedupe), newest last. */
  readonly keys: ReadonlyArray<string>;
}

export type HandedInLedger = Readonly<Record<string, HandedInEntry>>;

const KEYS_KEPT = 50;

const ledgerFile = (stateDir: string) =>
  nodePath.join(assistantStoreDir(stateDir), "handed-chats-in.json");

export async function readHandedIn(stateDir: string): Promise<HandedInLedger> {
  const raw = await readStoreJson<Record<string, HandedInEntry>>(ledgerFile(stateDir), {});
  return Object.fromEntries(
    Object.entries(raw).filter(
      ([, entry]) =>
        typeof entry?.chatThreadId === "string" && typeof entry.handlerThreadId === "string",
    ),
  );
}

export function updateHandedIn<A>(
  stateDir: string,
  change: (ledger: HandedInLedger) => { readonly ledger: HandedInLedger; readonly result: A },
): Promise<A> {
  let result: A | undefined;
  return updateStoreJson<Record<string, HandedInEntry>>(ledgerFile(stateDir), {}, (current) => {
    const next = change(current);
    result = next.result;
    return { ...next.ledger };
  }).then(() => result as A);
}

/** The chats of other computers `handlerThreadId` handles here. */
export const handledFromElsewhere = (
  ledger: HandedInLedger,
  handlerThreadId: string,
): ReadonlyArray<HandedInEntry> =>
  Object.values(ledger).filter((entry) => entry.handlerThreadId === handlerThreadId);

const pruneStale = (ledger: HandedInLedger, nowMs: number): HandedInLedger =>
  Object.fromEntries(
    Object.entries(ledger).filter(
      ([, entry]) => nowMs - (Date.parse(entry.seenAt) || 0) < HANDED_IN_STALE_MS,
    ),
  );

/** A letter's effect on the ledger, and whether to queue it for the handler. */
export function applyLetter(
  ledger: HandedInLedger,
  input: HandedLetterInput,
  nowIso: string,
): {
  readonly ledger: HandedInLedger;
  readonly result: "queue" | "duplicate" | "not_handling";
} {
  const chatId = input.chat.threadId;
  const entry = ledger[chatId];
  const mine = entry !== undefined && entry.handlerThreadId === input.handlerThreadId;
  if (mine && entry.keys.includes(input.key)) return { ledger, result: "duplicate" };
  const remember = (base: HandedInEntry): HandedInEntry => ({
    ...base,
    title: input.chat.title || base.title,
    seenAt: nowIso,
    ...(input.status !== undefined ? { status: input.status } : {}),
    keys: [...base.keys, input.key].slice(-KEYS_KEPT),
  });
  if (input.kind === "brief") {
    const fresh: HandedInEntry = {
      chatThreadId: chatId,
      title: input.chat.title,
      fromComputerName: input.from.computerName,
      fromBoxId: input.from.boxId,
      handlerThreadId: input.handlerThreadId,
      handedAt: nowIso,
      seenAt: nowIso,
      status: input.status ?? null,
      // Handed again (or to another chat here): what the old handler wrote
      // and the chat never fetched is not this handler's.
      outbox: mine ? entry.outbox : [],
      keys: mine ? entry.keys : [],
    };
    return { ledger: { ...ledger, [chatId]: remember(fresh) }, result: "queue" };
  }
  if (!mine) return { ledger, result: "not_handling" };
  if (input.kind === "off") {
    const { [chatId]: _gone, ...rest } = ledger;
    return { ledger: rest, result: "queue" };
  }
  return { ledger: { ...ledger, [chatId]: remember(entry) }, result: "queue" };
}

/** A pull: drop what was delivered, keep the status brought. */
export function applyPull(
  ledger: HandedInLedger,
  chatThreadId: string,
  input: HandedPullInput,
  nowIso: string,
): { readonly ledger: HandedInLedger; readonly result: HandedInEntry | null } {
  const entry = ledger[chatThreadId];
  if (entry === undefined || entry.handlerThreadId !== input.handlerThreadId) {
    return { ledger, result: null };
  }
  const acked = new Set(input.ack);
  const next: HandedInEntry = {
    ...entry,
    seenAt: nowIso,
    ...(input.status !== undefined ? { status: input.status, title: input.status.title } : {}),
    outbox: entry.outbox.filter((message) => !acked.has(message.id)),
  };
  return { ledger: { ...ledger, [chatThreadId]: next }, result: next };
}

// ── the host ─────────────────────────────────────────────────────────────

export interface HandedHostReply {
  readonly status: number;
  readonly body: unknown;
}

export interface HandedHostDeps {
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getThreadShellById" | "getShellSnapshot"
  >;
  readonly read: Effect.Effect<HandedInLedger>;
  readonly update: <A>(
    change: (ledger: HandedInLedger) => { readonly ledger: HandedInLedger; readonly result: A },
  ) => Effect.Effect<A>;
  /** Queue a turn for the handler (AssistantPush letters: one at a time, when it is free). */
  readonly queueLetter: (letter: {
    readonly key: string;
    readonly handlerThreadId: string;
    readonly text: string;
    readonly at: string;
  }) => Effect.Effect<void>;
  readonly nowMs?: () => number;
  readonly newId?: () => string;
}

const fail = (status: number, error: string, message: string): HandedHostReply => ({
  status,
  body: { ok: false, error, message },
});

const liveShell = (shell: Option.Option<OrchestrationThreadShell>) =>
  Option.isSome(shell) && shell.value.archivedAt === null ? shell.value : null;

const GONE_MESSAGE = "The chat it was handed to is deleted or archived on this computer.";

/** Why `handler` can't take a chat of another computer, or null. */
export function handlerHereRefusal(input: {
  readonly handler: OrchestrationThreadShell;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}): { readonly error: string; readonly message: string } | null {
  if ((input.handler.handler?.computer ?? null) !== null) {
    return {
      error: "handler_loop",
      message: `“${input.handler.title}” is itself handed to another computer, so it can't take chats of other computers.`,
    };
  }
  // The chat handles nothing itself (its side checks that): the chain is
  // the handler's own handlers here, plus this one hop.
  if (handlerHopsAbove(input.threads, input.handler.id) + 1 > THREAD_HANDLER_MAX_DEPTH) {
    return {
      error: "handler_too_deep",
      message: `Chats can be handed at most ${THREAD_HANDLER_MAX_DEPTH} levels deep.`,
    };
  }
  return null;
}

export function makeHandedHost(deps: HandedHostDeps) {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  const handlerShell = (threadId: string) =>
    deps.projections.getThreadShellById(ThreadId.make(threadId)).pipe(
      Effect.map(liveShell),
      Effect.orElseSucceed(() => null),
    );

  const letter = (input: HandedLetterInput): Effect.Effect<HandedHostReply> =>
    Effect.gen(function* () {
      if (input.text.trim().length === 0 || input.text.length > HANDED_TEXT_MAX_CHARS) {
        return fail(400, "invalid_payload", `"text" is 1–${HANDED_TEXT_MAX_CHARS} characters.`);
      }
      const handler = yield* handlerShell(input.handlerThreadId);
      if (handler === null) {
        // Gone: nothing to tell, and the ledger forgets the chat.
        yield* deps.update((ledger) => {
          const entry = ledger[input.chat.threadId];
          if (entry === undefined || entry.handlerThreadId !== input.handlerThreadId) {
            return { ledger, result: undefined };
          }
          const { [input.chat.threadId]: _gone, ...rest } = ledger;
          return { ledger: rest, result: undefined };
        });
        return fail(410, "handler_gone", GONE_MESSAGE);
      }
      if (input.kind === "brief") {
        const snapshot = yield* deps.projections.getShellSnapshot().pipe(
          Effect.orElseSucceed(() => ({
            threads: [] as ReadonlyArray<OrchestrationThreadShell>,
          })),
        );
        const refusal = handlerHereRefusal({ handler, threads: snapshot.threads });
        if (refusal !== null) return fail(409, refusal.error, refusal.message);
      }
      const at = new Date(nowMs()).toISOString();
      const outcome = yield* deps.update((ledger) =>
        applyLetter(pruneStale(ledger, nowMs()), input, at),
      );
      if (outcome === "not_handling") {
        return fail(409, "not_handling", "That chat isn't handed to this chat here.");
      }
      if (outcome === "queue") {
        yield* deps.queueLetter({
          key: `handed-remote:${input.chat.threadId}:${input.key}`,
          handlerThreadId: input.handlerThreadId,
          text: input.text,
          at,
        });
        yield* Effect.logInfo("hand to: letter from another computer").pipe(
          Effect.annotateLogs({
            threadId: input.chat.threadId,
            handler: input.handlerThreadId,
            from: input.from.computerName,
            kind: input.kind,
          }),
        );
      }
      return {
        status: 200,
        body: { ok: true, queued: outcome === "queue", handlerTitle: handler.title },
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("hand to: letter from another computer failed", { cause }).pipe(
          Effect.as(fail(500, "internal_error", "This computer couldn't take the letter.")),
        ),
      ),
    );

  const pull = (rawThreadId: string, input: HandedPullInput): Effect.Effect<HandedHostReply> =>
    Effect.gen(function* () {
      const chatThreadId = rawThreadId.trim();
      const handler = yield* handlerShell(input.handlerThreadId);
      const at = new Date(nowMs()).toISOString();
      if (handler === null) {
        yield* deps.update((ledger) => {
          const entry = ledger[chatThreadId];
          if (entry === undefined || entry.handlerThreadId !== input.handlerThreadId) {
            return { ledger, result: undefined };
          }
          const { [chatThreadId]: _gone, ...rest } = ledger;
          return { ledger: rest, result: undefined };
        });
        return {
          status: 200,
          body: { handler: "gone", handlerTitle: null, messages: [] } satisfies HandedPullResult,
        };
      }
      const entry = yield* deps.update((ledger) => applyPull(ledger, chatThreadId, input, at));
      if (entry === null) {
        // Not handed here (any more): for the chat's computer the handler is
        // gone — the person gets the chat back.
        return {
          status: 200,
          body: {
            handler: "gone",
            handlerTitle: handler.title,
            messages: [],
          } satisfies HandedPullResult,
        };
      }
      return {
        status: 200,
        body: {
          handler: "active",
          handlerTitle: handler.title,
          messages: entry.outbox,
        } satisfies HandedPullResult,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("hand to: pull from another computer failed", { cause }).pipe(
          Effect.as(fail(500, "internal_error", "This computer couldn't answer.")),
        ),
      ),
    );

  /**
   * The handler writes into the chat it handles on another computer
   * (`chat_message`): kept here until that computer fetches it. Null: no
   * such chat handed to this caller (the bridge answers its usual 404).
   */
  const sendFromHandler = (input: {
    readonly callerThreadId: string;
    readonly callerRuntimeMode: RuntimeMode;
    readonly chatThreadId: string;
    readonly text: string;
  }): Effect.Effect<HandedHostReply | null> =>
    Effect.gen(function* () {
      const at = new Date(nowMs()).toISOString();
      const result = yield* deps.update(
        (ledger): { ledger: HandedInLedger; result: HandedHostReply | null } => {
          const entry = ledger[input.chatThreadId];
          if (entry === undefined || entry.handlerThreadId !== input.callerThreadId) {
            return { ledger, result: null };
          }
          if (
            entry.status !== null &&
            isRuntimeModeWider(entry.status.runtimeMode, input.callerRuntimeMode)
          ) {
            return {
              ledger,
              result: fail(
                403,
                "runtime_mode_escalation",
                `That chat runs in "${entry.status.runtimeMode}", wider than yours ("${input.callerRuntimeMode}"). Only the person can write there.`,
              ),
            };
          }
          if (entry.outbox.length >= HANDED_OUTBOX_LIMIT) {
            return {
              ledger,
              result: fail(
                409,
                "target_busy",
                `${entry.fromComputerName} hasn't picked up your last ${HANDED_OUTBOX_LIMIT} messages yet. Wait for its next update.`,
              ),
            };
          }
          const message: HandedOutMessage = {
            id: newId(),
            text: input.text,
            at,
            runtimeMode: input.callerRuntimeMode,
          };
          return {
            ledger: {
              ...ledger,
              [input.chatThreadId]: { ...entry, outbox: [...entry.outbox, message] },
            },
            result: {
              status: 200,
              body: {
                ok: true,
                threadId: input.chatThreadId,
                relation: "handed",
                computer: entry.fromComputerName,
                note: `Queued for ${entry.fromComputerName}: it goes into the chat within a minute (when the chat is free). Its answer comes to you as a work update.`,
              },
            },
          };
        },
      );
      return result;
    }).pipe(Effect.orElseSucceed(() => null));

  /** `chat_status` of a chat handled from here: the status its computer brought last. */
  const statusForHandler = (input: {
    readonly callerThreadId: string;
    readonly chatThreadId: string;
  }): Effect.Effect<HandedHostReply | null> =>
    Effect.gen(function* () {
      const entry = (yield* deps.read)[input.chatThreadId];
      if (entry === undefined || entry.handlerThreadId !== input.callerThreadId) return null;
      const status = entry.status;
      return {
        status: 200,
        body: {
          threadId: entry.chatThreadId,
          title: status?.title ?? entry.title,
          computer: entry.fromComputerName,
          status: status?.state ?? "unknown",
          runtimeMode: status?.runtimeMode ?? null,
          asOf: entry.seenAt,
          lastAssistantMessage: status?.lastMessage ?? null,
          pendingFromYou: entry.outbox.length,
          note: `This chat is on ${entry.fromComputerName}: this is its status as of ${entry.seenAt}. Only its last answer is readable from here.`,
        },
      };
    }).pipe(Effect.orElseSucceed(() => null));

  return { letter, pull, sendFromHandler, statusForHandler };
}

export type HandedHost = ReturnType<typeof makeHandedHost>;

// ── the chat's side: calls to the handler's computer ─────────────────────

/** What became of a letter sent to the handler's computer. */
export type HandedDelivery =
  | { readonly kind: "delivered"; readonly handlerTitle: string | null }
  /** The handler is deleted / archived there, or doesn't handle the chat: give it back. */
  | { readonly kind: "gone"; readonly message: string }
  /** That computer won't take it (a loop, too deep, too old): give it back, say why. */
  | { readonly kind: "refused"; readonly message: string };

type RemoteRequest = (input: {
  readonly boxId: number;
  readonly computerName: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}) => Effect.Effect<{ readonly status: number; readonly body: unknown }, RemoteComputerError>;

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const tooOld = (name: string) =>
  `Uno Work on ${name} is too old to take chats from other computers. It updates itself when it restarts.`;

/** One letter to the handler's computer. Unreachable / 5xx: the error (try again later). */
export const sendHandedLetter = (
  request: RemoteRequest,
  target: { readonly boxId: number; readonly name: string },
  body: HandedLetterInput,
): Effect.Effect<HandedDelivery, RemoteComputerError> =>
  Effect.gen(function* () {
    const reply = yield* request({
      boxId: target.boxId,
      computerName: target.name,
      method: "POST",
      path: `${HANDED_CHATS_PATH}/letters`,
      body,
    });
    const record = recordOf(reply.body);
    if (reply.status === 200 && record?.["ok"] === true) {
      return {
        kind: "delivered",
        handlerTitle: typeof record["handlerTitle"] === "string" ? record["handlerTitle"] : null,
      } as const;
    }
    const error = typeof record?.["error"] === "string" ? record["error"] : null;
    const message =
      typeof record?.["message"] === "string" ? record["message"].slice(0, 300) : null;
    if (reply.status === 410 || error === "not_handling") {
      return { kind: "gone", message: message ?? GONE_MESSAGE } as const;
    }
    if (reply.status >= 500) {
      return yield* remoteError(
        "unreachable",
        `${target.name} couldn't take it right now (HTTP ${reply.status}).`,
        reply.status,
      );
    }
    if (reply.status === 404 || reply.status === 405 || (reply.status === 200 && error === null)) {
      return { kind: "refused", message: tooOld(target.name) } as const;
    }
    if (reply.status === 401 || reply.status === 403) {
      return yield* remoteError(
        "no_permission",
        `${target.name} didn't let this computer in.`,
        reply.status,
      );
    }
    return {
      kind: "refused",
      message: message ?? `${target.name} refused it (HTTP ${reply.status}).`,
    } as const;
  });

/** Status and messages of a handed chat, from the handler's computer. Null: too old there. */
export const pullHanded = (
  request: RemoteRequest,
  target: { readonly boxId: number; readonly name: string },
  chatThreadId: string,
  body: HandedPullInput,
): Effect.Effect<HandedPullResult | null, RemoteComputerError> =>
  Effect.gen(function* () {
    const reply = yield* request({
      boxId: target.boxId,
      computerName: target.name,
      method: "POST",
      path: `${HANDED_CHATS_PATH}/${encodeURIComponent(chatThreadId)}/pull`,
      body,
    });
    const record = recordOf(reply.body);
    if (reply.status !== 200 || record === null || typeof record["handler"] !== "string") {
      if (reply.status === 404 || reply.status === 405 || reply.status === 200) return null;
      return yield* remoteError(
        "refused",
        `${target.name} didn't answer about the chat (HTTP ${reply.status}).`,
        reply.status,
      );
    }
    const messages = Array.isArray(record["messages"]) ? record["messages"] : [];
    return {
      handler: record["handler"] === "gone" ? "gone" : "active",
      handlerTitle: typeof record["handlerTitle"] === "string" ? record["handlerTitle"] : null,
      messages: messages.flatMap((raw): Array<HandedOutMessage> => {
        const message = recordOf(raw);
        const mode = Schema.decodeUnknownOption(RuntimeMode)(message?.["runtimeMode"]);
        if (
          message === null ||
          typeof message["id"] !== "string" ||
          typeof message["text"] !== "string" ||
          message["text"].trim().length === 0 ||
          message["text"].length > HANDED_TEXT_MAX_CHARS
        ) {
          return [];
        }
        return [
          {
            id: message["id"],
            text: message["text"],
            at: typeof message["at"] === "string" ? message["at"] : new Date().toISOString(),
            // Unknown: the narrowest.
            runtimeMode: Option.getOrElse(mode, () => "approval-required" as const),
          },
        ];
      }),
    } satisfies HandedPullResult;
  });
