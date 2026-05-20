import { CheckCircle2, CreditCard, Globe2, Zap } from "lucide-react";
import { useState } from "react";

import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  FeatureBullet,
  StepEyebrow,
  StepLead,
  StepTitle,
  TwoColumn,
} from "./stepShared";

export function UnoLlmStep() {
  const apiKey = useSettings((settings) => settings.uno?.apiKey ?? "");
  const { updateSettings } = useUpdateSettings();
  const [draft, setDraft] = useState("");

  const connected = apiKey.trim().length > 0;
  const masked = connected ? `${apiKey.slice(0, 8)}…` : "sk-uno-…";

  const handleConnect = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    updateSettings({ uno: { apiKey: trimmed } });
    setDraft("");
  };

  const handleDisconnect = () => {
    updateSettings({ uno: { apiKey: "" } });
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
            <Button variant="outline" size="sm" onClick={handleDisconnect}>
              Disconnect
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
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Button onClick={handleConnect} disabled={draft.trim().length === 0}>
                Connect
              </Button>
            </div>
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
