import { CheckCircle2, CreditCard, Globe2, Loader2, Zap } from "lucide-react";
import { useState } from "react";

import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerConfigReady } from "~/rpc/serverState";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { toastManager } from "../../ui/toast";
import {
  FeatureBullet,
  StepEyebrow,
  StepLead,
  StepTitle,
  TwoColumn,
} from "./stepShared";

const UNO_INSTANCE_ID = ProviderInstanceId.make("uno");
const UNO_TEXT_GEN_MODEL =
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make("uno")] ??
  DEFAULT_GIT_TEXT_GENERATION_MODEL;

export function UnoLlmStep() {
  const apiKey = useSettings((settings) => settings.uno?.apiKey ?? "");
  const { updateSettings } = useUpdateSettings();
  const serverReady = useServerConfigReady();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = apiKey.trim().length > 0;
  const masked = connected ? `${apiKey.slice(0, 8)}…` : "sk-uno-…";

  const handleConnect = async () => {
    const trimmed = draft.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      await updateSettings({
        uno: { apiKey: trimmed },
        textGenerationModelSelection: {
          instanceId: UNO_INSTANCE_ID,
          model: UNO_TEXT_GEN_MODEL,
        },
      });
      setDraft("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Update failed.";
      setError(message);
      toastManager.add({
        type: "error",
        title: "Could not save Uno API key",
        description: message,
      });
    } finally {
      setPending(false);
    }
  };

  const handleDisconnect = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await updateSettings({ uno: { apiKey: "" } });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Update failed.";
      toastManager.add({
        type: "error",
        title: "Could not disconnect Uno account",
        description: message,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <TwoColumn>
      <div>
        <StepEyebrow>Or use Uno LLM</StepEyebrow>
        <StepTitle>One key. 300+ models. Anywhere.</StepTitle>
        <StepLead>
          Uno LLM gives you a single account with access to OpenAI, Anthropic, Google, Mistral,
          Llama, and 300+ open and closed models. Works from any location — including regions
          where original providers are blocked.
        </StepLead>
        <ul className="mt-6 grid gap-3">
          <FeatureBullet icon={<Zap className="size-3.5" />}>
            No separate signups, no juggling API keys.
          </FeatureBullet>
          <FeatureBullet icon={<Globe2 className="size-3.5" />}>
            Single regional endpoint, low latency worldwide.
          </FeatureBullet>
          <FeatureBullet icon={<CreditCard className="size-3.5" />}>
            One bill instead of five subscriptions.
          </FeatureBullet>
        </ul>
      </div>
      <div className="rounded-2xl border-2 border-primary bg-card p-6 shadow-lg shadow-primary/10">
        {connected ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-full bg-green-500/15 text-green-600 dark:text-green-400">
                <CheckCircle2 className="size-5" />
              </div>
              <div>
                <div className="font-semibold">Connected to Uno account</div>
                <div className="font-mono text-xs text-muted-foreground">{masked}</div>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void handleDisconnect();
              }}
              disabled={pending}
            >
              {pending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Disconnecting…
                </>
              ) : (
                "Disconnect"
              )}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight">Connect Uno LLM</span>
              <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground">
                Recommended
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste your Uno API key.{" "}
              <a
                href="https://getuno.xyz"
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary hover:underline"
              >
                Get a key →
              </a>
            </p>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="sk-uno-..."
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleConnect();
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
                className="font-mono text-xs"
              />
              <Button
                onClick={() => {
                  void handleConnect();
                }}
                disabled={draft.trim().length === 0 || pending || !serverReady}
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  "Connect"
                )}
              </Button>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {!serverReady && !pending ? (
              <p className="text-xs text-muted-foreground">Waiting for local server…</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              No account yet?{" "}
              <a
                href="https://getuno.xyz"
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary hover:underline"
              >
                Sign up free
              </a>{" "}
              — takes 30 seconds.
            </p>
          </div>
        )}
      </div>
    </TwoColumn>
  );
}
