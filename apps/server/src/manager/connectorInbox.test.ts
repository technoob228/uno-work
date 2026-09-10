import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { Effect, Layer, Option, Ref } from "effect";

import type { ManagerRepositoryError } from "../persistence/Errors.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ManagerConnectorRepository,
  type ManagerConnectorKey,
} from "../persistence/Services/ManagerConnectors.ts";
import {
  INBOX_MAX_ATTEMPTS,
  processInboxEvents,
  recoverPendingEvents,
  type ConnectorInboxHandler,
} from "./connectorInbox.ts";

interface FakeUpdate {
  readonly update_id: number;
  readonly text: string;
}

const key: ManagerConnectorKey = { projectId: ProjectId.make("assistant-home"), kind: "telegram" };

const event = (updateId: number, text = `msg-${updateId}`) => ({
  providerEventId: String(updateId),
  payload: { update_id: updateId, text } satisfies FakeUpdate,
});

const decodeFake = (payload: unknown): FakeUpdate | null =>
  typeof payload === "object" &&
  payload !== null &&
  typeof (payload as { update_id?: unknown }).update_id === "number"
    ? (payload as FakeUpdate)
    : null;

const repositoryLayer = ManagerConnectorRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const makeHandler = (
  handled: Ref.Ref<ReadonlyArray<string>>,
  options?: { readonly failOn?: (update: FakeUpdate) => boolean },
): ConnectorInboxHandler<FakeUpdate, Error> => ({
  key,
  offsetAfter: (update) => update.update_id + 1,
  handle: (update) =>
    options?.failOn?.(update) === true
      ? Effect.fail(new Error(`boom ${update.update_id}`))
      : Ref.update(handled, (entries) => [...entries, update.text]),
});

const currentOffset = Effect.gen(function* () {
  const repository = yield* ManagerConnectorRepository;
  const state = yield* repository.getState(key);
  return Option.isSome(state) ? state.value.offset : null;
});

it.layer(NodeServices.layer)("connector durable inbox", (it) => {
  it.effect("skips updates that were already settled (duplicate update ids)", () =>
    Effect.gen(function* () {
      const handled = yield* Ref.make<ReadonlyArray<string>>([]);
      const handler = makeHandler(handled);

      const first = yield* processInboxEvents(handler, [event(10), event(11)]);
      expect(first).toEqual(["handled", "handled"]);

      // Telegram re-delivers 11 (offset write lost) together with a new 12.
      const second = yield* processInboxEvents(handler, [event(11), event(12)]);
      expect(second).toEqual(["duplicate", "handled"]);

      expect(yield* Ref.get(handled)).toEqual(["msg-10", "msg-11", "msg-12"]);
      expect(yield* currentOffset).toBe(13);
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("advances the persisted offset only after the update is handled", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      const offsetsSeenWhileHandling: Array<number | null> = [];
      // The handler itself reads the persisted offset, so it carries the
      // repository in its context.
      const handler: ConnectorInboxHandler<
        FakeUpdate,
        ManagerRepositoryError,
        ManagerConnectorRepository
      > = {
        key,
        offsetAfter: (update) => update.update_id + 1,
        handle: () =>
          currentOffset.pipe(
            Effect.map((offset) => {
              offsetsSeenWhileHandling.push(offset);
            }),
          ),
      };

      yield* processInboxEvents(handler, [event(1)]);
      // While handling update 1 nothing had been persisted yet.
      expect(offsetsSeenWhileHandling).toEqual([null]);
      expect(yield* currentOffset).toBe(2);

      yield* processInboxEvents(handler, [event(2)]);
      // While handling update 2 the offset still pointed at 2, not 3.
      expect(offsetsSeenWhileHandling).toEqual([null, 2]);
      expect(yield* currentOffset).toBe(3);

      const row = yield* repository.getInboxEvent({ ...key, providerEventId: "2" });
      expect(Option.isSome(row) && row.value.status).toBe("handled");
      expect(Option.isSome(row) && row.value.handledAt !== null).toBe(true);
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("records a handling failure and still moves past it", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      const handled = yield* Ref.make<ReadonlyArray<string>>([]);
      const handler = makeHandler(handled, { failOn: (update) => update.update_id === 5 });

      const outcomes = yield* processInboxEvents(handler, [event(4), event(5), event(6)]);
      expect(outcomes).toEqual(["handled", "failed", "handled"]);
      expect(yield* Ref.get(handled)).toEqual(["msg-4", "msg-6"]);

      const failed = yield* repository.getInboxEvent({ ...key, providerEventId: "5" });
      expect(Option.isSome(failed) && failed.value.status).toBe("failed");
      expect(Option.isSome(failed) && failed.value.error).toBe("boom 5");
      // A failed row is terminal: the poller must not refetch it forever.
      expect(yield* currentOffset).toBe(7);
      // ...and it is not re-handled when the provider re-delivers it.
      expect(yield* processInboxEvents(handler, [event(5)])).toEqual(["duplicate"]);
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("replays rows received but not handled before a restart, oldest first", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      const handled = yield* Ref.make<ReadonlyArray<string>>([]);
      const handler = makeHandler(handled);

      // Simulate a crash after the inbox insert but before handling.
      yield* repository.insertInboxEvent({
        ...key,
        providerEventId: "21",
        payload: { update_id: 21, text: "second" },
        receivedAt: "2026-09-05T10:00:01.000Z",
      });
      yield* repository.insertInboxEvent({
        ...key,
        providerEventId: "20",
        payload: { update_id: 20, text: "first" },
        receivedAt: "2026-09-05T10:00:00.000Z",
      });
      expect(yield* currentOffset).toBeNull();

      const summary = yield* recoverPendingEvents(handler, { decode: decodeFake });
      expect(summary).toEqual({ handled: 2, failed: 0, duplicates: 0, exhausted: 0 });
      expect(yield* Ref.get(handled)).toEqual(["first", "second"]);
      expect(yield* currentOffset).toBe(22);

      // Nothing left to replay; the poller's re-fetch of 21 is a duplicate.
      const again = yield* recoverPendingEvents(handler, { decode: decodeFake });
      expect(again.handled + again.failed + again.exhausted).toBe(0);
      expect(yield* processInboxEvents(handler, [event(21)])).toEqual(["duplicate"]);
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("gives up on a row that keeps crashing the daemon", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      const handled = yield* Ref.make<ReadonlyArray<string>>([]);
      const handler = makeHandler(handled);

      yield* repository.insertInboxEvent({
        ...key,
        providerEventId: "30",
        payload: { update_id: 30, text: "poison" },
        receivedAt: "2026-09-05T10:00:00.000Z",
      });
      // Each earlier run bumped `attempts` and then died mid-handling.
      for (let i = 0; i < INBOX_MAX_ATTEMPTS; i += 1) {
        yield* repository.beginInboxAttempt({ ...key, providerEventId: "30" });
      }

      const summary = yield* recoverPendingEvents(handler, { decode: decodeFake });
      expect(summary.exhausted).toBe(1);
      expect(yield* Ref.get(handled)).toEqual([]);
      const row = yield* repository.getInboxEvent({ ...key, providerEventId: "30" });
      expect(Option.isSome(row) && row.value.status).toBe("failed");
      expect(yield* currentOffset).toBe(31);
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("bounds recovery and honours the limit", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      const handled = yield* Ref.make<ReadonlyArray<string>>([]);
      const handler = makeHandler(handled);
      for (let id = 40; id < 45; id += 1) {
        yield* repository.insertInboxEvent({
          ...key,
          providerEventId: String(id),
          payload: { update_id: id, text: `m${id}` },
          receivedAt: `2026-09-05T10:00:0${id - 40}.000Z`,
        });
      }
      const summary = yield* recoverPendingEvents(handler, { decode: decodeFake, limit: 2 });
      expect(summary.handled).toBe(2);
      expect(yield* Ref.get(handled)).toEqual(["m40", "m41"]);
      const pending = yield* repository.listPendingInbox({ ...key, limit: 10 });
      expect(pending.map((row) => row.providerEventId)).toEqual(["42", "43", "44"]);
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("persists health transitions and resets the cursor on a new credential", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      const handled = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* repository.resetState({
        ...key,
        credentialFingerprint: "bot-a",
        updatedAt: "2026-09-05T10:00:00.000Z",
      });
      yield* processInboxEvents(makeHandler(handled), [event(100)]);

      yield* repository.recordHealth({
        ...key,
        status: "auth_expired",
        error: "Unauthorized",
        at: "2026-09-05T10:01:00.000Z",
      });
      let state = yield* repository.getState(key);
      expect(Option.isSome(state) && state.value.status).toBe("auth_expired");
      expect(Option.isSome(state) && state.value.lastError).toBe("Unauthorized");
      expect(Option.isSome(state) && state.value.lastErrorAt).toBe("2026-09-05T10:01:00.000Z");
      expect(Option.isSome(state) && state.value.lastOkAt).toBeNull();

      yield* repository.recordHealth({
        ...key,
        status: "connected",
        error: null,
        at: "2026-09-05T10:02:00.000Z",
      });
      state = yield* repository.getState(key);
      expect(Option.isSome(state) && state.value.status).toBe("connected");
      expect(Option.isSome(state) && state.value.lastOkAt).toBe("2026-09-05T10:02:00.000Z");
      // The last error stays on record for the UI; only the status flips.
      expect(Option.isSome(state) && state.value.lastError).toBe("Unauthorized");
      expect(Option.isSome(state) && state.value.offset).toBe(101);

      // A swapped bot token: cursor restarts, old inbox rows are gone.
      yield* repository.resetState({
        ...key,
        credentialFingerprint: "bot-b",
        updatedAt: "2026-09-05T10:03:00.000Z",
      });
      state = yield* repository.getState(key);
      expect(Option.isSome(state) && state.value.offset).toBe(0);
      expect(Option.isSome(state) && state.value.credentialFingerprint).toBe("bot-b");
      const old = yield* repository.getInboxEvent({ ...key, providerEventId: "100" });
      expect(Option.isNone(old)).toBe(true);
    }).pipe(Effect.provide(repositoryLayer)),
  );
});
