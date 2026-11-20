/**
 * The receiving side of "a cloud chat asks to start a chat here", on the
 * person's own computer (a laptop: no `uno.boxToken`):
 *
 * - each round reads `~/.uno-work/chat-requests/in/` (spool.ts) and admits
 *   each request by the rules (hostLogic.ts): waiting, or refused / expired
 *   at once; its answer goes into `out/`;
 * - the person presses Start or Decline (`chatRequests.*` RPC), here or in
 *   their Telegram (the cloud side writes it into `decisions/`; applied
 *   here by the same rules, the first decision wins, a late one is
 *   dropped); Start holds
 *   the new chat to the rules of this computer (the record says so before
 *   its first turn: CommandGuardPolicy) and opens it with the brief framed
 *   as the cloud agent's text (remoteChatHost.ts, so the sidebar says who
 *   started it);
 * - a started chat is followed for a day (its state, its last answer);
 *   `state.json` is rewritten every minute; every request and decision goes
 *   into the journal.
 *
 * @module chatRequests/host
 */
import * as crypto from "node:crypto";

import {
  ChatRequestsError,
  ThreadId,
  type ChatRequestDecidedVia,
  type ChatRequestDecideInput,
  type ChatRequestDecideResult,
  type ChatRequestsSetAllowedInput,
  type ChatRequestsState,
  type ManagerRemoteChatResult,
  type ManagerRemoteChatStatus,
} from "@t3tools/contracts";
import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { makeRemoteChatHost } from "../remoteComputers/remoteChatHost.ts";
import {
  admit,
  admitBroken,
  answerOf,
  checkDecidable,
  declined,
  expireDue,
  followed,
  framedBrief,
  GUARDED_PROVIDER,
  guard,
  hostStateOf,
  parseRemoteDecision,
  parseRequestFile,
  REMOTE_DECISION_FRESH_MS,
  prune,
  setAllow,
  started,
  stateOf,
  toFollow,
  type HostRecord,
  type HostStore,
} from "./hostLogic.ts";
import {
  appendJournal,
  ensureSpool,
  listDecisions,
  listIncoming,
  pruneAnswers,
  readDecision,
  readHostStore,
  readIncoming,
  removeDecision,
  removeIncoming,
  spoolPaths,
  writeAnswer,
  writeHostState,
  writeHostStore,
  type JournalEvent,
} from "./spool.ts";

const HOST_STATE_EVERY_MS = 60_000;

export interface HostDeps {
  readonly stateDir: string;
  /** The home of this computer (tests: a made-up one). */
  readonly home?: string;
  readonly host: Pick<ReturnType<typeof makeRemoteChatHost>, "create" | "status">;
  /** A laptop or desktop: the person's own computer, where requests arrive. */
  readonly isOwnComputer: Effect.Effect<boolean>;
  /** What `state.json` says wrote it: `uno-work 0.0.190`. */
  readonly app: string;
  readonly nowMs?: () => number;
}

export interface HostShape {
  /** One round: new requests, expiries, started chats, `state.json`. */
  readonly tick: Effect.Effect<void, ChatRequestsError>;
  readonly state: Effect.Effect<ChatRequestsState, ChatRequestsError>;
  readonly decide: (
    input: ChatRequestDecideInput,
  ) => Effect.Effect<ChatRequestDecideResult, ChatRequestsError>;
  readonly setAllowed: (
    input: ChatRequestsSetAllowedInput,
  ) => Effect.Effect<ChatRequestsState, ChatRequestsError>;
  readonly paths: ReturnType<typeof spoolPaths>;
}

const fail = (message: string) => new ChatRequestsError({ message });
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export const makeChatRequestsHost = (deps: HostDeps): Effect.Effect<HostShape> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const paths = spoolPaths(deps.home);
    const stateDir = deps.stateDir;
    const app = deps.app;
    const host = deps.host;
    const nowMs = deps.nowMs ?? (() => Date.now());

    const isOwnComputer = deps.isOwnComputer;

    const io = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (cause) => fail(errorText(cause)) });

    const journal = (event: JournalEvent, entry: HostRecord | null, detail?: string) =>
      io(() => appendJournal(stateDir, event, entry, new Date(), detail)).pipe(
        Effect.ignoreCause({ log: true }),
      );

    let lastStateWrite = 0;

    /** Save the record, then the answers that changed, then `state.json`. */
    const persist = (store: HostStore, changed: ReadonlyArray<HostRecord>, forceState = false) =>
      Effect.gen(function* () {
        yield* io(() => writeHostStore(stateDir, store));
        for (const entry of changed) {
          yield* io(() => writeAnswer(paths, answerOf(entry))).pipe(
            Effect.ignoreCause({ log: true }),
          );
        }
        if (forceState || changed.length > 0 || nowMs() - lastStateWrite > HOST_STATE_EVERY_MS) {
          yield* io(() => writeHostState(paths, hostStateOf(store, nowMs(), app))).pipe(
            Effect.ignoreCause({ log: true }),
          );
          lastStateWrite = nowMs();
        }
      });

    const eventOf = (entry: HostRecord): JournalEvent =>
      entry.status === "waiting" ? "received" : entry.status === "expired" ? "expired" : "refused";

    const hostTick = lock.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* isOwnComputer)) return;
        yield* io(() => ensureSpool(paths));
        let store = yield* io(() => readHostStore(stateDir));
        const before = store;
        const changed: Array<HostRecord> = [];
        const now = nowMs();
        for (const id of yield* io(() => listIncoming(paths))) {
          const raw = yield* io(() => readIncoming(paths, id));
          const parsed = parseRequestFile(raw);
          const admitted = parsed.ok
            ? parsed.file.id === id
              ? admit(store, parsed.file, now)
              : admitBroken(store, id, "The request's id doesn't match its file name.", now)
            : admitBroken(store, parsed.id ?? id, parsed.reason, now);
          yield* io(() => removeIncoming(paths, id));
          if (admitted === null) continue;
          store = admitted.store;
          changed.push(admitted.record);
          yield* journal(eventOf(admitted.record), admitted.record);
          yield* Effect.logInfo("chat request received").pipe(
            Effect.annotateLogs({
              id: admitted.record.id,
              status: admitted.record.status,
              from: admitted.record.from.computerName,
            }),
          );
        }
        if ((yield* io(() => listDecisions(paths))).length > 0) {
          // Saved first: a decision reads the store as it is now.
          if (changed.length > 0) yield* persist(store, changed);
          changed.length = 0;
          yield* applyRemoteDecisions;
          store = yield* io(() => readHostStore(stateDir));
        }
        const expired = expireDue(store, now);
        store = expired.store;
        for (const entry of expired.changed) {
          changed.push(entry);
          yield* journal("expired", entry);
        }
        for (const entry of toFollow(store, now)) {
          const reply = yield* host.status(entry.threadId!);
          if (reply.status !== 200) continue;
          const status = reply.body as ManagerRemoteChatStatus;
          const next = followed(store, entry.id, status, now);
          if (next === null) continue;
          store = next.store;
          changed.push(next.record);
        }
        const pruned = prune(store, now);
        if (pruned !== store) {
          store = pruned;
          yield* io(() => pruneAnswers(paths, new Set(store.records.map((entry) => entry.id))));
        }
        if (store !== before || nowMs() - lastStateWrite > HOST_STATE_EVERY_MS) {
          yield* persist(store, changed);
        }
      }),
    );

    const state: HostShape["state"] = io(() => readHostStore(stateDir)).pipe(
      Effect.map((store) => stateOf(store, nowMs())),
    );

    /** Start / Decline, under the lock: from the app here, or from the person's Telegram. */
    const decideNow = (input: ChatRequestDecideInput, via: ChatRequestDecidedVia) =>
      Effect.gen(function* () {
        let store = yield* io(() => readHostStore(stateDir));
        const now = nowMs();
        const check = checkDecidable(store, input.id, now);
        if (!check.ok) return yield* fail(check.message);
        const entry = check.record;
        if (input.decision === "decline") {
          const next = declined(store, entry.id, now, via);
          yield* persist(next.store, next.record ? [next.record] : [], true);
          if (next.record) yield* journal("declined", next.record);
          return { state: stateOf(next.store, now), threadId: null };
        }
        // Held to the rules before its first turn: the record says so first.
        const threadId = ThreadId.make(crypto.randomUUID());
        store = guard(store, threadId);
        yield* io(() => writeHostStore(stateDir, store));
        const reply = yield* host.create(
          {
            text: framedBrief(entry),
            title: entry.title,
            ...(entry.cwd ? { cwd: entry.cwd } : {}),
            provider: GUARDED_PROVIDER,
            ...(entry.model ? { model: entry.model } : {}),
            // No wider than the chat that asked, nor than the project's chats here.
            runtimeMode: entry.runtimeMode ?? "full-access",
            startedBy: {
              assistantName: entry.from.threadTitle.trim() || "A cloud chat",
              assistantProjectId: null,
              fromComputerName: entry.from.computerName,
              fromBoxId: entry.from.boxId,
              fromThreadId: entry.from.threadId,
            },
          },
          { threadId },
        );
        if (reply.status !== 200) {
          const body = reply.body as { readonly message?: unknown };
          const message =
            typeof body.message === "string" ? body.message : "The chat couldn't start here.";
          yield* journal("start-failed", entry, message);
          return yield* fail(message);
        }
        const result = reply.body as ManagerRemoteChatResult;
        const next = started(
          store,
          entry.id,
          { threadId: result.threadId, title: result.title },
          nowMs(),
          via,
        );
        yield* persist(next.store, next.record ? [next.record] : [], true);
        if (next.record) yield* journal("started", next.record);
        return { state: stateOf(next.store, nowMs()), threadId: result.threadId };
      });

    const decide: HostShape["decide"] = (input) => lock.withPermits(1)(decideNow(input, "here"));

    /**
     * Start / Decline the person pressed in Telegram: applied like the app's
     * own buttons. Too late (Uno Work was closed when it came), or decided
     * already (here, first): dropped, with a journal line.
     */
    const applyRemoteDecisions = Effect.gen(function* () {
      for (const id of yield* io(() => listDecisions(paths))) {
        const read = yield* io(() => readDecision(paths, id));
        yield* io(() => removeDecision(paths, id));
        const decision = read === null ? null : parseRemoteDecision(read.raw, id);
        if (read === null || decision === null) continue;
        const store = yield* io(() => readHostStore(stateDir));
        const entry = store.records.find((candidate) => candidate.id === id) ?? null;
        if (read.writtenAtMs + REMOTE_DECISION_FRESH_MS < nowMs()) {
          yield* journal("telegram-dropped", entry, `${decision.decision} came too late`);
          continue;
        }
        yield* decideNow({ id, decision: decision.decision }, "telegram").pipe(
          Effect.catchTag("ChatRequestsError", (error) =>
            journal("telegram-dropped", entry, `${decision.decision}: ${error.message}`),
          ),
        );
      }
    });

    const setAllowed: HostShape["setAllowed"] = (input) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const store = yield* io(() => readHostStore(stateDir));
          const now = nowMs();
          const next = setAllow(store, input.allow, now);
          yield* persist(next.store, next.changed, true);
          yield* journal(input.allow ? "allowed" : "turned-off", null);
          for (const entry of next.changed) yield* journal("refused", entry);
          return stateOf(next.store, now);
        }),
      );

    return { tick: hostTick, state, decide, setAllowed, paths } satisfies HostShape;
  });
