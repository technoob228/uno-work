/**
 * "Inbox" under Home in the standard sidebar: what finished, what waits for
 * you and what apps have to say, with the unread count. A click turns the
 * sidebar's list into the Inbox; a second click (or the back arrow) returns
 * to Chats / Files / Apps as they were.
 */
import { InboxIcon } from "lucide-react";
import { memo } from "react";

import { useInboxNeedsYouCount, useInboxUnreadCount } from "../../inbox/inboxStore";
import { cn } from "../../lib/utils";
import { useNavStore } from "../../navigation/navStore";

export function InboxCountBadge(props: { unread: number; needsYou: number; className?: string }) {
  if (props.unread <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] leading-4.5 font-semibold tabular-nums",
        props.needsYou > 0
          ? "bg-warning text-warning-foreground"
          : "bg-primary text-primary-foreground",
        props.className,
      )}
      aria-label={`${props.unread} unread`}
    >
      {props.unread > 99 ? "99+" : props.unread}
    </span>
  );
}

export const SidebarInboxRow = memo(function SidebarInboxRow() {
  const mode = useNavStore((state) => state.sidebarMode);
  const lastListMode = useNavStore((state) => state.lastListMode);
  const setMode = useNavStore((state) => state.setSidebarMode);
  const unread = useInboxUnreadCount();
  const needsYou = useInboxNeedsYouCount();
  const active = mode === "inbox";

  return (
    <button
      type="button"
      onClick={() => setMode(active ? lastListMode : "inbox")}
      className={cn(
        "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-hidden ring-ring transition-colors focus-visible:ring-2",
        active
          ? "bg-sidebar-row-active text-foreground"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      aria-pressed={active}
      data-testid="sidebar-inbox"
    >
      <InboxIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">Inbox</span>
      {needsYou > 0 ? (
        <span className="shrink-0 text-[11px] text-warning">{needsYou} need you</span>
      ) : null}
      <InboxCountBadge unread={unread} needsYou={needsYou} />
    </button>
  );
});
