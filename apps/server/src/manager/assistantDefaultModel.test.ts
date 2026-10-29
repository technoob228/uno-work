import { assert, it } from "@effect/vitest";
import { assistantModelSelection } from "@t3tools/shared/assistantLlm";
import { ProviderInstanceId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  isAutomaticModelCommand,
  readLastModelSelectionCommandId,
  shouldMoveToDefaultModel,
} from "./assistantDefaultModel.ts";

const smart = assistantModelSelection({ provider: "uno", model: "uno/smart" });

it("moves only a gateway model the daemon set", () => {
  assert.isTrue(
    shouldMoveToDefaultModel({ selection: smart, lastSetBy: "assistant-chat-create:1" }),
  );
  assert.isTrue(
    shouldMoveToDefaultModel({ selection: smart, lastSetBy: "assistant-chat-hermes:1" }),
  );
  // The person picked it in the engine picker, or someone we can't tell.
  assert.isFalse(shouldMoveToDefaultModel({ selection: smart, lastSetBy: "assistant-llm:1" }));
  assert.isFalse(shouldMoveToDefaultModel({ selection: smart, lastSetBy: "6f1c0e" }));
  assert.isFalse(shouldMoveToDefaultModel({ selection: smart, lastSetBy: null }));
  // Already on the default; a key or a plan of the person's own.
  assert.isFalse(
    shouldMoveToDefaultModel({
      selection: assistantModelSelection({ provider: "uno", model: "z-ai/glm-5.3-flash" }),
      lastSetBy: "assistant-chat-create:1",
    }),
  );
  assert.isFalse(
    shouldMoveToDefaultModel({
      selection: assistantModelSelection({ provider: "xai", model: "grok-4.7" }),
      lastSetBy: "assistant-chat-create:1",
    }),
  );
  assert.isFalse(
    shouldMoveToDefaultModel({
      selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      lastSetBy: "assistant-chat-create:1",
    }),
  );
  assert.isTrue(isAutomaticModelCommand("assistant-chat-default:1"));
});

it.layer(SqlitePersistenceMemory)("readLastModelSelectionCommandId", (it) => {
  it.effect("finds the last event that set the model, skipping other meta updates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let version = 0;
      const insert = (type: string, commandId: string, payload: object) =>
        sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          ) VALUES (
            ${`evt-${version}`}, 'thread', 'thread-uno', ${version++}, ${type},
            '2026-10-29T00:00:00.000Z', ${commandId}, NULL, NULL, 'server',
            ${JSON.stringify(payload)}, '{}'
          )
        `;

      assert.isNull(yield* readLastModelSelectionCommandId("thread-uno"));
      yield* insert("thread.created", "assistant-chat-create:1", { modelSelection: smart });
      // Marking it the Uno chat sets no model.
      yield* insert("thread.meta-updated", "assistant-chat-migrate:1", { assistantRole: "chat" });
      assert.strictEqual(
        yield* readLastModelSelectionCommandId("thread-uno"),
        "assistant-chat-create:1",
      );
      yield* insert("thread.meta-updated", "assistant-llm:1", { modelSelection: smart });
      yield* insert("thread.meta-updated", "rename:1", { title: "Uno" });
      assert.strictEqual(yield* readLastModelSelectionCommandId("thread-uno"), "assistant-llm:1");
    }),
  );
});
