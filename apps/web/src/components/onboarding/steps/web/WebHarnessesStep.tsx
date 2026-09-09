import { CheckCircle2, ChevronDown, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { ProviderDriverKind } from "@t3tools/contracts";

import { useServerProviders } from "~/rpc/serverState";
import { cn } from "~/lib/utils";
import { getDriverOption } from "../../../settings/providerDriverMeta";
import { StepEyebrow, StepLead, StepTitle } from "../stepShared";

/** Shipped in the box image and signed in through the Uno gateway. */
const BUNDLED_DRIVERS = [
  ProviderDriverKind.make("uno"),
  ProviderDriverKind.make("opencode"),
  ProviderDriverKind.make("hermes"),
] as const;

const ADDITIONAL_HARNESSES = [
  {
    label: "Claude Code",
    install: "npm i -g @anthropic-ai/claude-code && claude login",
    note: "Signs in with your own Anthropic account.",
  },
  {
    label: "Codex",
    install: "npm i -g @openai/codex && codex login",
    note: "Signs in with your own OpenAI account.",
  },
  {
    label: "Cursor",
    install: "curl https://cursor.com/install -fsS | bash",
    note: "Early access; needs a Cursor subscription.",
  },
];

export function WebHarnessesStep() {
  const providers = useServerProviders();
  const [showAdditional, setShowAdditional] = useState(false);

  return (
    <div className="flex flex-1 flex-col">
      <StepEyebrow>Harnesses</StepEyebrow>
      <StepTitle>Three agents, already signed in</StepTitle>
      <StepLead>
        Your machine ships with three coding harnesses, all authenticated through the Uno gateway —
        nothing to install, no API keys to paste. Switch between them per thread from the model
        picker.
      </StepLead>

      <div className="mt-8 flex max-w-xl flex-col gap-3">
        {BUNDLED_DRIVERS.map((driver) => {
          const option = getDriverOption(driver);
          const provider = providers.find((candidate) => candidate.driver === driver);
          const Icon = option?.icon;
          // No snapshot at all once the server has reported its providers means
          // the binary is missing from this machine's image.
          const status = provider?.status ?? (providers.length > 0 ? "missing" : "pending");

          return (
            <div
              key={driver}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2.5",
                status === "ready"
                  ? "border-primary/30 bg-primary/5"
                  : status === "error"
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-border bg-card",
              )}
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
                {Icon ? <Icon className="size-5" /> : null}
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold">{option?.label ?? driver}</div>
                {provider?.version ? (
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {provider.version}
                  </div>
                ) : null}
              </div>
              {status === "ready" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  <CheckCircle2 className="size-3" />
                  Ready
                </span>
              ) : status === "error" || status === "missing" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                  <TriangleAlert className="size-3" />
                  {status === "missing" ? "Not installed" : "Needs attention"}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Checking…
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-6 max-w-xl">
        <button
          type="button"
          onClick={() => setShowAdditional((value) => !value)}
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", showAdditional && "rotate-180")}
          />
          Want Claude Code, Codex or Cursor too?
        </button>

        {showAdditional ? (
          <div className="mt-4 flex flex-col gap-4 rounded-xl border border-border bg-muted/20 p-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              They run on your subscriptions, so they need a one-time sign-in. Open a terminal on
              this machine (⌘J) and run:
            </p>
            {ADDITIONAL_HARNESSES.map((harness) => (
              <div key={harness.label} className="flex flex-col gap-1">
                <div className="text-xs font-semibold">{harness.label}</div>
                <code className="rounded-md bg-background px-2 py-1.5 font-mono text-[11px] break-all">
                  {harness.install}
                </code>
                <div className="text-[11px] text-muted-foreground">{harness.note}</div>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              After signing in, the harness shows up in the model picker automatically — no restart
              needed.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
