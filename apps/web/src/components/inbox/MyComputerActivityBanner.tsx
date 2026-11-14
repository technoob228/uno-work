/**
 * The Inbox's top line while agents work on the person's own computer:
 * something runs there now, or ran in the last 10 minutes. Stop is the same
 * "Stop all agents" as in Settings → My computer, confirmed first. Asks the
 * daemon only while the Inbox is open and a computer is connected.
 */
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  TRUST_POLL_MS,
  useMyComputers,
  useMyComputerTrust,
} from "../../localComputer/useMyComputers";
import { agentsActive, computersLabel } from "../localComputer/myComputerTrust.logic";
import { StopAllAgentsDialog } from "../localComputer/StopAllAgents";
import { Button } from "../ui/button";

export function MyComputerActivityBanner() {
  const environmentId = usePrimaryEnvironmentId();
  const { computers } = useMyComputers(environmentId);
  const trust = useMyComputerTrust(environmentId, {
    pollMs: TRUST_POLL_MS,
    enabled: computers.length > 0,
  });
  const [stopOpen, setStopOpen] = useState(false);
  const state = trust.data;
  if (computers.length === 0 || state === undefined) return null;
  if (!agentsActive(state, trust.dataUpdatedAt) && !stopOpen) return null;
  const label = computersLabel(computers);
  return (
    <div
      role="status"
      className="mx-1 mb-1.5 flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/8 py-1 pr-1 pl-2 text-xs"
      data-testid="inbox-my-computer-banner"
    >
      <span className="relative flex size-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning/60" />
        <span className="relative inline-flex size-2 rounded-full bg-warning" />
      </span>
      <Link
        to="/settings/my-computer"
        title="Agent permissions and journal"
        className="min-w-0 flex-1 truncate text-foreground underline-offset-2 hover:underline"
      >
        Agents are working on {label}
      </Link>
      <Button
        size="xs"
        variant="destructive-outline"
        onClick={() => setStopOpen(true)}
        data-testid="inbox-my-computer-stop"
      >
        Stop
      </Button>
      <StopAllAgentsDialog open={stopOpen} onOpenChange={setStopOpen} />
    </div>
  );
}
