import {
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Laptop,
  Link2,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { addSavedEnvironment } from "~/environments/runtime";
import { useServerConfig } from "~/rpc/serverState";
import { useStore } from "~/store";
import { cn } from "~/lib/utils";
import { plainExplanation } from "../../../../plainLanguage";
import { Explain } from "../../../Explain";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { toastManager } from "../../../ui/toast";
import type { OnboardingWorkLocation } from "../../useOnboardingState";
import { StepEyebrow, StepLead, StepTitle } from "../stepShared";
import { describeConnectedMachine } from "./connectedMachine";

/** Desktop builds are published as GitHub releases of the fork. */
export const DESKTOP_RELEASES_URL = "https://github.com/technoob228/uno-work/releases/latest";

/** Same installer a managed Uno box uses (deploy/install.sh). */
export const DAEMON_INSTALL_COMMAND =
  "curl -fsSL https://console.uno4.dev/cli/work/install.sh | sudo bash";

/**
 * The installer keeps the daemon state in /var/lib/uno-work (0750, service
 * user), so the pairing CLI needs root and an explicit --base-dir.
 */
export const DAEMON_PAIRING_COMMAND =
  "sudo uno-work auth pairing create --base-dir /var/lib/uno-work --role owner --base-url http://<machine-address> --json";

export interface WebWhereStepProps {
  workLocation: OnboardingWorkLocation | null;
  onSelect: (workLocation: OnboardingWorkLocation) => void;
}

interface ChoiceCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  children?: ReactNode;
}

function ChoiceCard({ icon, title, description, selected, onSelect, children }: ChoiceCardProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-h-52 flex-col items-start gap-3 rounded-2xl border p-6 text-left transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected
          ? "border-primary/60 bg-primary/5 shadow-sm"
          : "border-border bg-card hover:border-primary/40 hover:bg-primary/4",
      )}
    >
      <span className="flex w-full items-start justify-between gap-3">
        <span
          className={cn(
            "flex size-10 items-center justify-center rounded-xl",
            selected ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
          )}
        >
          {icon}
        </span>
        {selected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
            <CheckCircle2 className="size-3" />
            Selected
          </span>
        ) : null}
      </span>
      <span className="text-lg font-semibold tracking-tight">{title}</span>
      <span className="text-sm leading-relaxed text-muted-foreground">{description}</span>
      {children}
    </button>
  );
}

function CommandLine({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the command is still visible to select.
    }
  }, [command]);

  return (
    <div className="flex items-start gap-2 rounded-md bg-background px-2 py-1.5">
      <code className="min-w-0 flex-1 font-mono text-[11px] break-all">{command}</code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function ConnectOwnMachine() {
  const [pairingLink, setPairingLink] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedLabel, setConnectedLabel] = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    const pairingUrl = pairingLink.trim();
    if (pairingUrl.length === 0 || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const record = await addSavedEnvironment({ label: "", pairingUrl });
      // Make it the machine the sidebar opens on once onboarding closes.
      useStore.getState().setActiveEnvironmentId(record.environmentId);
      setConnectedLabel(record.label);
      setPairingLink("");
      toastManager.add({
        type: "success",
        title: "Machine connected",
        description: `${record.label} is now your active machine.`,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to that machine.");
    } finally {
      setConnecting(false);
    }
  }, [connecting, pairingLink]);

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-muted/20 p-5">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Link2 className="size-4 text-primary" />
          Connect your own machine
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Any Debian/Ubuntu machine you can SSH into — a home server, a spare laptop, your own VPS.
          Install the Uno Work background service (the daemon) there, create a pairing link, paste
          it below.
        </p>
      </div>

      <ol className="flex flex-col gap-3 text-xs">
        <li className="flex flex-col gap-1.5">
          <span className="font-semibold">1. Install the background service (on that machine)</span>
          <CommandLine command={DAEMON_INSTALL_COMMAND} label="install command" />
        </li>
        <li className="flex flex-col gap-1.5">
          <span className="font-semibold">2. Create a pairing link</span>
          <CommandLine command={DAEMON_PAIRING_COMMAND} label="pairing command" />
          <span className="text-[11px] text-muted-foreground">
            Replace <span className="font-mono">&lt;machine-address&gt;</span> with the address this
            browser can reach the machine on. The JSON output contains the link.
          </span>
        </li>
        <li className="flex flex-col gap-1.5">
          <label className="font-semibold" htmlFor="web-where-pairing-link">
            3. Paste the pairing link
          </label>
          <div className="flex gap-2">
            <Input
              id="web-where-pairing-link"
              value={pairingLink}
              onChange={(event) => setPairingLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleConnect();
              }}
              placeholder="http://192.168.1.20/pair#token=…"
              spellCheck={false}
              disabled={connecting}
            />
            <Button
              size="sm"
              onClick={() => void handleConnect()}
              disabled={connecting || pairingLink.trim().length === 0}
            >
              {connecting ? <Loader2 className="size-4 animate-spin" /> : null}
              Connect
            </Button>
          </div>
        </li>
      </ol>

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {connectedLabel ? (
        <p className="flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400">
          <CheckCircle2 className="size-3.5" />
          Connected to {connectedLabel}. Continue to finish setup.
        </p>
      ) : null}
    </section>
  );
}

export function WebWhereStep({ workLocation, onSelect }: WebWhereStepProps) {
  const machine = describeConnectedMachine(useServerConfig());

  return (
    <div className="flex flex-1 flex-col">
      <StepEyebrow>Where to work</StepEyebrow>
      <StepTitle>
        <span className="inline-flex items-center gap-3">
          Where do you want to work?
          <Explain term="machine" technical className="size-6 [&_svg]:size-5" />
        </span>
      </StepTitle>
      <StepLead>
        The browser is always the screen. Pick the machine —{" "}
        {plainExplanation("machine").replace(/\.$/u, "").toLowerCase()} — and you can add the other
        one later from the machine list in the sidebar.
      </StepLead>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <ChoiceCard
          icon={<Cloud className="size-5" />}
          title="In the Uno cloud"
          description="Nothing to install. Work on the machine this tab is already connected to; long tasks keep running when you close the tab."
          selected={workLocation === "cloud"}
          onSelect={() => onSelect("cloud")}
        >
          <span className="mt-auto w-full rounded-lg border border-border/60 bg-background/70 px-3 py-2">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              This machine
            </span>
            <span className="block truncate text-sm font-semibold">{machine.label}</span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {machine.platformLabel}
              {machine.serverVersion ? ` · ${machine.serverVersion}` : ""}
            </span>
          </span>
        </ChoiceCard>

        <ChoiceCard
          icon={<Laptop className="size-5" />}
          title="On my own computer"
          description="The browser stays the screen, but files and agents live on a machine you own. Use the desktop app, or connect any machine with the Uno Work background service on it."
          selected={workLocation === "local"}
          onSelect={() => onSelect("local")}
        />
      </div>

      {workLocation === "local" ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1.4fr]">
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-muted/20 p-5">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Download className="size-4 text-primary" />
                Use the desktop app
              </h3>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Uno Work for desktop is this same app with the background service built in. Files,
                terminals and agents stay on your computer; sign in with the same account.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              render={<a href={DESKTOP_RELEASES_URL} target="_blank" rel="noopener noreferrer" />}
            >
              Download Uno Work
              <ExternalLink className="size-3.5" />
            </Button>
          </section>

          <ConnectOwnMachine />
        </div>
      ) : null}
    </div>
  );
}
