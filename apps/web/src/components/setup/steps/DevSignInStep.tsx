/**
 * The developer way, step 1 — sign in to Claude Code or Codex with the plan
 * the person already pays for (13.11). The same sign-in as setup's AI step and
 * the model picker (`HarnessSignInPanel` + the daemon's sign-in jobs), Claude
 * and Codex only; Uno AI is the one-line way out for someone with neither.
 * The pick becomes the default for new chats and the first chat's agent.
 */
import { ProviderDriverKind, type ProviderAuthDriver } from "@t3tools/contracts";
import { Loader2Icon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { useSettings } from "../../../hooks/useSettings";
import { cn } from "../../../lib/utils";
import { useServerProviders } from "../../../rpc/serverState";
import { HarnessSignInPanel } from "../../harness/HarnessSignInDialog";
import { isJobActive, progressLine } from "../../harness/harnessSetupState";
import { useHarnessSetup } from "../../harness/useHarnessSetup";
import { ClaudeAI, OpenAI, type Icon } from "../../Icons";
import { Button } from "../../ui/button";
import { withAnswer } from "../goals";
import {
  DEV_AGENTS,
  DEV_AGENT_LABEL,
  devAgentSelection,
  devAgentSignedIn,
  initialDevAgent,
  parseDevAgent,
  type DevAgentId,
} from "../devAgent";
import { DEV_AGENT_KEY } from "../devSetup";
import { ConnectedBadge, SetupHeading, SetupNote, SetupShell } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { useSetupProgress, useUpdateSetupProgress } from "../useSetupProgress";

const AGENT_ROW: Readonly<Record<ProviderAuthDriver, { icon: Icon; plan: string }>> = {
  claudeAgent: { icon: ClaudeAI, plan: "Your Claude Pro or Max plan, or an Anthropic API key." },
  codex: { icon: OpenAI, plan: "Your ChatGPT Plus or Pro plan, or an OpenAI API key." },
};

type RowStatus = "checking" | "notInstalled" | "needsSignIn" | "signedIn";

export function DevSignInStep() {
  const providers = useServerProviders();
  const providersLoaded = providers.length > 0;
  const setup = useHarnessSetup();
  const settings = useSettings();
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const { completeStep } = useSetupNavigation();
  const setSticky = useComposerDraftStore((store) => store.setStickyModelSelection);

  const saved = parseDevAgent(progress.answers[DEV_AGENT_KEY]);
  const [touched, setTouched] = useState(false);
  const [picked, setPicked] = useState<ProviderAuthDriver>(() => initialDevAgent(providers, saved));
  const [open, setOpen] = useState<ProviderAuthDriver | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Providers arrive after the first render: start on the one already signed in.
  useEffect(() => {
    if (!touched) setPicked(initialDevAgent(providers, saved));
  }, [providers, saved, touched]);

  const statusOf = useMemo(
    () =>
      (id: ProviderAuthDriver): RowStatus => {
        const provider = providers.find((entry) => entry.instanceId === id);
        if (!provider) return providersLoaded ? "notInstalled" : "checking";
        if (!provider.installed) return "notInstalled";
        return devAgentSignedIn(providers, id) ? "signedIn" : "needsSignIn";
      },
    [providers, providersLoaded],
  );

  // A finished sign-in closes its panel.
  useEffect(() => {
    if (open && statusOf(open) === "signedIn") setOpen(null);
  }, [open, statusOf]);

  const choose = (id: ProviderAuthDriver) => {
    setTouched(true);
    setPicked(id);
    if (statusOf(id) === "needsSignIn") setOpen(id);
  };

  const confirm = async (id: DevAgentId) => {
    setError(null);
    const selection = devAgentSelection(id, providers, settings);
    if (!selection) {
      setError(`${DEV_AGENT_LABEL[id]} has no model to start on yet. Give it a moment.`);
      return;
    }
    setSticky(selection);
    await update((current) => withAnswer(current, DEV_AGENT_KEY, id));
    void completeStep("sign-in");
  };

  const pickedReady = statusOf(picked) === "signedIn";
  return (
    <SetupShell
      step="sign-in"
      primary={{
        label: pickedReady ? `Continue with ${DEV_AGENT_LABEL[picked]}` : "Sign in first",
        disabled: !pickedReady,
        onClick: () => void confirm(picked),
      }}
    >
      <SetupHeading
        title="Sign in to your coding agent"
        lead="Use the plan you already pay for. Your agent works here, in the cloud, even with your laptop closed."
      />
      <div
        role="radiogroup"
        aria-label="Your coding agent"
        className="overflow-hidden rounded-2xl border border-border"
      >
        {DEV_AGENTS.map((id, index) => {
          const status = statusOf(id);
          const row = AGENT_ROW[id];
          const Logo = row.icon;
          const isPicked = id === picked;
          const installJob = setup.installJobs[id];
          const installing = isJobActive(installJob);
          let side: ReactNode = null;
          if (status === "signedIn") side = <ConnectedBadge>Signed in</ConnectedBadge>;
          else if (status === "checking") {
            side = <Loader2Icon className="size-4 animate-spin text-muted-foreground" />;
          } else if (status === "notInstalled") {
            side = (
              <Button
                size="xs"
                variant="outline"
                disabled={installing}
                onClick={(event) => {
                  event.stopPropagation();
                  setTouched(true);
                  setPicked(id);
                  void setup.startInstall(ProviderDriverKind.make(id));
                }}
              >
                {installing ? <Loader2Icon className="size-3 animate-spin" /> : null}
                {installing ? "Installing" : "Install"}
              </Button>
            );
          } else {
            side = (
              <Button
                size="xs"
                variant={isPicked ? "default" : "outline"}
                onClick={(event) => {
                  event.stopPropagation();
                  setTouched(true);
                  setPicked(id);
                  setOpen(open === id ? null : id);
                }}
                data-testid={`setup-dev-sign-in-${id}`}
              >
                Sign in
              </Button>
            );
          }
          const expanded = open === id && status === "needsSignIn";
          return (
            <div
              key={id}
              role="radio"
              aria-checked={isPicked}
              tabIndex={0}
              onClick={() => choose(id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  choose(id);
                }
              }}
              data-testid={`setup-dev-agent-${id}`}
              data-status={status}
              className={cn(
                "cursor-pointer px-4 py-4 outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:px-5",
                index > 0 && "border-t border-border",
                isPicked
                  ? "bg-primary/[0.04] ring-1 ring-inset ring-primary/40"
                  : "hover:bg-muted/40",
              )}
            >
              <div className="flex items-start gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
                  <Logo className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{DEV_AGENT_LABEL[id]}</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">{row.plan}</div>
                  {installing ? (
                    <div className="mt-2 truncate text-xs text-muted-foreground">
                      {progressLine(installJob?.log ?? "") ?? "Installing…"}
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
              {/* Under the whole row: on a phone the text column is too narrow for it. */}
              {expanded ? (
                <div className="sm:ml-14" onClick={(event) => event.stopPropagation()}>
                  <HarnessSignInPanel
                    key={id}
                    className="mt-3 rounded-xl border border-border bg-muted/30 p-3"
                    driver={id}
                    job={setup.authJobs[id]}
                    onStart={(input) =>
                      void setup.startAuth({
                        driver: id,
                        method: input.method,
                        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
                      })
                    }
                    onSubmitCode={(code) => void setup.submitAuthCode({ driver: id, code })}
                    onReset={() => setup.clearAuth(id)}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <SetupNote>
        No subscription?{" "}
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => void confirm("uno")}
          data-testid="setup-dev-use-uno"
        >
          Use Uno AI
        </button>
      </SetupNote>
    </SetupShell>
  );
}
