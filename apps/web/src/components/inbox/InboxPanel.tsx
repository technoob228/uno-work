/**
 * The Inbox list — in the standard sidebar (the "Inbox" row under Home) and
 * as the Inbox panel of the rail. Newest first, "Needs you" on top of the
 * filter, each item opens where it belongs; hover (always on touch) offers
 * Mark read, Snooze and Dismiss. The bell turns system notifications on for
 * this device.
 */
import type { InboxItemKind } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  AppWindowIcon,
  BellIcon,
  BellOffIcon,
  CheckCheckIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  ChevronLeftIcon,
  FileTextIcon,
  InboxIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState, type ComponentType, type SyntheticEvent } from "react";

import {
  type InboxEntry,
  isNeedsYou,
  isSnoozed,
  updateInbox,
  updateInboxEverywhere,
  useInboxEntries,
} from "../../inbox/inboxStore";
import {
  setSystemNotifications,
  useSystemNotificationsState,
} from "../../inbox/systemNotifications";
import { useOpenInboxItem } from "../../inbox/useOpenInboxItem";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { resolveSnoozePresets, snoozeWakeDescription } from "../Sidebar.snooze";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type Filter = "all" | "needs-you" | "chats" | "apps" | "snoozed";

const KIND_ICON: Record<InboxItemKind, ComponentType<{ className?: string }>> = {
  "agent.done": CircleCheckIcon,
  "agent.approval": ShieldQuestionIcon,
  "agent.input": CircleHelpIcon,
  "agent.error": CircleAlertIcon,
  app: AppWindowIcon,
};

const KIND_TONE: Record<InboxItemKind, string> = {
  "agent.done": "text-success bg-success/10",
  "agent.approval": "text-warning bg-warning/12",
  "agent.input": "text-warning bg-warning/12",
  "agent.error": "text-destructive bg-destructive/10",
  app: "text-primary bg-primary/10",
};

const stop = (event: SyntheticEvent) => event.stopPropagation();

export function filterInbox(
  entries: ReadonlyArray<InboxEntry>,
  filter: Filter,
  nowMs: number = Date.now(),
): ReadonlyArray<InboxEntry> {
  return entries.filter((item) => {
    const snoozed = isSnoozed(item, nowMs);
    if (filter === "snoozed") return snoozed;
    if (snoozed) return false;
    switch (filter) {
      case "needs-you":
        return isNeedsYou(item) && item.readAt === null;
      case "chats":
        return item.source.kind === "agent";
      case "apps":
        return item.source.kind !== "agent";
      default:
        return true;
    }
  });
}

function dayLabel(iso: string, now: Date): "Today" | "Earlier" {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString() ? "Today" : "Earlier";
}

export const InboxPanel = memo(function InboxPanel(props: {
  /** Standard sidebar: a way back to Chats / Files / Apps. */
  readonly onBack?: () => void;
  /** Rail: the panel already has a title bar of its own. */
  readonly showTitle?: boolean;
}) {
  const entries = useInboxEntries();
  const [filter, setFilter] = useState<Filter>("all");
  const now = new Date();
  const visible = useMemo(() => filterInbox(entries, filter), [entries, filter]);
  const needsYou = useMemo(() => filterInbox(entries, "needs-you").length, [entries]);
  const snoozedCount = useMemo(() => filterInbox(entries, "snoozed").length, [entries]);
  const unreadVisible = visible.some((item) => item.readAt === null);
  const hasRead = entries.some((item) => item.readAt !== null);

  const chips: ReadonlyArray<{ id: Filter; label: string; count?: number }> = [
    { id: "all", label: "All" },
    { id: "needs-you", label: "Needs you", count: needsYou },
    { id: "chats", label: "Chats" },
    { id: "apps", label: "Apps" },
    ...(snoozedCount > 0
      ? [{ id: "snoozed" as const, label: "Snoozed", count: snoozedCount }]
      : []),
  ];

  let lastGroup: string | null = null;

  return (
    <section aria-label="Inbox" className="flex min-h-full flex-col" data-testid="inbox-panel">
      {props.showTitle !== false ? (
        <div className="flex h-8 items-center gap-1 pr-0.5 pl-1">
          {props.onBack ? (
            <button
              type="button"
              aria-label="Back"
              onClick={props.onBack}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
            >
              <ChevronLeftIcon className="size-4" />
            </button>
          ) : null}
          <span className="flex-1 truncate text-sm font-semibold">Inbox</span>
          <InboxHeaderActions unread={unreadVisible} hasRead={hasRead} />
        </div>
      ) : (
        <div className="flex h-7 items-center justify-end pr-0.5">
          <InboxHeaderActions unread={unreadVisible} hasRead={hasRead} />
        </div>
      )}

      <div className="flex flex-wrap gap-1 px-1 pt-1 pb-1.5" role="tablist" aria-label="Filter">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="tab"
            aria-selected={filter === chip.id}
            onClick={() => setFilter(chip.id)}
            className={cn(
              "inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors",
              filter === chip.id
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {chip.label}
            {chip.count ? (
              <span
                className={cn(
                  "rounded-full px-1 text-[10px] tabular-nums",
                  filter === chip.id ? "bg-background/20" : "bg-warning/15 text-warning",
                )}
              >
                {chip.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground/70">
          <InboxIcon className="size-5" />
          {filter === "needs-you"
            ? "Nothing waits for you."
            : "All caught up. Agents that finish or need you, and apps that have news, show up here."}
        </div>
      ) : (
        <ul className="flex flex-col gap-px">
          {visible.map((item) => {
            const group = filter === "snoozed" ? null : dayLabel(item.updatedAt, now);
            const header =
              group !== null && group !== lastGroup ? (
                <li
                  key={`h:${group}`}
                  className="list-none px-2 pt-2 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase"
                >
                  {group}
                </li>
              ) : null;
            lastGroup = group;
            return [header, <InboxRow key={`${item.environmentId}:${item.id}`} item={item} />];
          })}
        </ul>
      )}
    </section>
  );
});

function InboxHeaderActions({ unread, hasRead }: { unread: boolean; hasRead: boolean }) {
  const system = useSystemNotificationsState();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-0.5">
      {system !== "unsupported" ? (
        <HeaderButton
          label={
            system === "on"
              ? "Notifications on this device: on"
              : system === "blocked"
                ? "Notifications are blocked in this browser's settings"
                : "Notify me on this device"
          }
          disabled={busy || system === "blocked"}
          onClick={() => {
            setBusy(true);
            void setSystemNotifications(system !== "on").finally(() => setBusy(false));
          }}
          testId="inbox-system-notifications"
        >
          {system === "on" ? (
            <BellIcon className="size-3.5 text-primary" />
          ) : (
            <BellOffIcon className="size-3.5" />
          )}
        </HeaderButton>
      ) : null}
      <HeaderButton
        label="Mark all read"
        disabled={!unread}
        onClick={() => void updateInboxEverywhere({ action: "readAll" })}
        testId="inbox-mark-all-read"
      >
        <CheckCheckIcon className="size-3.5" />
      </HeaderButton>
      <HeaderButton
        label="Clear read"
        disabled={!hasRead}
        onClick={() => void updateInboxEverywhere({ action: "clearRead" })}
      >
        <XIcon className="size-3.5" />
      </HeaderButton>
    </div>
  );
}

function HeaderButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            data-testid={props.testId}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function ItemIcon({ item }: { item: InboxEntry }) {
  if (item.source.kind === "app" && item.source.icon) {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-[15px] leading-none">
        {item.source.icon}
      </span>
    );
  }
  const Icon =
    item.source.kind === "app" && item.open?.kind === "file" ? FileTextIcon : KIND_ICON[item.kind];
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg",
        KIND_TONE[item.kind],
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

const InboxRow = memo(function InboxRow({ item }: { item: InboxEntry }) {
  const openItem = useOpenInboxItem();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const unread = item.readAt === null;
  const snoozed = isSnoozed(item);
  const time = formatRelativeTime(item.updatedAt).value;
  const presets = useMemo(() => (snoozeOpen ? resolveSnoozePresets(new Date()) : []), [snoozeOpen]);

  return (
    <li className="group/inbox relative list-none" data-testid="inbox-item">
      <button
        type="button"
        onClick={() => void openItem(item)}
        className={cn(
          "flex w-full cursor-pointer items-start gap-2.5 rounded-lg py-2 pr-2 pl-3 text-left outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 group-hover/inbox:pr-[5.5rem] max-md:pr-[5.5rem]",
          !unread && "opacity-70",
        )}
      >
        {unread ? (
          <span
            aria-label="Unread"
            className="absolute top-3.5 left-1 size-1.5 rounded-full bg-primary"
          />
        ) : null}
        <ItemIcon item={item} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px]",
                unread ? "font-semibold text-foreground" : "font-medium text-sidebar-foreground",
              )}
            >
              {item.title}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums group-hover/inbox:invisible max-md:invisible">
              {snoozed ? snoozeWakeDescription(item.snoozedUntil!, new Date()) : time}
            </span>
          </span>
          {item.body ? (
            <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
              {item.body}
            </span>
          ) : null}
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            {item.source.kind === "app" ? <span>{item.source.name}</span> : null}
            {item.count > 1 ? <span className="tabular-nums">×{item.count}</span> : null}
          </span>
        </span>
      </button>
      <div
        className="absolute top-1.5 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/inbox:opacity-100 focus-within:opacity-100 max-md:opacity-100"
        onClick={stop}
      >
        <RowAction
          label={unread ? "Mark read" : "Mark unread"}
          onClick={() =>
            void updateInbox(item.environmentId, {
              action: unread ? "read" : "unread",
              ids: [item.id],
            })
          }
        >
          <CheckIcon className="size-3.5" />
        </RowAction>
        {snoozed ? (
          <RowAction
            label="Bring back now"
            onClick={() =>
              void updateInbox(item.environmentId, { action: "unsnooze", ids: [item.id] })
            }
          >
            <AlarmClockIcon className="size-3.5 text-info" />
          </RowAction>
        ) : (
          <Menu open={snoozeOpen} onOpenChange={setSnoozeOpen}>
            <MenuTrigger
              aria-label="Snooze"
              title="Snooze"
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <AlarmClockIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" side="bottom" className="min-w-44">
              <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Remind me</div>
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
              <MenuSeparator />
              <MenuItem
                onClick={() =>
                  void updateInbox(item.environmentId, { action: "dismiss", ids: [item.id] })
                }
              >
                Dismiss
              </MenuItem>
            </MenuPopup>
          </Menu>
        )}
        <RowAction
          label="Dismiss"
          onClick={() =>
            void updateInbox(item.environmentId, { action: "dismiss", ids: [item.id] })
          }
        >
          <XIcon className="size-3.5" />
        </RowAction>
      </div>
    </li>
  );
});

function RowAction(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {props.children}
    </button>
  );
}

/** "Needs you" on the rail's Home panel: approvals and questions, nothing else. */
export const InboxNeedsYouList = memo(function InboxNeedsYouList() {
  const entries = useInboxEntries();
  const needsYou = useMemo(() => filterInbox(entries, "needs-you"), [entries]);
  return (
    <section aria-label="Needs you" className="flex flex-col gap-px">
      <div className="flex h-6 items-center pl-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
          Needs you
        </span>
      </div>
      {needsYou.length === 0 ? (
        <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground/60">
          Nothing waits for you. Approvals and questions from agents show up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {needsYou.map((item) => (
            <InboxRow key={`${item.environmentId}:${item.id}`} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
});
