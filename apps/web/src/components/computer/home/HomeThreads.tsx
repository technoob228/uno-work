/**
 * Home's chat blocks: the "N things need you" pill, the "Continue" cards and
 * the chat widgets (Needs you, Recent chats). All read the same thread
 * summaries the sidebar shows, with the sidebar's status colors.
 *
 * Approvals get Allow / Don't right in the Needs-you widget (the row subscribes
 * to the chat's details to learn the request); questions open the chat.
 */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import type { ProviderApprovalDecision } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  PlusIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn, newCommandId } from "~/lib/utils";
import { readEnvironmentApi } from "../../../environmentApi";
import { retainThreadDetailSubscription } from "../../../environments/runtime/service";
import { derivePendingApprovals } from "../../../session-logic";
import { createThreadSelectorByRef } from "../../../storeSelectors";
import { useMinuteClock } from "../../../hooks/useMinuteClock";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../../store";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { useUiStateStore } from "../../../uiStateStore";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import {
  approvalQuestion,
  attentionThreads,
  homeThreadStatus,
  pickContinueThreads,
  recentThreads,
  shortAgo,
  threadActivityAt,
  type HomeThread,
} from "./homeModel";

/** Every chat summary, with when the person last opened it. */
export function useHomeThreads(): { threads: HomeThread[]; now: number } {
  const summaries = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const visited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const clock = useMinuteClock();
  const threads = useMemo(
    () =>
      summaries.map((thread) => ({
        ...thread,
        lastVisitedAt: visited[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
      })),
    [summaries, visited],
  );
  // The minute clock keeps "12 min" labels and snooze expiry moving.
  return { threads, now: Math.max(Date.parse(clock), Date.now()) };
}

export function useOpenThread() {
  const navigate = useNavigate();
  return useCallback(
    (thread: HomeThread) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      }),
    [navigate],
  );
}

function StatusLabel({ thread }: { thread: HomeThread }) {
  const status = homeThreadStatus(thread);
  if (!status) return null;
  return (
    <span className={cn("flex items-center gap-1 text-[11px] font-medium", status.colorClass)}>
      <span
        className={cn("size-1.5 rounded-full", status.dotClass, status.pulse && "animate-pulse")}
        aria-hidden
      />
      {status.label}
    </span>
  );
}

/** "3 things need you ›" — opens the first chat that waits. Nothing when nothing waits. */
export function NeedsYouPill({ threads, now }: { threads: HomeThread[]; now: number }) {
  const open = useOpenThread();
  const waiting = attentionThreads(threads, now);
  const first = waiting[0];
  if (!first) return null;
  return (
    <button
      type="button"
      onClick={() => open(first)}
      data-testid="home-needs-you"
      className="flex items-center gap-2 self-start rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
    >
      <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
      {waiting.length} {waiting.length === 1 ? "thing needs" : "things need"} you
      <ChevronRightIcon className="size-3.5" />
    </button>
  );
}

function threadLine(thread: HomeThread): string {
  if (thread.hasPendingApprovals) return "Wants your OK to go on.";
  if (thread.hasPendingUserInput) return "Asked you a question.";
  if (thread.session?.status === "running" || thread.session?.status === "connecting")
    return "Working on it…";
  if (thread.session?.status === "error" && thread.session.lastError)
    return thread.session.lastError;
  return "";
}

/** The three chats most worth picking up. */
export function ContinueCards({ threads, now }: { threads: HomeThread[]; now: number }) {
  const open = useOpenThread();
  const cards = pickContinueThreads(threads, { now });
  if (cards.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border/80 px-4 py-3 text-sm text-muted-foreground">
        No chats yet. Type a task above and Uno starts on it.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="home-continue">
      {cards.map((thread) => {
        const line = threadLine(thread);
        return (
          <button
            key={`${thread.environmentId}:${thread.id}`}
            type="button"
            onClick={() => open(thread)}
            className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-border/70 bg-card/40 p-3.5 text-left transition-colors hover:bg-accent/40"
          >
            <div className="flex min-h-4 items-center gap-2">
              <StatusLabel thread={thread} />
              <span className="ml-auto text-[11px] text-muted-foreground">
                {shortAgo(threadActivityAt(thread), now)}
              </span>
            </div>
            <div className="truncate text-sm font-medium">{thread.title}</div>
            {line ? (
              <span className="line-clamp-2 text-xs text-muted-foreground">{line}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * An approval, answerable right here: the row keeps the chat's details
 * subscribed (only the chat's own events name the request) and sends the same
 * `thread.approval.respond` the chat's Approve / Decline buttons send. Until
 * the request is known — or when it's gone — the row just opens the chat.
 */
function ApprovalRow({ thread, onOpen }: { thread: HomeThread; onOpen: () => void }) {
  const ref = useMemo(() => scopeThreadRef(thread.environmentId, thread.id), [thread]);
  useEffect(
    () => retainThreadDetailSubscription(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const detail = useStore(useMemo(() => createThreadSelectorByRef(ref), [ref]));
  const approval = useMemo(
    () => (detail ? (derivePendingApprovals(detail.activities)[0] ?? null) : null),
    [detail],
  );
  const [responding, setResponding] = useState(false);
  const respond = async (decision: ProviderApprovalDecision) => {
    if (!approval) return;
    const api = readEnvironmentApi(thread.environmentId);
    if (!api) return;
    setResponding(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.approval.respond",
        commandId: newCommandId(),
        threadId: thread.id,
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
  const question = approval ? approvalQuestion(approval) : null;
  return (
    <div
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2"
      data-testid="home-approval"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 [&_svg]:size-4">
        <ShieldAlertIcon />
      </span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium">
          {question ? (
            <>
              {question.lead}
              {question.subject ? (
                <>
                  {" "}
                  <span className="font-mono text-[13px]">{question.subject}</span>
                </>
              ) : null}
              ?
            </>
          ) : (
            thread.title
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {question ? thread.title : "Wants your OK to go on"}
        </span>
      </button>
      {approval ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            disabled={responding}
            onClick={() => void respond("decline")}
          >
            Don't
          </Button>
          <Button size="xs" disabled={responding} onClick={() => void respond("accept")}>
            Allow
          </Button>
        </span>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">Open</span>
      )}
    </div>
  );
}

/** Widget: the chats waiting for the person — approvals answered in place, questions open the chat. */
export function NeedsYouWidget({ threads, now }: { threads: HomeThread[]; now: number }) {
  const open = useOpenThread();
  const waiting = attentionThreads(threads, now).slice(0, 4);
  if (waiting.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-2 rounded-full bg-success" aria-hidden />
        Nothing waits for you.
      </p>
    );
  }
  return (
    <ul className="-mx-2 flex flex-col">
      {waiting.map((thread) => (
        <li key={`${thread.environmentId}:${thread.id}`}>
          {thread.hasPendingApprovals ? (
            <ApprovalRow thread={thread} onOpen={() => open(thread)} />
          ) : (
            <button
              type="button"
              onClick={() => open(thread)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/50"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 [&_svg]:size-4">
                <MessageCircleQuestionIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{thread.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  Asked you a question
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">Open</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Widget: the latest chats, newest first, and "New chat". */
export function RecentChatsWidget({
  threads,
  now,
  onNewChat,
}: {
  threads: HomeThread[];
  now: number;
  onNewChat: () => void;
}) {
  const open = useOpenThread();
  const recent = recentThreads(threads, { now, limit: 8 });
  return (
    <div className="flex flex-col gap-0.5">
      {recent.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <MessagesSquareIcon className="size-4" />
          No chats yet.
        </p>
      ) : null}
      {recent.map((thread) => {
        const pill = homeThreadStatus(thread);
        return (
          <button
            key={`${thread.environmentId}:${thread.id}`}
            type="button"
            onClick={() => open(thread)}
            className="-mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                pill ? pill.dotClass : "bg-muted-foreground/40",
                pill?.pulse && "animate-pulse",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {shortAgo(threadActivityAt(thread), now)}
            </span>
          </button>
        );
      })}
      <Button
        size="xs"
        variant="ghost"
        className="mt-1 self-start text-muted-foreground"
        onClick={onNewChat}
      >
        <PlusIcon />
        New chat
      </Button>
    </div>
  );
}
