import { Fragment, type ReactNode } from "react";

import { groupRecentsByTime, type RecentsTimeGroupId } from "./recentsTimeGroups";

/** "Today", "Yesterday", "This week", "Older" — quieter than a section label. */
function SidebarRecentsTimeLabel(props: { id: RecentsTimeGroupId; label: string }) {
  return (
    <li
      aria-hidden
      data-testid={`sidebar-recents-time-${props.id}`}
      className="list-none px-2.5 pt-2 pb-0.5 text-[11px] font-medium text-sidebar-muted-foreground/55"
    >
      {props.label}
    </li>
  );
}

/**
 * The rows of Recents / the one-list sidebar under time labels (T3 port
 * 29.10). Only the rows already shown are grouped: "Show N more" stays at the
 * bottom of the list, as before.
 */
export function renderRecentsByTime<T>(input: {
  readonly chats: ReadonlyArray<T>;
  readonly timeOf: (chat: T) => number;
  readonly now: Date;
  readonly renderRow: (chat: T) => ReactNode;
}): ReactNode {
  return groupRecentsByTime(input).map((group) => (
    <Fragment key={`recents-time-${group.id}`}>
      <SidebarRecentsTimeLabel id={group.id} label={group.label} />
      {group.chats.map(input.renderRow)}
    </Fragment>
  ));
}
