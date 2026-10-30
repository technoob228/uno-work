/**
 * T3 v2 compat: handlers of WsRpcGroupV2 for one phone socket.
 *
 * Writes go through our v1 WS handlers via an in-process RPC client
 * (RpcTest.makeClient over the same per-socket v1 layer the web gets), so a
 * phone command takes exactly the web's path — normalize, startup queue,
 * archive side effects — and none of that code is duplicated or touched.
 *
 * Reads come straight from ProjectionSnapshotQuery and are mapped to v2 JSON.
 * Live updates: subscribe to the domain-event PubSub first, read the snapshot,
 * then re-read only what changed, at most once per COALESCE window, and only
 * while this phone is subscribed. Nothing here runs for web sockets: with no
 * phone connected the adapter costs nothing.
 */
import {
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { Duration, Effect, Option, Queue, type Scope, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { translateV2Command, translateV2Launch, V2_REFUSAL, v2CommandNeeds } from "./commands.ts";
import { toV2ServerConfig } from "./mapConfig.ts";
import {
  toV2ProjectShell,
  toV2ThreadShell,
  V2_SHELL_SCHEMA_VERSION,
  type V2Json,
  v2ShellLocation,
} from "./mapShell.ts";
import { deriveRuntimeRequests, toV2AppThread } from "./mapThread.ts";
import { makeV2Reads } from "./reads.ts";
import { v2UnsupportedError, V2_METHODS, WsRpcGroupV2 } from "./rpcGroup.ts";

/** Re-read window for live updates of one subscription (Misha 29.10: ≤ ~5/s per chat). */
export const V2_COALESCE = Duration.millis(150);
const V2_BATCH_MAX = 512;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw =>
  value && typeof value === "object" ? (value as Raw) : {};
const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const dispatchError = (input: { commandId: string; commandType: string; message: string }) => ({
  _tag: "OrchestrationV2DispatchCommandError" as const,
  commandId: input.commandId,
  commandType: input.commandType,
  message: input.message,
});

const threadProjectionError = (threadId: string, message: string) => ({
  _tag: "OrchestrationV2GetThreadProjectionError" as const,
  threadId,
  message,
});

const shellError = (message: string) => ({
  _tag: "OrchestrationV2GetShellSnapshotError" as const,
  message,
});

const causeMessage = (cause: unknown, fallback: string) => {
  const record = asRecord(cause);
  return asString(record["message"]) ?? (cause instanceof Error ? cause.message : fallback);
};

const makeV1Client = () => RpcTest.makeClient(WsRpcGroup);
type V1Client = Effect.Success<ReturnType<typeof makeV1Client>>;
type V1Requirements = Exclude<Effect.Services<ReturnType<typeof makeV1Client>>, Scope.Scope>;

// @effect-diagnostics-next-line anyUnknownInErrorContext:off
export const makeV2HandlersLayer = WsRpcGroupV2.toLayer(
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const turnRepository = Option.getOrUndefined(
      yield* Effect.serviceOption(ProjectionTurnRepository),
    );
    // Same handlers, same session as a web socket of this person. The layer
    // scope ends once the socket's RpcServer is built, so an in-process client
    // is made per call, inside that call's own scope (cheap: no serialization).
    const v1Handlers = yield* Effect.context<V1Requirements>();
    const withV1 = <A, E>(use: (client: V1Client) => Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.scoped(makeV1Client().pipe(Effect.flatMap(use))).pipe(Effect.provide(v1Handlers));

    const nowIso = () => new Date().toISOString();

    const { currentSequence, readThread, readProjection, pendingSummaryOf, buildShellSnapshot } =
      makeV2Reads(projections, turnRepository);

    /** Attach to live events before reading anything, so nothing published
     *  while the snapshot loads is lost. */
    const attachLiveBuffer = (filter: (event: OrchestrationEvent) => boolean) =>
      Effect.gen(function* () {
        const buffer = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          engine.streamDomainEvents.pipe(
            Stream.filter(filter),
            Stream.runForEach((event) => Queue.offer(buffer, event)),
          ),
          { startImmediately: true },
        );
        return buffer;
      });

    const shellUpdatesFor = (batch: ReadonlyArray<OrchestrationEvent>) =>
      Effect.gen(function* () {
        const latestByAggregate = new Map<string, OrchestrationEvent>();
        for (const event of batch) {
          latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event);
        }
        const items: V2Json[] = [];
        for (const event of latestByAggregate.values()) {
          if (event.aggregateKind === "project") {
            const project = yield* projections
              .getProjectShellById(ProjectId.make(event.aggregateId))
              .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationProjectShell>()));
            items.push(
              Option.isSome(project)
                ? {
                    kind: "project.updated",
                    sequence: event.sequence,
                    project: toV2ProjectShell(project.value),
                  }
                : {
                    kind: "project.removed",
                    sequence: event.sequence,
                    projectId: event.aggregateId,
                  },
            );
            continue;
          }
          const thread = yield* projections
            .getThreadShellById(ThreadId.make(event.aggregateId))
            .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));
          if (Option.isNone(thread)) {
            items.push({
              kind: "thread.removed",
              sequence: event.sequence,
              location: "active",
              threadId: event.aggregateId,
            });
            continue;
          }
          const pending = yield* pendingSummaryOf(thread.value);
          items.push({
            kind: "thread.updated",
            sequence: event.sequence,
            location: v2ShellLocation(thread.value),
            thread: toV2ThreadShell(thread.value, { pendingRuntimeRequest: pending }),
          });
        }
        return items;
      });

    const subscribeShell = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const buffer = yield* attachLiveBuffer(() => true);
          const snapshot = yield* buildShellSnapshot.pipe(
            Effect.mapError((cause) => shellError(causeMessage(cause, "Could not load chats."))),
          );
          const snapshotSequence = snapshot["snapshotSequence"] as number;
          const live = Stream.fromQueue(buffer).pipe(
            Stream.filter((event) => event.sequence > snapshotSequence),
            Stream.groupedWithin(V2_BATCH_MAX, V2_COALESCE),
            Stream.mapEffect(shellUpdatesFor),
            Stream.flatMap((items) => Stream.fromIterable(items)),
          );
          return Stream.concat(
            Stream.make({ kind: "snapshot", snapshot }, { kind: "synchronized" }),
            live,
          );
        }),
      );

    const subscribeThread = (payload: unknown) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const threadIdRaw = asString(asRecord(payload)["threadId"]);
          if (!threadIdRaw) {
            return yield* Effect.fail(threadProjectionError("unknown", "threadId is required."));
          }
          const threadId = ThreadId.make(threadIdRaw);
          const buffer = yield* attachLiveBuffer(
            (event) => event.aggregateKind === "thread" && event.aggregateId === threadId,
          );
          const sequence = yield* currentSequence;
          const first = yield* readProjection(threadId);
          if (Option.isNone(first)) {
            return yield* Effect.fail(
              threadProjectionError(threadId, `Thread ${threadId} was not found.`),
            );
          }
          let lastThread = first.value.thread;
          const live = Stream.fromQueue(buffer).pipe(
            Stream.filter((event) => event.sequence > sequence),
            Stream.groupedWithin(V2_BATCH_MAX, V2_COALESCE),
            Stream.mapEffect((batch) =>
              // @effect-diagnostics-next-line anyUnknownInErrorContext:off
              Effect.gen(function* (): Generator<any, ReadonlyArray<V2Json>, any> {
                const lastSequence = Math.max(...batch.map((event) => event.sequence));
                const deleted = batch.find((event) => event.type === "thread.deleted");
                const next = deleted ? Option.none() : yield* readProjection(threadId);
                if (Option.isNone(next)) {
                  const at = deleted?.occurredAt ?? nowIso();
                  return [
                    {
                      kind: "event",
                      sequence: lastSequence,
                      event: {
                        id: deleted?.eventId ?? `deleted:${threadId}:${lastSequence}`,
                        threadId,
                        occurredAt: at,
                        type: "thread.deleted",
                        payload: { ...toV2AppThread(lastThread), deletedAt: at },
                      },
                    },
                  ];
                }
                lastThread = next.value.thread;
                return [
                  {
                    kind: "snapshot",
                    snapshotSequence: lastSequence,
                    projection: next.value.projection,
                  },
                ];
              }),
            ),
            Stream.flatMap((items) => Stream.fromIterable(items)),
          );
          return Stream.concat(
            Stream.make(
              { kind: "snapshot", snapshotSequence: sequence, projection: first.value.projection },
              { kind: "synchronized" },
            ),
            live,
          );
        }),
      );

    const dispatchV1 = (command: Parameters<V1Client["orchestration.dispatchCommand"]>[0]) =>
      withV1((v1) => v1["orchestration.dispatchCommand"](command));

    const dispatchCommand = (payload: unknown) =>
      Effect.gen(function* () {
        const raw = asRecord(payload);
        const commandId = asString(raw["commandId"]) ?? "unknown";
        const commandType = asString(raw["type"]) ?? "unknown";
        const threadIdRaw = asString(raw["threadId"]);
        const fail = (message: string) =>
          Effect.fail(dispatchError({ commandId, commandType, message }));

        const needs = v2CommandNeeds(commandType);
        let thread: OrchestrationThreadShell | null | undefined;
        let requests: ReturnType<typeof deriveRuntimeRequests> | undefined;
        if (needs === "thread" && threadIdRaw) {
          thread = Option.getOrNull(
            yield* projections
              .getThreadShellById(ThreadId.make(threadIdRaw))
              .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>())),
          );
        }
        if (needs === "requests" && threadIdRaw) {
          const detail = yield* readThread(ThreadId.make(threadIdRaw));
          requests = Option.isSome(detail) ? deriveRuntimeRequests(detail.value.activities) : [];
        }
        const plan = translateV2Command(payload, {
          now: nowIso(),
          ...(thread !== undefined ? { thread } : {}),
          ...(requests !== undefined ? { requests } : {}),
        });
        switch (plan.kind) {
          case "reject":
            return yield* fail(plan.message);
          case "noop":
            return { sequence: yield* currentSequence };
          case "dispatch": {
            let sequence = 0;
            for (const command of plan.commands) {
              const result = yield* dispatchV1(command).pipe(
                Effect.catch((cause) => fail(causeMessage(cause, "Uno Work could not do this."))),
              );
              sequence = result.sequence;
            }
            return { sequence };
          }
        }
      });

    const launchThread = (payload: unknown) =>
      Effect.gen(function* () {
        const raw = asRecord(payload);
        const commandId = asString(raw["commandId"]) ?? "unknown";
        const projectId = asString(raw["projectId"]) ?? "unknown";
        const fail = (message: string) =>
          Effect.fail({
            _tag: "OrchestrationV2ThreadLaunchError" as const,
            commandId,
            projectId,
            message,
          });
        const plan = translateV2Launch(payload, {
          now: nowIso(),
          newId: () => crypto.randomUUID(),
        });
        if ("kind" in plan) return yield* fail(plan.message);
        if (plan.create.kind !== "dispatch") {
          return yield* fail(
            plan.create.kind === "reject" ? plan.create.message : V2_REFUSAL.badCommand,
          );
        }
        let sequence = 0;
        for (const command of [...plan.create.commands, ...(plan.message ? [plan.message] : [])]) {
          const result = yield* dispatchV1(command).pipe(
            Effect.catch((cause) =>
              fail(causeMessage(cause, "Uno Work could not start the chat.")),
            ),
          );
          sequence = result.sequence;
        }
        const projection = yield* readProjection(ThreadId.make(plan.threadId));
        if (Option.isNone(projection))
          return yield* fail("The new chat did not appear. Try again.");
        return {
          threadId: plan.threadId,
          projection: projection.value.projection,
          resumed: false,
          sequence,
        };
      });

    const getThreadProjection = (payload: unknown) =>
      Effect.gen(function* () {
        const threadIdRaw = asString(asRecord(payload)["threadId"]);
        if (!threadIdRaw)
          return yield* Effect.fail(threadProjectionError("unknown", "threadId is required."));
        const projection = yield* readProjection(ThreadId.make(threadIdRaw));
        if (Option.isNone(projection)) {
          return yield* Effect.fail(
            threadProjectionError(threadIdRaw, `Thread ${threadIdRaw} was not found.`),
          );
        }
        return projection.value.projection;
      });

    const getArchivedShellSnapshot = () =>
      buildShellSnapshot.pipe(
        Effect.map((snapshot) => ({
          schemaVersion: V2_SHELL_SCHEMA_VERSION,
          snapshotSequence: snapshot["snapshotSequence"],
          projects: snapshot["projects"],
          threads: snapshot["archivedThreads"],
        })),
        Effect.mapError((cause) =>
          shellError(causeMessage(cause, "Could not load archived chats.")),
        ),
      );

    const loadConfig = withV1((v1) => v1["server.getConfig"]({})).pipe(
      Effect.map(toV2ServerConfig),
    );

    return WsRpcGroupV2.of({
      [V2_METHODS.serverProbe]: () => Effect.succeed({}),
      [V2_METHODS.serverGetConfig]: () => loadConfig,
      // The phone waits for the first snapshot and treats the stream ending
      // as a lost connection: send one and keep it open.
      [V2_METHODS.subscribeServerConfig]: () =>
        Stream.concat(
          Stream.fromEffect(loadConfig).pipe(
            Stream.map((config) => ({ version: 1, type: "snapshot", config })),
          ),
          Stream.never,
        ),
      [V2_METHODS.subscribeServerLifecycle]: () => Stream.never,
      [V2_METHODS.subscribeAuthAccess]: () => Stream.never,
      [V2_METHODS.dispatchCommand]: dispatchCommand,
      [V2_METHODS.launchThread]: launchThread,
      [V2_METHODS.getThreadProjection]: getThreadProjection,
      [V2_METHODS.getArchivedShellSnapshot]: getArchivedShellSnapshot,
      [V2_METHODS.subscribeShell]: subscribeShell,
      [V2_METHODS.subscribeThread]: subscribeThread,
      [V2_METHODS.unsupported]: (payload: unknown) =>
        Effect.fail(v2UnsupportedError(asString(asRecord(payload)["method"]) ?? "this")),
      [V2_METHODS.silentStream]: () => Stream.never,
    });
  }),
);
