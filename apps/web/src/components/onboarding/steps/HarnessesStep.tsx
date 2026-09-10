import { AlertTriangle, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import { ProviderDriverKind } from "@t3tools/contracts";

import { useServerProviders } from "~/rpc/serverState";
import { useDesktopUnoCodeInstallState } from "~/lib/desktopUnoCodeReactQuery";
import { Gemini, GithubCopilotIcon } from "../../Icons";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { HarnessSetupList } from "../../harness/HarnessSetupList";
import { COMING_SOON_HARNESSES } from "../../harness/harnessSetupState";
import { HARNESS_INSTALL_LINKS, openInstallDocs } from "../harnessInstallLinks";
import { StepEyebrow, StepLead, StepTitle } from "./stepShared";

const UNO_DRIVER = ProviderDriverKind.make("uno");

export function HarnessesStep() {
  const providers = useServerProviders();
  const unoCodeQuery = useDesktopUnoCodeInstallState();
  const unoStatus = unoCodeQuery.data?.status ?? "idle";
  const unoFailed = unoCodeQuery.data?.status === "failed" ? unoCodeQuery.data : null;
  const unoError = unoFailed?.error ?? null;
  const unoWillRetry = unoFailed?.willRetry ?? false;
  const [isRetryingUno, setIsRetryingUno] = useState(false);

  const handleRetryUno = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.retryUnoCodeInstall !== "function") return;
    setIsRetryingUno(true);
    void bridge
      .retryUnoCodeInstall()
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not start install",
          description: error instanceof Error ? error.message : "Install request failed.",
        });
      })
      .finally(() => {
        setIsRetryingUno(false);
      });
  }, []);

  return (
    <div>
      <StepEyebrow>Bring your AI</StepEyebrow>
      <StepTitle>Use the AI subscriptions you already have.</StepTitle>
      <StepLead>
        Uno Work auto-detects harnesses already installed and signed in on this computer. Anything
        missing you can install right here — no terminal — and sign in with your own account or an
        API key.
      </StepLead>

      <div className="mt-6 max-w-2xl">
        <HarnessSetupList
          providers={providers}
          comingSoon={[
            ...COMING_SOON_HARNESSES.map((label) => ({ label })),
            { label: "Gemini CLI", icon: <Gemini className="size-5" /> },
            { label: "GitHub Copilot CLI", icon: <GithubCopilotIcon className="size-5" /> },
          ]}
          renderRowExtra={(driver) => {
            // Uno Code is bundled: the desktop shell installs it, so the row
            // offers a retry rather than the generic Install button.
            if (driver === UNO_DRIVER) {
              if (unoStatus === "installing") {
                return (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    Installing Uno Code…
                  </span>
                );
              }
              if (unoStatus === "failed") {
                return (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isRetryingUno}
                    className="border-amber-500/50 text-amber-700 dark:text-amber-300"
                    onClick={handleRetryUno}
                  >
                    <AlertTriangle className="mr-1 size-3" />
                    Retry
                  </Button>
                );
              }
              return null;
            }

            const url = HARNESS_INSTALL_LINKS[driver];
            if (!url) return null;
            return (
              <button
                type="button"
                onClick={() => openInstallDocs(url)}
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              >
                Docs
              </button>
            );
          }}
        />
      </div>

      {unoError ? (
        <p className="mt-3 max-w-2xl text-xs text-amber-700 dark:text-amber-300">
          Uno Code didn’t install: {unoError}{" "}
          {unoWillRetry
            ? "Retrying automatically — you can keep going."
            : "You can continue onboarding — set it up later in Settings."}
        </p>
      ) : null}
      <p className="mt-4 text-xs text-muted-foreground">
        Switch between harnesses any time from the chat header — no lock-in.
      </p>
    </div>
  );
}
