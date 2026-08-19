import { FolderTree, HardDrive, RefreshCw, TerminalSquare } from "lucide-react";

import { useServerConfig } from "~/rpc/serverState";
import { FeatureBullet, StepEyebrow, StepLead, StepTitle, TwoColumn } from "../stepShared";

export function WebMachineStep() {
  const serverConfig = useServerConfig();
  const platform = serverConfig?.environment.platform;
  const label = serverConfig?.environment.label ?? "your machine";
  const workingDirectory = serverConfig?.cwd ?? null;
  const platformLabel = platform ? `${platform.os}/${platform.arch}` : "connecting…";

  return (
    <TwoColumn>
      <div>
        <StepEyebrow>Your machine</StepEyebrow>
        <StepTitle>Everything runs over there, not here</StepTitle>
        <StepLead>
          The browser is just the screen. Files, terminals, git and the agent all live on the
          machine below — so closing this tab does not stop the work, and reopening it picks up
          where you left off.
        </StepLead>

        <ul className="mt-8 flex flex-col gap-4">
          <FeatureBullet icon={<TerminalSquare className="size-3.5" />}>
            A real shell. Install packages, run servers, use whatever language you like.
          </FeatureBullet>
          <FeatureBullet icon={<FolderTree className="size-3.5" />}>
            A real filesystem. Your projects stay on disk between sessions.
          </FeatureBullet>
          <FeatureBullet icon={<RefreshCw className="size-3.5" />}>
            Long tasks keep running while the tab is closed.
          </FeatureBullet>
          <FeatureBullet icon={<HardDrive className="size-3.5" />}>
            Bring your own machine instead — the same app connects to any host you run it on.
          </FeatureBullet>
        </ul>
      </div>

      <div className="rounded-2xl border border-border bg-muted/30 p-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Connected to
        </div>
        <div className="mt-2 truncate text-lg font-semibold">{label}</div>
        <dl className="mt-6 flex flex-col gap-3 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">Platform</dt>
            <dd className="font-mono text-xs">{platformLabel}</dd>
          </div>
          {workingDirectory ? (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Home</dt>
              <dd className="truncate font-mono text-xs" title={workingDirectory}>
                {workingDirectory}
              </dd>
            </div>
          ) : null}
          {serverConfig?.environment.serverVersion ? (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-mono text-xs">{serverConfig.environment.serverVersion}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </TwoColumn>
  );
}
