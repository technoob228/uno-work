import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId, ThreadPullRequest } from "@t3tools/contracts";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useEnvironmentSettings } from "../../environments/settings/serverSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn, newCommandId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  PULL_REQUEST_TONE_CLASS,
  primaryPullRequest,
  pullRequestBranches,
  pullRequestChecksLabel,
  pullRequestReviewLabel,
  pullRequestStateLabel,
  pullRequestTone,
} from "./ThreadDetails.logic";

const TRIGGER_CLASS =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-input px-1.5 text-xs text-muted-foreground shadow-xs/5 hover:bg-accent hover:text-foreground sm:h-6";

function openLink(url: string) {
  const api = readLocalApi();
  if (api) {
    void api.shell.openExternal(url).catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function DetailRow(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{props.label}</span>
      <span className="min-w-0 truncate text-right">{props.children}</span>
    </div>
  );
}

function PullRequestRow(props: { readonly link: ThreadPullRequest }) {
  const { link } = props;
  const notes = [pullRequestChecksLabel(link), pullRequestReviewLabel(link)].filter(Boolean);
  const branches = pullRequestBranches(link);
  return (
    <button
      type="button"
      className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      onClick={() => openLink(link.url)}
    >
      <span className="flex items-center gap-1.5 text-xs">
        <GitPullRequestIcon
          className={cn("size-3.5 shrink-0", PULL_REQUEST_TONE_CLASS[pullRequestTone(link)])}
        />
        <span className="min-w-0 truncate font-medium">
          #{link.number}
          {link.snapshot ? ` ${link.snapshot.title}` : ""}
        </span>
        <ExternalLinkIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />
      </span>
      <span className="truncate pl-5 text-[11px] text-muted-foreground">
        <span className={PULL_REQUEST_TONE_CLASS[pullRequestTone(link)]}>
          {pullRequestStateLabel(link)}
        </span>
        {notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}
      </span>
      {branches ? (
        <span className="truncate pl-5 font-mono text-[11px] text-muted-foreground">
          {branches}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Dev mode's chat details: the chat's branch, its copy (worktree) and pull
 * requests. Nothing to say — nothing in the header.
 */
export function ThreadDetailsButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const ref = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  const thread = useStore((state) => selectSidebarThreadSummaryByRef(state, ref));
  const settings = useEnvironmentSettings(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>();
  const [saving, setSaving] = useState(false);

  if (!thread) return null;
  const { branch, worktreePath } = thread;
  const pullRequests = thread.pullRequests ?? [];
  const primary = primaryPullRequest(pullRequests);
  if (!branch && !worktreePath && primary === null) return null;

  const setAutoSettle = async (enabled: boolean) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    setSaving(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.auto-settle.set",
        commandId: newCommandId(),
        threadId,
        disabled: !enabled,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't change it",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger
        className={TRIGGER_CLASS}
        aria-label={primary ? `Pull request #${primary.number}` : "Branch and copy"}
      >
        {primary ? (
          <>
            <GitPullRequestIcon
              className={cn("size-3", PULL_REQUEST_TONE_CLASS[pullRequestTone(primary)])}
            />
            <span>#{primary.number}</span>
          </>
        ) : (
          <GitBranchIcon className="size-3" />
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80">
        <div className="flex flex-col gap-2">
          {branch ? (
            <DetailRow label="Branch">
              <span className="font-mono">{branch}</span>
            </DetailRow>
          ) : null}
          {worktreePath ? (
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="shrink-0 text-muted-foreground">Copy</span>
              <button
                type="button"
                title={worktreePath}
                className="inline-flex min-w-0 items-center gap-1 rounded-sm font-mono hover:text-foreground"
                onClick={() => copyToClipboard(worktreePath)}
              >
                <span className="truncate">{formatWorktreePathForDisplay(worktreePath)}</span>
                {isCopied ? (
                  <CheckIcon className="size-3 shrink-0" />
                ) : (
                  <CopyIcon className="size-3 shrink-0 text-muted-foreground" />
                )}
              </button>
            </div>
          ) : null}
          {pullRequests.length > 0 ? (
            <div className="-mx-2 flex flex-col">
              {pullRequests.map((link) => (
                <PullRequestRow key={link.url} link={link} />
              ))}
            </div>
          ) : null}
          {primary !== null && settings?.sidebarAutoSettleOnMerge ? (
            <label className="flex items-center justify-between gap-3 text-xs">
              <span>Move to Done after merge</span>
              <Switch
                checked={thread.autoSettleDisabledAt == null}
                disabled={saving}
                onCheckedChange={(checked) => void setAutoSettle(checked)}
                aria-label="Move to Done after merge"
              />
            </label>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
