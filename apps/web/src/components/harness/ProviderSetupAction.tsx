/**
 * The Install / Sign in control shown on a provider card in Settings.
 *
 * Same jobs as the onboarding list, rendered as a single button because a
 * settings row has no space for a status column of its own — the card
 * already shows the provider's state.
 *
 * @module components/harness/ProviderSetupAction
 */
import { Loader2 } from "lucide-react";
import { useState } from "react";

import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { getDriverOption } from "../settings/providerDriverMeta";
import { HarnessSignInDialog } from "./HarnessSignInDialog";
import {
  isAuthableDriver,
  isJobActive,
  resolveHarnessAction,
  resolveHarnessStatus,
} from "./harnessSetupState";
import type { HarnessSetupApi } from "./useHarnessSetup";

export interface ProviderSetupActionProps {
  readonly driver: ProviderDriverKind;
  readonly provider: ServerProvider | undefined;
  readonly providersLoaded: boolean;
  readonly setup: HarnessSetupApi;
  /** False when this environment cannot be mutated (disconnected, read-only). */
  readonly enabled: boolean;
}

export function ProviderSetupAction({
  driver,
  provider,
  providersLoaded,
  setup,
  enabled,
}: ProviderSetupActionProps) {
  const [signInOpen, setSignInOpen] = useState(false);
  const status = resolveHarnessStatus({ provider, providersLoaded });
  const action = resolveHarnessAction({ driver, status });
  const installJob = setup.installJobs[driver];
  const installing = isJobActive(installJob);

  if (installing) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Installing…
      </span>
    );
  }

  if (action === "install") {
    return (
      <Button
        size="xs"
        variant="outline"
        disabled={!enabled}
        onClick={() => void setup.startInstall(driver)}
      >
        {installJob?.state === "failed" ? "Retry install" : "Install"}
      </Button>
    );
  }

  if (action === "signIn" && isAuthableDriver(driver)) {
    return (
      <>
        <Button size="xs" variant="outline" disabled={!enabled} onClick={() => setSignInOpen(true)}>
          Sign in
        </Button>
        {signInOpen ? (
          <HarnessSignInDialog
            open
            onOpenChange={setSignInOpen}
            driver={driver}
            label={getDriverOption(driver)?.label ?? String(driver)}
            job={setup.authJobs[driver]}
            onStart={({ method, apiKey }) =>
              void setup.startAuth({ driver, method, ...(apiKey ? { apiKey } : {}) })
            }
            onSubmitCode={(code) => void setup.submitAuthCode({ driver, code })}
            onReset={() => setup.clearAuth(driver)}
          />
        ) : null}
      </>
    );
  }

  return null;
}
