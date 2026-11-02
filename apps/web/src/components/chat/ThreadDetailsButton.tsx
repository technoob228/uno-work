import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId, ThreadPullRequest } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useEnvironmentSettings } from "../../environments/settings/serverSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn, newCommandId } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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

function PullRequestRow(props: {
  readonly link: ThreadPullRequest;
  readonly projectId: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { link, projectId, environmentId, threadId } = props;
  const navigate = useNavigate();
  const notes = [pullRequestChecksLabel(link), pullRequestReviewLabel(link)].filter(Boolean);
  const branches = pullRequestBranches(link);
  const watching = link.watch !== undefined;
  const open = link.snapshot === null || link.snapshot.state === "open";
  const call = (run: () => Promise<void> | undefined) =>
    void Promise.resolve(run()).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Didn't go through",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  const api = () => readEnvironmentApi(environmentId)?.pullRequests;
  return (
    <div className="group flex items-start gap-1 rounded-md hover:bg-accent">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left"
        data-testid="thread-pull-request-row"
        onClick={() =>
          void navigate({
            to: "/pull-requests",
            search: {
              env: environmentId,
              project: projectId,
              repo: link.repository,
              n: link.number,
            },
          })
        }
      >
        <span className="flex items-center gap-1.5 text-xs">
          <GitPullRequestIcon
            className={cn("size-3.5 shrink-0", PULL_REQUEST_TONE_CLASS[pullRequestTone(link)])}
          />
          <span className="min-w-0 truncate font-medium">
            #{link.number}
            {link.snapshot ? ` ${link.snapshot.title}` : ""}
          </span>
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
      <span className="flex shrink-0 items-center gap-0.5 pt-1 pr-1">
        {open ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={watching ? "Stop waking the agent" : "Wake the agent on changes"}
            title={watching ? "Stop waking the agent" : "Wake the agent on changes"}
            aria-pressed={watching}
            data-testid="thread-pull-request-watch"
            onClick={() =>
              call(() =>
                api()?.setWatch({
                  threadId,
                  repository: link.repository,
                  number: link.number,
                  watching: !watching,
                }),
              )
            }
          >
            {watching ? <EyeIcon /> : <EyeOffIcon className="opacity-50" />}
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open on the site"
          title="Open on the site"
          onClick={() => openLink(link.url)}
        >
          <ExternalLinkIcon />
        </Button>
        {link.source === "created" ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Remove from this chat"
            title="Remove from this chat"
            onClick={() =>
              call(() =>
                api()?.unlink({ threadId, repository: link.repository, number: link.number }),
              )
            }
          >
            <XIcon />
          </Button>
        ) : null}
      </span>
    </div>
  );
}

/** Keeps another pull request with this chat, from its link or `owner/name#12`. */
function LinkPullRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const link = async () => {
    const api = readEnvironmentApi(environmentId)?.pullRequests;
    const value = reference.trim();
    if (!api || value.length === 0) return;
    setBusy(true);
    try {
      await api.link({ threadId, reference: value });
      setReference("");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Not added",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void link();
      }}
    >
      <Input
        size="sm"
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        placeholder="Add a pull request"
        aria-label="Add a pull request by link or number"
        data-testid="thread-pull-request-link"
      />
      <Button
        size="icon-xs"
        variant="ghost"
        type="submit"
        aria-label="Add"
        disabled={busy || reference.trim().length === 0}
      >
        <PlusIcon />
      </Button>
    </form>
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
            {pullRequests.length > 1 ? <span>+{pullRequests.length - 1}</span> : null}
            {pullRequests.some((link) => link.watch !== undefined) ? (
              <EyeIcon className="size-3" aria-label="Watched" />
            ) : null}
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
                <PullRequestRow
                  key={link.url}
                  link={link}
                  projectId={thread.projectId}
                  environmentId={environmentId}
                  threadId={threadId}
                />
              ))}
            </div>
          ) : null}
          <LinkPullRequest environmentId={environmentId} threadId={threadId} />
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
