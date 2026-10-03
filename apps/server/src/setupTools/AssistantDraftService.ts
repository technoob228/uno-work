/**
 * AssistantDraftService — "New assistant"'s draft (`assistantDraft.ts`) bound
 * to this daemon: Uno AI through this computer's gateway key and the model
 * picked for text generation (like the materials job).
 *
 * @module setupTools/AssistantDraftService
 */
import {
  UNO_GATEWAY_BASE_URL,
  type AssistantDraftInput,
  type AssistantDraftResult,
} from "@t3tools/contracts";
import { Context, Data, Effect, Layer } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { UnoGatewayKey } from "../unoGatewayKey.ts";
import { draftAssistant } from "./assistantDraft.ts";
import { gatewayModelFromSelection } from "./materialsAdapters.ts";

export class AssistantDraftError extends Data.TaggedError("AssistantDraftError")<{
  readonly status: 502 | 503;
  readonly code: "no_ai" | "ai_failed";
  readonly message: string;
}> {}

export interface AssistantDraftServiceShape {
  readonly draft: (
    input: AssistantDraftInput,
  ) => Effect.Effect<AssistantDraftResult, AssistantDraftError>;
}

export class AssistantDraftService extends Context.Service<
  AssistantDraftService,
  AssistantDraftServiceShape
>()("t3/setupTools/AssistantDraftService") {}

export const makeAssistantDraftService = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const gatewayKey = yield* UnoGatewayKey;
  return {
    draft: (input) =>
      Effect.gen(function* () {
        const key = yield* gatewayKey.harnessKey().pipe(Effect.orElseSucceed(() => ""));
        if (key.length === 0) {
          return yield* new AssistantDraftError({
            status: 503,
            code: "no_ai",
            message: "Uno AI is not linked on this computer.",
          });
        }
        const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
        const model = gatewayModelFromSelection(
          current?.textGenerationModelSelection,
          (instanceId) =>
            (current?.providerInstances as Record<string, { driver?: string }> | undefined)?.[
              instanceId
            ]?.driver,
        );
        return yield* Effect.tryPromise({
          try: () =>
            draftAssistant(
              { baseUrl: UNO_GATEWAY_BASE_URL, apiKey: key, model, timeoutMs: 30_000 },
              input,
            ),
          catch: (cause) =>
            new AssistantDraftError({
              status: 502,
              code: "ai_failed",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
  } satisfies AssistantDraftServiceShape;
});

export const AssistantDraftServiceLive = Layer.effect(
  AssistantDraftService,
  makeAssistantDraftService,
);
