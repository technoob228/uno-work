import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { ManagerConnectorBindingRepository } from "../Services/ManagerConnectorBindings.ts";
import { ManagerConnectorBindingRepositoryLive } from "./ManagerConnectorBindings.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const assistantId = ProjectId.make("assistant-home");
const otherAssistantId = ProjectId.make("assistant-other");
const projectId = ProjectId.make("project-api");
const threadId = ThreadId.make("thread-1");

const testLayer = ManagerConnectorBindingRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.layer(NodeServices.layer)("ManagerConnectorBindingRepository", (it) => {
  it.effect("round-trips bindings per (kind, chatId) and lists them per connector", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorBindingRepository;

      expect(Option.isNone(yield* repository.get({ kind: "telegram", chatId: "100" }))).toBe(true);

      yield* repository.upsert({
        kind: "telegram",
        chatId: "100",
        connectorProjectId: assistantId,
        target: { kind: "project", projectId },
        notifyOnComplete: false,
        updatedAt: "2026-09-11T10:00:00.000Z",
      });
      yield* repository.upsert({
        kind: "telegram",
        chatId: "200",
        connectorProjectId: otherAssistantId,
        target: { kind: "thread", threadId },
        notifyOnComplete: true,
        updatedAt: "2026-09-11T10:00:00.000Z",
      });
      // Same chat id on another connector kind is a different row.
      yield* repository.upsert({
        kind: "slack",
        chatId: "100",
        connectorProjectId: assistantId,
        target: { kind: "assistant", projectId: assistantId },
        notifyOnComplete: false,
        updatedAt: "2026-09-11T10:00:00.000Z",
      });

      const telegram = yield* repository.get({ kind: "telegram", chatId: "100" });
      expect(Option.getOrNull(telegram)).toEqual({
        kind: "telegram",
        chatId: "100",
        connectorProjectId: assistantId,
        target: { kind: "project", projectId },
        notifyOnComplete: false,
        updatedAt: "2026-09-11T10:00:00.000Z",
      });
      const slack = yield* repository.get({ kind: "slack", chatId: "100" });
      expect(Option.getOrNull(slack)?.target).toEqual({
        kind: "assistant",
        projectId: assistantId,
      });

      // Upsert replaces the target and the flag in place.
      yield* repository.upsert({
        kind: "telegram",
        chatId: "100",
        connectorProjectId: assistantId,
        target: { kind: "thread", threadId },
        notifyOnComplete: true,
        updatedAt: "2026-09-11T11:00:00.000Z",
      });
      const updated = yield* repository.get({ kind: "telegram", chatId: "100" });
      expect(Option.getOrNull(updated)).toMatchObject({
        target: { kind: "thread", threadId },
        notifyOnComplete: true,
        updatedAt: "2026-09-11T11:00:00.000Z",
      });

      const all = yield* repository.listAll();
      expect(all.map((row) => `${row.kind}:${row.chatId}`)).toEqual([
        "slack:100",
        "telegram:100",
        "telegram:200",
      ]);
      const mine = yield* repository.listByConnectorProject(assistantId);
      expect(mine.map((row) => `${row.kind}:${row.chatId}`)).toEqual(["slack:100", "telegram:100"]);

      expect(yield* repository.remove({ kind: "telegram", chatId: "100" })).toBe(true);
      expect(yield* repository.remove({ kind: "telegram", chatId: "100" })).toBe(false);
      expect(Option.isNone(yield* repository.get({ kind: "telegram", chatId: "100" }))).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
