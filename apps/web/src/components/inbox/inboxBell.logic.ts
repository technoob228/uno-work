/**
 * What the bell's popover lists: the same Inbox items as everywhere (daemon
 * snapshots merged newest first), filtered by the chips and grouped "Needs
 * you" first, then today, then earlier. Snoozed items stay out.
 */
import { type InboxEntry, isNeedsYou, isSnoozed } from "../../inbox/inboxStore";

export type BellFilter = "all" | "needs-you" | "chats" | "apps";

export const BELL_FILTERS: ReadonlyArray<{ id: BellFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs-you", label: "Needs you" },
  { id: "chats", label: "Chats" },
  { id: "apps", label: "Apps" },
];

export interface BellSection {
  readonly id: "needs-you" | "today" | "earlier";
  readonly label: string;
  readonly items: ReadonlyArray<InboxEntry>;
}

function matches(item: InboxEntry, filter: BellFilter): boolean {
  switch (filter) {
    case "needs-you":
      return isNeedsYou(item);
    case "chats":
      return item.source.kind === "agent";
    case "apps":
      return item.source.kind !== "agent";
    default:
      return true;
  }
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function bellSections(
  entries: ReadonlyArray<InboxEntry>,
  filter: BellFilter,
  nowMs: number,
): ReadonlyArray<BellSection> {
  const needsYou: InboxEntry[] = [];
  const today: InboxEntry[] = [];
  const earlier: InboxEntry[] = [];
  for (const item of entries) {
    if (isSnoozed(item, nowMs) || !matches(item, filter)) continue;
    // A waiting approval / question stays on top until it is answered or dismissed.
    if (isNeedsYou(item)) needsYou.push(item);
    else if (sameDay(Date.parse(item.updatedAt), nowMs)) today.push(item);
    else earlier.push(item);
  }
  return [
    { id: "needs-you", label: "Needs you", items: needsYou },
    { id: "today", label: "Today", items: today },
    { id: "earlier", label: "Earlier", items: earlier },
  ];
}
