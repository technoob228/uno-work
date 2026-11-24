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
 * - a request from a chat the person trusts ("Don't ask again for this
 *   chat") starts at once, as if Start were pressed; Settings revokes it;
 * - "Stop cloud agents" turns the switch off and stops every command a cloud
 *   agent runs here right now (`stopRunning`);
 * - a started chat is followed for a day (its state, its last answer);
 *   `state.json` is rewritten every minute; every request and decision goes
 *   into the journal.
 *
 * T51: a colleague's session request comes from the Uno cloud through the
 * team bridge (team/bridge.ts → `team.admit`), on a laptop and on a cloud
 * computer alike; its record carries `team`, goes by its level and its own
 * limit; the bridge tells the cloud how it goes. Its chat is marked
 * as holding outside text before it starts (T49), and a question from a
 * colleague's agent is answered by a chat that only reads.
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
  type ChatRequestsRevokeTrustInput,
  type ChatRequestsSetAllowedInput,
  type ChatRequestFile,
  type ChatRequestsState,
  type ChatRequestTeam,
  type ManagerRemoteChatCreateInput,
  type ManagerRemoteChatResult,
  type ManagerRemoteChatStatus,
} from "@t3tools/contracts";
import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { makeRemoteChatHost } from "../remoteComputers/remoteChatHost.ts";
import {
  admit,
  admitBroken,
  admitTeam,
  answerOf,
  checkDecidable,
  declined,
  expireDue,
  followed,
  framedBrief,
  guard,
  GUARDED_PROVIDER,
  guardReadOnly,
  guardedProviderOf,
  hostStateOf,
  parseRemoteDecision,
  parseRequestFile,
  REMOTE_DECISION_FRESH_MS,
  prune,
  retireTeam,
  setAllow,
  started,
  stateOf,
  toFollow,
  trust,
  untrust,
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
  readRemoteCommands,
  trimRemoteCommands,
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
  /** "Stop cloud agents": stops what cloud agents run here right now; how many. */
  readonly stopRunning?: () => Promise<number>;
  readonly nowMs?: () => number;
  /**
   * T51: mark a chat as holding outside text (T49 `OutsideThreads.mark`)
   * before its first turn. A failure stops the start: never open.
   */
  readonly markOutside?: (threadId: string) => Effect.Effect<void, ChatRequestsError>;
}

/** T51: a read-only chat that answers a colleague's agent's question. */
export interface ReadOnlyStartInput {
  readonly title: string;
  readonly text: string;
  readonly cwd: string;
  readonly startedBy: ManagerRemoteChatCreateInput["startedBy"];
}

/** T51: what the team bridge does with the host. */
export interface TeamHostShape {
  /** A colleague's session request, as read from the cloud (its id: `teamRecordId`). */
  readonly admit: (
    file: ChatRequestFile & { readonly team: ChatRequestTeam },
  ) => Effect.Effect<HostRecord | null, ChatRequestsError>;
  /** Start it without a button (level Do tasks; the bridge checked the level again). */
  readonly autoStart: (id: string) => Effect.Effect<string, ChatRequestsError>;
  /** The cloud says it is over (cancelled, expired there) while it waits here. */
  readonly retire: (
    id: string,
    status: "expired" | "refused",
    reason: string,
  ) => Effect.Effect<HostRecord | null, ChatRequestsError>;
  readonly startReadOnly: (
    input: ReadOnlyStartInput,
  ) => Effect.Effect<{ readonly threadId: string; readonly title: string }, ChatRequestsError>;
  readonly threadStatus: (threadId: string) => Effect.Effect<ManagerRemoteChatStatus | null>;
  /** The colleagues' records here, newest first. */
  readonly records: Effect.Effect<ReadonlyArray<HostRecord>, ChatRequestsError>;
  /** Called with each colleague's record that changed (the bridge reports it). */
  readonly onChange: (listener: ((record: HostRecord) => void) | null) => void;
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
  readonly revokeTrust: (
    input: ChatRequestsRevokeTrustInput,
  ) => Effect.Effect<ChatRequestsState, ChatRequestsError>;
  readonly paths: ReturnType<typeof spoolPaths>;
  readonly team: TeamHostShape;
}

/** A colleague's session: edits go on, commands still wait for a yes (DESIGN: no wider than that). */
const TEAM_RUNTIME_MODE = "auto-accept-edits" as const;
/** A chat that only reads: the strictest mode, and the guard refuses all but reading. */
const READ_ONLY_RUNTIME_MODE = "approval-required" as const;

/** No connected apps (Gmail, Drive…) for a chat a colleague asked for: they are the person's. */
const NO_APPS = { restricted: true, permissions: {} } as const;

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
    const markOutside = deps.markOutside ?? (() => Effect.void);
    let teamListener: ((record: HostRecord) => void) | null = null;

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
        const own = yield* isOwnComputer;
        for (const entry of changed) {
          if (entry.team !== undefined) {
            // The cloud hears of it from the team bridge. `out/` too, on the
            // person's own computer: their cloud computer reads it through the
            // tunnel to offer Start / Decline in Telegram.
            const listener = teamListener;
            if (listener !== null) yield* Effect.sync(() => listener(entry));
            if (!own) continue;
          }
          yield* io(() => writeAnswer(paths, answerOf(entry))).pipe(
            Effect.ignoreCause({ log: true }),
          );
        }
        if (!own) return;
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
        // The request folder is the person's own computer's; a colleague's
        // records (T51) are followed on a cloud computer too.
        const own = yield* isOwnComputer;
        if (own) yield* io(() => ensureSpool(paths));
        let store = yield* io(() => readHostStore(stateDir));
        if (!own && !store.records.some((entry) => entry.team !== undefined)) return;
        const before = store;
        const changed: Array<HostRecord> = [];
        const autoStart: Array<HostRecord> = [];
        const now = nowMs();
        for (const id of own ? yield* io(() => listIncoming(paths)) : []) {
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
          // A trusted chat's: its answer is "started", not a "waiting" first.
          if (admitted.autoStart) autoStart.push(admitted.record);
          else changed.push(admitted.record);
          yield* journal(eventOf(admitted.record), admitted.record);
          yield* Effect.logInfo("chat request received").pipe(
            Effect.annotateLogs({
              id: admitted.record.id,
              status: admitted.record.status,
              from: admitted.record.from.computerName,
            }),
          );
        }
        if (own && autoStart.length > 0) {
          yield* persist(store, changed);
          changed.length = 0;
          for (const entry of autoStart) {
            const startedOk = yield* decideNow(
              { id: entry.id, decision: "start" },
              "here",
              true,
            ).pipe(
              Effect.as(true),
              Effect.catchTag("ChatRequestsError", () => Effect.succeed(false)),
            );
            // Couldn't start by itself: it waits for the person's Start like any other.
            if (!startedOk) {
              const now2 = yield* io(() => readHostStore(stateDir));
              const still = now2.records.find((candidate) => candidate.id === entry.id);
              if (still) changed.push(still);
            }
          }
          store = yield* io(() => readHostStore(stateDir));
        }
        if (own && (yield* io(() => listDecisions(paths))).length > 0) {
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
        yield* io(() => trimRemoteCommands(paths)).pipe(Effect.ignoreCause({ log: false }));
        const pruned = prune(store, now);
        if (pruned !== store) {
          store = pruned;
          if (own) {
            yield* io(() => pruneAnswers(paths, new Set(store.records.map((entry) => entry.id))));
          }
        }
        if (store !== before || nowMs() - lastStateWrite > HOST_STATE_EVERY_MS) {
          yield* persist(store, changed);
        }
      }),
    );

    /** The view, with the last calls of cloud agents here (`commands.jsonl`). */
    const viewWithCommands = (store: HostStore) =>
      io(() => readRemoteCommands(paths)).pipe(
        Effect.orElseSucceed(() => []),
        Effect.map((commands) => ({ ...stateOf(store, nowMs()), commands })),
      );

    const state: HostShape["state"] = io(() => readHostStore(stateDir)).pipe(
      Effect.flatMap(viewWithCommands),
    );

    /** Start / Decline, under the lock: from the app here, or from the person's Telegram. */
    const decideNow = (
      input: ChatRequestDecideInput,
      via: ChatRequestDecidedVia,
      /** No press: a trusted chat's request, started as it arrived. */
      auto = false,
    ) =>
      Effect.gen(function* () {
        let store = yield* io(() => readHostStore(stateDir));
        const now = nowMs();
        const check = checkDecidable(store, input.id, now);
        if (!check.ok) return yield* fail(check.message);
        const entry = auto ? { ...check.record, trusted: true } : check.record;
        const provider = guardedProviderOf(entry.provider);
        if (provider === null) return yield* fail("That harness isn't held to the rules here.");
        if (input.decision === "decline") {
          const next = declined(store, entry.id, now, via);
          yield* persist(next.store, next.record ? [next.record] : [], true);
          if (next.record) yield* journal("declined", next.record);
          return { state: stateOf(next.store, now), threadId: null };
        }
        // Held to the rules before its first turn: the record says so first.
        const threadId = ThreadId.make(crypto.randomUUID());
        store = guard(store, threadId);
        // "Don't ask again" is for the person's own cloud chats; a colleague's has its level (T51).
        if (input.trustChat === true && !auto && entry.team === undefined) {
          store = trust(store, entry, now);
          yield* journal("trusted", entry);
        }
        yield* io(() => writeHostStore(stateDir, store));
        const team = entry.team;
        if (team !== undefined) {
          // A colleague's words: outside text (T49) before the first turn, or no start.
          yield* markOutside(threadId);
        }
        const reply = yield* host.create(
          {
            text: framedBrief(entry),
            title: entry.title,
            ...(entry.cwd ? { cwd: entry.cwd } : {}),
            provider,
            ...(entry.model ? { model: entry.model } : {}),
            // No wider than the chat that asked, nor than the project's chats here.
            // A colleague's: edits without asking at most, commands wait for a yes.
            runtimeMode:
              team !== undefined ? TEAM_RUNTIME_MODE : (entry.runtimeMode ?? "full-access"),
            startedBy:
              team !== undefined
                ? {
                    assistantName:
                      team.fromAssistant === true
                        ? `${team.fromName}'s assistant`
                        : team.viaAgent
                          ? `${team.fromName}'s agent`
                          : team.fromName,
                    assistantProjectId: null,
                    fromComputerName: `a colleague in ${team.projectName}`,
                    fromBoxId: null,
                    fromThreadId: entry.from.threadId,
                    apps: NO_APPS,
                  }
                : {
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
          auto,
        );
        yield* persist(next.store, next.record ? [next.record] : [], true);
        if (next.record) {
          yield* journal(
            auto || (team?.auto === true && via === "here") ? "auto-started" : "started",
            next.record,
          );
        }
        return { state: stateOf(next.store, nowMs()), threadId: result.threadId };
      });

    const decide: HostShape["decide"] = (input) =>
      lock.withPermits(1)(
        decideNow(input, "here").pipe(
          Effect.flatMap((result) =>
            io(() => readRemoteCommands(paths)).pipe(
              Effect.orElseSucceed(() => []),
              Effect.map((commands) => ({ ...result, state: { ...result.state, commands } })),
            ),
          ),
        ),
      );

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
          const stopping = input.stopRunning === true;
          const next = setAllow(store, stopping ? false : input.allow, now, stopping);
          // Saved first: the cloud side reads it before its next call.
          yield* persist(next.store, next.changed, true);
          if (stopping) {
            const stopped = deps.stopRunning
              ? yield* io(deps.stopRunning).pipe(Effect.orElseSucceed(() => 0))
              : 0;
            yield* journal("stopped", null, `${stopped} running command(s) stopped`);
          } else {
            yield* journal(input.allow ? "allowed" : "turned-off", null);
          }
          for (const entry of next.changed) yield* journal("refused", entry);
          return yield* viewWithCommands(next.store);
        }),
      );

    // ── T51: a colleague's requests ─────────────────────────────────────
    const team: TeamHostShape = {
      admit: (file) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const store = yield* io(() => readHostStore(stateDir));
            const admitted = admitTeam(store, file, nowMs());
            if (admitted === null) return null;
            yield* persist(admitted.store, [admitted.record]);
            yield* journal(eventOf(admitted.record), admitted.record);
            return admitted.record;
          }),
        ),
      autoStart: (id) =>
        lock.withPermits(1)(
          // Only a colleague's request marked auto, never one from their
          // assistant computer (Misha 23.11): that one waits for the button.
          io(() => readHostStore(stateDir)).pipe(
            Effect.flatMap((store) => {
              const team = store.records.find((entry) => entry.id === id)?.team;
              return team?.auto === true && team.fromAssistant !== true
                ? Effect.void
                : Effect.fail(fail("This request waits for the person's Start."));
            }),
            Effect.andThen(decideNow({ id, decision: "start" }, "here")),
            Effect.flatMap((result) =>
              result.threadId === null
                ? Effect.fail(fail("The chat couldn't start here."))
                : Effect.succeed(result.threadId),
            ),
          ),
        ),
      retire: (id, status, reason) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const store = yield* io(() => readHostStore(stateDir));
            const next = retireTeam(store, id, status, reason, nowMs());
            if (next === null) return null;
            yield* persist(next.store, [next.record]);
            yield* journal("retired", next.record);
            return next.record;
          }),
        ),
      startReadOnly: (input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const threadId = ThreadId.make(crypto.randomUUID());
            const store = guardReadOnly(yield* io(() => readHostStore(stateDir)), threadId);
            yield* io(() => writeHostStore(stateDir, store));
            yield* markOutside(threadId);
            const reply = yield* host.create(
              {
                text: input.text,
                title: input.title,
                cwd: input.cwd,
                provider: GUARDED_PROVIDER,
                runtimeMode: READ_ONLY_RUNTIME_MODE,
                startedBy: { ...input.startedBy, apps: NO_APPS },
              },
              { threadId },
            );
            if (reply.status !== 200) {
              const body = reply.body as { readonly message?: unknown };
              return yield* fail(
                typeof body.message === "string" ? body.message : "The chat couldn't start here.",
              );
            }
            const result = reply.body as ManagerRemoteChatResult;
            yield* journal("answering", null, `${result.threadId}: ${input.title}`);
            return { threadId: result.threadId, title: result.title };
          }),
        ),
      threadStatus: (threadId) =>
        host
          .status(threadId)
          .pipe(
            Effect.map((reply) =>
              reply.status === 200 ? (reply.body as ManagerRemoteChatStatus) : null,
            ),
          ),
      records: io(() => readHostStore(stateDir)).pipe(
        Effect.map((store) => store.records.filter((entry) => entry.team !== undefined)),
      ),
      onChange: (listener) => {
        teamListener = listener;
      },
    };

    const revokeTrust: HostShape["revokeTrust"] = (input) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const store = yield* io(() => readHostStore(stateDir));
          const next = untrust(store, input);
          if (next === null) return yield* viewWithCommands(store);
          yield* persist(next.store, [], true);
          yield* journal(
            "untrusted",
            null,
            `${next.chat.threadTitle} on ${next.chat.computerName}`,
          );
          return yield* viewWithCommands(next.store);
        }),
      );

    return {
      tick: hostTick,
      state,
      decide,
      setAllowed,
      revokeTrust,
      paths,
      team,
    } satisfies HostShape;
  });
