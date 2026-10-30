/**
 * Sign-in dialog for Claude Code and Codex.
 *
 * Two ways in, both driven by the daemon that owns the machine:
 *   - paste an API key (stored in that harness's provider environment, on
 *     that machine's disk);
 *   - sign in with the account, which starts the CLI's device/OAuth flow and
 *     surfaces the URL, the one-time code and — for Claude — the box to paste
 *     the authorization code back into.
 *
 * @module components/harness/HarnessSignInDialog
 */
import { CheckCircle2, Copy, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import type { ProviderAuthDriver } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { inAppBrowserName } from "./inAppBrowser";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SetupLogDetails } from "./SetupLogDetails";
import type { AuthJobView } from "./useHarnessSetup";
import { describeSignInFailure, isJobActive } from "./harnessSetupState";

export interface HarnessSignInPanelProps {
  readonly driver: ProviderAuthDriver;
  readonly label: string;
  readonly job: AuthJobView | undefined;
  readonly onStart: (input: {
    readonly method: "apiKey" | "oauth";
    readonly apiKey?: string;
    /** Drop the sign-in that is waiting and start a new one. */
    readonly restart?: boolean;
  }) => void;
  /** Stop the sign-in that waits for the browser. Absent: no Cancel button. */
  readonly onCancel?: () => void;
  readonly onSubmitCode: (code: string) => void;
  /** Forget the finished job so the panel starts over. */
  readonly onReset: () => void;
  /** A second account: its plan's sign-in only, no API key. */
  readonly accountOnly?: boolean;
}

export interface HarnessSignInDialogProps extends HarnessSignInPanelProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The person's own subscription comes first (flow-agent 15.10). The link is
 * the CLI's own (`claude auth login` / `codex login --device-auth` on that
 * machine): they sign in on claude.ai / the ChatGPT site themselves.
 */
const ACCOUNT_HINT: Readonly<Record<ProviderAuthDriver, string>> = {
  claudeAgent:
    "Uses your Claude Pro or Max plan. The link comes from Claude Code on this computer: you sign in on claude.ai yourself and paste the code back here.",
  codex:
    "Uses your ChatGPT plan. The link comes from Codex on this computer: you sign in on the ChatGPT site yourself and enter the code there.",
};

const API_KEY_HINT: Readonly<Record<ProviderAuthDriver, string>> = {
  claudeAgent: "Stored as ANTHROPIC_API_KEY for this agent, in plain text on that machine's disk.",
  codex:
    "Handed to `codex login --with-api-key`; Codex stores it in its own config on that machine.",
};

/** After this long checking a pasted code, say so and offer a new link. */
export const CODE_CHECK_SLOW_MS = 30_000;

/** Who checks the pasted code, in the person's words. */
const CODE_CHECKER: Readonly<Record<ProviderAuthDriver, string>> = {
  claudeAgent: "Claude",
  codex: "OpenAI",
};

/** One-line lead for the sign-in surface, shared by the dialog and the picker pane. */
export function describeSignInState(label: string, job: AuthJobView | undefined): string {
  return job?.state === "succeeded"
    ? `${label} is signed in on this machine.`
    : `Use your own ${label} account, or an API key.`;
}

/**
 * The sign-in controls without any dialog chrome, so the model picker can
 * show them inline. `key` the component on the driver to reset its inputs.
 */
export function HarnessSignInPanel({
  driver,
  job,
  onStart,
  onSubmitCode,
  onReset,
  onCancel,
  accountOnly,
  className,
}: Omit<HarnessSignInPanelProps, "label"> & { readonly className?: string }) {
  const [apiKey, setApiKey] = useState("");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

  const active = isJobActive(job);
  const succeeded = job?.state === "succeeded";
  const failed = job?.state === "failed";
  // The pasted code went to the CLI and it is trading it for a sign-in
  // (P4, 28.10: nothing on screen moved for 25 s, the box stayed as it was).
  const checking = active && job?.codeCheck === "checking" && !job.needsCodeInput;
  const rejected = active && job?.codeCheck === "rejected" && job.needsCodeInput;
  // A Submit the computer refused (the sign-in isn't waiting any more…).
  const submitError = active && !checking ? (job?.error ?? null) : null;
  // The CLI's own words ("exited with code 1… status code 400") go to the
  // console and under Details; the person reads what happened and what next.
  const failure = failed && job ? describeSignInFailure(job) : null;
  const failedError = failed ? job?.error : undefined;
  useEffect(() => {
    if (failedError) console.warn(`[sign-in] ${driver} did not finish:`, failedError);
  }, [driver, failedError]);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!checking) return;
    const timer = setTimeout(() => setSlow(true), CODE_CHECK_SLOW_MS);
    return () => clearTimeout(timer);
  }, [checking]);
  // That code didn't work: the box starts empty for the next one.
  useEffect(() => {
    if (rejected) setCode("");
  }, [rejected]);
  const submit = () => {
    const value = code.trim();
    if (value.length === 0 || checking) return;
    onSubmitCode(value);
  };

  const [linkCopied, setLinkCopied] = useState(false);
  const inApp = inAppBrowserName();
  const copyLink = () => {
    if (!job?.verificationUrl) return;
    void navigator.clipboard
      ?.writeText(job.verificationUrl)
      .then(() => setLinkCopied(true))
      .catch(() => setLinkCopied(false));
  };

  const copyCode = () => {
    if (!job?.userCode) return;
    void navigator.clipboard
      ?.writeText(job.userCode)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {succeeded ? (
        <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2.5 text-sm">
          <CheckCircle2 className="size-4 text-success" />
          <span>Signed in. The agent is ready to use.</span>
        </div>
      ) : job?.method === "oauth" && (active || failed) ? (
        <div className="flex flex-col gap-3">
          {job.verificationUrl && active ? (
            // The link itself is six lines of OAuth parameters: a button to
            // open it and one to copy it, the address stays folded away.
            // Only while the sign-in waits: after it ended the link leads to a
            // code nothing here can take any more.
            <div className="flex flex-col gap-1.5" data-testid="harness-sign-in-link">
              {inApp ? (
                // Telegram's own browser (sign-in through Telegram opens Work
                // there): the person is not signed in to Claude / ChatGPT in it.
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="harness-sign-in-in-app-browser"
                >
                  You&apos;re in {inApp}&apos;s browser. Copy the link and open it in Safari or
                  Chrome, where you use your account.
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => openInstallDocs(job.verificationUrl!)}>
                  <ExternalLink className="mr-1 size-3.5" />
                  Open sign-in page
                </Button>
                <Button size="sm" variant="outline" onClick={copyLink}>
                  <Copy className="mr-1 size-3" />
                  {linkCopied ? "Copied" : "Copy link"}
                </Button>
              </div>
              <details className="text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none hover:text-foreground">
                  Show the link
                </summary>
                <p className="mt-1 break-all font-mono text-[10px] leading-4">
                  {job.verificationUrl}
                </p>
              </details>
            </div>
          ) : null}

          {job.userCode && active ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Enter this one-time code on that page
              </span>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-base tracking-widest">
                  {job.userCode}
                </code>
                <Button size="sm" variant="outline" onClick={copyCode}>
                  <Copy className="mr-1 size-3" />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          ) : null}

          {job.needsCodeInput ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" htmlFor={`harness-code-${driver}`}>
                Paste the code from the browser
              </label>
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <Input
                  id={`harness-code-${driver}`}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Authorization code"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="harness-sign-in-code"
                />
                <Button
                  size="sm"
                  type="submit"
                  disabled={code.trim().length === 0}
                  data-testid="harness-sign-in-submit"
                >
                  Submit
                </Button>
              </form>
              {rejected ? (
                <p
                  className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300"
                  data-testid="harness-sign-in-rejected"
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {CODE_CHECKER[driver]} didn&apos;t take that code. Copy the code from the newest
                  sign-in page and paste it again, or get a new link.
                </p>
              ) : null}
              {submitError ? (
                <p
                  className="flex items-start gap-1.5 text-xs text-destructive"
                  data-testid="harness-sign-in-submit-error"
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{submitError}</span>
                </p>
              ) : null}
            </div>
          ) : checking ? (
            <div
              className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 px-3 py-2.5"
              data-testid="harness-sign-in-checking"
              role="status"
            >
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
                Checking the code with {CODE_CHECKER[driver]}…
              </div>
              <span className="pl-6 text-xs text-muted-foreground">
                {slow
                  ? "Taking longer than usual. Keep this open — or get a new link below."
                  : "Usually a few seconds. Keep this window open."}
              </span>
            </div>
          ) : active ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {job.verificationUrl
                ? "Waiting for you to finish in the browser…"
                : "Starting the sign-in…"}
            </div>
          ) : null}
          {active ? (
            // Closing this page does not lose the sign-in: it is still here
            // when you come back. These two are the ways out of it.
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {onCancel ? (
                <button
                  type="button"
                  className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
                  onClick={onCancel}
                  data-testid="harness-sign-in-cancel"
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => onStart({ method: "oauth", restart: true })}
                data-testid="harness-sign-in-restart"
              >
                Get a new link
              </button>
              <span>Signed in from a terminal instead? This page notices in a few seconds.</span>
            </div>
          ) : null}
        </div>
      ) : active ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Connecting…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Sign in with your account</span>
            <Button
              size="sm"
              className="self-start"
              onClick={() => onStart({ method: "oauth" })}
              data-testid="harness-sign-in-account"
            >
              Sign in with your account
            </Button>
            <span className="text-[11px] text-muted-foreground">{ACCOUNT_HINT[driver]}</span>
          </div>

          {accountOnly ? null : (
            <div className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
              <label className="text-xs font-medium" htmlFor={`harness-key-${driver}`}>
                Or use an API key
              </label>
              <div className="flex items-center gap-2">
                <Input
                  id={`harness-key-${driver}`}
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={apiKey.trim().length === 0}
                  onClick={() => onStart({ method: "apiKey", apiKey: apiKey.trim() })}
                >
                  Connect
                </Button>
              </div>
              <span className="text-[11px] text-muted-foreground">{API_KEY_HINT[driver]}</span>
            </div>
          )}
        </div>
      )}

      {failure ? (
        <div
          className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5"
          data-testid="harness-sign-in-failed"
        >
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{failure.message}</span>
          </div>
          <SetupLogDetails log={failure.details} label="Details" />
          {failure.codeRejected ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => onStart({ method: "oauth", restart: true })}
            >
              Get a new link
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="self-start" onClick={onReset}>
              Try again
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function HarnessSignInDialog({
  open,
  onOpenChange,
  driver,
  label,
  job,
  onStart,
  onSubmitCode,
  onReset,
  onCancel,
  accountOnly,
}: HarnessSignInDialogProps) {
  // Remount the panel when the dialog closes so its inputs start empty next time.
  const [panelKey, setPanelKey] = useState(0);
  useEffect(() => {
    if (open) return;
    setPanelKey((value) => value + 1);
  }, [open]);

  const succeeded = job?.state === "succeeded";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in to {label}</DialogTitle>
          <DialogDescription>{describeSignInState(label, job)}</DialogDescription>
        </DialogHeader>

        <HarnessSignInPanel
          key={panelKey}
          driver={driver}
          job={job}
          onStart={onStart}
          onSubmitCode={onSubmitCode}
          onReset={onReset}
          {...(onCancel ? { onCancel } : {})}
          {...(accountOnly ? { accountOnly: true } : {})}
          className="px-4 pb-2 sm:px-6"
        />

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {succeeded ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
