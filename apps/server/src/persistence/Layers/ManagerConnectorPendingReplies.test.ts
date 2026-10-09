import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import {
  ManagerConnectorPendingReplyRepository,
  type ConnectorPendingReply,
} from "../Services/ManagerConnectorPendingReplies.ts";
import { ManagerConnectorPendingReplyRepositoryLive } from "./ManagerConnectorPendingReplies.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const testLayer = ManagerConnectorPendingReplyRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const row = (overrides: Partial<ConnectorPendingReply>): ConnectorPendingReply => ({
  kind: "telegram",
  connectorProjectId: ProjectId.make("assistant-home"),
  replyKey: "100:1",
  chatId: "100",
  replyTo: "1",
  replyThread: null,
  threadId: ThreadId.make("thread-1"),
  userMessageId: MessageId.make("message-1"),
  turnId: null,
  requestedAt: "2026-10-09T00:00:00.000Z",
  language: "ru",
  meta: { hotKey: "assistant-home:100" },
  status: "waiting",
  progressNotes: 0,
  resumeAttempts: 0,
  deliveredParts: 0,
  error: null,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
  ...overrides,
});

it.layer(NodeServices.layer)("ManagerConnectorPendingReplyRepository", (it) => {
  it.effect("inserts once, saves updates, lists open rows and prunes settled ones", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorPendingReplyRepository;
      expect(yield* repository.insertIfAbsent(row({}))).toBe(true);
      // A replayed update finds its row: no second insert.
      expect(yield* repository.insertIfAbsent(row({ chatId: "other" }))).toBe(false);
      expect(
        yield* repository.insertIfAbsent(
          row({ replyKey: "100:2", status: "queued", createdAt: "2026-10-09T00:00:01.000Z" }),
        ),
      ).toBe(true);
      yield* repository.insertIfAbsent(
        row({ kind: "slack", replyKey: "C1:1.0", chatId: "C1", replyTo: null }),
      );

      const open = yield* repository.listOpen("telegram");
      expect(open.map((entry) => entry.replyKey)).toEqual(["100:1", "100:2"]);
      expect(open[0]?.meta).toEqual({ hotKey: "assistant-home:100" });

      yield* repository.save({
        ...open[0]!,
        status: "delivered",
        turnId: TurnId.make("turn-1"),
        deliveredParts: 3,
        updatedAt: "2026-10-09T00:10:00.000Z",
      });
      const saved = yield* repository.get({
        kind: "telegram",
        connectorProjectId: ProjectId.make("assistant-home"),
        replyKey: "100:1",
      });
      expect(Option.getOrNull(saved)).toMatchObject({
        status: "delivered",
        turnId: "turn-1",
        deliveredParts: 3,
        chatId: "100",
      });
      expect((yield* repository.listOpen("telegram")).map((entry) => entry.replyKey)).toEqual([
        "100:2",
      ]);

      const byThread = yield* repository.listByThread({
        threadId: ThreadId.make("thread-1"),
        limit: 10,
      });
      expect(byThread.map((entry) => entry.replyKey)).toEqual(["100:1", "C1:1.0", "100:2"]);

      yield* repository.prune({ before: "2026-10-09T01:00:00.000Z" });
      expect(
        Option.isNone(
          yield* repository.get({
            kind: "telegram",
            connectorProjectId: ProjectId.make("assistant-home"),
            replyKey: "100:1",
          }),
        ),
      ).toBe(true);
      expect((yield* repository.listOpen("telegram")).length).toBe(1);
    }).pipe(Effect.provide(testLayer)),
  );
});
