/**
 * The Uno chat's engine (0.0.84): it always runs on Hermes; the person picks
 * where its AI comes from — the Uno gateway (default, the latest Grok) or a
 * key they brought — and the model.
 *
 * - {@link AssistantModelPicker}: the chip in the chat header and the
 *   composer ("Grok (latest) · Uno gateway ▾") with the provider + model
 *   picker. It replaces the generic harness picker in this chat only.
 * - {@link AssistantEngineBanner}: Hermes being installed / failed (Retry),
 *   or a brought key that is gone.
 */
import {
  AI_PROVIDER_LABELS,
  type AssistantLlmModel,
  type AssistantLlmProvider,
  type EnvironmentId,
} from "@t3tools/contracts";
import { assistantModelLabel, assistantProviderLabel } from "@t3tools/shared/assistantLlm";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BrainCircuitIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { assistantEngineNotice } from "../../assistant/assistantEngine.logic";
import { useAssistantLlm } from "../../assistant/useAssistantLlm";
import { listAssistantLlmModels } from "../../lib/assistantLlmApi";
import { cn } from "../../lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";

const PROVIDER_ORDER: ReadonlyArray<AssistantLlmProvider> = [
  "uno",
  "xai",
  "openrouter",
  "openai",
  "custom",
];

const MODEL_LIST_LIMIT = 80;

function useProviderModels(
  environmentId: EnvironmentId,
  provider: AssistantLlmProvider,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["uno-assistant", "llm-models", environmentId, provider],
    queryFn: () => listAssistantLlmModels({ environmentId, provider }),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function AssistantModelPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly compact?: boolean;
  readonly testId?: string;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const llm = useAssistantLlm(environmentId);
  const [open, setOpen] = useState(false);
  const status = llm.status;
  const [viewedProvider, setViewedProvider] = useState<AssistantLlmProvider | null>(null);
  const activeProvider = status?.provider ?? "uno";
  const provider = viewedProvider ?? activeProvider;
  const [search, setSearch] = useState("");
  const models = useProviderModels(environmentId, provider, open && llm.supported);

  const keyByProvider = useMemo(
    () => new Map(status?.keys.map((key) => [key.provider, key]) ?? []),
    [status?.keys],
  );
  const filteredModels = useMemo<ReadonlyArray<AssistantLlmModel>>(() => {
    const all = models.data?.models ?? [];
    const query = search.trim().toLowerCase();
    const matched =
      query.length === 0
        ? all
        : all.filter(
            (model) =>
              model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query),
          );
    return matched.slice(0, MODEL_LIST_LIMIT);
  }, [models.data?.models, search]);

  if (!llm.supported) return null;

  const openKeys = () => {
    setOpen(false);
    void navigate({
      to: "/settings/environment/$environmentId/providers",
      params: { environmentId },
    });
  };

  const apply = async (nextProvider: AssistantLlmProvider, model: string) => {
    try {
      await llm.setLlm({ provider: nextProvider, model });
      setViewedProvider(null);
      setOpen(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't switch Uno's model",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const pickProvider = (next: AssistantLlmProvider) => {
    setSearch("");
    setViewedProvider(next);
  };

  const modelLabel = status ? assistantModelLabel(status.model) : "Grok (latest)";
  const providerLabel = assistantProviderLabel(activeProvider);
  const byokNote =
    provider === "uno"
      ? "Counts against this computer's AI limit and your Uno credits."
      : `Billed by ${AI_PROVIDER_LABELS[provider]} on your key — Uno spend limits don't apply.`;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setViewedProvider(null);
          setSearch("");
        }
      }}
    >
      <PopoverTrigger
        data-testid={props.testId ?? "uno-engine"}
        className={cn(
          "inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-input px-2 text-xs font-medium text-foreground shadow-xs/5 hover:bg-accent",
          props.compact ? "h-7 sm:h-6" : "h-7 sm:h-6",
        )}
        title={`Uno runs on Hermes · ${modelLabel} · ${providerLabel}`}
      >
        <BrainCircuitIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{modelLabel}</span>
        {props.compact ? null : (
          <span className="hidden truncate text-muted-foreground sm:inline">· {providerLabel}</span>
        )}
        {llm.switching ? (
          <LoaderCircleIcon className="size-3 shrink-0 animate-spin opacity-60" />
        ) : (
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[22rem]" data-testid="uno-engine-popup">
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-sm font-semibold">Uno's AI</div>
            <div className="text-[11px] text-muted-foreground">
              Hermes{status?.harness.version ? ` ${status.harness.version}` : ""}
            </div>
          </div>

          <div
            className="flex flex-col gap-1"
            role="radiogroup"
            aria-label="Where Uno's AI comes from"
          >
            {PROVIDER_ORDER.map((entry) => {
              const key = entry === "uno" ? null : keyByProvider.get(entry);
              const available = entry === "uno" || key?.configured === true;
              const selected = entry === provider;
              return (
                <button
                  key={entry}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`uno-engine-provider-${entry}`}
                  onClick={() => (available ? pickProvider(entry) : openKeys())}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                    selected && "bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-3.5 shrink-0 place-items-center rounded-full border",
                      selected ? "border-primary bg-primary" : "border-input",
                    )}
                    aria-hidden
                  >
                    {selected ? (
                      <span className="size-1.5 rounded-full bg-primary-foreground" />
                    ) : null}
                  </span>
                  <span className="flex-1 truncate">
                    {entry === "uno" ? "Uno gateway" : `${AI_PROVIDER_LABELS[entry]} — your key`}
                  </span>
                  {entry === "uno" ? (
                    <span className="text-[11px] text-muted-foreground">default</span>
                  ) : available ? (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      ••••{key?.keyHint}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <KeyRoundIcon className="size-3" />
                      Add key
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">{byokNote}</p>

          <div className="flex flex-col gap-1.5 border-t pt-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium text-muted-foreground">Model</div>
              {models.data?.defaultModel ? (
                <button
                  type="button"
                  className="text-[11px] text-primary hover:underline"
                  onClick={() => void apply(provider, models.data!.defaultModel!)}
                  data-testid="uno-engine-default-model"
                >
                  Use default ({assistantModelLabel(models.data.defaultModel)})
                </button>
              ) : null}
            </div>
            <label className="flex items-center gap-1.5 rounded-md border border-input px-2">
              <SearchIcon className="size-3.5 text-muted-foreground" />
              <input
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder="Search models"
                className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none"
                data-testid="uno-engine-model-search"
              />
            </label>
            <div className="max-h-56 overflow-y-auto" data-testid="uno-engine-models">
              {models.isLoading ? (
                <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                  <LoaderCircleIcon className="size-3.5 animate-spin" /> Loading models…
                </div>
              ) : models.data?.error && filteredModels.length === 0 ? (
                <div className="px-2 py-3 text-xs text-destructive">{models.data.error}</div>
              ) : filteredModels.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">No models match.</div>
              ) : (
                filteredModels.map((model) => {
                  const current = provider === activeProvider && model.id === status?.model;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => void apply(provider, model.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent",
                        current && "bg-accent/60",
                      )}
                      data-testid="uno-engine-model"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{model.name}</span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground">
                          {model.id}
                        </span>
                      </span>
                      {current ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                    </button>
                  );
                })
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={openKeys}
            className="inline-flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"
          >
            <KeyRoundIcon className="size-3.5" /> Manage AI provider keys
          </button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function AssistantEngineBanner(props: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const llm = useAssistantLlm(props.environmentId);
  const notice = assistantEngineNotice(llm.status);
  if (!llm.supported || notice === null) return null;

  const onAction = () => {
    if (notice.action === "settings") {
      void navigate({
        to: "/settings/environment/$environmentId/providers",
        params: { environmentId: props.environmentId },
      });
      return;
    }
    void llm.retryHarness().catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Couldn't start the install",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  return (
    <Alert variant={notice.variant} className="mb-2" data-testid={`uno-engine-banner-${notice.id}`}>
      {notice.busy ? <LoaderCircleIcon className="animate-spin" /> : <CircleAlertIcon />}
      <AlertTitle>{notice.title}</AlertTitle>
      {notice.description || notice.detail ? (
        <AlertDescription>
          {notice.description ? <span>{notice.description}</span> : null}
          {notice.detail ? (
            <pre className="mt-1 max-h-16 overflow-hidden whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
              {notice.detail}
            </pre>
          ) : null}
        </AlertDescription>
      ) : null}
      {notice.action ? (
        <AlertAction>
          <Button
            size="xs"
            variant="outline"
            onClick={onAction}
            disabled={llm.retryingHarness}
            data-testid="uno-engine-banner-action"
          >
            {notice.action === "settings" ? (
              <>
                <KeyRoundIcon /> Settings
              </>
            ) : (
              <>
                <RefreshCwIcon className={cn(llm.retryingHarness && "animate-spin")} />
                {notice.action === "install" ? "Install" : "Retry"}
              </>
            )}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
