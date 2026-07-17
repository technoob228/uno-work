import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { Reminder } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RemindersRepositoryLive } from "../persistence/Layers/Reminders.ts";
import { RemindersRepository } from "../persistence/Services/Reminders.ts";

const testLayer = RemindersRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const projectId = ProjectId.make("assistant-home");

const makeReminder = (
  overrides: Partial<Reminder> & Pick<Reminder, "reminderId" | "dueAt">,
): Reminder => ({
  projectId,
  chatId: "123456",
  connector: "telegram",
  message: "ping",
  status: "pending",
  createdAt: "2026-07-08T00:00:00.000Z",
  createdBy: "manager-token:test",
  deliveredAt: null,
  failureReason: null,
  ...overrides,
});

const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const NOW = "2026-07-08T12:00:00.000Z";

it.layer(NodeServices.layer)("reminders repository", (it) => {
  it.effect("listDue returns only pending reminders whose due_at has passed", () =>
    Effect.gen(function* () {
      const repo = yield* RemindersRepository;
      yield* repo.create(makeReminder({ reminderId: "due", dueAt: PAST }));
      yield* repo.create(makeReminder({ reminderId: "later", dueAt: FUTURE }));

      const due = yield* repo.listDue({ now: NOW });
      expect(due.map((r) => r.reminderId)).toEqual(["due"]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("markDelivered takes a reminder out of the due set", () =>
    Effect.gen(function* () {
      const repo = yield* RemindersRepository;
      yield* repo.create(makeReminder({ reminderId: "r1", dueAt: PAST }));

      yield* repo.markDelivered({ reminderId: "r1", deliveredAt: NOW });

      const due = yield* repo.listDue({ now: NOW });
      expect(due).toHaveLength(0);

      const stored = yield* repo.getById({ reminderId: "r1" });
      expect(Option.isSome(stored)).toBe(true);
      if (Option.isSome(stored)) {
        expect(stored.value.status).toBe("delivered");
        expect(stored.value.deliveredAt).toBe(NOW);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("cancel transitions pending -> cancelled once", () =>
    Effect.gen(function* () {
      const repo = yield* RemindersRepository;
      yield* repo.create(makeReminder({ reminderId: "r2", dueAt: FUTURE }));

      const first = yield* repo.cancel({ reminderId: "r2" });
      const second = yield* repo.cancel({ reminderId: "r2" });
      expect(first).toBe(true);
      expect(second).toBe(false);

      const stored = yield* repo.getById({ reminderId: "r2" });
      expect(Option.isSome(stored) && stored.value.status).toBe("cancelled");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("round-trips the delivery connector (slack thread chat key)", () =>
    Effect.gen(function* () {
      const repo = yield* RemindersRepository;
      yield* repo.create(
        makeReminder({
          reminderId: "slack-r",
          dueAt: PAST,
          connector: "slack",
          chatId: "C0123ABCD:1700000000.000100",
        }),
      );

      const due = yield* repo.listDue({ now: NOW });
      expect(due).toHaveLength(1);
      expect(due[0]?.connector).toBe("slack");
      expect(due[0]?.chatId).toBe("C0123ABCD:1700000000.000100");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("list respects includeInactive", () =>
    Effect.gen(function* () {
      const repo = yield* RemindersRepository;
      yield* repo.create(makeReminder({ reminderId: "pending", dueAt: FUTURE }));
      yield* repo.create(makeReminder({ reminderId: "done", dueAt: PAST }));
      yield* repo.markDelivered({ reminderId: "done", deliveredAt: NOW });

      const activeOnly = yield* repo.list({ includeInactive: false });
      expect(activeOnly.map((r) => r.reminderId)).toEqual(["pending"]);

      const all = yield* repo.list({ includeInactive: true });
      expect(all.map((r) => r.reminderId).toSorted()).toEqual(["done", "pending"]);
    }).pipe(Effect.provide(testLayer)),
  );
});
