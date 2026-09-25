/**
 * OpenCode's provider key form: the key becomes a secret environment
 * variable of the `opencode` instance (the one Settings → Providers edits),
 * then the daemon re-probes OpenCode. Shared by Work setup (AI step) and the
 * chat's "signed out" card.
 *
 * @module components/harness/OpenCodeKeyForm
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { refreshEnvironmentProviders } from "../../environments/settings/serverSettings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { buildProviderInstanceUpdatePatch } from "../settings/SettingsPanels.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Which environment variable an OpenCode key goes into, from its prefix. */
export function openCodeKeyVariable(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.startsWith("sk-ant-")) return "ANTHROPIC_API_KEY";
  if (trimmed.startsWith("sk-or-")) return "OPENROUTER_API_KEY";
  if (trimmed.startsWith("sk-")) return "OPENAI_API_KEY";
  return null;
}

export function OpenCodeKeyForm({
  onSaved,
  className,
}: {
  onSaved: () => void;
  className?: string;
}) {
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
    <div
      className={cn(
        "mt-3 flex flex-col gap-2 rounded-xl border border-border bg-muted/30 p-3",
        className,
      )}
    >
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
