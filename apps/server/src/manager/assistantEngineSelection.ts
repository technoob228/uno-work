/**
 * What the Uno assistant runs on right now — the pinned chat's selection
 * (Hermes + LLM provider + model), or the default when there is no chat yet.
 * Connectors (Telegram, Slack) start the assistant's threads on it (0.0.84).
 */
import type { ModelSelection } from "@t3tools/contracts";
import { findMarkedAssistantChat } from "@t3tools/shared/assistantChat";
import { coerceAssistantModelSelection } from "@t3tools/shared/assistantLlm";
import { Effect } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export const currentAssistantModelSelection = (
  snapshotQuery: ProjectionSnapshotQueryShape,
): Effect.Effect<ModelSelection> =>
  snapshotQuery.getShellSnapshot().pipe(
    Effect.map((snapshot) =>
      coerceAssistantModelSelection(findMarkedAssistantChat(snapshot.threads)?.modelSelection),
    ),
    Effect.orElseSucceed(() => coerceAssistantModelSelection(null)),
  );
