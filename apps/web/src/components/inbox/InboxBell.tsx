/**
 * The Inbox as a bell next to the logo (0.0.83): a counter (amber when
 * something waits for you) and a popover over whatever is on screen — the
 * sidebar and the page stay where they were. Each item answers in place:
 * Approve / Deny for an approval, Open, Done, Snooze. "Done" is the same
 * Done as on Home's Continue cards (`inboxDone.ts`), so both agree.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  BellIcon,
  BellOffIcon,
  CheckCheckIcon,
  CheckIcon,
  InboxIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import { markInboxItemDone } from "../../inbox/inboxDone";
import {
  type InboxEntry,
  isSnoozed,
  updateInbox,
  updateInboxEverywhere,
  useInboxEntries,
  useInboxNeedsYouCount,
  useInboxUnreadCount,
} from "../../inbox/inboxStore";
import { usePendingApproval } from "../../inbox/usePendingApproval";
import {
  setSystemNotifications,
  useSystemNotificationsState,
} from "../../inbox/systemNotifications";
import { useOpenInboxItem } from "../../inbox/useOpenInboxItem";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { resolveSnoozePresets, snoozeWakeDescription } from "../Sidebar.snooze";
import { approvalQuestion } from "../computer/home/homeModel";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ItemIcon, filterInbox } from "./InboxPanel";
import { InboxCountBadge } from "../sidebar/SidebarInboxRow";
import { type BellFilter, BELL_FILTERS, bellSections } from "./inboxBell.logic";
import { useAssistantChat } from "../../assistant/useAssistantChat";
import { ASSISTANT_CHAT_NAME } from "../../assistant/assistantChat.logic";

export const InboxBell = memo(function InboxBell() {
  const [open, setOpen] = useState(false);
  const unread = useInboxUnreadCount();
  const needsYou = useInboxNeedsYouCount();
  const label =
    unread > 0
      ? `Notifications: ${unread} unread${needsYou > 0 ? `, ${needsYou} need you` : ""}`
      : "Notifications";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label={label}
              data-testid="inbox-bell"
              className="relative inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover data-[popup-open]:text-foreground"
            />
          }
        >
          <BellIcon className="size-4" />
          <InboxCountBadge
            unread={unread}
            needsYou={needsYou}
            className="absolute -top-1 -right-1 min-w-4 px-0.5 text-[9px] leading-4"
          />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="bottom"
        align="start"
        className="w-[min(26rem,calc(100vw-1.5rem))] [--viewport-inline-padding:0px]"
        data-testid="inbox-popover"
      >
        <BellPanel onClose={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
});

function BellPanel({ onClose }: { onClose: () => void }) {
  const entries = useInboxEntries();
  const [filter, setFilter] = useState<BellFilter>("all");
  const now = Date.now();
  const sections = useMemo(() => bellSections(entries, filter, now), [entries, filter, now]);
  const needsYouCount = useMemo(() => filterInbox(entries, "needs-you").length, [entries]);
  const anyUnread = entries.some((item) => item.readAt === null && !isSnoozed(item));
  const system = useSystemNotificationsState();
  const empty = sections.every((section) => section.items.length === 0);
  const assistantChatId = useAssistantChat().chat?.id ?? null;

  return (
    <section aria-label="Notifications" className="-my-4 flex max-h-[min(34rem,75vh)] flex-col">
      <header className="flex items-center gap-1 border-b border-border/60 px-3 py-2.5">
        <span className="flex-1 text-sm font-semibold">Notifications</span>
        <Button
          size="xs"
          variant="ghost"
          disabled={!anyUnread}
          onClick={() => void updateInboxEverywhere({ action: "readAll" })}
          data-testid="inbox-mark-all-read"
        >
          <CheckCheckIcon />
          Mark all read
        </Button>
        {system !== "unsupported" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={
                    system === "on"
                      ? "Notifications on this device: on"
                      : system === "blocked"
                        ? "Notifications are blocked in this browser's settings"
                        : "Notify me on this device"
                  }
                  disabled={system === "blocked"}
                  onClick={() => void setSystemNotifications(system !== "on")}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                />
              }
            >
              {system === "on" ? (
                <BellIcon className="size-3.5 text-primary" />
              ) : (
                <BellOffIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {system === "on" ? "Device notifications on" : "Notify me on this device"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </header>
      <div className="flex gap-1 px-3 pt-2 pb-1.5" role="tablist" aria-label="Filter">
        {BELL_FILTERS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="tab"
            aria-selected={filter === chip.id}
            onClick={() => setFilter(chip.id)}
            className={cn(
              "inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium transition-colors",
              filter === chip.id
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {chip.label}
            {chip.id === "needs-you" && needsYouCount > 0 ? (
              <span className="tabular-nums opacity-80">{needsYouCount}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {empty ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground/70">
            <InboxIcon className="size-5" />
            {filter === "needs-you"
              ? "Nothing waits for you."
              : "All caught up. Chats that finish or need you, and apps with news, show up here."}
          </div>
        ) : (
          sections.map((section) =>
            section.items.length === 0 ? null : (
              <div key={section.id}>
                <p className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
                  {section.label}
                </p>
                <ul className="flex flex-col gap-px">
                  {section.items.map((item) => (
                    <BellItem
                      key={`${item.environmentId}:${item.id}`}
                      item={item}
                      title={
                        assistantChatId !== null &&
                        item.open?.kind === "thread" &&
                        item.open.threadId === assistantChatId
                          ? ASSISTANT_CHAT_NAME
                          : item.title
                      }
                      onNavigate={onClose}
                    />
                  ))}
                </ul>
              </div>
            ),
          )
        )}
      </div>
    </section>
  );
}

const BellItem = memo(function BellItem({
  item,
  title,
  onNavigate,
}: {
  item: InboxEntry;
  /** The chat's name as the sidebar shows it ("Uno" for the assistant chat). */
  title: string;
  onNavigate: () => void;
}) {
  const openItem = useOpenInboxItem();
  const unread = item.readAt === null;
  const threadId = item.open?.kind === "thread" ? item.open.threadId : null;
  const isApproval = item.kind === "agent.approval" && threadId !== null;
  const open = () => {
    onNavigate();
    void openItem(item);
  };

  return (
    <li className="group/bell relative list-none" data-testid="inbox-item">
      <div
        className={cn(
          "flex w-full items-start gap-2.5 rounded-lg py-2 pr-2 pl-3 transition-colors hover:bg-accent/50",
          !unread && "opacity-75",
        )}
      >
        {unread ? (
          <span
            aria-label="Unread"
            className="absolute top-3.5 left-1 size-1.5 rounded-full bg-primary"
          />
        ) : null}
        <ItemIcon item={item} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button type="button" onClick={open} className="min-w-0 cursor-pointer text-left">
            <span className="flex items-baseline gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px]",
                  unread ? "font-semibold text-foreground" : "font-medium",
                )}
              >
                {title}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {formatRelativeTime(item.updatedAt).value}
              </span>
            </span>
            {item.body ? (
              <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                {item.body}
              </span>
            ) : null}
            {item.source.kind === "app" || item.count > 1 ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
                {item.source.kind === "app" ? <span>{item.source.name}</span> : null}
                {item.count > 1 ? <span className="tabular-nums">×{item.count}</span> : null}
              </span>
            ) : null}
          </button>
          <div className="flex flex-wrap items-center gap-1">
            {isApproval ? (
              <ApprovalActions
                item={item}
                environmentId={item.environmentId}
                threadId={threadId as ThreadId}
                body={item.body}
                onOpen={open}
              />
            ) : (
              <Button size="xs" variant="outline" onClick={open} data-testid="inbox-open">
                Open
              </Button>
            )}
            {isApproval ? null : <DoneButton item={item} />}
            <SnoozeMenu item={item} />
          </div>
        </div>
      </div>
    </li>
  );
});

function DoneButton({ item }: { item: InboxEntry }) {
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

function ApprovalActions(props: {
  item: InboxEntry;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  body: string | null;
  onOpen: () => void;
}) {
  const { approval, responding, respond } = usePendingApproval(props.environmentId, props.threadId);
  if (!approval) {
    // Answered (or gone): nothing to approve any more — open it or clear it.
    return (
      <>
        <Button size="xs" variant="outline" onClick={props.onOpen}>
          Open
        </Button>
        <DoneButton item={props.item} />
      </>
    );
  }
  const question = approvalQuestion(approval);
  return (
    <>
      {question.subject && !(props.body ?? "").includes(question.subject) ? (
        <code className="mb-0.5 block w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          {question.subject}
        </code>
      ) : null}
      <Button
        size="xs"
        disabled={responding}
        onClick={() => void respond("accept")}
        data-testid="inbox-approve"
      >
        <CheckIcon />
        Approve
      </Button>
      <Button
        size="xs"
        variant="outline"
        disabled={responding}
        onClick={() => void respond("decline")}
        data-testid="inbox-deny"
      >
        Deny
      </Button>
      <Button size="xs" variant="ghost" onClick={props.onOpen}>
        Open
      </Button>
    </>
  );
}

function SnoozeMenu({ item }: { item: InboxEntry }) {
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
