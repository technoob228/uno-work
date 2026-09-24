/**
 * toolApprovalStore - Pending "Allow this?" requests from the uno-work MCP
 * server (an agent wants to show an app on the internet, publish a site…).
 *
 * Filled by BrowserBridgeListener from `toolApprovalRequest` bridge events and
 * drained on Allow/Deny or on a `toolApprovalSettled` event (which also covers
 * another window answering first, or the request timing out).
 */

import { useSyncExternalStore } from "react";
import type { BridgeToolApprovalRequestEvent, EnvironmentId } from "@t3tools/contracts";

export interface ActiveToolApproval {
  readonly event: BridgeToolApprovalRequestEvent;
  readonly environmentId: EnvironmentId;
}

let approvals: readonly ActiveToolApproval[] = [];
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

export const addToolApproval = (entry: ActiveToolApproval): void => {
  if (approvals.some((approval) => approval.event.requestId === entry.event.requestId)) {
    return;
  }
  approvals = [...approvals, entry];
  emit();
};

export const removeToolApproval = (requestId: string): void => {
  const next = approvals.filter((approval) => approval.event.requestId !== requestId);
  if (next.length === approvals.length) {
    return;
  }
  approvals = next;
  emit();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const readSnapshot = (): readonly ActiveToolApproval[] => approvals;

export const useToolApprovals = (): readonly ActiveToolApproval[] =>
  useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
