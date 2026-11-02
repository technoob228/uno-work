/** How a pull request looks in a row and a header: its icon, status colors and small marks. */
import type { PullRequestListEntry } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  CircleXIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";

type StateFields = Pick<PullRequestListEntry, "state" | "isDraft">;

export function PullRequestStateIcon(props: StateFields & { readonly className?: string }) {
  const { state, isDraft, className } = props;
  if (state === "merged") {
    return <GitMergeIcon className={cn("text-violet-600 dark:text-violet-400", className)} />;
  }
  if (state === "closed") {
    return <GitPullRequestClosedIcon className={cn("text-red-600 dark:text-red-400", className)} />;
  }
  if (isDraft) {
    return <GitPullRequestDraftIcon className={cn("text-muted-foreground", className)} />;
  }
  return <GitPullRequestIcon className={cn("text-emerald-600 dark:text-emerald-400", className)} />;
}

export function PullRequestChecksMark(props: {
  readonly state: PullRequestListEntry["checksState"];
}) {
  if (props.state === "passing") {
    return <CheckCircle2Icon aria-label="Checks passed" className="size-3.5 text-emerald-500" />;
  }
  if (props.state === "failing") {
    return <CircleXIcon aria-label="Checks failed" className="size-3.5 text-red-500" />;
  }
  if (props.state === "pending") {
    return <CircleDotIcon aria-label="Checks running" className="size-3.5 text-amber-500" />;
  }
  return null;
}

export const PULL_REQUEST_STATE_LABEL = (entry: StateFields): string =>
  entry.state === "merged"
    ? "Merged"
    : entry.state === "closed"
      ? "Closed"
      : entry.isDraft
        ? "Draft"
        : "Open";
