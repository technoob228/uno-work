/**
 * The agent asks before a step: the question sits on the step's own row at
 * the end of the feed — what it wants to do, and Allow / Deny right there —
 * instead of a "PENDING APPROVAL" plate on the composer (upstream 1f8530ec3c
 * #26255, adapted: our PendingApproval and decisions).
 */
import { type ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { EyeIcon, type LucideIcon, ShieldIcon, SquarePenIcon, TerminalIcon } from "lucide-react";
import { memo } from "react";

import { type PendingApproval } from "../../session-logic";
import { Button } from "../ui/button";
import { describeApprovalRequest } from "./approvalRequest.logic";

const APPROVAL_ICON: Record<PendingApproval["requestKind"], LucideIcon> = {
  command: TerminalIcon,
  "file-change": SquarePenIcon,
  "file-read": EyeIcon,
  other: ShieldIcon,
};

const DETAIL_CLASS =
  "mt-1.5 block max-h-40 overflow-auto rounded-md bg-background/70 px-2 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground wrap-anywhere select-text";

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
  pendingCount,
  isResponding,
  onRespondToApproval,
}: {
  approval: PendingApproval;
  pendingCount: number;
  isResponding: boolean;
  onRespondToApproval:
    | ((requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => Promise<void>)
    | undefined;
}) {
  const description = describeApprovalRequest(approval.requestKind, approval.detail);
  const Icon = APPROVAL_ICON[approval.requestKind];
  const respond = (decision: ProviderApprovalDecision) => {
    if (!isResponding) void onRespondToApproval?.(approval.requestId, decision);
  };
  return (
    <div
      role="group"
      aria-label={description.title}
      data-testid="timeline-pending-approval"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5"
    >
      <div className="flex items-center gap-2 text-xs">
        <Icon className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
        <span className="font-medium text-foreground">{description.title}</span>
        {pendingCount > 1 ? (
          <span className="text-muted-foreground">· 1 of {pendingCount}</span>
        ) : null}
      </div>
      {description.detail && description.foldDetail ? (
        <details className="mt-1 text-xs" data-testid="timeline-pending-approval-detail">
          <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">
            {approval.requestKind === "command" ? "Show the command" : "Show the path"}
          </summary>
          <code className={DETAIL_CLASS}>{description.detail}</code>
        </details>
      ) : description.detail ? (
        <code className={DETAIL_CLASS}>{description.detail}</code>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-amber-700 dark:text-amber-300">Waiting for your OK</span>
        <Button size="xs" disabled={isResponding} onClick={() => respond("accept")}>
          Allow
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={isResponding}
          onClick={() => respond("acceptForSession")}
        >
          Always allow in this chat
        </Button>
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={isResponding}
          onClick={() => respond("decline")}
        >
          Deny
        </Button>
        <Button size="xs" variant="ghost" disabled={isResponding} onClick={() => respond("cancel")}>
          Stop
        </Button>
      </div>
    </div>
  );
});
