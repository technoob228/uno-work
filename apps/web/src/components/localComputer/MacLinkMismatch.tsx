/**
 * T70: the helper on this Mac is linked to another Uno account than the one
 * Uno Work here is signed in to, so the cloud never sees this Mac. Say it, and
 * offer the existing connect flow; nothing is rebound by itself.
 */
import { AlertTriangleIcon } from "lucide-react";

import { useComputersLifecycleDesktop } from "../../computersLifecycle/desktop";
import { useOwnComputers } from "../../computersLifecycle/useComputers";
import { localComputer } from "../../localComputer/localComputerStore";
import { useThisMacHelper } from "../computersLifecycle/WhereAgentsRun";
import { Button } from "../ui/button";
import { MAC_LINK_MISMATCH_LINE, macLinkedElsewhere } from "./connectComputer.logic";

export function MacLinkMismatch() {
  const desktop = useComputersLifecycleDesktop();
  const helper = useThisMacHelper();
  const { computers, settled, enabled } = useOwnComputers();
  if (!macLinkedElsewhere({ desktop, helper, settled, enabled, computers })) return null;
  return (
    <div
      className="flex items-center gap-3 border-b border-border bg-warning/8 px-4 py-3 sm:px-5"
      role="alert"
      data-testid="mac-link-mismatch"
    >
      <AlertTriangleIcon className="size-4 shrink-0 text-warning-foreground" aria-hidden />
      <span className="min-w-0 flex-1 text-sm">{MAC_LINK_MISMATCH_LINE}</span>
      <Button size="sm" onClick={localComputer.openConnect} data-testid="mac-link-reconnect">
        Reconnect to my account
      </Button>
    </div>
  );
}
