/**
 * AssistantPush — the daemon side of "your thread is done" (decisions in
 * `manager/assistantPush.ts`).
 *
 * - Listens to the orchestration events: a turn the assistant asked for
 *   starts a watch; any event of a watched chat marks it for a look.
 * - A tick looks at marked chats (and every watched chat now and then, which
 *   also covers a missed event and a daemon restart) with the same probe as
 *   `wait_for_thread` (`threadSettlement.ts`), and turns outcomes into
 *   notices.
 * - Notices go out per conversation, coalesced: into a Telegram / Slack chat
 *   the request came from as a system turn of that chat's reply path (queued
 *   behind its turns, answered there), else straight into the conversation
 *   once it is idle (the desktop).
 *
 * State (watches, outbox, dedupe keys) is persisted in the daemon's state dir
 * (`assistants/push-state.json`), so a restart loses nothing.
 *
 * @module manager/Layers/AssistantPush
 */
import {
  ASSISTANT_PROJECT_ID,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  assistantTokenLabel,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { Clock, Duration, Effect, Layer, Option, Ref, Semaphore, Stream } from "effect";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { readReports, reportOfThread } from "../../sites/reports.ts";

import { ServerConfig } from "../../config.ts";
import { systemCommandOrigin } from "../../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorPendingReplyRepositoryLive } from "../../persistence/Layers/ManagerConnectorPendingReplies.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ManagerCapabilityTokenRepository } from "../../persistence/Services/ManagerCapabilityTokens.ts";
import { ManagerConnectorPendingReplyRepository } from "../../persistence/Services/ManagerConnectorPendingReplies.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { remoteComputersOption } from "../../remoteComputers/RemoteComputers.ts";
import {
  assistantPushEnabled,
  decideTurnStart,
  dropWatch,
  dueBatches,
  EMPTY_PUSH_STATE,
  formatPushFallback,
  formatPushNotice,
  guessConversation,
  isAssistantConversationThread,
  markBatchSent,
  noticeFromProbe,
  noticeFromRemoteStatus,
  pruneWatches,
  remotePollEveryMs,
  PUSH_CALLER_ROUTE_TTL_MS,
  rememberSent,
  upsertWatch,
  type PushBatch,
  type PushState,
  type PushThreadShell,
  type PushVia,
} from "../assistantPush.ts";
import { isThreadBusyForNewTurn, SYSTEM_TURN_ORIGIN_COMPONENT } from "../connectorReplies.ts";
import { detectReplyLanguage } from "../connectorReplyText.ts";
import {
  decideLaunchTruth,
  LAUNCH_CHECK_ORIGIN_COMPONENT,
  launchCheckPromptText,
  notLaunchedText,
} from "../launchTruth.ts";
import { makeThreadSettlementProbe } from "../threadSettlement.ts";
import { eventTouchesThreads } from "../threadWait.ts";
import { AssistantPushService, type AssistantPushServiceShape } from "../Services/AssistantPush.ts";
import { ManagerSlackService } from "./SlackConnector.ts";
import { ManagerTelegramService } from "./TelegramConnector.ts";

/** How often the loop looks at marked chats and the outbox. */
const TICK = Duration.seconds(1);
/** Every watched chat is looked at this often even without an event. */
const PROBE_EVERY_MS = 10_000;
/** A reported chat stays "reported by its assistant" this long (late per-chat notices). */
const REPORTED_HOLD_MS = 10 * 60_000;
/** Uno's final text must sit still this long before the launch check reads it. */
const LAUNCH_SETTLE_MS = 3_000;
/** A Uno turn the launch check still has no answer for after this long is let go. */
const LAUNCH_WATCH_MS = 3 * 60_000;

/**
 * A Uno turn in the app (not a Telegram / Slack message: their reply path
 * checks those itself) whose answer the launch check reads (launchTruth.ts).
 */
interface LaunchWatch {
  readonly messageId: string;
  /** The person's message the chain started from (its text, once read). */
  readonly original: string | null;
  readonly checksMade: number;
  readonly sinceMs: number;
}

const stateFile = (stateDir: string) => nodePath.join(stateDir, "assistants", "push-state.json");

async function readState(file: string): Promise<PushState> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<PushState>;
    return {
      watches: Array.isArray(parsed.watches) ? parsed.watches : [],
      outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
      sentKeys: Array.isArray(parsed.sentKeys) ? parsed.sentKeys : [],
      turns:
        typeof parsed.turns === "object" && parsed.turns !== null && !Array.isArray(parsed.turns)
          ? parsed.turns
          : {},
    };
  } catch {
    return EMPTY_PUSH_STATE;
  }
}

async function writeState(file: string, state: PushState): Promise<void> {
  await fsp.mkdir(nodePath.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporary, file);
}

const toPushShell = (shell: OrchestrationThreadShell): PushThreadShell => ({
  id: shell.id,
  projectId: shell.projectId,
  assistantRole: shell.assistantRole ?? null,
  spawnedByThreadId: shell.spawnedByThreadId ?? null,
  archivedAt: shell.archivedAt,
  updatedAt: shell.updatedAt,
  session: shell.session == null ? null : { status: shell.session.status },
});

export interface AssistantPushOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly tick?: Duration.Input;
}

export const makeAssistantPush = (options?: AssistantPushOptions) =>
  Effect.gen(function* () {
    const enabled = assistantPushEnabled(options?.env);
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const turnRepository = yield* ProjectionTurnRepository;
    const tokens = yield* ManagerCapabilityTokenRepository;
    const pendingReplies = yield* ManagerConnectorPendingReplyRepository;
    const telegram = yield* ManagerTelegramService;
    const slack = yield* ManagerSlackService;
    const { probe } = yield* makeThreadSettlementProbe;
    // Chats on other computers of the account (assistants D): polled there.
    const remoteComputers = yield* remoteComputersOption;
    const serverConfig = Option.getOrNull(yield* Effect.serviceOption(ServerConfig));
    const file = serverConfig === null ? null : stateFile(serverConfig.stateDir);

    const initial = file === null ? EMPTY_PUSH_STATE : yield* Effect.promise(() => readState(file));
    const stateRef = yield* Ref.make<PushState>(initial);
    const dirtyRef = yield* Ref.make<ReadonlySet<string>>(new Set());
    const probedAtRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const reportedRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const routesRef = yield* Ref.make<
      ReadonlyMap<
        string,
        { readonly assistant: string; readonly conversation: string; readonly atMs: number }
      >
    >(new Map());
    const tokenAssistantRef = yield* Ref.make<ReadonlyMap<string, string | null>>(new Map());
    const launchWatchesRef = yield* Ref.make<ReadonlyMap<string, LaunchWatch>>(new Map());
    // The event handler and the tick both change the state: one at a time.
    const lock = yield* Semaphore.make(1);
    const exclusive = lock.withPermits(1);

    const persist = (state: PushState) =>
      file === null
        ? Effect.void
        : Effect.tryPromise(() => writeState(file, state)).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("assistant push: state not saved").pipe(
                Effect.annotateLogs({ cause: String(cause) }),
              ),
            ),
          );

    const commit = (next: PushState) =>
      Effect.gen(function* () {
        yield* Ref.set(stateRef, next);
        yield* persist(next);
      });

    /** The assistant a manager token belongs to (`assistant:<projectId>`), cached. */
    const assistantOfToken = (tokenId: string) =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(tokenAssistantRef)).get(tokenId);
        if (cached !== undefined) return cached;
        const prefix = assistantTokenLabel("");
        const label = yield* tokens.list().pipe(
          Effect.map((all) => all.find((token) => token.tokenId === tokenId)?.label ?? ""),
          Effect.orElseSucceed(() => ""),
        );
        const assistant = label.startsWith(prefix) ? label.slice(prefix.length) : null;
        yield* Ref.update(tokenAssistantRef, (map) => new Map(map).set(tokenId, assistant));
        return assistant;
      });

    const shellOf = (threadId: string) =>
      projections.getThreadShellById(ThreadId.make(threadId)).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );

    /** The chat the request came from: a reply of that conversation still in flight. */
    const viaOf = (conversationThreadId: string) =>
      pendingReplies
        .listByThread({ threadId: ThreadId.make(conversationThreadId), limit: 10 })
        .pipe(
          Effect.map((rows): PushVia | null => {
            const waiting = rows.findLast((row) => row.status === "waiting");
            return waiting === undefined
              ? null
              : {
                  kind: waiting.kind,
                  connectorProjectId: waiting.connectorProjectId,
                  replyKey: waiting.replyKey,
                };
          }),
          Effect.orElseSucceed(() => null),
        );

    // ── watches ──

    const onTurnStart = (
      event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>,
    ) =>
      Effect.gen(function* () {
        const threadId = event.payload.threadId;
        const target = yield* shellOf(threadId);
        const origin = event.metadata.origin;
        const tokenAssistant =
          origin?.kind === "manager" ? yield* assistantOfToken(origin.tokenId) : null;
        const sender = origin?.kind === "agent" ? yield* shellOf(origin.threadId) : null;
        const decision = decideTurnStart({
          target: target === null ? null : toPushShell(target),
          origin,
          assistantOfToken: () => tokenAssistant,
          threadById: (id) => (sender !== null && sender.id === id ? toPushShell(sender) : null),
        });
        if (decision.kind === "ignore") return;
        if (decision.kind === "drop") {
          const state = yield* Ref.get(stateRef);
          const next = dropWatch(state, threadId);
          if (next !== state) yield* commit(next);
          return;
        }
        const nowMs = yield* Clock.currentTimeMillis;
        let conversation = decision.conversationThreadId;
        if (conversation === null) {
          const route = (yield* Ref.get(routesRef)).get(threadId);
          if (
            route !== undefined &&
            route.assistant === decision.assistantProjectId &&
            nowMs - route.atMs < PUSH_CALLER_ROUTE_TTL_MS
          ) {
            conversation = route.conversation;
          }
        }
        if (conversation === null) {
          const snapshot = yield* projections.getShellSnapshot().pipe(
            Effect.orElseSucceed(() => ({
              threads: [] as ReadonlyArray<OrchestrationThreadShell>,
            })),
          );
          conversation = guessConversation(
            snapshot.threads.map(toPushShell),
            decision.assistantProjectId,
          );
        }
        if (conversation === null) return;
        const via = yield* viaOf(conversation);
        yield* commit(
          upsertWatch(yield* Ref.get(stateRef), {
            threadId,
            assistantProjectId: decision.assistantProjectId,
            conversationThreadId: conversation,
            via,
            since: event.payload.createdAt,
            startedAt: new Date(nowMs).toISOString(),
          }),
        );
        yield* Effect.logInfo("assistant push: watching a handed-off chat").pipe(
          Effect.annotateLogs({
            threadId,
            assistant: decision.assistantProjectId,
            conversation,
            via: via?.kind ?? "desktop",
          }),
        );
      });

    // ── the Uno chat's launch check (the app) ──

    /** A turn of the Uno chat starts: watch its answer when it runs for the app. */
    const noteUnoTurn = (
      event: Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>,
    ) =>
      Effect.gen(function* () {
        const threadId = event.payload.threadId;
        const origin = event.metadata.origin;
        const component = origin?.kind === "system" ? origin.component : null;
        const known = (yield* Ref.get(launchWatchesRef)).get(threadId);
        if (known !== undefined && known.messageId === event.payload.messageId) return;
        const forTheApp =
          origin === undefined ||
          component === SYSTEM_TURN_ORIGIN_COMPONENT ||
          component === LAUNCH_CHECK_ORIGIN_COMPONENT;
        const shell = forTheApp ? yield* shellOf(threadId) : null;
        const watched =
          shell !== null &&
          shell.projectId === ASSISTANT_PROJECT_ID &&
          isAssistantConversationThread(toPushShell(shell));
        const nowMs = yield* Clock.currentTimeMillis;
        yield* Ref.update(launchWatchesRef, (map) => {
          const next = new Map(map);
          // Any other turn (Telegram, the person again) ends the old watch.
          if (!watched) next.delete(threadId);
          else
            next.set(threadId, {
              messageId: event.payload.messageId,
              original: null,
              checksMade: 0,
              sinceMs: nowMs,
            });
          return next;
        });
      });

    const forgetLaunchWatch = (threadId: string) =>
      Ref.update(launchWatchesRef, (map) => {
        if (!map.has(threadId)) return map;
        const next = new Map(map);
        next.delete(threadId);
        return next;
      });

    /** Look at one watched Uno turn: still running, fine, or a claim with no launch. */
    const checkUnoTurn = (threadId: string, watch: LaunchWatch, nowMs: number) =>
      Effect.gen(function* () {
        if (nowMs - watch.sinceMs > LAUNCH_WATCH_MS) return yield* forgetLaunchWatch(threadId);
        const id = ThreadId.make(threadId);
        const turns = yield* turnRepository
          .listByThreadId({ threadId: id })
          .pipe(Effect.orElseSucceed(() => []));
        const turn = turns.find(
          (entry) => entry.pendingMessageId === watch.messageId && entry.turnId !== null,
        );
        if (turn === undefined || turn.turnId === null) return;
        if (turn.state === "pending" || turn.state === "running") return;
        if (turn.state !== "completed") return yield* forgetLaunchWatch(threadId);
        // A Telegram / Slack row owns it: their reply path checks it.
        const rows = yield* pendingReplies
          .listByThread({ threadId: id, limit: 20 })
          .pipe(Effect.orElseSucceed(() => []));
        if (rows.some((row) => row.userMessageId === watch.messageId)) {
          return yield* forgetLaunchWatch(threadId);
        }
        const detail = Option.getOrNull(
          yield* projections
            .getThreadDetailById(id)
            .pipe(Effect.orElseSucceed(() => Option.none())),
        );
        if (detail === null) return yield* forgetLaunchWatch(threadId);
        const session = detail.session;
        if (
          session !== null &&
          (session.status === "running" || session.status === "starting") &&
          session.activeTurnId === turn.turnId
        ) {
          return;
        }
        const own = detail.messages.filter(
          (message) =>
            message.role === "assistant" &&
            message.turnId === turn.turnId &&
            message.text.trim().length > 0,
        );
        if (own.some((message) => message.streaming)) return;
        const final = own.at(-1);
        if (final === undefined) {
          if (nowMs - Date.parse(turn.completedAt ?? turn.requestedAt) > 45_000) {
            yield* forgetLaunchWatch(threadId);
          }
          return;
        }
        if (
          nowMs - Math.max(Date.parse(final.updatedAt), Date.parse(turn.completedAt ?? "")) <
          LAUNCH_SETTLE_MS
        ) {
          return;
        }
        const original =
          watch.original ??
          detail.messages.find((message) => message.id === watch.messageId)?.text ??
          "";
        const truth = decideLaunchTruth({
          text: final.text,
          activities: detail.activities,
          turnId: turn.turnId,
          checksMade: watch.checksMade,
        });
        if (truth.kind === "ok") return yield* forgetLaunchWatch(threadId);
        if (truth.kind === "check") {
          if (!(yield* conversationFree(id))) return;
          const messageId = MessageId.make(crypto.randomUUID());
          yield* Ref.update(launchWatchesRef, (map) =>
            new Map(map).set(threadId, {
              messageId,
              original,
              checksMade: watch.checksMade + 1,
              sinceMs: nowMs,
            }),
          );
          yield* engine.dispatch(
            {
              type: "thread.turn.start",
              commandId: CommandId.make(`${LAUNCH_CHECK_ORIGIN_COMPONENT}:${crypto.randomUUID()}`),
              threadId: id,
              message: {
                messageId,
                role: "user",
                text: launchCheckPromptText(original),
                attachments: [],
              },
              runtimeMode: detail.runtimeMode,
              interactionMode: detail.interactionMode,
              createdAt: new Date(nowMs).toISOString(),
            },
            { origin: systemCommandOrigin(LAUNCH_CHECK_ORIGIN_COMPONENT, "launch claim, no call") },
          );
          yield* Effect.logInfo("uno launch check: a claim with no launch; asked Uno once").pipe(
            Effect.annotateLogs({ threadId, turnId: turn.turnId }),
          );
          return;
        }
        // Claimed again with no call: the person reads the honest line.
        const at = new Date(nowMs).toISOString();
        const messageId = MessageId.make(crypto.randomUUID());
        const turnId = TurnId.make(turn.turnId);
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(
            `${LAUNCH_CHECK_ORIGIN_COMPONENT}:delta:${crypto.randomUUID()}`,
          ),
          threadId: id,
          messageId,
          delta: notLaunchedText(detectReplyLanguage(original, null)),
          turnId,
          createdAt: at,
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`${LAUNCH_CHECK_ORIGIN_COMPONENT}:done:${crypto.randomUUID()}`),
          threadId: id,
          messageId,
          turnId,
          createdAt: at,
        });
        yield* Effect.logWarning("uno launch check: claimed again with no launch; said so").pipe(
          Effect.annotateLogs({ threadId, turnId: turn.turnId }),
        );
        yield* forgetLaunchWatch(threadId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("uno launch check failed on a turn").pipe(
            Effect.annotateLogs({ threadId, cause }),
            Effect.andThen(forgetLaunchWatch(threadId)),
          ),
        ),
      );

    const lookAtLaunches = (nowMs: number) =>
      Effect.gen(function* () {
        const watches = yield* Ref.get(launchWatchesRef);
        for (const [threadId, watch] of watches) yield* checkUnoTurn(threadId, watch, nowMs);
      });

    const handleEvent = (event: OrchestrationEvent) =>
      Effect.gen(function* () {
        if (event.type === "thread.turn-start-requested") {
          yield* exclusive(onTurnStart(event));
          yield* noteUnoTurn(event);
          return;
        }
        if (event.type === "thread.archived" || event.type === "thread.deleted") {
          // The person put it away: nothing to report.
          yield* exclusive(
            Effect.gen(function* () {
              const state = yield* Ref.get(stateRef);
              const next = dropWatch(state, event.payload.threadId);
              if (next !== state) yield* commit(next);
            }),
          );
          return;
        }
        const watched = new Set((yield* Ref.get(stateRef)).watches.map((watch) => watch.threadId));
        if (watched.size === 0 || !eventTouchesThreads(event, watched)) return;
        const id = event.aggregateId;
        const payloadThreadId = (event.payload as { readonly threadId?: unknown } | null)?.threadId;
        const threadId = watched.has(id)
          ? id
          : typeof payloadThreadId === "string"
            ? payloadThreadId
            : id;
        yield* Ref.update(dirtyRef, (set) => new Set(set).add(threadId));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant push failed on an event").pipe(
            Effect.annotateLogs({ eventType: event.type, cause }),
          ),
        ),
      );

    // ── outcomes ──

    const lookAtWatches = (nowMs: number) =>
      Effect.gen(function* () {
        let state = pruneWatches(yield* Ref.get(stateRef), nowMs);
        const dirty = yield* Ref.getAndSet(dirtyRef, new Set());
        const probedAt = yield* Ref.get(probedAtRef);
        const nextProbedAt = new Map(probedAt);
        const sentKeys = new Set(state.sentKeys);
        let changed = state !== (yield* Ref.get(stateRef));
        for (const watch of state.watches) {
          if (watch.remote !== undefined) {
            const remote = watch.remote;
            const ageMs = nowMs - Date.parse(watch.startedAt);
            if (
              remoteComputers === null ||
              nowMs - (probedAt.get(watch.threadId) ?? 0) < remotePollEveryMs(ageMs)
            ) {
              continue;
            }
            nextProbedAt.set(watch.threadId, nowMs);
            const status = yield* remoteComputers
              .chatStatus({
                boxId: remote.boxId,
                computerName: remote.computerName,
                threadId: watch.threadId,
              })
              .pipe(
                Effect.timeoutOption("25 seconds"),
                Effect.map(Option.getOrNull),
                Effect.catch((error) =>
                  Effect.logDebug("assistant push: remote chat status unavailable").pipe(
                    Effect.annotateLogs({ threadId: watch.threadId, code: error.code }),
                    Effect.as(null),
                  ),
                ),
              );
            if (status === null) continue;
            yield* remoteComputers.noteStatus(watch.threadId, status);
            const result = noticeFromRemoteStatus({ watch, status, sentKeys, nowMs });
            if (result === null) continue;
            sentKeys.add(result.notice.key);
            state = rememberSent(state, result.notice.key);
            state = { ...state, outbox: [...state.outbox, result.notice] };
            if (result.endsWatch) state = dropWatch(state, watch.threadId);
            changed = true;
            yield* Effect.logInfo("assistant push: remote outcome noticed").pipe(
              Effect.annotateLogs({
                threadId: watch.threadId,
                boxId: remote.boxId,
                outcome: result.notice.outcome,
              }),
            );
            continue;
          }
          const due =
            dirty.has(watch.threadId) ||
            nowMs - (probedAt.get(watch.threadId) ?? 0) >= PROBE_EVERY_MS;
          if (!due) continue;
          nextProbedAt.set(watch.threadId, nowMs);
          const settled = yield* probe(ThreadId.make(watch.threadId)).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (settled === null) continue;
          const shell = yield* shellOf(watch.threadId);
          if (shell !== null && shell.archivedAt !== null) {
            state = dropWatch(state, watch.threadId);
            changed = true;
            continue;
          }
          const project =
            shell === null
              ? null
              : yield* projections.getProjectShellById(shell.projectId).pipe(
                  Effect.map((value) => (Option.isSome(value) ? value.value.title : null)),
                  Effect.orElseSucceed(() => null),
                );
          const report = yield* Effect.promise(() => readReports(os.homedir())).pipe(
            Effect.map((reports) =>
              reportOfThread(reports, watch.threadId, {
                sinceMs: Date.parse(watch.since) || 0,
                nowMs,
              }),
            ),
          );
          const result = noticeFromProbe({
            watch,
            probe: settled,
            title: shell?.title ?? watch.threadId,
            project,
            sentKeys,
            nowMs,
            report: report === null ? undefined : { title: report.title, url: report.url },
          });
          if (result === null) continue;
          sentKeys.add(result.notice.key);
          state = rememberSent(state, result.notice.key);
          state = { ...state, outbox: [...state.outbox, result.notice] };
          if (result.endsWatch) state = dropWatch(state, watch.threadId);
          changed = true;
          yield* Ref.update(reportedRef, (map) =>
            new Map(map).set(watch.threadId, nowMs + REPORTED_HOLD_MS),
          );
          yield* Effect.logInfo("assistant push: outcome noticed").pipe(
            Effect.annotateLogs({
              threadId: watch.threadId,
              outcome: result.notice.outcome,
              conversation: watch.conversationThreadId,
            }),
          );
        }
        // Forget probe times of chats no longer watched.
        const live = new Set(state.watches.map((watch) => watch.threadId));
        for (const key of nextProbedAt.keys()) if (!live.has(key)) nextProbedAt.delete(key);
        yield* Ref.set(probedAtRef, nextProbedAt);
        if (changed) yield* commit(state);
      });

    // ── delivery ──

    /** The conversation can take a turn now (nothing running, nothing queued for it). */
    const conversationFree = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const shell = yield* projections
          .getThreadShellById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        const rows = yield* pendingReplies
          .listByThread({ threadId, limit: 50 })
          .pipe(Effect.orElseSucceed(() => []));
        const turns = yield* turnRepository
          .listByThreadId({ threadId })
          .pipe(Effect.orElseSucceed(() => []));
        const busy = isThreadBusyForNewTurn({
          rows,
          selfRowId: null,
          selfCreatedAt: null,
          session: Option.isSome(shell) ? shell.value.session : null,
          turns,
          nowMs: yield* Clock.currentTimeMillis,
        });
        return !busy.busy;
      });

    /** Hand one batch over. `true`: out of the outbox (sent, queued, or not deliverable). */
    const deliverBatch = (batch: PushBatch) =>
      Effect.gen(function* () {
        const conversation = yield* shellOf(batch.conversationThreadId);
        if (conversation === null || conversation.archivedAt !== null) {
          yield* Effect.logWarning("assistant push: conversation gone; notice dropped").pipe(
            Effect.annotateLogs({ conversation: batch.conversationThreadId }),
          );
          return true;
        }
        const text = formatPushNotice(batch.notices);
        const fallbackText = formatPushFallback(batch.notices);
        if (batch.via !== null) {
          const via = batch.via;
          const row = yield* pendingReplies
            .get({
              kind: via.kind,
              connectorProjectId: ProjectId.make(via.connectorProjectId),
              replyKey: via.replyKey,
            })
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(row)) {
            const input = {
              from: row.value,
              replyKey: `push:${crypto.randomUUID()}`,
              text,
              fallbackText,
              runtimeMode: conversation.runtimeMode,
              interactionMode: conversation.interactionMode,
            };
            const outcome =
              via.kind === "telegram"
                ? yield* telegram.enqueueSystemTurn(input)
                : yield* slack.enqueueSystemTurn(input);
            yield* Effect.logInfo("assistant push: notice queued for the chat").pipe(
              Effect.annotateLogs({
                conversation: batch.conversationThreadId,
                chat: via.kind,
                outcome,
                notices: batch.notices.length,
              }),
            );
            return outcome !== "failed";
          }
          // The chat's rows are gone (pruned): the conversation itself still hears it.
        }
        if (!(yield* conversationFree(conversation.id))) return false;
        yield* engine.dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(`assistant-push:${crypto.randomUUID()}`),
            threadId: conversation.id,
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode: conversation.runtimeMode,
            interactionMode: conversation.interactionMode,
            createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          },
          { origin: systemCommandOrigin(SYSTEM_TURN_ORIGIN_COMPONENT, "work update") },
        );
        yield* Effect.logInfo("assistant push: notice turn started").pipe(
          Effect.annotateLogs({
            conversation: batch.conversationThreadId,
            notices: batch.notices.length,
          }),
        );
        return true;
      });

    const flushOutbox = (nowMs: number) =>
      Effect.gen(function* () {
        let state = yield* Ref.get(stateRef);
        const batches = dueBatches(state, nowMs);
        if (batches.length === 0) return;
        let changed = false;
        for (const batch of batches) {
          const handed = yield* deliverBatch(batch).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("assistant push: delivery failed; retrying").pipe(
                Effect.annotateLogs({ conversation: batch.conversationThreadId, cause }),
                Effect.as(false),
              ),
            ),
          );
          if (handed) {
            state = markBatchSent(state, batch, nowMs);
            changed = true;
          }
        }
        if (changed) yield* commit(state);
      });

    const tick = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      yield* lookAtWatches(nowMs);
      yield* flushOutbox(nowMs);
      yield* lookAtLaunches(nowMs);
    }).pipe(
      exclusive,
      Effect.catchCause((cause) =>
        Effect.logWarning("assistant push tick failed").pipe(Effect.annotateLogs({ cause })),
      ),
    );

    if (enabled) {
      yield* Effect.forkScoped(engine.streamDomainEvents.pipe(Stream.runForEach(handleEvent)));
      yield* Effect.forkScoped(
        Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(options?.tick ?? TICK)))),
      );
    }

    // ── the service ──

    const noteCaller: AssistantPushServiceShape["noteCaller"] = (input) =>
      enabled
        ? Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
            Ref.update(routesRef, (map) => {
              const next = new Map(
                [...map].filter(([, route]) => nowMs - route.atMs < PUSH_CALLER_ROUTE_TTL_MS),
              );
              next.set(input.threadId, {
                assistant: input.assistantProjectId,
                conversation: input.conversationThreadId,
                atMs: nowMs,
              });
              return next;
            }),
          )
        : Effect.void;

    const watchRemote: AssistantPushServiceShape["watchRemote"] = (input) =>
      enabled
        ? exclusive(
            Effect.gen(function* () {
              const nowMs = yield* Clock.currentTimeMillis;
              const at = new Date(nowMs).toISOString();
              const via = yield* viaOf(input.conversationThreadId);
              yield* commit(
                upsertWatch(yield* Ref.get(stateRef), {
                  threadId: input.threadId,
                  assistantProjectId: input.assistantProjectId,
                  conversationThreadId: input.conversationThreadId,
                  via,
                  since: at,
                  startedAt: at,
                  remote: { boxId: input.boxId, computerName: input.computerName },
                }),
              );
            }),
          )
        : Effect.void;

    const chatOf: AssistantPushServiceShape["chatOf"] = (threadId) => viaOf(threadId);

    const tellViaChat: AssistantPushServiceShape["tellViaChat"] = (input) =>
      Effect.gen(function* () {
        const conversation = yield* shellOf(input.threadId);
        if (conversation === null || conversation.archivedAt !== null) return false;
        const row = yield* pendingReplies
          .get({
            kind: input.chat.kind,
            connectorProjectId: ProjectId.make(input.chat.connectorProjectId),
            replyKey: input.chat.replyKey,
          })
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(row)) return false;
        const turn = {
          from: row.value,
          replyKey: `note:${crypto.randomUUID()}`,
          text: input.text,
          fallbackText: input.fallbackText,
          runtimeMode: conversation.runtimeMode,
          interactionMode: conversation.interactionMode,
        };
        const outcome =
          input.chat.kind === "telegram"
            ? yield* telegram.enqueueSystemTurn(turn)
            : yield* slack.enqueueSystemTurn(turn);
        return outcome !== "failed";
      }).pipe(Effect.orElseSucceed(() => false));

    const reportsOutcomeOf: AssistantPushServiceShape["reportsOutcomeOf"] = (threadId) =>
      Effect.gen(function* () {
        if (!enabled) return false;
        const state = yield* Ref.get(stateRef);
        if (state.watches.some((watch) => watch.threadId === threadId)) return true;
        if (state.outbox.some((notice) => notice.threadId === threadId)) return true;
        const until = (yield* Ref.get(reportedRef)).get(threadId);
        return until !== undefined && until > (yield* Clock.currentTimeMillis);
      });

    const watchedBy: AssistantPushServiceShape["watchedBy"] = (assistantProjectId) =>
      Ref.get(stateRef).pipe(
        Effect.map((state) => {
          const pending = new Set(
            state.outbox
              .filter((notice) => notice.assistantProjectId === assistantProjectId)
              .map((notice) => notice.threadId),
          );
          const ids = new Set([
            ...state.watches
              .filter((watch) => watch.assistantProjectId === assistantProjectId)
              .map((watch) => watch.threadId),
            ...pending,
          ]);
          return [...ids].map((id) => ({
            threadId: ThreadId.make(id),
            reportPending: pending.has(id),
          }));
        }),
      );

    return {
      enabled,
      noteCaller,
      watchRemote,
      chatOf,
      tellViaChat,
      reportsOutcomeOf,
      watchedBy,
    } satisfies AssistantPushServiceShape;
  });

export const AssistantPushServiceLive = Layer.effect(
  AssistantPushService,
  makeAssistantPush(),
).pipe(
  Layer.provide(
    Layer.mergeAll(ProjectionTurnRepositoryLive, ManagerConnectorPendingReplyRepositoryLive),
  ),
);
