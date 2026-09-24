/**
 * ComposerToolApprovalPanel - "Allow this?" for an action of the uno-work MCP
 * server (show an app on the internet, publish a site, create a share link…).
 *
 * Renders above the composer of the chat that asked, like the secret panel.
 * The answer is POSTed to the environment's `/api/uno-work/approval/result`
 * with the request's one-time response token; the agent waits for it.
 */

import { memo, useState } from "react";
import { ShieldQuestionIcon } from "lucide-react";

import { environmentFetchJson, isEnvironmentHttpError } from "../../environments/http/target";
import {
  type ActiveToolApproval,
  removeToolApproval,
  useToolApprovals,
} from "../../toolApprovalStore";
import { Button } from "../ui/button";

const APPROVAL_RESULT_PATH = "/api/uno-work/approval/result";

export const ComposerToolApprovalPanel = memo(function ComposerToolApprovalPanel({
  threadId,
}: {
  threadId: string | undefined;
}) {
  const approvals = useToolApprovals();
  const matching = approvals.filter((approval) => {
    const approvalThreadId = approval.event.context?.threadId;
    return approvalThreadId === undefined || approvalThreadId === threadId;
  });
  const active = matching[0];
  if (!active) return null;
  return (
    <ToolApprovalCard
      key={active.event.requestId}
      approval={active}
      pendingCount={matching.length}
    />
  );
});

const ToolApprovalCard = memo(function ToolApprovalCard({
  approval,
  pendingCount,
}: {
  approval: ActiveToolApproval;
  pendingCount: number;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { event } = approval;

  const answer = async (approved: boolean) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await environmentFetchJson<{ ok: boolean }>({
        environmentId: approval.environmentId,
        pathname: APPROVAL_RESULT_PATH,
        method: "POST",
        body: { requestId: event.requestId, responseToken: event.responseToken, approved },
      });
      removeToolApproval(event.requestId);
    } catch (cause) {
      if (isEnvironmentHttpError(cause) && cause.status === 404) {
        // Already answered elsewhere or timed out — nothing waits on it.
        removeToolApproval(event.requestId);
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      setIsSubmitting(false);
    }
  };

  return (
    <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20 px-4 py-3 sm:px-5">
      <div className="flex items-center gap-2">
        <ShieldQuestionIcon className="size-3.5 text-muted-foreground/60" />
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
          {event.sensitive ? "Allow this?" : "Allow this change?"}
        </span>
        {pendingCount > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
            1/{pendingCount}
          </span>
        ) : null}
      </div>
      <p className="mt-1.5 text-sm text-foreground/90">{event.title}</p>
      {event.detail ? (
        <p className="mt-1 text-xs text-muted-foreground/65">{event.detail}</p>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isSubmitting}
          onClick={() => void answer(false)}
        >
          Don't allow
        </Button>
        <Button type="button" size="sm" disabled={isSubmitting} onClick={() => void answer(true)}>
          Allow
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </div>
  );
});
