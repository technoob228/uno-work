/** One pull request inside Work: what it is, its changes, commits and comments. */
import type { PullRequestComment, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { useState } from "react";

import ChatMarkdown, { RemoteImagesOffContext } from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { PullRequestActions } from "./PullRequestActions";
import { PullRequestFilesTab } from "./PullRequestFilesTab";
import { pullRequestBlocker } from "./pullRequestList.logic";
import { PULL_REQUEST_STATE_LABEL, PullRequestStateIcon } from "./pullRequestPresentation";
import { pullRequestDetailQuery, usePullRequestComment } from "./pullRequestQueries";

type TabId = "summary" | "files" | "commits" | "comments";

function CheckRow(props: { readonly check: PullRequestDetailView["checks"][number] }) {
  const { check } = props;
  const failed =
    check.status === "failure" ||
    check.status === "cancelled" ||
    check.status === "action-required";
  const body = (
    <>
      {failed ? (
        <CircleXIcon className="size-3.5 shrink-0 text-red-500" />
      ) : check.status === "pending" ? (
        <CircleDotIcon className="size-3.5 shrink-0 text-amber-500" />
      ) : (
        <CircleCheckIcon className="size-3.5 shrink-0 text-emerald-500" />
      )}
      <span className="truncate">{check.name}</span>
    </>
  );
  return check.url ? (
    <a
      href={check.url}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-1.5 text-xs hover:underline"
    >
      {body}
    </a>
  ) : (
    <div className="flex items-center gap-1.5 text-xs">{body}</div>
  );
}

function CommentRow(props: { readonly comment: PullRequestComment; readonly cwdLabel: string }) {
  const { comment } = props;
  return (
    <article className="border-b border-border py-2" data-testid="pull-request-comment">
      <p className="pb-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{comment.author?.login ?? "Someone"}</span>
        {comment.reviewState ? ` ${comment.reviewState}` : ""}
        {comment.path ? ` on ${comment.path}` : ""}
      </p>
      {comment.body.trim().length > 0 ? (
        <div className="text-sm">
          <ChatMarkdown text={comment.body} cwd={undefined} />
        </div>
      ) : null}
    </article>
  );
}

function CommentsTab(props: {
  readonly environmentId: string;
  readonly detail: PullRequestDetailView;
  readonly reference: PullRequestRef;
}) {
  const { environmentId, detail, reference } = props;
  const [draft, setDraft] = useState("");
  const send = usePullRequestComment(environmentId, reference);
  return (
    <div className="flex flex-col gap-1 overflow-y-auto">
      {detail.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : null}
      {detail.comments.map((comment) => (
        <CommentRow key={comment.id} comment={comment} cwdLabel={detail.repository} />
      ))}
      {detail.capabilities.comment ? (
        <form
          className="flex flex-col items-end gap-2 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim().length === 0) return;
            send.mutate(draft, { onSuccess: () => setDraft("") });
          }}
        >
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Comment"
            aria-label="Comment"
            data-testid="pull-request-comment-input"
          />
          <Button
            size="sm"
            type="submit"
            disabled={send.isPending || draft.trim().length === 0}
            data-testid="pull-request-comment-send"
          >
            Send
          </Button>
        </form>
      ) : null}
    </div>
  );
}

export function PullRequestDetail(props: {
  readonly environmentId: string;
  readonly reference: PullRequestRef;
  readonly tab: string;
}) {
  const { environmentId, reference, tab } = props;
  const navigate = useNavigate();
  const query = useQuery(pullRequestDetailQuery(environmentId, reference));
  const [commit, setCommit] = useState<string | null>(null);
  const setTab = (next: TabId) =>
    void navigate({
      to: "/pull-requests",
      search: {
        env: environmentId,
        project: reference.projectId,
        repo: reference.repository,
        n: reference.number,
        tab: next,
      },
    });
  const back = () => void navigate({ to: "/pull-requests", search: {} });
  const detail = query.data;

  if (query.error) {
    return (
      <div className="flex flex-col items-start gap-2 p-5 text-sm text-muted-foreground">
        {query.error.message}
        <Button size="sm" variant="outline" onClick={back}>
          Back
        </Button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex flex-col gap-2 p-5">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const blocker = pullRequestBlocker(detail);
  const tabs: ReadonlyArray<{ readonly id: TabId; readonly label: string }> = [
    { id: "summary", label: "Summary" },
    ...(detail.capabilities.diff
      ? [{ id: "files" as const, label: `Files ${detail.changedFiles}` }]
      : []),
    { id: "commits", label: `Commits ${detail.commits.length}` },
    { id: "comments", label: `Comments ${detail.comments.length}` },
  ];
  const active: TabId = tabs.some((item) => item.id === tab) ? (tab as TabId) : "summary";

  return (
    <RemoteImagesOffContext.Provider value={true}>
      <div className="flex min-h-0 flex-1 flex-col" data-testid="pull-request-detail">
        <div className="flex items-start gap-2 px-3 pt-3 sm:px-5">
          <Button size="icon-xs" variant="ghost" aria-label="Back to the list" onClick={back}>
            <ArrowLeftIcon />
          </Button>
          <PullRequestStateIcon
            state={detail.state}
            isDraft={detail.isDraft}
            className="mt-1 size-4 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">
              {detail.title} <span className="text-muted-foreground">#{detail.number}</span>
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              <span data-testid="pull-request-state">{PULL_REQUEST_STATE_LABEL(detail)}</span> ·{" "}
              <span className="font-mono">
                {detail.headBranch} → {detail.baseBranch}
              </span>
              {blocker !== null ? ` · ${blocker}` : ""}
              {detail.autoMergeEnabled ? " · Auto-merge on" : ""}
            </p>
          </div>
          <PullRequestActions environmentId={environmentId} detail={detail} />
          <a
            href={detail.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open on the site"
            className="mt-1 text-muted-foreground hover:text-foreground"
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </div>
        <div className="flex gap-0.5 border-b border-border px-3 py-1.5 sm:px-5" role="tablist">
          {tabs.map((item) => (
            <Button
              key={item.id}
              size="xs"
              role="tab"
              aria-selected={item.id === active}
              variant={item.id === active ? "secondary" : "ghost"}
              onClick={() => setTab(item.id)}
              data-testid={`pull-request-tab-${item.id}`}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3 sm:px-5">
          {active === "summary" ? (
            <div className="flex flex-col gap-4">
              {detail.body.trim().length > 0 ? (
                <div className="text-sm">
                  <ChatMarkdown text={detail.body} cwd={undefined} />
                </div>
              ) : null}
              {detail.checks.length > 0 ? (
                <div className="flex flex-col gap-1" data-testid="pull-request-checks">
                  {detail.checks.map((check) => (
                    <CheckRow key={check.name} check={check} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {active === "files" ? (
            <PullRequestFilesTab
              environmentId={environmentId}
              detail={detail}
              commit={commit}
              onClearCommit={() => setCommit(null)}
            />
          ) : null}
          {active === "commits" ? (
            <div className="flex flex-col">
              {detail.commits.map((item) => {
                const line = (
                  <>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {item.oid.slice(0, 7)}
                    </span>
                    <span className="truncate">{item.messageHeadline}</span>
                  </>
                );
                const rowClass =
                  "flex items-baseline gap-2 rounded-sm px-1 py-1 text-left text-sm hover:bg-accent";
                // Without changes read here, a commit opens on the host's site.
                if (!detail.capabilities.diff) {
                  return item.url ? (
                    <a
                      key={item.oid}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className={rowClass}
                      data-testid="pull-request-commit"
                    >
                      {line}
                    </a>
                  ) : (
                    <div
                      key={item.oid}
                      className="flex items-baseline gap-2 px-1 py-1 text-sm"
                      data-testid="pull-request-commit"
                    >
                      {line}
                    </div>
                  );
                }
                return (
                  <button
                    type="button"
                    key={item.oid}
                    className={rowClass}
                    onClick={() => {
                      setCommit(item.oid);
                      setTab("files");
                    }}
                    data-testid="pull-request-commit"
                  >
                    {line}
                  </button>
                );
              })}
            </div>
          ) : null}
          {active === "comments" ? (
            <CommentsTab environmentId={environmentId} detail={detail} reference={reference} />
          ) : null}
        </div>
      </div>
    </RemoteImagesOffContext.Provider>
  );
}
