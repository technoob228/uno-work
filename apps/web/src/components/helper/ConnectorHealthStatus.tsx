import type { ManagerConnectorHealth } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { CONNECTOR_HEALTH_CHIP } from "./telegramPageLogic";

const formatClock = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

/**
 * Persisted connector health (see `ManagerConnectorHealth`): a chip for the
 * state, when the link was last known good, and the last error while the
 * state is not `connected`. `fallbackError` is the poller's in-memory error
 * for problems that are not provider health (invalid config, storage).
 */
export function ConnectorHealthStatus({
  health,
  fallbackError,
}: {
  health: ManagerConnectorHealth | null;
  fallbackError: string | null;
}) {
  if (health === null) {
    return fallbackError ? (
      <span className="text-destructive-foreground">{fallbackError}</span>
    ) : (
      <span>Not polled yet.</span>
    );
  }
  const chip = CONNECTOR_HEALTH_CHIP[health.status];
  const showError = health.status !== "connected" && health.lastError !== null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Badge variant={chip.variant} size="sm">
        {chip.label}
      </Badge>
      {health.lastOkAt !== null ? <span>last ok {formatClock(health.lastOkAt)}</span> : null}
      {showError ? (
        <span className="text-destructive-foreground">
          {health.lastError}
          {health.lastErrorAt !== null ? ` (${formatClock(health.lastErrorAt)})` : ""}
        </span>
      ) : null}
      {!showError && fallbackError !== null ? (
        <span className="text-destructive-foreground">{fallbackError}</span>
      ) : null}
    </span>
  );
}
