import { useCallback, useEffect, useMemo, useState } from "react";
import type { EnvironmentId, ManagerActionProposal, ManagerProposalId } from "@t3tools/contracts";

import { listManagerProposals, resolveManagerProposal } from "../../lib/managerApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const REFRESH_INTERVAL_MS = 10_000;

function describeAction(proposal: ManagerActionProposal): {
  title: string;
  detail: string | null;
} {
  const action = proposal.action;
  switch (action.kind) {
    case "create-thread":
      return {
        title: `Create thread “${action.title}”`,
        detail: action.prompt,
      };
    case "send-turn":
      return {
        title: `Send a turn to thread ${action.threadId.slice(0, 8)}…`,
        detail: action.prompt,
      };
    case "interrupt-turn":
      return {
        title: `Interrupt the active turn of thread ${action.threadId.slice(0, 8)}…`,
        detail: null,
      };
    case "respond-to-request":
      return {
        title: `Answer approval request (${action.decision}) in thread ${action.threadId.slice(0, 8)}…`,
        detail: null,
      };
  }
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function minutesUntil(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
}

const STATUS_BADGE: Record<
  ManagerActionProposal["status"],
  "warning" | "success" | "error" | "outline"
> = {
  pending: "warning",
  approved: "success",
  denied: "error",
  expired: "outline",
};

export function ProposalCard({
  proposal,
  busy,
  onResolve,
}: {
  proposal: ManagerActionProposal;
  busy: boolean;
  onResolve: (proposalId: ManagerProposalId, decision: "approved" | "denied") => void;
}) {
  const { title, detail } = describeAction(proposal);
  const isPending = proposal.status === "pending";
  return (
    <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <Badge variant={STATUS_BADGE[proposal.status]} className="shrink-0">
          {proposal.status}
        </Badge>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70">
          {isPending
            ? `expires in ${minutesUntil(proposal.expiresAt)} min`
            : (proposal.resolvedBy ?? "")}
        </span>
      </div>
      {detail ? (
        <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground/60">
          filed {formatClock(proposal.requestedAt)}
        </span>
        {isPending ? (
          <div className="ml-auto flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onResolve(proposal.proposalId, "denied")}
            >
              Deny
            </Button>
            <Button
              size="xs"
              disabled={busy}
              onClick={() => onResolve(proposal.proposalId, "approved")}
            >
              Approve
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Polls the manager proposals of one environment and exposes approve/deny.
 * Shared by the /assistant panel and the Advanced section of the Telegram
 * page, so both show the same queue.
 */
export function useManagerProposals({
  environmentId,
  canMutate,
  onError,
}: {
  environmentId: EnvironmentId | null;
  canMutate: boolean;
  onError: (message: string) => void;
}) {
  const [proposals, setProposals] = useState<ReadonlyArray<ManagerActionProposal> | null>(null);
  const [busyProposalId, setBusyProposalId] = useState<ManagerProposalId | null>(null);

  const refresh = useCallback(async () => {
    if (environmentId === null) return;
    try {
      const result = await listManagerProposals({ environmentId });
      setProposals(result.proposals);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Failed to load assistant proposals.");
    }
  }, [environmentId, onError]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const resolve = useCallback(
    (proposalId: ManagerProposalId, decision: "approved" | "denied") => {
      if (environmentId === null || !canMutate) return;
      setBusyProposalId(proposalId);
      void resolveManagerProposal({ environmentId, proposalId, decision })
        .catch((cause: unknown) => {
          onError(cause instanceof Error ? cause.message : "Failed to resolve proposal.");
        })
        .finally(() => {
          setBusyProposalId(null);
          void refresh();
        });
    },
    [canMutate, environmentId, onError, refresh],
  );

  const pending = useMemo(
    () => (proposals ?? []).filter((proposal) => proposal.status === "pending"),
    [proposals],
  );
  const resolved = useMemo(
    () => (proposals ?? []).filter((proposal) => proposal.status !== "pending").slice(0, 12),
    [proposals],
  );

  return { proposals, pending, resolved, busyProposalId, resolve, refresh };
}

/** Pending + recent proposal cards, headed the way the /assistant panel does it. */
export function ProposalsList({
  proposals,
  pending,
  resolved,
  busyProposalId,
  onResolve,
  pendingTitle = "Pending approvals",
  emptyText,
}: {
  proposals: ReadonlyArray<ManagerActionProposal> | null;
  pending: ReadonlyArray<ManagerActionProposal>;
  resolved: ReadonlyArray<ManagerActionProposal>;
  busyProposalId: ManagerProposalId | null;
  onResolve: (proposalId: ManagerProposalId, decision: "approved" | "denied") => void;
  pendingTitle?: string;
  emptyText: string;
}) {
  return (
    <>
      <section className="space-y-2.5">
        <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
          {pendingTitle}
        </h2>
        {pending.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
            {proposals === null ? "Loading…" : emptyText}
          </div>
        ) : (
          pending.map((proposal) => (
            <ProposalCard
              key={proposal.proposalId}
              proposal={proposal}
              busy={busyProposalId === proposal.proposalId}
              onResolve={onResolve}
            />
          ))
        )}
      </section>

      {resolved.length > 0 ? (
        <section className="space-y-2.5">
          <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
            Recent
          </h2>
          {resolved.map((proposal) => (
            <ProposalCard
              key={proposal.proposalId}
              proposal={proposal}
              busy={false}
              onResolve={onResolve}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}
