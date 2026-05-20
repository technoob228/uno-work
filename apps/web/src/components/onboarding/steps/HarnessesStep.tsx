import { CheckCircle2 } from "lucide-react";
import { useMemo } from "react";

import { useServerProviders } from "~/rpc/serverState";
import { Gemini, GithubCopilotIcon, type Icon } from "../../Icons";
import { Button } from "../../ui/button";
import { cn } from "~/lib/utils";
import { HARNESS_INSTALL_LINKS, openInstallDocs } from "../harnessInstallLinks";
import {
  PROVIDER_CLIENT_DEFINITIONS,
  type ProviderClientDefinition,
} from "../../settings/providerDriverMeta";
import { StepEyebrow, StepLead, StepTitle } from "./stepShared";

type RowVariant = "bundled" | "detected" | "signin" | "install" | "coming-soon";

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

  const isInteractive = variant === "install" || variant === "signin";

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2.5",
        variant === "bundled" && "border-primary/30 bg-primary/5",
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
      {variant === "coming-soon" && (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
          {statusLabel}
        </span>
      )}
      {isInteractive && (
        <Button size="xs" variant="outline" onClick={onAction}>
          {statusLabel}
        </Button>
      )}
    </div>
  );
}

function resolveVariant(
  definition: ProviderClientDefinition,
  installed: boolean,
  authStatus: string | undefined,
): RowVariant {
  if (definition.value === "uno") return "bundled";
  if (installed && authStatus === "authenticated") return "detected";
  if (installed && authStatus !== "authenticated") return "signin";
  return "install";
}

export function HarnessesStep() {
  const providers = useServerProviders();

  const rows = useMemo(() => {
    return PROVIDER_CLIENT_DEFINITIONS.map((definition) => {
      const provider = providers.find((p) => p.driver === definition.value);
      const installed = provider?.installed ?? false;
      const authStatus = provider?.auth.status;
      const variant = resolveVariant(definition, installed, authStatus);
      return { definition, variant };
    });
  }, [providers]);

  return (
    <div>
      <StepEyebrow>Bring your AI</StepEyebrow>
      <StepTitle>Use the AI subscriptions you already have.</StepTitle>
      <StepLead>
        Uno Work auto-detects accounts and harnesses already installed on your computer. If you
        have a third-party CLI installed and signed in — like Claude Code or Codex CLI — we plug
        into it automatically. No re-authentication, no manual setup.
      </StepLead>
      <div className="mt-6 grid max-w-2xl gap-2">
        {rows.map(({ definition, variant }) => (
          <HarnessRow
            key={definition.value}
            icon={definition.icon}
            name={definition.label}
            variant={variant}
            onAction={() => {
              const url = HARNESS_INSTALL_LINKS[definition.value];
              if (url) openInstallDocs(url);
            }}
          />
        ))}
        <HarnessRow icon={Gemini} name="Gemini CLI" variant="coming-soon" />
        <HarnessRow icon={GithubCopilotIcon} name="GitHub Copilot CLI" variant="coming-soon" />
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Switch between harnesses any time from the chat header — no lock-in.
      </p>
    </div>
  );
}
