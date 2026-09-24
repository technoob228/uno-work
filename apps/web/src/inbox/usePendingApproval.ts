/**
 * An approval answerable where it is shown (Home's Needs-you row, the bell):
 * keeps the chat's details subscribed while mounted (only the chat's own
 * events name the request) and sends the same `thread.approval.respond` the
 * chat's Approve / Decline buttons send. `approval` stays null until the
 * request is known, or when it is gone — callers then just offer Open.
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProviderApprovalDecision, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { newCommandId } from "../lib/utils";
import { derivePendingApprovals, type PendingApproval } from "../session-logic";
import { createThreadSelectorByRef } from "../storeSelectors";
import { useStore } from "../store";

export interface PendingApprovalState {
  readonly approval: PendingApproval | null;
  readonly responding: boolean;
  readonly respond: (decision: ProviderApprovalDecision) => Promise<void>;
}

export function usePendingApproval(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): PendingApprovalState {
  const ref = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  useEffect(
    () => retainThreadDetailSubscription(environmentId, threadId),
    [environmentId, threadId],
  );
  const detail = useStore(useMemo(() => createThreadSelectorByRef(ref), [ref]));
  const approval = useMemo(
    () => (detail ? (derivePendingApprovals(detail.activities)[0] ?? null) : null),
    [detail],
  );
  const [responding, setResponding] = useState(false);
  const respond = async (decision: ProviderApprovalDecision) => {
    if (!approval) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    setResponding(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.approval.respond",
        commandId: newCommandId(),
        threadId,
        requestId: approval.requestId,
        decision,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't send your answer",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResponding(false);
    }
  };
  return { approval, responding, respond };
}
