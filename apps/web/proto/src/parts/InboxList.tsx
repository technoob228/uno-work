/**
 * The Inbox list, shared by the three C variants: the page (C1, with a
 * selection), the bell popover (C2) and nothing else — C3 renders the same
 * items as Home cards. "Needs you" first, then Today / Earlier; approvals and
 * questions can be answered in place.
 */
import { CheckIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { InboxItem } from "../data";
import { useProto } from "../store";
import { InboxKindIcon, ago } from "./bits";

export type InboxFilter = "all" | "needs" | "chats" | "apps";

export function useOpenItem() {
  const go = useProto((s) => s.go);
  const markRead = useProto((s) => s.markRead);
  return (item: InboxItem) => {
    if (item.kind !== "approval" && item.kind !== "input") markRead(item.id);
    if (item.threadId) go({ kind: "chat", threadId: item.threadId });
    else if (item.appId) go({ kind: "app", appId: item.appId });
  };
}

export function filterItems(items: ReadonlyArray<InboxItem>, filter: InboxFilter) {
  return items.filter((i) =>
    filter === "all"
      ? true
      : filter === "needs"
        ? i.kind === "approval" || i.kind === "input"
        : filter === "chats"
          ? Boolean(i.threadId)
          : i.kind === "app",
  );
}

export function groupItems(items: ReadonlyArray<InboxItem>) {
  const needs = items.filter((i) => (i.kind === "approval" || i.kind === "input") && !i.read);
  const rest = items.filter((i) => !needs.includes(i));
  return [
    { label: "Needs you", items: needs },
    { label: "Today", items: rest.filter((i) => i.minAgo < 60 * 12) },
    { label: "Earlier", items: rest.filter((i) => i.minAgo >= 60 * 12) },
  ].filter((g) => g.items.length > 0);
}

export function FilterChips({ value, onChange }: { value: InboxFilter; onChange: (f: InboxFilter) => void }) {
  const inbox = useProto((s) => s.inbox);
  const needs = inbox.filter((i) => (i.kind === "approval" || i.kind === "input") && !i.read).length;
  const chips: ReadonlyArray<{ id: InboxFilter; label: string; count?: number }> = [
    { id: "all", label: "All" },
    { id: "needs", label: "Needs you", count: needs },
    { id: "chats", label: "Chats" },
    { id: "apps", label: "Apps" },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onChange(c.id)}
          className={cn(
            "flex h-6 items-center gap-1 rounded-full px-2.5 text-xs transition-colors",
            value === c.id ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
          )}
        >
          {c.label}
          {c.count ? <span className="tabular-nums opacity-70">{c.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Inline action for an item: Approve, the question's options, or Done. */
export function ItemActions({ item, stop }: { item: InboxItem; stop?: boolean }) {
  const threads = useProto((s) => s.threads);
  const approve = useProto((s) => s.approve);
  const answer = useProto((s) => s.answer);
  const dismiss = useProto((s) => s.dismiss);
  const thread = item.threadId ? threads.find((t) => t.id === item.threadId) : undefined;
  const halt = (e: React.MouseEvent) => {
    if (stop) e.stopPropagation();
  };
  if (item.kind === "approval" && !item.read && thread?.approval) {
    return (
      <div className="flex flex-wrap items-center gap-1.5" onClick={halt}>
        <code className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[11px]">{thread.approval.command}</code>
        <Button size="xs" onClick={() => approve(thread.id)}>
          <CheckIcon /> Approve
        </Button>
        <Button size="xs" variant="outline">
          Deny
        </Button>
      </div>
    );
  }
  if (item.kind === "input" && !item.read && thread?.question) {
    return (
      <div className="flex flex-wrap items-center gap-1.5" onClick={halt}>
        {thread.question.options.map((o) => (
          <Button key={o} size="xs" variant="outline" onClick={() => answer(thread.id, o)}>
            {o}
          </Button>
        ))}
      </div>
    );
  }
  return null;
}

export function InboxRow({
  item,
  selected,
  onClick,
  withActions,
}: {
  item: InboxItem;
  selected?: boolean;
  onClick: () => void;
  withActions?: boolean;
}) {
  const dismiss = useProto((s) => s.dismiss);
  const [hover, setHover] = useState(false);
  return (
    <li
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(
        "group relative flex cursor-pointer gap-2.5 rounded-lg px-2.5 py-2 transition-colors",
        selected ? "bg-sidebar-row-active" : "hover:bg-accent/60",
      )}
      onClick={onClick}
    >
      <InboxKindIcon item={item} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", !item.read ? "font-medium text-foreground" : "text-muted-foreground")}>
            {item.title}
            {item.count ? <span className="ml-1 text-xs text-muted-foreground">×{item.count}</span> : null}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{ago(item.minAgo)}</span>
          {!item.read ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">{item.detail}</div>
        {withActions ? (
          <div className="mt-1.5 empty:hidden">
            <ItemActions item={item} stop />
          </div>
        ) : null}
      </div>
      {hover && item.kind !== "approval" && item.kind !== "input" ? (
        <button
          type="button"
          aria-label="Done"
          title="Done"
          onClick={(e) => {
            e.stopPropagation();
            dismiss(item.id);
          }}
          className="absolute top-2 right-2 grid size-6 place-items-center rounded-md bg-popover text-muted-foreground shadow-xs ring-1 ring-border hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}
