/**
 * The strip every environment-scoped page wears: whose settings these are,
 * whether that machine is reachable, and how fresh what you are reading is.
 *
 * The point is that the destination of a save is visible *before* the save —
 * the failure this whole area addresses was a page that looked identical no
 * matter which daemon it was about to write to.
 *
 * @module environments/scope/EnvironmentScopeBanner
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { LaptopIcon, RefreshCwIcon, ServerIcon } from "lucide-react";

import { useReconnectEnvironment } from "~/hooks/useReconnectEnvironment";
import { formatElapsedAgoLabel } from "~/timestampFormat";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import {
  environmentAvailabilityLabel,
  environmentMutationBlockMessage,
  environmentSyncSummary,
} from "./availability";
import type { EnvironmentScopeInfo } from "./scopes";

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-500 animate-pulse",
  offline: "bg-muted-foreground/50",
};

export function EnvironmentScopeBanner({
  scope,
  environmentId,
  className,
}: {
  /** `null` when the URL names an environment this device no longer has. */
  readonly scope: EnvironmentScopeInfo | null;
  readonly environmentId: EnvironmentId;
  readonly className?: string;
}) {
  const { reconnect, reconnectingId } = useReconnectEnvironment();

  if (!scope) {
    return (
      <div
        className={cn(
          "rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive",
          className,
        )}
      >
        This page is bound to an environment this device no longer has saved. Add it again from
        Settings → Connections; nothing here will be read from or written to another machine.
      </div>
    );
  }

  const { status } = scope.availability;
  const elapsedLabel = scope.lastSynchronizedAt
    ? formatElapsedAgoLabel(scope.lastSynchronizedAt)
    : null;
  const PlacementIcon = scope.placement === "local" ? LaptopIcon : ServerIcon;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card/40 px-4 py-2.5",
        className,
      )}
    >
      <PlacementIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="text-xs font-medium text-foreground">{scope.label}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {scope.placement === "local" ? "Local" : "Remote"}
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
        <span className="text-[11px] text-muted-foreground">
          {environmentAvailabilityLabel(status)}
        </span>
      </span>
      <span className="text-[11px] text-muted-foreground">
        {environmentSyncSummary({ status, elapsedLabel })}
      </span>
      {scope.availability.mutationBlock === "client-session" ? (
        <span className="text-[11px] text-amber-700 dark:text-amber-400">
          {environmentMutationBlockMessage("client-session")}
        </span>
      ) : null}
      {scope.availability.canReconnect ? (
        <Button
          size="xs"
          variant="outline"
          className="ms-auto"
          disabled={reconnectingId === environmentId}
          onClick={() => void reconnect(environmentId)}
        >
          <RefreshCwIcon
            className={cn("size-3.5", reconnectingId === environmentId && "animate-spin")}
          />
          Reconnect
        </Button>
      ) : null}
    </div>
  );
}
