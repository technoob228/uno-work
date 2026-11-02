/**
 * The lines of the work log around a permission card, in a person's words.
 * Chats keep what the daemon wrote at the time, so the client reads the old
 * wording through {@link approvalActivityLine} too.
 */
export function approvalRequestedSummary(requestKind: string | undefined): string {
  if (requestKind === "command") return "Asked to run a command";
  if (requestKind === "file-read") return "Asked to read a file";
  if (requestKind === "file-change") return "Asked to change a file";
  return "Asked for permission";
}

export function approvalResolvedSummary(decision: string | undefined): string {
  if (decision === "accept" || decision === "acceptForSession") return "Allowed";
  if (decision === "decline") return "Denied";
  if (decision === "expired") return "No answer in time";
  if (decision === "cancel") return "Stopped";
  return "Answered";
}

const OLD_REQUESTED: Readonly<Record<string, string | undefined>> = {
  "Command approval requested": "command",
  "File-read approval requested": "file-read",
  "File-change approval requested": "file-change",
  "Approval requested": undefined,
};

export function approvalActivityLine(activity: {
  readonly kind: string;
  readonly summary: string;
  readonly decision?: string | undefined;
}): string {
  if (activity.kind === "approval.resolved" && activity.summary === "Approval resolved") {
    return approvalResolvedSummary(activity.decision);
  }
  if (activity.kind === "approval.requested" && activity.summary in OLD_REQUESTED) {
    return approvalRequestedSummary(OLD_REQUESTED[activity.summary]);
  }
  return activity.summary;
}
