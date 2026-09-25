/**
 * "You were signed out of <harness>" — the in-chat card that replaces the red
 * status / error banners when a harness loses its sign-in. Its button runs
 * the same sign-in as first setup and Settings:
 *   - Claude / Codex: the in-app sign-in dialog (`useHarnessSetup`);
 *   - OpenCode: the provider key form from Work setup, in a dialog;
 *   - Uno AI (and Hermes on it): Settings → Providers, where the Uno key lives;
 *   - the assistant on the person's own key: Settings → AI provider keys;
 *   - Cursor: no in-app login — the terminal command, copyable.
 * Once signed in, the failed turn can be sent again with one click.
 *
 * Detection is pure and lives in harness/harnessAuthLoss.ts.
 *
 * @module components/chat/HarnessReauthCard
 */
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderAuthDriver,
  type ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2Icon, CopyIcon, KeyRoundIcon, Loader2Icon, XIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import {
  AI_PROVIDER_KEYS_ANCHOR,
  HARNESS_REAUTH_COPY,
  type HarnessAuthLoss,
} from "../harness/harnessAuthLoss";
import { HarnessSignInDialog } from "../harness/HarnessSignInDialog";
import { isAuthableDriver } from "../harness/harnessSetupState";
import { OpenCodeKeyForm } from "../harness/OpenCodeKeyForm";
import { useHarnessSetup } from "../harness/useHarnessSetup";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export interface HarnessReauthCardProps {
  readonly loss: HarnessAuthLoss;
  readonly environmentId: EnvironmentId;
  readonly providerStatus: ServerProvider | null;
  /** Re-sends the failed turn; absent when there is nothing to retry. */
  readonly onRetry?: (() => Promise<void>) | undefined;
  /** Optional escape hatch, e.g. "Switch to built-in Uno AI". */
  readonly fallbackAction?: { readonly label: string; readonly onClick: () => void } | null;
  /** Called when the card is closed (it also hides itself until the next loss). */
  readonly onDismiss?: (() => void) | undefined;
}

export const HarnessReauthCard = memo(function HarnessReauthCard({
  loss,
  environmentId,
  providerStatus,
  onRetry,
  fallbackAction,
  onDismiss,
}: HarnessReauthCardProps) {
  const copy = HARNESS_REAUTH_COPY;
  const navigate = useNavigate();
  const setup = useHarnessSetup(environmentId);
  const [signInOpen, setSignInOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const driverKind = ProviderDriverKind.make(loss.driver);
  const authDriver: ProviderAuthDriver | null =
    loss.kind === "signIn" && isAuthableDriver(driverKind) ? driverKind : null;
  const authJob = authDriver ? setup.authJobs[authDriver] : undefined;

  // A sign-in finished in this card: offer the retry.
  useEffect(() => {
    if (authJob?.state === "succeeded") setSignedIn(true);
  }, [authJob?.state]);

  const openSettings = (hash?: string) =>
    void navigate({
      to: "/settings/environment/$environmentId/providers",
      params: { environmentId },
      ...(hash ? { hash } : {}),
    });

  const copyCommand = () => {
    if (!loss.command) return;
    void navigator.clipboard
      ?.writeText(loss.command)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const primary = () => {
    switch (loss.kind) {
      case "signIn":
        setSignInOpen(true);
        return;
      case "updateKey":
        setKeyOpen(true);
        return;
      case "cursorCli":
        copyCommand();
        return;
      case "unoAccount":
        openSettings();
        return;
      case "assistantKey":
        openSettings(AI_PROVIDER_KEYS_ANCHOR);
        return;
    }
  };

  const retry = async () => {
    if (!onRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  if (dismissed) return null;

  const canRetry = Boolean(onRetry) && loss.source === "error";
  const title = signedIn ? copy.signedInTitle(loss.harnessLabel) : loss.title;
  const message = signedIn
    ? canRetry
      ? copy.signedInMessage
      : copy.retryUnavailable
    : loss.message;

  return (
    <div
      className="mb-2 rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-3 sm:px-4"
      data-harness-reauth-card={loss.kind}
      role="status"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background">
          {loss.kind === "assistantKey" ? (
            <KeyRoundIcon className="size-4 text-muted-foreground" />
          ) : (
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={loss.harnessLabel}
              accentColor={providerStatus?.accentColor}
              className="size-5"
              iconClassName="size-4"
            />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {signedIn ? <CheckCircle2Icon className="size-4 shrink-0 text-success" /> : null}
            <span className="min-w-0">{title}</span>
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{message}</p>
          {loss.command && !signedIn ? (
            <button
              type="button"
              onClick={copyCommand}
              className="mt-2 inline-flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs hover:bg-muted"
              aria-label={`Copy ${loss.command}`}
            >
              {loss.command}
              <CopyIcon className="size-3 text-muted-foreground" />
            </button>
          ) : null}
          {copied && !signedIn ? (
            <p className="mt-1 text-[11px] text-muted-foreground">{copy.copyCommandDone}</p>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {signedIn && canRetry ? (
              <Button size="xs" onClick={() => void retry()} disabled={retrying}>
                {retrying ? <Loader2Icon className="size-3 animate-spin" /> : null}
                {retrying ? copy.retryingAction : copy.retryAction}
              </Button>
            ) : signedIn ? null : (
              <>
                <Button size="xs" onClick={primary}>
                  {loss.actionLabel}
                </Button>
                {loss.kind === "cursorCli" ? (
                  <Button size="xs" variant="outline" onClick={() => openSettings()}>
                    {copy.openSettingsAction}
                  </Button>
                ) : null}
                {/* Signed in somewhere else (Settings, a terminal): retry from here. */}
                {canRetry && loss.kind !== "signIn" && loss.kind !== "updateKey" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void retry()}
                    disabled={retrying}
                  >
                    {retrying ? copy.retryingAction : copy.retryAction}
                  </Button>
                ) : null}
                {fallbackAction ? (
                  <Button size="xs" variant="ghost" onClick={fallbackAction.onClick}>
                    {fallbackAction.label}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground"
          onClick={() => {
            setDismissed(true);
            onDismiss?.();
          }}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      {authDriver && signInOpen ? (
        <HarnessSignInDialog
          open
          onOpenChange={setSignInOpen}
          driver={authDriver}
          label={loss.harnessLabel}
          job={authJob}
          onStart={({ method, apiKey }) =>
            void setup.startAuth({ driver: authDriver, method, ...(apiKey ? { apiKey } : {}) })
          }
          onSubmitCode={(code) => void setup.submitAuthCode({ driver: authDriver, code })}
          onReset={() => setup.clearAuth(authDriver)}
        />
      ) : null}

      {loss.kind === "updateKey" && keyOpen ? (
        <Dialog open onOpenChange={setKeyOpen}>
          <DialogPopup className="max-w-md">
            <DialogHeader>
              <DialogTitle>{copy.updateKeyAction}</DialogTitle>
              <DialogDescription>{loss.message}</DialogDescription>
            </DialogHeader>
            <OpenCodeKeyForm
              className="mx-4 mt-0 sm:mx-6"
              onSaved={() => {
                setKeyOpen(false);
                setSignedIn(true);
              }}
            />
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={() => setKeyOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
});
