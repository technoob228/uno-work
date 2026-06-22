import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useServerProviders } from "~/rpc/serverState";
import { useDesktopUnoCodeInstallState } from "~/lib/desktopUnoCodeReactQuery";
import { Gemini, GithubCopilotIcon, type Icon } from "../../Icons";
import { Button } from "../../ui/button";
import { cn } from "~/lib/utils";
import { toastManager } from "../../ui/toast";
import { HARNESS_INSTALL_LINKS, openInstallDocs } from "../harnessInstallLinks";
import {
  PROVIDER_CLIENT_DEFINITIONS,
  type ProviderClientDefinition,
} from "../../settings/providerDriverMeta";
import { StepEyebrow, StepLead, StepTitle } from "./stepShared";

type RowVariant =
  | "bundled"
  | "bundled-installing"
  | "bundled-failed"
  | "detected"
  | "signin"
  | "install"
  | "coming-soon";

interface HarnessRowProps {
  icon: Icon;
  name: string;
  variant: RowVariant;
  onAction?: () => void;
}

function HarnessRow({ icon: IconComponent, name, variant, onAction }: HarnessRowProps) {
  const statusLabel = (() => {
    switch (variant) {
      case "bundled":
        return "Installed";
      case "bundled-installing":
        return "Installing…";
      case "bundled-failed":
        return "Retry";
      case "detected":
        return "Detected";
      case "signin":
        return "Sign in";
      case "install":
        return "Install";
      case "coming-soon":
        return "Coming soon";
    }
  })();

  const isInteractive =
    variant === "install" || variant === "signin" || variant === "bundled-failed";

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2.5",
        variant === "bundled" && "border-primary/30 bg-primary/5",
        variant === "bundled-installing" && "border-primary/30 bg-primary/5",
        variant === "bundled-failed" && "border-amber-500/40 bg-amber-500/5",
        variant === "detected" && "border-green-500/30 bg-green-500/5",
        (variant === "install" || variant === "signin") && "border-border bg-card",
        variant === "coming-soon" && "border-border bg-muted/30 opacity-70",
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
        <IconComponent className="size-5" />
      </div>
      <div className="flex-1 text-sm font-semibold">{name}</div>
      {variant === "detected" && (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-semibold text-green-600 dark:text-green-400">
          <CheckCircle2 className="size-3" />
          {statusLabel}
        </span>
      )}
      {variant === "bundled" && (
        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
          {statusLabel}
        </span>
      )}
      {variant === "bundled-installing" && (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
          <Loader2 className="size-3 animate-spin" />
          {statusLabel}
        </span>
      )}
      {variant === "coming-soon" && (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
          {statusLabel}
        </span>
      )}
      {isInteractive && (
        <Button
          size="xs"
          variant="outline"
          onClick={onAction}
          className={cn(
            variant === "bundled-failed" &&
              "border-amber-500/50 text-amber-700 dark:text-amber-300",
          )}
        >
          {variant === "bundled-failed" ? (
            <>
              <AlertTriangle className="mr-1 size-3" />
              {statusLabel}
            </>
          ) : (
            statusLabel
          )}
        </Button>
      )}
    </div>
  );
}

function resolveVariant(
  definition: ProviderClientDefinition,
  installed: boolean,
  authStatus: string | undefined,
  unoStatus: "idle" | "installing" | "installed" | "failed",
): RowVariant {
  if (definition.value === "uno") {
    if (unoStatus === "installing") return "bundled-installing";
    if (unoStatus === "failed") return "bundled-failed";
    return "bundled";
  }
  if (installed && authStatus === "authenticated") return "detected";
  if (installed && authStatus !== "authenticated") return "signin";
  return "install";
}

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

  const rows = useMemo(() => {
    return PROVIDER_CLIENT_DEFINITIONS.map((definition) => {
      const provider = providers.find((p) => p.driver === definition.value);
      const installed = provider?.installed ?? false;
      const authStatus = provider?.auth.status;
      const variant = resolveVariant(definition, installed, authStatus, unoStatus);
      return { definition, variant };
    });
  }, [providers, unoStatus]);

  return (
    <div>
      <StepEyebrow>Bring your AI</StepEyebrow>
      <StepTitle>Use the AI subscriptions you already have.</StepTitle>
      <StepLead>
        Uno Work auto-detects accounts and harnesses already installed on your computer. If you have
        a third-party CLI installed and signed in — like Claude Code or Codex CLI — we plug into it
        automatically. No re-authentication, no manual setup.
      </StepLead>
      <div className="mt-6 grid max-w-2xl gap-2">
        {rows.map(({ definition, variant }) => (
          <HarnessRow
            key={definition.value}
            icon={definition.icon}
            name={definition.label}
            variant={variant}
            onAction={() => {
              if (definition.value === "uno" && variant === "bundled-failed") {
                if (!isRetryingUno) handleRetryUno();
                return;
              }
              const url = HARNESS_INSTALL_LINKS[definition.value];
              if (url) openInstallDocs(url);
            }}
          />
        ))}
        <HarnessRow icon={Gemini} name="Gemini CLI" variant="coming-soon" />
        <HarnessRow icon={GithubCopilotIcon} name="GitHub Copilot CLI" variant="coming-soon" />
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
