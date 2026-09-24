/**
 * Step 1 — the AI for this computer. Uno AI is built in; Claude and Codex
 * sign in with the person's own subscription or an API key through the
 * daemon's existing sign-in jobs (the same panel as the model picker's);
 * OpenCode takes a provider key as a secret environment variable of its
 * instance, like Settings → Providers does. The pick becomes the default for
 * new chats the way a pick in any composer does (the draft store's sticky
 * model selection).
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { refreshEnvironmentProviders } from "../../../environments/settings/serverSettings";
import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { cn } from "../../../lib/utils";
import { resolveAppModelSelectionForInstance } from "../../../modelSelection";
import { useServerProviders } from "../../../rpc/serverState";
import { HarnessSignInPanel } from "../../harness/HarnessSignInDialog";
import {
  isJobActive,
  progressLine,
  resolveHarnessStatus,
  type HarnessStatus,
} from "../../harness/harnessSetupState";
import { useHarnessSetup } from "../../harness/useHarnessSetup";
import { ClaudeAI, OpenAI, OpenCodeIcon, UnoIcon, type Icon } from "../../Icons";
import { buildProviderInstanceUpdatePatch } from "../../settings/SettingsPanels.logic";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ConnectedBadge, SetupHeading, SetupNote, SetupShell } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";

type AiId = "uno" | "claudeAgent" | "codex" | "opencode";

interface AiRow {
  readonly id: AiId;
  readonly name: string;
  readonly icon: Icon;
  readonly description: (provider: ServerProvider | undefined) => string;
}

const AI_ROWS: ReadonlyArray<AiRow> = [
  {
    id: "uno",
    name: "Uno AI",
    icon: UnoIcon,
    description: (provider) => {
      const count = provider?.models.length ?? 0;
      return `Built in. ${count > 0 ? `${count} models, paid` : "Paid"} from the AI credits in your plan.`;
    },
  },
  {
    id: "claudeAgent",
    name: "Claude",
    icon: ClaudeAI,
    description: () => "Use your Claude Pro or Max plan, or an Anthropic API key.",
  },
  {
    id: "codex",
    name: "ChatGPT / Codex",
    icon: OpenAI,
    description: () => "Use your ChatGPT Plus or Pro plan, or an OpenAI API key.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    icon: OpenCodeIcon,
    description: () => "Open-source agent. Runs on its free models or any API key you add.",
  },
];

/** Which environment variable an OpenCode key goes into, from its prefix. */
export function openCodeKeyVariable(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.startsWith("sk-ant-")) return "ANTHROPIC_API_KEY";
  if (trimmed.startsWith("sk-or-")) return "OPENROUTER_API_KEY";
  if (trimmed.startsWith("sk-")) return "OPENAI_API_KEY";
  return null;
}

function OpenCodeKeyForm({ onSaved }: { onSaved: () => void }) {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const environmentId = usePrimaryEnvironmentId();
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const variable = openCodeKeyVariable(key);

  const save = async () => {
    if (!variable) {
      setError("Paste an Anthropic (sk-ant-…), OpenRouter (sk-or-…) or OpenAI (sk-…) key.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const instanceId = ProviderInstanceId.make("opencode");
      const driver = ProviderDriverKind.make("opencode");
      const existing: ProviderInstanceConfig = settings.providerInstances[instanceId] ?? {
        driver,
        enabled: settings.providers.opencode.enabled,
        config: settings.providers.opencode,
      };
      const environment = [
        ...(existing.environment ?? []).filter((entry) => entry.name !== variable),
        { name: variable, value: key.trim(), sensitive: true },
      ];
      await updateSettings(
        buildProviderInstanceUpdatePatch({
          settings: {
            providers: settings.providers,
            providerInstances: settings.providerInstances,
          },
          instanceId,
          instance: { ...existing, environment },
          driver,
          isDefault: true,
        }),
      );
      if (environmentId) await refreshEnvironmentProviders(environmentId, instanceId);
      setKey("");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the key.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3">
      <label htmlFor="opencode-key" className="text-xs font-medium">
        Provider API key
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="opencode-key"
          className="min-w-[200px] flex-1 font-mono"
          placeholder="sk-…"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          type="password"
        />
        <Button size="sm" onClick={() => void save()} disabled={pending || key.trim().length === 0}>
          {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          Connect
        </Button>
      </div>
      <span className="text-xs text-muted-foreground">
        Anthropic, OpenAI or OpenRouter. Stored on this computer only, as a secret.
      </span>
      {error ? <span className="text-xs text-destructive-foreground">{error}</span> : null}
    </div>
  );
}

export function AiStep() {
  const providers = useServerProviders();
  const providersLoaded = providers.length > 0;
  const setup = useHarnessSetup();
  const settings = useSettings();
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const { completeStep } = useSetupNavigation();
  const stickyActive = useComposerDraftStore((store) => store.stickyActiveProvider);
  const setSticky = useComposerDraftStore((store) => store.setStickyModelSelection);

  const initial = (AI_ROWS.find((row) => row.id === stickyActive)?.id ?? "uno") as AiId;
  const [picked, setPicked] = useState<AiId>(initial);
  const [open, setOpen] = useState<AiId | null>(null);

  const statusOf = useMemo(() => {
    const byId = new Map(providers.map((provider) => [provider.instanceId, provider]));
    return (id: AiId): { provider: ServerProvider | undefined; status: HarnessStatus } => {
      const provider = byId.get(ProviderInstanceId.make(id));
      return { provider, status: resolveHarnessStatus({ provider, providersLoaded }) };
    };
  }, [providers, providersLoaded]);

  // A finished sign-in closes its panel.
  useEffect(() => {
    if (open && statusOf(open).status === "ready") setOpen(null);
  }, [open, statusOf]);

  const pickedRow = AI_ROWS.find((row) => row.id === picked) ?? AI_ROWS[0]!;
  const pickedReady = statusOf(picked).status === "ready";

  const choose = (id: AiId) => {
    setPicked(id);
    if (statusOf(id).status !== "ready") setOpen(id);
  };

  const confirm = () => {
    const instanceId = ProviderInstanceId.make(picked);
    const model = resolveAppModelSelectionForInstance(instanceId, settings, providers, null);
    if (model) setSticky({ instanceId, model });
    void completeStep("ai");
  };

  return (
    <SetupShell
      step="ai"
      primary={{
        label: pickedReady ? `Continue with ${pickedRow.name}` : `Connect ${pickedRow.name} first`,
        disabled: !pickedReady,
        onClick: confirm,
      }}
    >
      <SetupHeading
        title="Pick the AI for this computer"
        lead="It does the work in your chats. Use ours, or bring the subscription you already pay for."
      />
      <div
        role="radiogroup"
        aria-label="Default AI"
        className="overflow-hidden rounded-2xl border border-border"
      >
        {AI_ROWS.map((row, index) => {
          const { provider, status } = statusOf(row.id);
          const isPicked = row.id === picked;
          const Logo = row.icon;
          const authJob =
            row.id === "claudeAgent" || row.id === "codex" ? setup.authJobs[row.id] : undefined;
          const installJob = setup.installJobs[row.id];
          const installing = isJobActive(installJob);
          let side: ReactNode = null;
          if (status === "ready") {
            side = <ConnectedBadge>{row.id === "uno" ? "Ready" : "Connected"}</ConnectedBadge>;
          } else if (status === "checking") {
            side = <Loader2Icon className="size-4 animate-spin text-muted-foreground" />;
          } else if (status === "notInstalled" && row.id !== "uno") {
            side = (
              <Button
                size="xs"
                variant="outline"
                disabled={installing}
                onClick={(event) => {
                  event.stopPropagation();
                  setPicked(row.id);
                  void setup.startInstall(ProviderDriverKind.make(row.id));
                }}
              >
                {installing ? <Loader2Icon className="size-3 animate-spin" /> : null}
                {installing ? "Installing" : "Install"}
              </Button>
            );
          } else if (row.id === "uno") {
            side = (
              <Button
                size="xs"
                variant="outline"
                onClick={(event) => {
                  event.stopPropagation();
                  if (environmentId) {
                    void navigate({
                      to: "/settings/environment/$environmentId/providers",
                      params: { environmentId },
                    });
                  }
                }}
              >
                Set up
              </Button>
            );
          } else {
            side = (
              <Button
                size="xs"
                variant="outline"
                onClick={(event) => {
                  event.stopPropagation();
                  setPicked(row.id);
                  setOpen(open === row.id ? null : row.id);
                }}
              >
                {row.id === "opencode" ? "Add key" : "Sign in"}
              </Button>
            );
          }
          const expanded = open === row.id && status !== "ready" && status !== "notInstalled";
          return (
            <div
              key={row.id}
              role="radio"
              aria-checked={isPicked}
              tabIndex={0}
              onClick={() => choose(row.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  choose(row.id);
                }
              }}
              data-testid={`setup-ai-${row.id}`}
              className={cn(
                "flex cursor-pointer items-start gap-4 px-4 py-4 outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:px-5",
                index > 0 && "border-t border-border",
                isPicked
                  ? "bg-primary/[0.04] ring-1 ring-inset ring-primary/40"
                  : "hover:bg-muted/40",
              )}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
                <Logo className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {row.name}
                  {isPicked ? (
                    <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                      Default
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-sm text-muted-foreground">
                  {row.description(provider)}
                </div>
                {installing ? (
                  <div className="mt-2 truncate text-xs text-muted-foreground">
                    {progressLine(installJob?.log ?? "") ?? "Installing…"}
                  </div>
                ) : null}
                {expanded ? (
                  <div onClick={(event) => event.stopPropagation()}>
                    {row.id === "claudeAgent" || row.id === "codex" ? (
                      <HarnessSignInPanel
                        key={row.id}
                        className="mt-3 rounded-xl border border-border bg-muted/30 p-3"
                        driver={row.id}
                        job={authJob}
                        onStart={(input) =>
                          void setup.startAuth({
                            driver: row.id as "claudeAgent" | "codex",
                            method: input.method,
                            ...(input.apiKey ? { apiKey: input.apiKey } : {}),
                          })
                        }
                        onSubmitCode={(code) =>
                          void setup.submitAuthCode({
                            driver: row.id as "claudeAgent" | "codex",
                            code,
                          })
                        }
                        onReset={() => setup.clearAuth(row.id as "claudeAgent" | "codex")}
                      />
                    ) : row.id === "opencode" ? (
                      <OpenCodeKeyForm onSaved={() => setOpen(null)} />
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-3 pt-1">
                {side}
                <span
                  aria-hidden
                  className={cn(
                    "flex size-[18px] items-center justify-center rounded-full border-2",
                    isPicked ? "border-primary" : "border-border",
                  )}
                >
                  {isPicked ? <span className="size-2 rounded-full bg-primary" /> : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <SetupNote>
        AI inside apps runs on Uno AI. Change the default any time from the model picker in a chat.
      </SetupNote>
    </SetupShell>
  );
}
