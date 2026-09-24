/**
 * Settings → Agents → "AI provider keys" (0.0.84): keys the person brings for
 * other AI providers, for Uno (the assistant chat) to use instead of the Uno
 * gateway. Keys go to the machine's secret store; this page only ever sees
 * their last four characters. Each row can test a key (`GET /models`).
 */
import {
  AI_PROVIDER_LABELS,
  type AiProviderKeySummary,
  type AiProviderKeyTestResult,
  BYOK_PROVIDER_IDS,
  type ByokProviderId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CircleAlertIcon, KeyRoundIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

import { assistantLlmQueryKey } from "../../assistant/useAssistantLlm";
import { useEnvironmentSupportsAssistantLlm } from "../../environments/assistantChatSupport";
import {
  listAiProviderKeys,
  removeAiProviderKey,
  saveAiProviderKey,
  testAiProviderKey,
} from "../../lib/assistantLlmApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const PROVIDER_BLURB: Readonly<Record<ByokProviderId, string>> = {
  xai: "Grok straight from xAI (console.x.ai).",
  openrouter: "Hundreds of models behind one key (openrouter.ai).",
  openai: "OpenAI's models (platform.openai.com).",
  custom: "Any OpenAI-compatible endpoint: a base URL ending in /v1 and a key.",
};

const keysQueryKey = (environmentId: EnvironmentId) =>
  ["uno-assistant", "ai-provider-keys", environmentId] as const;

function TestResultLine({ result }: { result: AiProviderKeyTestResult | null }) {
  if (result === null) return null;
  return result.ok ? (
    <span className="inline-flex items-center gap-1 text-success" data-testid="ai-key-test-ok">
      <CheckIcon className="size-3" /> Works — {result.modelCount ?? 0} models available
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1 text-destructive"
      data-testid="ai-key-test-error"
    >
      <CircleAlertIcon className="size-3" /> {result.error}
    </span>
  );
}

function ProviderKeyRow(props: {
  readonly environmentId: EnvironmentId;
  readonly summary: AiProviderKeySummary;
  readonly onChanged: () => void;
}) {
  const { environmentId, summary } = props;
  const provider = summary.provider;
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(summary.baseUrl ?? "");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [testResult, setTestResult] = useState<AiProviderKeyTestResult | null>(null);

  const typedBaseUrl = provider === "custom" ? baseUrl.trim() : undefined;

  const runTest = async (candidate: boolean) => {
    setBusy("test");
    setTestResult(null);
    try {
      setTestResult(
        await testAiProviderKey({
          environmentId,
          provider,
          ...(candidate && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(candidate && typedBaseUrl ? { baseUrl: typedBaseUrl } : {}),
        }),
      );
    } catch (error) {
      setTestResult({
        ok: false,
        modelCount: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      await saveAiProviderKey({
        environmentId,
        provider,
        apiKey: apiKey.trim(),
        ...(typedBaseUrl !== undefined ? { baseUrl: typedBaseUrl } : {}),
      });
      setApiKey("");
      setEditing(false);
      props.onChanged();
      toastManager.add({ type: "success", title: `${AI_PROVIDER_LABELS[provider]} key saved` });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't save the key",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await removeAiProviderKey({ environmentId, provider });
      setTestResult(null);
      props.onChanged();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't remove the key",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const status = summary.configured ? (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-mono" data-testid={`ai-key-hint-${provider}`}>
        Key ••••{summary.keyHint}
      </span>
      {provider === "custom" && summary.baseUrl ? (
        <span className="truncate font-mono">{summary.baseUrl}</span>
      ) : null}
      {editing ? null : <TestResultLine result={testResult} />}
    </span>
  ) : (
    <span>No key</span>
  );

  return (
    <SettingsRow
      title={AI_PROVIDER_LABELS[provider]}
      description={PROVIDER_BLURB[provider]}
      status={status}
      control={
        editing ? null : (
          <>
            {summary.configured ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void runTest(false)}
                disabled={busy !== null}
                data-testid={`ai-key-test-${provider}`}
              >
                {busy === "test" ? <LoaderCircleIcon className="animate-spin" /> : null}
                Test
              </Button>
            ) : null}
            <Button
              size="xs"
              variant={summary.configured ? "ghost" : "outline"}
              onClick={() => {
                setEditing(true);
                setTestResult(null);
              }}
              disabled={busy !== null}
              data-testid={`ai-key-edit-${provider}`}
            >
              <KeyRoundIcon /> {summary.configured ? "Replace" : "Add key"}
            </Button>
            {summary.configured ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-destructive-foreground"
                onClick={() => void remove()}
                disabled={busy !== null}
              >
                Remove
              </Button>
            ) : null}
          </>
        )
      }
    >
      {editing ? (
        <form
          className="flex flex-col gap-2 pb-4 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {provider === "custom" ? (
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
              placeholder="https://your-endpoint.example.com/v1"
              aria-label="Base URL"
              size="sm"
              data-testid="ai-key-base-url"
            />
          ) : null}
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
            placeholder={`${AI_PROVIDER_LABELS[provider]} API key`}
            aria-label={`${AI_PROVIDER_LABELS[provider]} API key`}
            size="sm"
            data-testid={`ai-key-input-${provider}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              type="submit"
              disabled={
                busy !== null ||
                apiKey.trim().length === 0 ||
                (provider === "custom" && !baseUrl.trim())
              }
              data-testid={`ai-key-save-${provider}`}
            >
              {busy === "save" ? <LoaderCircleIcon className="animate-spin" /> : null}
              Save
            </Button>
            <Button
              size="xs"
              variant="outline"
              type="button"
              disabled={busy !== null || apiKey.trim().length === 0}
              onClick={() => void runTest(true)}
            >
              {busy === "test" ? <LoaderCircleIcon className="animate-spin" /> : null}
              Test
            </Button>
            <Button
              size="xs"
              variant="ghost"
              type="button"
              onClick={() => {
                setEditing(false);
                setApiKey("");
                setTestResult(null);
              }}
            >
              Cancel
            </Button>
            <span className="text-[11px]">
              <TestResultLine result={testResult} />
            </span>
          </div>
        </form>
      ) : null}
    </SettingsRow>
  );
}

export function AiProviderKeysSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const supported = useEnvironmentSupportsAssistantLlm(environmentId);
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: keysQueryKey(environmentId),
    queryFn: () => listAiProviderKeys({ environmentId }),
    enabled: supported,
    retry: false,
  });
  if (!supported) return null;

  const onChanged = () => {
    void queryClient.invalidateQueries({ queryKey: keysQueryKey(environmentId) });
    void queryClient.invalidateQueries({ queryKey: assistantLlmQueryKey(environmentId) });
  };
  const byProvider = new Map(keys.data?.keys.map((key) => [key.provider, key]) ?? []);

  return (
    <SettingsSection title="AI provider keys">
      <div className="px-4 pt-4 text-xs leading-relaxed text-muted-foreground sm:px-5">
        Uno runs on the Uno gateway by default. Add your own key to run it on your xAI, OpenRouter,
        OpenAI or any OpenAI-compatible account instead — pick it in the Uno chat. Keys stay on this
        computer. Requests on your key are billed by that provider;{" "}
        <span className="font-medium text-foreground">
          Uno's AI limits and credits don't apply to them.
        </span>
      </div>
      {keys.isLoading ? (
        <div className="flex items-center gap-2 px-5 py-4 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading…
        </div>
      ) : keys.error ? (
        <div className="px-5 py-4 text-xs text-destructive">
          {keys.error instanceof Error ? keys.error.message : "Couldn't load keys."}
        </div>
      ) : (
        <div className="mt-2" data-testid="ai-provider-keys">
          {BYOK_PROVIDER_IDS.map((provider) => (
            <ProviderKeyRow
              key={provider}
              environmentId={environmentId}
              summary={
                byProvider.get(provider) ?? {
                  provider,
                  configured: false,
                  keyHint: null,
                  baseUrl: null,
                  updatedAt: null,
                }
              }
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
