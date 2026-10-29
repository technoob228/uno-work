/**
 * Moving the Uno chat to a new default model (29.10: Smart → GLM-5.3 Flash)
 * without overriding the person's own choice.
 *
 * The chat stores its model selection (thread.created / thread.meta-updated
 * events), so a chat made on the old default keeps it. Who wrote the
 * current selection is in the command id of the event that set it: the
 * daemon's own writes carry the prefixes below, the person's choice in the
 * engine picker is `assistant-llm:` (AssistantLlmService.setLlm), anything
 * else (a client, an older daemon) is not provably automatic and is kept.
 *
 * @module manager/assistantDefaultModel
 */
import { ASSISTANT_DEFAULT_GATEWAY_MODEL, type ModelSelection } from "@t3tools/contracts";
import {
  isAssistantHarnessSelection,
  readAssistantLlmProvider,
} from "@t3tools/shared/assistantLlm";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Command id of the daemon moving a chat to the default (this module). */
export const ASSISTANT_DEFAULT_MODEL_COMMAND_PREFIX = "assistant-chat-default:";

/**
 * Commands that set the chat's model without the person: creating the chat
 * on the default, moving a pre-0.0.84 chat to Hermes (onto the default), and
 * a previous move to the default.
 */
const AUTOMATIC_MODEL_COMMAND_PREFIXES: ReadonlyArray<string> = [
  "assistant-chat-create:",
  "assistant-chat-hermes:",
  ASSISTANT_DEFAULT_MODEL_COMMAND_PREFIX,
];

export function isAutomaticModelCommand(commandId: string | null | undefined): boolean {
  if (!commandId) return false;
  return AUTOMATIC_MODEL_COMMAND_PREFIXES.some((prefix) => commandId.startsWith(prefix));
}

/** On the Uno gateway, on a model other than the current default. */
export function runsOffDefaultGatewayModel(selection: ModelSelection): boolean {
  return (
    isAssistantHarnessSelection(selection) &&
    readAssistantLlmProvider(selection) === "uno" &&
    selection.model !== ASSISTANT_DEFAULT_GATEWAY_MODEL
  );
}

/**
 * The chat goes to the current default only when it runs on the Uno gateway,
 * on another model, and the daemon — not the person — set that model.
 */
export function shouldMoveToDefaultModel(input: {
  readonly selection: ModelSelection;
  /** Command id of the last event that set the chat's model; null: unknown. */
  readonly lastSetBy: string | null;
}): boolean {
  return runsOffDefaultGatewayModel(input.selection) && isAutomaticModelCommand(input.lastSetBy);
}

/**
 * Command id of the last event that set the thread's model selection (its
 * creation or a meta update carrying one); null when there is none.
 */
export const readLastModelSelectionCommandId = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly commandId: string | null }>`
      SELECT command_id AS "commandId"
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND (
          event_type = 'thread.created'
          OR (
            event_type = 'thread.meta-updated'
            AND json_extract(payload_json, '$.modelSelection') IS NOT NULL
          )
        )
      ORDER BY sequence DESC
      LIMIT 1
    `;
    return rows[0]?.commandId ?? null;
  });
