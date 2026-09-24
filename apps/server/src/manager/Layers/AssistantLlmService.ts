/**
 * ManagerAssistantLlm — the Uno assistant's engine panel (0.0.84).
 *
 * @module manager/Layers/AssistantLlmService
 */
import {
  ASSISTANT_DEFAULT_GATEWAY_MODEL,
  ASSISTANT_HARNESS_INSTANCE_ID,
  ASSISTANT_PROJECT_ID,
  AI_PROVIDER_LABELS,
  type AssistantLlmModelList,
  CommandId,
  ProviderDriverKind,
  type ProviderInstallJobStatus,
  type ProviderSetupJobId,
} from "@t3tools/contracts";
import { findMarkedAssistantChat } from "@t3tools/shared/assistantChat";
import {
  assistantModelSelection,
  coerceAssistantModelSelection,
  DEFAULT_ASSISTANT_MODEL_SELECTION,
  defaultAssistantModelFor,
  readAssistantLlmProvider,
} from "@t3tools/shared/assistantLlm";
import { Effect, Layer, Ref } from "effect";
import * as crypto from "node:crypto";

import { AiProviderKeys } from "../../aiProviders/AiProviderKeys.ts";
import { assistantCommandOrigin } from "../../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { fetchHermesModelCatalog } from "../../provider/Layers/HermesProvider.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { HarnessSetup } from "../../provider/setup/HarnessSetupService.ts";
import { UnoGatewayKey } from "../../unoGatewayKey.ts";
import { deriveAssistantHarnessStatus, orderAssistantModels } from "../assistantLlm.ts";
import {
  ManagerAssistantLlm,
  type ManagerAssistantLlmShape,
} from "../Services/AssistantLlmService.ts";
import { ManagerAssistantError } from "../Services/AssistantService.ts";

const HERMES_DRIVER = ProviderDriverKind.make("hermes");

const makeManagerAssistantLlm = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const providerRegistry = yield* ProviderRegistry;
  const harnessSetup = yield* HarnessSetup;
  const providerKeys = yield* AiProviderKeys;
  const gatewayKey = yield* UnoGatewayKey;
  const installJobId = yield* Ref.make<ProviderSetupJobId | null>(null);

  const toError = (detail: string) => (cause: unknown) =>
    new ManagerAssistantError({ detail, cause });

  const currentJob = Effect.gen(function* () {
    const jobId = yield* Ref.get(installJobId);
    if (jobId === null) return null;
    return yield* harnessSetup
      .installStatus({ jobId })
      .pipe(Effect.orElseSucceed((): ProviderInstallJobStatus | null => null));
  });

  const harnessStatus = Effect.gen(function* () {
    const providers = yield* providerRegistry.getProviders;
    const snapshot = providers.find(
      (provider) => provider.instanceId === ASSISTANT_HARNESS_INSTANCE_ID,
    );
    return deriveAssistantHarnessStatus({ snapshot, job: yield* currentJob });
  });

  const findChat = Effect.gen(function* () {
    const snapshot = yield* snapshotQuery
      .getShellSnapshot()
      .pipe(Effect.mapError(toError("Failed to load chats.")));
    return findMarkedAssistantChat(snapshot.threads);
  });

  const status: ManagerAssistantLlmShape["status"] = () =>
    Effect.gen(function* () {
      const chat = yield* findChat;
      const selection = chat
        ? coerceAssistantModelSelection(chat.modelSelection)
        : DEFAULT_ASSISTANT_MODEL_SELECTION;
      const keys = yield* providerKeys.list();
      const gatewayConfigured = (yield* gatewayKey.harnessKey()).length > 0;
      return {
        threadId: chat?.id ?? null,
        provider: readAssistantLlmProvider(selection),
        model: selection.model,
        harness: yield* harnessStatus,
        keys,
        gatewayConfigured,
      };
    });

  const setLlm: ManagerAssistantLlmShape["setLlm"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== "uno") {
        const stored = yield* providerKeys.resolve(input.provider);
        if (stored === null) {
          return yield* new ManagerAssistantError({
            detail: `No ${AI_PROVIDER_LABELS[input.provider]} key on this computer — add it in Settings → Agents first.`,
          });
        }
      }
      const chat = yield* findChat;
      if (chat === null) {
        return yield* new ManagerAssistantError({
          detail: "The Uno chat is not set up on this computer yet.",
        });
      }
      const next = assistantModelSelection({ provider: input.provider, model: input.model });
      yield* engine
        .dispatch(
          {
            type: "thread.meta.update",
            commandId: CommandId.make(`assistant-llm:${crypto.randomUUID()}`),
            threadId: chat.id,
            modelSelection: next,
          },
          { origin: assistantCommandOrigin({ assistantKey: ASSISTANT_PROJECT_ID }) },
        )
        .pipe(Effect.mapError(toError("Failed to switch the assistant's model.")));
      yield* Effect.logInfo("assistant llm switched").pipe(
        Effect.annotateLogs({ threadId: chat.id, provider: input.provider, model: input.model }),
      );
      return yield* status();
    });

  const listModels: ManagerAssistantLlmShape["listModels"] = (provider) =>
    Effect.gen(function* () {
      if (provider === "uno") {
        const key = yield* gatewayKey.harnessKey();
        if (key.length === 0) {
          return {
            provider,
            models: orderAssistantModels([], { ensureGatewayAlias: true }),
            defaultModel: ASSISTANT_DEFAULT_GATEWAY_MODEL,
            error: "This computer has no Uno AI key yet.",
          } satisfies AssistantLlmModelList;
        }
        const catalog = yield* Effect.tryPromise(() => fetchHermesModelCatalog(key)).pipe(
          Effect.orElseSucceed(() => []),
        );
        const models = catalog
          .filter(
            (model) =>
              model.supportsTools !== false &&
              (model.outputModalities === undefined || model.outputModalities.includes("text")),
          )
          .map((model) => ({ id: model.modelId, name: model.name }));
        return {
          provider,
          models: orderAssistantModels(models, { ensureGatewayAlias: true }),
          defaultModel: ASSISTANT_DEFAULT_GATEWAY_MODEL,
          error: catalog.length === 0 ? "Could not load the Uno gateway's model list." : null,
        } satisfies AssistantLlmModelList;
      }
      const result = yield* providerKeys.listModels(provider);
      if (!result.ok) {
        return { provider, models: [], defaultModel: null, error: result.error };
      }
      const models = orderAssistantModels(result.models);
      return {
        provider,
        models,
        defaultModel: defaultAssistantModelFor(
          provider,
          models.map((model) => model.id),
        ),
        error: null,
      } satisfies AssistantLlmModelList;
    });

  const ensureHarness: ManagerAssistantLlmShape["ensureHarness"] = (input) =>
    Effect.gen(function* () {
      const current = yield* harnessStatus;
      const shouldInstall =
        current.state === "missing" ||
        (input.retry && (current.state === "failed" || current.state === "unsupported"));
      if (!shouldInstall) return current;
      const started = yield* harnessSetup.installStart({ driver: HERMES_DRIVER }).pipe(
        Effect.map((result) => result.jobId),
        Effect.catch((error) =>
          Effect.logWarning("assistant: Hermes install did not start").pipe(
            Effect.annotateLogs({ code: error.code, message: error.message }),
            Effect.as(null),
          ),
        ),
      );
      if (started !== null) {
        yield* Ref.set(installJobId, started);
        yield* Effect.logInfo("assistant: installing Hermes on first use").pipe(
          Effect.annotateLogs({ jobId: started }),
        );
      }
      return yield* harnessStatus;
    });

  return { status, setLlm, listModels, ensureHarness } satisfies ManagerAssistantLlmShape;
});

export const ManagerAssistantLlmLive = Layer.effect(ManagerAssistantLlm, makeManagerAssistantLlm);
