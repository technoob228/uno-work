/**
 * "You're not signed in to Claude Code" — the composer's question before a
 * harness without a sign-in of its own runs on the account's Uno credits.
 *
 * Two ways on: **Sign in** (the CLI's own sign-in, the same dialog as in
 * Settings — Uno never signs in for the person) or **Use Uno credits**
 * (remembered for this harness on this computer, in the machine's settings;
 * Settings → Agents turns it off again). With no premium credit left the
 * second button goes to billing instead, and Uno AI · Smart is offered.
 *
 * A message sent before the choice waits in the composer and goes out by
 * itself once the person picks (ChatComposer). Rules and texts:
 * unoCreditsChoice.logic.ts.
 *
 * @module components/chat/UnoCreditsChoicePanel
 */
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderAuthDriver,
  type ServerProvider,
} from "@t3tools/contracts";
import { Loader2Icon } from "lucide-react";
import { memo, useState } from "react";

import { useUpdateEnvironmentSettings } from "~/environments/settings/serverSettings";
import { AI_STATUS_PREMIUM_POLL_MS, useAiStatus } from "../../lib/aiStatusReactQuery";
import { cn } from "../../lib/utils";
import { openInNewTab } from "../../navigation/useOpenApp";
import { HarnessSignInDialog } from "../harness/HarnessSignInDialog";
import { isAuthableDriver } from "../harness/harnessSetupState";
import { useHarnessSetup } from "../harness/useHarnessSetup";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { unoCreditsChoiceCopy, unoCreditsHarnessLabel } from "./unoCreditsChoice.logic";

export interface UnoCreditsChoicePanelProps {
  readonly environmentId: EnvironmentId | null;
  readonly provider: ServerProvider;
  /** A message is waiting for the choice. */
  readonly queued: boolean;
  /** Switch this chat to Uno AI · Smart; null when the chat can't switch. */
  readonly onSwitchToSmart: (() => void) | null;
  /** Uno credits allowed (the waiting message may go now). */
  readonly onAllowed?: (() => void) | undefined;
}

export const UnoCreditsChoicePanel = memo(function UnoCreditsChoicePanel({
  environmentId,
  provider,
  queued,
  onSwitchToSmart,
  onAllowed,
}: UnoCreditsChoicePanelProps) {
  const driver = provider.driver;
  const label = unoCreditsHarnessLabel(driver) ?? provider.displayName ?? driver;
  const status = useAiStatus(environmentId, { pollMs: AI_STATUS_PREMIUM_POLL_MS });
  const { updateSettings } = useUpdateEnvironmentSettings(environmentId);
  const setup = useHarnessSetup(environmentId);
  const [signInOpen, setSignInOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const driverKind = ProviderDriverKind.make(driver);
  const authDriver: ProviderAuthDriver | null = isAuthableDriver(driverKind) ? driverKind : null;
  const authJob = authDriver ? setup.authJobs[authDriver] : undefined;
  const copy = unoCreditsChoiceCopy({
    driver,
    premium: status?.premium,
    canSwitchToSmart: onSwitchToSmart !== null,
    queued,
  });

  const allow = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateSettings({ harnessUnoCredits: { [driver]: true } });
      onAllowed?.();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't save your choice",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const creditsAction = copy.creditsAction;
  return (
    <div
      className={cn(
        "mx-3 mt-3 rounded-xl border bg-muted/30 px-3 py-2.5 transition-colors",
        queued ? "border-amber-500/50 bg-amber-500/[0.06]" : "border-border/70",
      )}
      role="status"
      data-testid="uno-credits-choice"
      data-uno-credits-action={creditsAction.kind}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background">
          <ProviderInstanceIcon
            driverKind={driverKind}
            displayName={label}
            accentColor={provider.accentColor}
            className="size-4.5"
            iconClassName="size-3.5"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{copy.title}</p>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{copy.body}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {authDriver ? (
              <Button
                type="button"
                size="xs"
                onClick={() => setSignInOpen(true)}
                data-testid="uno-credits-sign-in"
              >
                {copy.signInLabel}
              </Button>
            ) : null}
            {creditsAction.kind === "useCredits" ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={saving}
                onClick={() => void allow()}
                data-testid="uno-credits-use"
              >
                {saving ? <Loader2Icon className="size-3 animate-spin" /> : null}
                {creditsAction.label}
              </Button>
            ) : (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => openInNewTab(creditsAction.url)}
                data-testid="uno-credits-billing"
              >
                {creditsAction.label}
              </Button>
            )}
            {copy.smartLabel && onSwitchToSmart ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={onSwitchToSmart}
                data-testid="uno-credits-smart"
              >
                {copy.smartLabel}
              </Button>
            ) : null}
          </div>
          {copy.note ? (
            <p
              className={cn(
                "mt-1.5 text-[11px] leading-snug",
                queued ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
              )}
            >
              {copy.note}
            </p>
          ) : null}
        </div>
      </div>

      {authDriver && signInOpen ? (
        <HarnessSignInDialog
          open
          onOpenChange={setSignInOpen}
          driver={authDriver}
          label={label}
          job={authJob}
          onStart={({ method, apiKey }) =>
            void setup.startAuth({ driver: authDriver, method, ...(apiKey ? { apiKey } : {}) })
          }
          onSubmitCode={(code) => void setup.submitAuthCode({ driver: authDriver, code })}
          onReset={() => setup.clearAuth(authDriver)}
        />
      ) : null}
    </div>
  );
});
