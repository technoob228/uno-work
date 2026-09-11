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

import { openInstallDocs } from "../onboarding/harnessInstallLinks";
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
import { isJobActive } from "./harnessSetupState";

export interface HarnessSignInDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly driver: ProviderAuthDriver;
  readonly label: string;
  readonly job: AuthJobView | undefined;
  readonly onStart: (input: {
    readonly method: "apiKey" | "oauth";
    readonly apiKey?: string;
  }) => void;
  readonly onSubmitCode: (code: string) => void;
  /** Forget the finished job so the dialog reopens in its initial state. */
  readonly onReset: () => void;
}

const API_KEY_HINT: Readonly<Record<ProviderAuthDriver, string>> = {
  claudeAgent: "Stored as ANTHROPIC_API_KEY for this agent, in plain text on that machine's disk.",
  codex:
    "Handed to `codex login --with-api-key`; Codex stores it in its own config on that machine.",
};

export function HarnessSignInDialog({
  open,
  onOpenChange,
  driver,
  label,
  job,
  onStart,
  onSubmitCode,
  onReset,
}: HarnessSignInDialogProps) {
  const [apiKey, setApiKey] = useState("");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) return;
    setApiKey("");
    setCode("");
    setCopied(false);
  }, [open]);

  const active = isJobActive(job);
  const succeeded = job?.state === "succeeded";
  const failed = job?.state === "failed";

  const copyCode = () => {
    if (!job?.userCode) return;
    void navigator.clipboard
      ?.writeText(job.userCode)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in to {label}</DialogTitle>
          <DialogDescription>
            {succeeded
              ? `${label} is signed in on this machine.`
              : `Use your own ${label} account, or paste an API key.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4 pb-2 sm:px-6">
          {succeeded ? (
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2.5 text-sm">
              <CheckCircle2 className="size-4 text-success" />
              <span>Signed in. The agent is ready to use.</span>
            </div>
          ) : job?.method === "oauth" && (active || failed) ? (
            <div className="flex flex-col gap-3">
              {job.verificationUrl ? (
                <button
                  type="button"
                  onClick={() => openInstallDocs(job.verificationUrl!)}
                  className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5 text-left text-sm font-medium text-primary hover:bg-primary/10"
                >
                  <ExternalLink className="size-4 shrink-0" />
                  <span className="min-w-0 break-all">{job.verificationUrl}</span>
                </button>
              ) : null}

              {job.userCode ? (
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
                  <div className="flex items-center gap-2">
                    <Input
                      id={`harness-code-${driver}`}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      placeholder="Authorization code"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Button
                      size="sm"
                      disabled={code.trim().length === 0}
                      onClick={() => onSubmitCode(code.trim())}
                    >
                      Submit
                    </Button>
                  </div>
                </div>
              ) : active ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {job.verificationUrl
                    ? "Waiting for you to finish in the browser…"
                    : "Starting the sign-in…"}
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
                <label className="text-xs font-medium" htmlFor={`harness-key-${driver}`}>
                  Use an API key
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
                    disabled={apiKey.trim().length === 0}
                    onClick={() => onStart({ method: "apiKey", apiKey: apiKey.trim() })}
                  >
                    Connect
                  </Button>
                </div>
                <span className="text-[11px] text-muted-foreground">{API_KEY_HINT[driver]}</span>
              </div>

              <div className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
                <span className="text-xs font-medium">Or sign in with your account</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onClick={() => onStart({ method: "oauth" })}
                >
                  Sign in with account
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Opens a one-time link you finish in your browser. Uses your existing subscription.
                </span>
              </div>
            </div>
          )}

          {failed ? (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">
                  {job?.error ?? "The sign-in did not complete."}
                </span>
              </div>
              <SetupLogDetails log={job?.log ?? ""} />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {failed ? (
            <Button size="sm" variant="outline" onClick={onReset}>
              Try again
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {succeeded ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
