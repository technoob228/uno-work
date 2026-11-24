/**
 * One quiet line of chips above the composer (T63, Misha 24.11: "two bars
 * stack in the middle of the screen, eat space, steal attention"). What sat
 * there as stacked strips — "Waiting for you", the Tasks list, where the
 * chat came from / who handles it with its buttons — becomes chips 24 px
 * high; a chip says the gist and opens its details upward on a click. Only
 * what waits for the person is warm. Nothing to say: no line. Nothing opens
 * by itself (Tasks used to open when a task needed the person; now its chip
 * turns warm). ChatView hides the line while an Allow or a question waits.
 */
import type { EnvironmentId, ThreadController, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightLeftIcon,
  ChevronUpIcon,
  CornerUpLeftIcon,
  ListChecksIcon,
  LockIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type ComponentProps, type ReactNode } from "react";

import { agentTasksChip, agentTasksOf } from "../../agentTasks.logic";
import {
  resolveComposerOriginChip,
  type ComposerOriginChip,
  type ThreadControlBarAction,
} from "../../agentThreads.logic";
import { setThreadAgentsClosed, setThreadHandler } from "../../agentsAccess";
import { useEnvironmentSupportsAgentsCloseChat } from "../../environments/agentsCloseChatSupport";
import { useEnvironmentSupportsAgentThreads } from "../../environments/agentThreadsSupport";
import { useThreadTitle } from "../../hooks/useThreadTitle";
import { cn } from "../../lib/utils";
import { useSecretRequests } from "../../secretRequestStore";
import { useToolApprovals } from "../../toolApprovalStore";
import { selectEnvironmentState, selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { isWaitingOnAgents, threadOwner } from "../Sidebar.owner";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { AgentTasksBar } from "./AgentTasksBar";
import { PendingForYouStrip } from "./PendingForYouStrip";

const CHIP =
  "inline-flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring";
const QUIET =
  "border-border/70 bg-background text-muted-foreground hover:bg-muted hover:text-foreground";
const WARM = "border-warning/40 bg-warning/6 text-foreground hover:bg-warning/12";

function Chip(props: {
  readonly testId: string;
  readonly className?: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly popupClassName?: string;
  readonly popup: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid={props.testId}
        title={props.label}
        className={cn(CHIP, props.className ?? QUIET)}
      >
        {props.icon}
        <span className="min-w-0 truncate">{props.label}</span>
        <ChevronUpIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={6}
        className={cn("w-[min(24rem,calc(100vw-1rem))]", props.popupClassName)}
      >
        {props.popup(close)}
      </PopoverPopup>
    </Popover>
  );
}

/** Where the chat came from and who handles it, with the old strip's buttons. */
function OriginPopup(props: {
  readonly chip: ComposerOriginChip;
  readonly onOpenParent: () => void;
  readonly onAction: (action: ThreadControlBarAction) => void;
  readonly busy: boolean;
}) {
  const { chip } = props;
  const { state } = chip;
  const actions = [state.action, state.secondaryAction].filter(
    (action): action is ThreadControlBarAction => action !== null,
  );
  return (
    <div className="flex flex-col gap-2.5 text-xs" data-testid="composer-origin-popup">
      <p className="text-foreground">
        {state.leadText}
        {state.parentLinkText ? (
          <button
            type="button"
            onClick={props.onOpenParent}
            title="Open the chat that created this one"
            className="cursor-pointer rounded-sm font-medium underline-offset-2 outline-hidden hover:underline focus-visible:ring-1 focus-visible:ring-ring"
          >
            {state.parentLinkText}
          </button>
        ) : null}
        {state.trailText}
      </p>
      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <Button
              key={action.label}
              size="xs"
              variant={action === state.action ? "outline" : "ghost"}
              disabled={props.busy}
              {...(action.kind === "handoff" && action.hint ? { title: action.hint } : {})}
              onClick={() => props.onAction(action)}
              data-testid={
                action.kind === "agents-access"
                  ? "composer-origin-agents-access"
                  : "composer-origin-handoff"
              }
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * An "Allow this?" or a secret request for this chat waits in the composer:
 * then it alone stands above the field, the chip line steps aside (14:15).
 */
export function useComposerAskWaiting(threadId: string | undefined): boolean {
  const approvals = useToolApprovals();
  const secrets = useSecretRequests();
  const forThisChat = (context: { readonly threadId?: string | undefined } | undefined) =>
    context?.threadId === undefined || context.threadId === threadId;
  return (
    approvals.some((approval) => forThisChat(approval.event.context)) ||
    secrets.some((request) => forThisChat(request.event.context))
  );
}

export function ComposerContextLine(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly spawnedByThreadId: ThreadId | null | undefined;
  readonly controller: ThreadController | null | undefined;
  readonly agentsClosedAt: string | null | undefined;
  /** "Waiting for you" (T52); null: this chat keeps no list. */
  readonly pending: ComponentProps<typeof PendingForYouStrip> | null;
}) {
  const { environmentId, threadId, spawnedByThreadId, controller, agentsClosedAt } = props;
  const navigate = useNavigate();
  const supported = useEnvironmentSupportsAgentThreads(environmentId);
  const supportsAgentsAccess = useEnvironmentSupportsAgentsCloseChat(environmentId);
  const parentTitle = useThreadTitle(environmentId, spawnedByThreadId);
  const agentLed = useStore((store) => {
    const summary = selectSidebarThreadSummaryByRef(store, { environmentId, threadId });
    return (
      summary !== undefined && (isWaitingOnAgents(summary) || threadOwner(summary) === "agent")
    );
  });
  const summaries = useStore(
    (state) => selectEnvironmentState(state, environmentId).sidebarThreadSummaryById,
  );
  const tasks = useMemo(
    () => (supported ? agentTasksOf(threadId, Object.values(summaries)) : []),
    [summaries, supported, threadId],
  );
  const [busy, setBusy] = useState(false);

  const origin = supported
    ? resolveComposerOriginChip({
        spawnedByThreadId,
        controller,
        parentTitle,
        agentsClosedAt,
        supportsAgentsAccess,
        agentLed,
      })
    : null;

  const open = (id: ThreadId) =>
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId: id } });

  const runAction = async (action: ThreadControlBarAction, close: () => void) => {
    setBusy(true);
    try {
      if (action.kind === "agents-access") {
        await setThreadAgentsClosed({ environmentId, threadId, closed: action.nextClosed });
      } else {
        // Join / Hand to agent (and an older daemon's Take over / Hand back).
        await setThreadHandler({ environmentId, threadId, controller: action.nextController });
      }
      close();
    } finally {
      setBusy(false);
    }
  };

  const pending = props.pending && props.pending.items.length > 0 ? props.pending : null;
  const pendingChip = pending ? (
    <Chip
      testId="composer-chip-pending"
      className={cn("shrink-0 font-medium", WARM)}
      icon={<span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />}
      label={`Waiting for you · ${pending.items.length}`}
      popupClassName="w-[min(38rem,calc(100vw-1rem))]"
      popup={(close) => (
        <PendingForYouStrip
          {...pending}
          embedded
          onShow={(item) => {
            close();
            pending.onShow(item);
          }}
          onOpenLink={(item, link) => {
            close();
            pending.onOpenLink(item, link);
          }}
        />
      )}
    />
  ) : null;

  let tasksChip: ReactNode = null;
  if (tasks.length > 0) {
    const gist = agentTasksChip(tasks);
    tasksChip = (
      <Chip
        testId="composer-chip-tasks"
        className={cn("shrink-0", gist.tone === "needs-you" ? WARM : QUIET)}
        icon={
          gist.tone === "working" ? (
            <Spinner aria-hidden className="size-3.5 shrink-0 text-info" />
          ) : (
            <ListChecksIcon aria-hidden className="size-3.5 shrink-0" />
          )
        }
        label={`Tasks · ${gist.label}`}
        popupClassName="w-[min(30rem,calc(100vw-1rem))]"
        popup={(close) => (
          // Opening a task leaves this chat: the popover goes with it.
          <div
            onClickCapture={(event) => {
              const button = (event.target as Element).closest("button");
              if (button && button.getAttribute("data-testid") !== "agent-task-handoff") close();
            }}
          >
            <AgentTasksBar environmentId={environmentId} threadId={threadId} embedded />
          </div>
        )}
      />
    );
  }

  const originChip = origin ? (
    <Chip
      testId="composer-chip-origin"
      icon={
        origin.kind === "closed" ? (
          <LockIcon aria-hidden className="size-3.5 shrink-0" />
        ) : origin.kind === "handled" ? (
          <ArrowRightLeftIcon aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <CornerUpLeftIcon aria-hidden className="size-3.5 shrink-0" />
        )
      }
      label={origin.label}
      popupClassName="w-[min(22rem,calc(100vw-1rem))]"
      popup={(close) => (
        <OriginPopup
          chip={origin}
          busy={busy}
          onOpenParent={() => {
            close();
            if (spawnedByThreadId) open(spawnedByThreadId);
          }}
          onAction={(action) => void runAction(action, close)}
        />
      )}
    />
  ) : null;

  if (!pendingChip && !tasksChip && !originChip) return null;
  return (
    <div
      data-testid="composer-context-line"
      className="mx-auto mb-1.5 flex max-w-208 min-w-0 items-center gap-1.5 px-1"
    >
      {pendingChip}
      {tasksChip}
      {originChip}
    </div>
  );
}
