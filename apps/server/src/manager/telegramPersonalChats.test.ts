import { describe, expect, it } from "@effect/vitest";
import {
  ASSISTANT_PROJECT_ID,
  ProjectId,
  ThreadId,
  type ManagerConnectorBinding,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { migratePersonalTelegramChats } from "./telegramPersonalChats.ts";

const mainThreadId = ThreadId.make("thread-main");
const projectId = ProjectId.make("project-api");
const nowIso = "2026-09-25T00:00:00.000Z";

const makeStore = (input: {
  readonly allowedChatIds: ReadonlyArray<string> | null;
  readonly bindings: ReadonlyArray<ManagerConnectorBinding>;
}) => {
  const bindings = new Map(input.bindings.map((binding) => [binding.chatId, binding]));
  let upserts = 0;
  return {
    connectors: {
      get: () =>
        Effect.succeed(
          input.allowedChatIds === null
            ? Option.none()
            : Option.some({
                projectId: ASSISTANT_PROJECT_ID,
                kind: "telegram" as const,
                config: {
                  botToken: "123:abc",
                  allowedChatIds: input.allowedChatIds,
                  enabled: true,
                },
                updatedAt: nowIso,
              }),
        ),
    },
    bindings: {
      listAll: () => Effect.succeed([...bindings.values()]),
      upsert: (row: Omit<ManagerConnectorBinding, "updatedAt"> & { readonly updatedAt: string }) =>
        Effect.sync(() => {
          upserts += 1;
          bindings.set(row.chatId, row as ManagerConnectorBinding);
        }),
    },
    snapshot: () => bindings,
    upserts: () => upserts,
  };
};

const legacyBindings: ReadonlyArray<ManagerConnectorBinding> = [
  {
    kind: "telegram",
    chatId: "333",
    connectorProjectId: ASSISTANT_PROJECT_ID,
    target: { kind: "assistant", projectId: ASSISTANT_PROJECT_ID },
    notifyOnComplete: true,
    updatedAt: nowIso,
  },
  {
    kind: "telegram",
    chatId: "444",
    connectorProjectId: ASSISTANT_PROJECT_ID,
    target: { kind: "project", projectId },
    notifyOnComplete: false,
    updatedAt: nowIso,
  },
];

describe("migratePersonalTelegramChats", () => {
  it.effect("re-points private chats to the main conversation and leaves groups alone", () =>
    Effect.gen(function* () {
      const store = makeStore({
        allowedChatIds: ["111", "-100222", "-5", "333", "444"],
        bindings: legacyBindings,
      });
      const result = yield* migratePersonalTelegramChats({
        ...store,
        findMainThreadId: Effect.succeed(mainThreadId),
        nowIso,
      });
      expect(result.status).toBe("done");
      expect(result.status === "done" ? result.migrated.map((step) => step.chatId) : []).toEqual([
        "111",
        "333",
      ]);
      const rows = store.snapshot();
      expect(rows.get("111")?.target).toEqual({ kind: "thread", threadId: mainThreadId });
      expect(rows.get("333")?.target).toEqual({ kind: "thread", threadId: mainThreadId });
      expect(rows.get("333")?.notifyOnComplete).toBe(true);
      // Groups keep no binding (their own thread); an explicit /use stays.
      expect(rows.has("-100222")).toBe(false);
      expect(rows.has("-5")).toBe(false);
      expect(rows.get("444")?.target).toEqual({ kind: "project", projectId });
    }),
  );

  it.effect("is idempotent: a second run changes nothing", () =>
    Effect.gen(function* () {
      const store = makeStore({
        allowedChatIds: ["111", "-100222", "333"],
        bindings: legacyBindings,
      });
      const run = migratePersonalTelegramChats({
        ...store,
        findMainThreadId: Effect.succeed(mainThreadId),
        nowIso,
      });
      yield* run;
      const upsertsAfterFirst = store.upserts();
      expect(upsertsAfterFirst).toBe(2);
      const second = yield* run;
      expect(second).toEqual({ status: "done", mainThreadId, migrated: [] });
      expect(store.upserts()).toBe(upsertsAfterFirst);
    }),
  );

  it.effect("defers while there is no main conversation, and skips without a connector", () =>
    Effect.gen(function* () {
      const store = makeStore({ allowedChatIds: ["111"], bindings: [] });
      const deferred = yield* migratePersonalTelegramChats({
        ...store,
        findMainThreadId: Effect.succeed(null),
        nowIso,
      });
      expect(deferred).toEqual({ status: "no-main-conversation" });
      expect(store.upserts()).toBe(0);

      const none = makeStore({ allowedChatIds: null, bindings: [] });
      let mainLookedUp = false;
      const skipped = yield* migratePersonalTelegramChats({
        ...none,
        findMainThreadId: Effect.sync(() => {
          mainLookedUp = true;
          return mainThreadId;
        }),
        nowIso,
      });
      expect(skipped).toEqual({ status: "no-connector" });
      expect(mainLookedUp).toBe(false);
    }),
  );
});
