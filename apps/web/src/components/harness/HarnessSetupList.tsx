/**
 * The list of harnesses with a status badge and, when there is something to
 * do, an Install or Sign in button. Shared by the web and desktop onboarding
 * steps so both shells behave identically.
 *
 * @module components/harness/HarnessSetupList
 */
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { EnvironmentId, ProviderAuthDriver, ProviderDriverKind } from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { getDriverOption } from "../settings/providerDriverMeta";
import { HarnessSignInDialog } from "./HarnessSignInDialog";
import { SetupLogDetails } from "./SetupLogDetails";
import {
  COMING_SOON_HARNESSES,
  HARNESS_ROW_DRIVERS,
  HARNESS_STATUS_LABEL,
  isAuthableDriver,
  isJobActive,
  progressLine,
  resolveHarnessAction,
  resolveHarnessStatus,
  type HarnessStatus,
} from "./harnessSetupState";
import { useHarnessSetup } from "./useHarnessSetup";

function StatusBadge({ status }: { status: HarnessStatus }) {
  const label = HARNESS_STATUS_LABEL[status];
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
        <CheckCircle2 className="size-3" />
        {label}
      </span>
    );
  }
  if (status === "checking") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
      <TriangleAlert className="size-3" />
      {label}
    </span>
  );
}

function HarnessRowShell({
  icon,
  title,
  subtitle,
  right,
  footer,
  muted = false,
  tone = "neutral",
}: {
  icon: ReactNode;
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  muted?: boolean;
  tone?: "neutral" | "ready" | "warning";
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border px-3 py-2.5",
        tone === "ready" && "border-primary/30 bg-primary/5",
        tone === "warning" && "border-amber-500/40 bg-amber-500/5",
        tone === "neutral" && "border-border bg-card",
        muted && "bg-muted/30 opacity-70",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {subtitle ? (
            <div className="truncate font-mono text-[11px] text-muted-foreground">{subtitle}</div>
          ) : null}
        </div>
        {right}
      </div>
      {footer}
    </div>
  );
}

export interface HarnessSetupListProps {
  readonly providers: ReadonlyArray<ServerProvider>;
  /**
   * The machine to install on. Omit on the onboarding screens, which always
   * target the machine serving the UI.
   */
  readonly environmentId?: EnvironmentId | null;
  /** Extra content rendered inside a row (docs links on desktop). */
  readonly renderRowExtra?: (driver: ProviderDriverKind) => ReactNode;
  /**
   * Disabled "coming soon" rows appended to the list. Defaults to the shared
   * roadmap list; shells that already advertise more can pass their own.
   */
  readonly comingSoon?: ReadonlyArray<{ readonly label: string; readonly icon?: ReactNode }>;
}

export function HarnessSetupList({
  providers,
  environmentId,
  renderRowExtra,
  comingSoon,
}: HarnessSetupListProps) {
  const comingSoonRows: ReadonlyArray<{ readonly label: string; readonly icon?: ReactNode }> =
    comingSoon ?? COMING_SOON_HARNESSES.map((label) => ({ label }));
  const setup = useHarnessSetup(environmentId ?? null);
  const [signInDriver, setSignInDriver] = useState<ProviderAuthDriver | null>(null);
  const providersLoaded = providers.length > 0;

  return (
    <div className="grid gap-2">
      {HARNESS_ROW_DRIVERS.map((driver) => {
        const option = getDriverOption(driver);
        const provider = providers.find((candidate) => candidate.driver === driver);
        const installJob = setup.installJobs[driver];
        const status = resolveHarnessStatus({ provider, providersLoaded });
        const action = resolveHarnessAction({ driver, status });
        const Icon = option?.icon;
        const installing = isJobActive(installJob);
        const installFailed = installJob?.state === "failed";
        const hint = installing ? progressLine(installJob?.log ?? "") : undefined;

        return (
          <HarnessRowShell
            key={driver}
            tone={status === "ready" ? "ready" : installFailed ? "warning" : "neutral"}
            icon={Icon ? <Icon className="size-5" /> : null}
            title={option?.label ?? String(driver)}
            subtitle={provider?.version ?? undefined}
            right={
              <div className="flex shrink-0 items-center gap-2">
                {installing ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    Installing…
                  </span>
                ) : (
                  <StatusBadge status={status} />
                )}
                {!installing && action === "install" ? (
                  <button
                    type="button"
                    onClick={() => void setup.startInstall(driver)}
                    className="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-semibold hover:bg-muted"
                  >
                    {installFailed ? "Retry" : "Install"}
                  </button>
                ) : null}
                {!installing && action === "signIn" && isAuthableDriver(driver) ? (
                  <button
                    type="button"
                    onClick={() => setSignInDriver(driver)}
                    className="rounded-md border border-border bg-background px-2 py-1 text-[11px] font-semibold hover:bg-muted"
                  >
                    Sign in
                  </button>
                ) : null}
              </div>
            }
            footer={
              <>
                {hint ? (
                  <div className="truncate pl-11 font-mono text-[11px] text-muted-foreground">
                    {hint}
                  </div>
                ) : null}
                {installFailed ? (
                  <div className="flex flex-col gap-1.5 pl-11">
                    <span className="text-[11px] text-amber-700 dark:text-amber-300">
                      {installJob?.error ?? "The install failed."}
                    </span>
                    <SetupLogDetails log={installJob?.log ?? ""} />
                  </div>
                ) : null}
                {renderRowExtra ? <div className="pl-11">{renderRowExtra(driver)}</div> : null}
              </>
            }
          />
        );
      })}

      {comingSoonRows.map((harness) => (
        <HarnessRowShell
          key={harness.label}
          muted
          icon={
            harness.icon ?? (
              <span className="text-[11px] font-semibold text-muted-foreground">
                {harness.label.slice(0, 2)}
              </span>
            )
          }
          title={harness.label}
          right={
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
              Coming soon
            </span>
          }
        />
      ))}

      {signInDriver ? (
        <HarnessSignInDialog
          open
          onOpenChange={(open) => {
            if (!open) setSignInDriver(null);
          }}
          driver={signInDriver}
          label={getDriverOption(signInDriver as ProviderDriverKind)?.label ?? signInDriver}
          job={setup.authJobs[signInDriver]}
          onStart={({ method, apiKey }) =>
            void setup.startAuth({
              driver: signInDriver,
              method,
              ...(apiKey ? { apiKey } : {}),
            })
          }
          onSubmitCode={(code) => void setup.submitAuthCode({ driver: signInDriver, code })}
          onReset={() => setup.clearAuth(signInDriver)}
        />
      ) : null}
    </div>
  );
}
