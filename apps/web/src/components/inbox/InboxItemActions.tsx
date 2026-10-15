/**
 * The actions of one Inbox item, by why the agent needs the person
 * (`inbox/inboxActions.logic.ts`): Allow / Decline / View for an approval,
 * Open chat / Skip for now for a question, Open / Done / Snooze for the rest.
 * Shared by the bell (and the sidebar's Needs-you popover) and the Inbox
 * panel; Home's Needs-you rows use the same resolver and `SkipForNowMenu`.
 */
import type { ThreadId } from "@t3tools/contracts";
import { AlarmClockIcon, CheckIcon, ClockIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  INBOX_BUTTON_LABEL,
  type InboxButton,
  type InboxItemActions,
  resolveInboxItemActions,
  SKIP_FOR_NOW_LABEL,
  skipForNowPresets,
} from "../../inbox/inboxActions.logic";
import { markInboxItemDone } from "../../inbox/inboxDone";
import { type InboxEntry, isSnoozed, updateInbox } from "../../inbox/inboxStore";
import {
  type PendingApprovalState,
  useChatOpenRequests,
  usePendingApproval,
} from "../../inbox/usePendingApproval";
import { cn } from "../../lib/utils";
import { resolveSnoozePresets, snoozeWakeDescription } from "../Sidebar.snooze";
import { approvalQuestion } from "../computer/home/homeModel";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

export interface ResolvedInboxActions {
  readonly actions: InboxItemActions;
  /** Approvals answerable here (null for every other item). */
  readonly approval: PendingApprovalState | null;
}

function itemThreadId(item: InboxEntry): string | null {
  return item.open?.kind === "thread" ? item.open.threadId : null;
}

/**
 * Resolves the item's actions and hands them to `children`. An approval keeps
 * the chat's details subscribed while mounted (only they name the request).
 */
export function WithInboxItemActions({
  item,
  children,
}: {
  item: InboxEntry;
  children: (resolved: ResolvedInboxActions) => ReactNode;
}) {
  const threadId = itemThreadId(item);
  if (item.kind === "agent.approval" && threadId !== null) {
    return <ApprovalResolver item={item} threadId={threadId as ThreadId} render={children} />;
  }
  return <PlainResolver item={item} threadId={threadId} render={children} />;
}

function PlainResolver(props: {
  item: InboxEntry;
  threadId: string | null;
  render: (resolved: ResolvedInboxActions) => ReactNode;
}) {
  const open = useChatOpenRequests(props.item.environmentId, props.threadId);
  const actions = resolveInboxItemActions({
    kind: props.item.kind,
    hasThread: props.threadId !== null,
    unread: props.item.readAt === null,
    open,
  });
  return <>{props.render({ actions, approval: null })}</>;
}

function ApprovalResolver(props: {
  item: InboxEntry;
  threadId: ThreadId;
  render: (resolved: ResolvedInboxActions) => ReactNode;
}) {
  const approval = usePendingApproval(props.item.environmentId, props.threadId);
  const open = useChatOpenRequests(props.item.environmentId, props.threadId);
  const actions = resolveInboxItemActions({
    kind: props.item.kind,
    hasThread: true,
    unread: props.item.readAt === null,
    open,
    approvalPhase: approval.phase,
  });
  return <>{props.render({ actions, approval })}</>;
}

/**
 * The buttons of an item: the reason's own (Allow / Decline / View, Open chat
 * + Skip for now, Open), then Done and Snooze where the surface has no other
 * place for them (`withDone`, `withSnooze` — the panel keeps those on hover).
 */
export function InboxActionButtons({
  item,
  resolved,
  onOpen,
  withDone = false,
  withSnooze = false,
}: {
  item: InboxEntry;
  resolved: ResolvedInboxActions;
  onOpen: () => void;
  withDone?: boolean;
  withSnooze?: boolean;
}) {
  const { actions, approval } = resolved;
  const pending = approval?.approval ?? null;
  const question = pending ? approvalQuestion(pending) : null;
  const responding = approval?.responding ?? false;
  const button = (id: InboxButton, index: number) => {
    switch (id) {
      case "allow":
        return (
          <Button
            key={id}
            size="xs"
            disabled={responding || !pending}
            onClick={() => void approval?.respond("accept")}
            data-testid="inbox-approve"
          >
            <CheckIcon />
            {INBOX_BUTTON_LABEL.allow}
          </Button>
        );
      case "decline":
        return (
          <Button
            key={id}
            size="xs"
            variant="outline"
            disabled={responding || !pending}
            onClick={() => void approval?.respond("decline")}
            data-testid="inbox-deny"
          >
            {INBOX_BUTTON_LABEL.decline}
          </Button>
        );
      default:
        return (
          <Button
            key={id}
            size="xs"
            // The first button is the main one; View next to Allow / Decline is quiet.
            variant={index === 0 ? "outline" : "ghost"}
            onClick={onOpen}
            data-testid="inbox-open"
          >
            {INBOX_BUTTON_LABEL[id]}
          </Button>
        );
    }
  };
  return (
    <>
      {question?.subject && !(item.body ?? "").includes(question.subject) ? (
        <code className="mb-0.5 block w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          {question.subject}
        </code>
      ) : null}
      {actions.buttons.map(button)}
      {actions.skip ? (
        <SkipForNowMenu
          onSkip={(until) =>
            updateInbox(item.environmentId, { action: "snooze", ids: [item.id], until })
          }
        />
      ) : null}
      {withDone && actions.done ? <InboxDoneButton item={item} /> : null}
      {withSnooze && (actions.snooze || isSnoozed(item)) ? <InboxSnoozeMenu item={item} /> : null}
    </>
  );
}

export function InboxDoneButton({ item }: { item: InboxEntry }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => void markInboxItemDone(item)}
      data-testid="inbox-done"
    >
      <CheckIcon />
      Done
    </Button>
  );
}

/**
 * "Skip for now" on a question: 1 hour / This evening / Tomorrow morning.
 * The Inbox item is snoozed (not the chat — the chat can't be snoozed while it
 * waits, and not dismissed — the question would be lost); it comes back unread.
 */
export function SkipForNowMenu({
  onSkip,
  className,
  disabled = false,
}: {
  onSkip: (until: string) => Promise<void>;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const presets = useMemo(() => (open ? skipForNowPresets(new Date()) : []), [open]);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        disabled={disabled}
        data-testid="inbox-skip"
        className={cn(
          "inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 sm:h-6 sm:text-xs",
          className,
        )}
      >
        <ClockIcon className="size-3.5" />
        {SKIP_FOR_NOW_LABEL}
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-44">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={() =>
              void onSkip(preset.snoozedUntil).catch((error: unknown) =>
                toastManager.add({
                  type: "error",
                  title: "Couldn't skip it",
                  description: error instanceof Error ? error.message : String(error),
                }),
              )
            }
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
              {snoozeWakeDescription(preset.snoozedUntil, new Date())}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/** The general Snooze of news (finished, failed, an app's), or Bring back when snoozed. */
export function InboxSnoozeMenu({ item }: { item: InboxEntry }) {
  const [open, setOpen] = useState(false);
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open]);
  if (isSnoozed(item)) {
    return (
      <Button
        size="xs"
        variant="ghost"
        onClick={() => void updateInbox(item.environmentId, { action: "unsnooze", ids: [item.id] })}
      >
        <AlarmClockIcon />
        Bring back
      </Button>
    );
  }
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        aria-label="Snooze"
        className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <AlarmClockIcon className="size-3.5" />
        Snooze
      </MenuTrigger>
      <MenuPopup align="start" side="bottom" className="min-w-44">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={() =>
              void updateInbox(item.environmentId, {
                action: "snooze",
                ids: [item.id],
                until: preset.snoozedUntil,
              })
            }
          >
            <span className="flex-1">{preset.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
              {snoozeWakeDescription(preset.snoozedUntil, new Date())}
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
