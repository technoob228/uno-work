/**
 * "Waiting for you" (T52) on a chat's sidebar row: how many cards to answer
 * and site links to open wait there — the same list as the strip above its
 * composer and its Inbox item. Nothing waits: nothing shown.
 */
import { memo } from "react";

export const SidebarPendingCount = memo(function SidebarPendingCount(props: {
  readonly count: number;
}) {
  if (props.count <= 0) return null;
  const label = `${props.count} ${props.count === 1 ? "thing waits" : "things wait"} for you here`;
  return (
    <span
      role="img"
      aria-label={label}
      title={`${label} — cards to answer, links to open`}
      data-testid="sidebar-row-pending"
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning/16 px-1 text-[10px] leading-none font-semibold text-warning tabular-nums"
    >
      {props.count}
    </span>
  );
});
