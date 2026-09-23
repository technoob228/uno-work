import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ExternalLinkIcon, KeyRoundIcon, ServerIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import { useStore } from "~/store";
import { CopyButton } from "../../computer/computerUi";
import { computerStateQueryOptions } from "../../computer/computerQueries";
import { Button } from "../../ui/button";
import { Skeleton } from "../../ui/skeleton";
import { openInstallDocs } from "../harnessInstallLinks";
import { thisDeviceWords } from "../onboardingPath";
import type { OnboardingFlow } from "../useOnboardingState";
import { StepTitle } from "./stepShared";

/** Console → Secrets → SSH keys: named public keys placed onto new computers. */
export const CONSOLE_SSH_KEYS_URL = "https://console.uno4.dev/secrets?tab=sshkeys";
/** Console start flow for the SSH path (size → key → create). */
export const CONSOLE_START_SSH_URL = "https://console.uno4.dev/start?path=ssh";

function ExternalButton({
  href,
  children,
  variant = "outline",
}: {
  href: string;
  children: ReactNode;
  variant?: "outline" | "default";
}) {
  return (
    <Button size="sm" variant={variant} onClick={() => openInstallDocs(href)}>
      {children}
      <ExternalLinkIcon className="size-3 opacity-60" />
    </Button>
  );
}

/**
 * "Over SSH". On an Uno cloud computer: its ready-to-run SSH command (the same
 * one as "For engineers" on the computer screen) and where keys live. On a
 * Mac/PC, or anywhere without a cloud computer: SSH needs one, so the step
 * points to the console's start flow and offers to carry on in Uno Work here.
 */
export function SshAccessStep({
  flow,
  onContinueInUnoWork,
}: {
  flow: OnboardingFlow;
  /** Switch this onboarding to the "In Uno Work" path and keep going. */
  onContinueInUnoWork: () => void;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  // Only a browser tab can be sitting on a cloud computer; the desktop app runs here.
  const stateQuery = useQuery({
    ...computerStateQueryOptions(environmentId, null),
    enabled: flow === "web" && environmentId !== null,
  });
  const box = stateQuery.data?.own ? stateQuery.data.box : null;
  const loading = flow === "web" && stateQuery.isPending && environmentId !== null;
  const here = flow === "web" ? "this computer" : thisDeviceWords();

  return (
    <div className="m-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
          Over SSH
        </div>
        <StepTitle>
          {box || loading ? "Reach this computer over SSH" : "SSH needs a cloud computer"}
        </StepTitle>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground">
          {box || loading
            ? "A real Linux computer: log in from your own terminal with your key, like any server."
            : `Uno Work runs on ${here} right now. For SSH you need a clean Linux computer in the Uno cloud — with root and your own key.`}
        </p>
      </div>

      {loading ? (
        <Skeleton className="h-28 w-full rounded-2xl" />
      ) : box ? (
        <div className="flex flex-col gap-5">
          <div className="rounded-2xl border border-border bg-muted/30 p-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {box.name}
            </div>
            {box.ssh ? (
              <div className="mt-3 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm">
                  {box.ssh}
                </code>
                <CopyButton value={box.ssh} label="SSH command" />
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                This computer has no SSH address yet. It appears here and on the computer screen
                under &ldquo;For engineers&rdquo; once it&apos;s ready.
              </p>
            )}
          </div>

          <div className="flex gap-3 text-sm">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRoundIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">Your key</div>
              <p className="mt-1 text-muted-foreground">
                Uno logs you in with keys, not passwords. Save your public key under SSH keys in
                the console — it goes onto every new computer you make.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <ExternalButton href={CONSOLE_SSH_KEYS_URL}>Open SSH keys</ExternalButton>
                <ExternalButton href={CONSOLE_START_SSH_URL}>
                  Make a separate clean computer
                </ExternalButton>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-4 rounded-2xl border border-border bg-muted/30 p-5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ServerIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">Get a cloud computer</div>
              <p className="mt-1 text-muted-foreground">
                Pick a size, add your key, and in about ten seconds you get a command like{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs whitespace-nowrap">
                  ssh uno@… -p …
                </code>
                . It opens in the Uno console.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <ExternalButton href={CONSOLE_START_SSH_URL} variant="default">
                  Get a cloud computer
                </ExternalButton>
                <ExternalButton href={CONSOLE_SSH_KEYS_URL}>Add my SSH key</ExternalButton>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onContinueInUnoWork}
            className="self-start rounded-md px-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Or set up Uno Work on {here} instead →
          </button>
        </div>
      )}
    </div>
  );
}
