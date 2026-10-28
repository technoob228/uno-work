import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  /** An assistant's chat (variant A): plain words — what it wants to do, Allow or Decline. */
  assistant?: boolean;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  assistant = false,
}: ComposerPendingApprovalPanelProps) {
  if (assistant) {
    return (
      <div className="px-4 py-3.5 sm:px-5 sm:py-4" data-testid="assistant-allow-card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">
            ✋ Needs your Allow
          </span>
          {pendingCount > 1 ? (
            <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
          ) : null}
        </div>
        {approval.detail ? (
          <p className="mt-1.5 text-sm text-foreground" data-testid="assistant-allow-detail">
            {approval.detail}
          </p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing goes out until you say so. It waits here and in Needs you.
        </p>
      </div>
    );
  }
  const approvalSummary =
    approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "file-read"
        ? "File-read approval requested"
        : approval.requestKind === "file-change"
          ? "File-change approval requested"
          : "Approval requested";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
    </div>
  );
});
