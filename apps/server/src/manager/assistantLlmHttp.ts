/**
 * HTTP surface of the assistant's engine and of the machine's AI provider
 * keys (0.0.84). Owner sessions only.
 *
 * - `GET  /api/ai-providers`           — stored keys, masked (last 4 chars).
 * - `POST /api/ai-providers`           — store / replace a key.
 * - `POST /api/ai-providers/remove`    — forget a key.
 * - `POST /api/ai-providers/test`      — `GET {baseUrl}/models` with a stored or typed key.
 * - `GET  /api/manager/assistant/llm`  — provider, model, Hermes state, keys.
 * - `POST /api/manager/assistant/llm`  — switch provider / model of the Uno chat.
 * - `GET  /api/manager/assistant/llm/models?provider=` — models a provider offers.
 * - `POST /api/manager/assistant/llm/harness` — install / retry Hermes.
 * - `POST /api/manager/assistant/default-ai` — the account's default AI, as a client read it.
 *
 * Keys travel only inbound (store / test). No response and no log line
 * carries one.
 */
import {
  AiProviderKeyRemoveInput,
  AiProviderKeySetInput,
  AiProviderKeyTestInput,
  AssistantLlmProvider,
  AssistantLlmSetInput,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AiProviderKeys } from "../aiProviders/AiProviderKeys.ts";
import { AuthError } from "../auth/Services/ServerAuth.ts";
import { authenticateOwnerSession, respondServerError, respondToAuthError } from "./http.ts";
import { ManagerAccountDefaultAi } from "./Layers/AccountDefaultAi.ts";
import { ManagerAssistantLlm } from "./Services/AssistantLlmService.ts";

const badRequest = (message: string) => new AuthError({ message, status: 400 });

export const aiProvidersListRouteLayer = HttpRouter.add(
  "GET",
  "/api/ai-providers",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const keys = yield* AiProviderKeys;
    return HttpServerResponse.jsonUnsafe({ keys: yield* keys.list() }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const aiProvidersSetRouteLayer = HttpRouter.add(
  "POST",
  "/api/ai-providers",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const keys = yield* AiProviderKeys;
    const input = yield* HttpServerRequest.schemaBodyJson(AiProviderKeySetInput).pipe(
      Effect.mapError(() => badRequest("Invalid key payload.")),
    );
    return yield* keys.set(input).pipe(
      Effect.map((key) => HttpServerResponse.jsonUnsafe({ key }, { status: 200 })),
      Effect.catchTag("AiProviderKeyError", (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status }),
        ),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const aiProvidersRemoveRouteLayer = HttpRouter.add(
  "POST",
  "/api/ai-providers/remove",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const keys = yield* AiProviderKeys;
    const input = yield* HttpServerRequest.schemaBodyJson(AiProviderKeyRemoveInput).pipe(
      Effect.mapError(() => badRequest("Invalid remove payload.")),
    );
    return yield* keys.remove(input.provider).pipe(
      Effect.map(() => HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 })),
      Effect.catchTag("AiProviderKeyError", (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status }),
        ),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const aiProvidersTestRouteLayer = HttpRouter.add(
  "POST",
  "/api/ai-providers/test",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const keys = yield* AiProviderKeys;
    const input = yield* HttpServerRequest.schemaBodyJson(AiProviderKeyTestInput).pipe(
      Effect.mapError(() => badRequest("Invalid test payload.")),
    );
    const result = yield* keys.test(input);
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const assistantLlmStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/llm",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistantLlm = yield* ManagerAssistantLlm;
    return yield* assistantLlm.status().pipe(
      Effect.map((status) => HttpServerResponse.jsonUnsafe(status, { status: 200 })),
      Effect.catch(respondServerError("assistant:llm:status")),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const assistantLlmSetRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/llm",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistantLlm = yield* ManagerAssistantLlm;
    const input = yield* HttpServerRequest.schemaBodyJson(AssistantLlmSetInput).pipe(
      Effect.mapError(() => badRequest("Invalid provider / model.")),
    );
    return yield* assistantLlm.setLlm(input).pipe(
      Effect.map((status) => HttpServerResponse.jsonUnsafe(status, { status: 200 })),
      Effect.catchTag("ManagerAssistantError", (error) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.detail }, { status: 409 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const isAssistantLlmProvider = Schema.is(AssistantLlmProvider);

export const assistantLlmModelsRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/llm/models",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistantLlm = yield* ManagerAssistantLlm;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const provider = url._tag === "Some" ? url.value.searchParams.get("provider") : null;
    if (!isAssistantLlmProvider(provider)) {
      return yield* badRequest("provider must be one of uno, xai, openrouter, openai, custom.");
    }
    const list = yield* assistantLlm.listModels(provider);
    return HttpServerResponse.jsonUnsafe(list, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const assistantLlmHarnessRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/llm/harness",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const assistantLlm = yield* ManagerAssistantLlm;
    const harness = yield* assistantLlm.ensureHarness({ retry: true });
    return HttpServerResponse.jsonUnsafe(harness, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

const DefaultAiPayload = Schema.Struct({ value: Schema.NullOr(Schema.String) });

/**
 * The account's default AI (console `/auth/me` `default_ai`) as a client read
 * it with its account token — a Work box's daemon holds only a gateway key.
 */
export const assistantDefaultAiRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/default-ai",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const accountDefaultAi = yield* ManagerAccountDefaultAi;
    const input = yield* HttpServerRequest.schemaBodyJson(DefaultAiPayload).pipe(
      Effect.mapError(() => badRequest("Invalid default AI payload.")),
    );
    const value = input.value?.trim() || null;
    if (value !== null && !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
      return yield* badRequest("Unknown default AI.");
    }
    yield* accountDefaultAi.set(value);
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
