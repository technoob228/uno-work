import type {
  AssistantHarnessStatus,
  AssistantLlmModelList,
  AssistantLlmProvider,
  AssistantLlmSetInput,
  AssistantLlmStatus,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ManagerAssistantError } from "./AssistantService.ts";

/**
 * The Uno assistant's engine (0.0.84): Hermes on this machine, and which LLM
 * it talks to — the Uno gateway or a key the person brought. The chat's
 * model selection is the single source of truth; this service reads it,
 * changes it, and keeps Hermes installed.
 */
export interface ManagerAssistantLlmShape {
  readonly status: () => Effect.Effect<AssistantLlmStatus, ManagerAssistantError>;
  /** Switch provider / model of the assistant chat (next turn uses it). */
  readonly setLlm: (
    input: AssistantLlmSetInput,
  ) => Effect.Effect<AssistantLlmStatus, ManagerAssistantError>;
  readonly listModels: (provider: AssistantLlmProvider) => Effect.Effect<AssistantLlmModelList>;
  /**
   * Install Hermes when it is missing. `retry`: also after a failed install
   * (the person pressed Retry). Never starts a second install.
   */
  readonly ensureHarness: (input: {
    readonly retry: boolean;
  }) => Effect.Effect<AssistantHarnessStatus>;
}

export class ManagerAssistantLlm extends Context.Service<
  ManagerAssistantLlm,
  ManagerAssistantLlmShape
>()("t3/manager/Services/AssistantLlmService/ManagerAssistantLlm") {}
