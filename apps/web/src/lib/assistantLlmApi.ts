/**
 * Client for the assistant's engine and the machine's AI provider keys
 * (0.0.84; server: apps/server/src/manager/assistantLlmHttp.ts). Every call
 * names the environment it addresses — keys and the assistant live on one
 * specific daemon. Keys only travel to the daemon; nothing here reads one back.
 */
import type {
  AiProviderKeySummary,
  AiProviderKeyTestResult,
  AssistantHarnessStatus,
  AssistantLlmModelList,
  AssistantLlmProvider,
  AssistantLlmStatus,
  ByokProviderId,
  EnvironmentId,
} from "@t3tools/contracts";

import { environmentFetchJson } from "~/environments/http/target";

interface EnvironmentScoped {
  readonly environmentId: EnvironmentId;
}

export function listAiProviderKeys(
  input: EnvironmentScoped,
): Promise<{ readonly keys: ReadonlyArray<AiProviderKeySummary> }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/ai-providers",
  });
}

export function saveAiProviderKey(
  input: EnvironmentScoped & {
    readonly provider: ByokProviderId;
    readonly apiKey: string;
    readonly baseUrl?: string;
  },
): Promise<{ readonly key: AiProviderKeySummary }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/ai-providers",
    method: "POST",
    body: {
      provider: input.provider,
      apiKey: input.apiKey,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    },
  });
}

export function removeAiProviderKey(
  input: EnvironmentScoped & { readonly provider: ByokProviderId },
): Promise<{ readonly ok: true }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/ai-providers/remove",
    method: "POST",
    body: { provider: input.provider },
  });
}

/** Test the stored key, or a typed one before saving (`apiKey` / `baseUrl`). */
export function testAiProviderKey(
  input: EnvironmentScoped & {
    readonly provider: ByokProviderId;
    readonly apiKey?: string;
    readonly baseUrl?: string;
  },
): Promise<AiProviderKeyTestResult> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/ai-providers/test",
    method: "POST",
    body: {
      provider: input.provider,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    },
  });
}

export function getAssistantLlmStatus(input: EnvironmentScoped): Promise<AssistantLlmStatus> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/llm",
  });
}

export function setAssistantLlm(
  input: EnvironmentScoped & {
    readonly provider: AssistantLlmProvider;
    readonly model: string;
  },
): Promise<AssistantLlmStatus> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/llm",
    method: "POST",
    body: { provider: input.provider, model: input.model },
  });
}

export function listAssistantLlmModels(
  input: EnvironmentScoped & { readonly provider: AssistantLlmProvider },
): Promise<AssistantLlmModelList> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/llm/models",
    searchParams: { provider: input.provider },
  });
}

/** Install Hermes (or retry a failed install). */
export function ensureAssistantHarness(input: EnvironmentScoped): Promise<AssistantHarnessStatus> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/assistant/llm/harness",
    method: "POST",
    body: {},
  });
}
