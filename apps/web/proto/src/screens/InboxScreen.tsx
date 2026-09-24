/**
 * C1: Inbox as a page, like Home. The sidebar keeps its chats; only the
 * Inbox row is highlighted. List on the left, the picked item on the right
 * with its action in place.
 */
import { CheckCheckIcon, ExternalLinkIcon, InboxIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { AppGlyph, InboxKindIcon, PageHeader, ago, appName } from "../parts/bits";
import { FilterChips, InboxRow, ItemActions, filterItems, groupItems, useOpenItem, type InboxFilter } from "../parts/InboxList";
import { useProto } from "../store";

export function InboxScreen() {
  const inbox = useProto((s) => s.inbox);
  const threads = useProto((s) => s.threads);
  const markRead = useProto((s) => s.markRead);
  const markAllRead = useProto((s) => s.markAllRead);
  const open = useOpenItem();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>("i-landing");
  const groups = groupItems(filterItems(inbox, filter));
  const selected = inbox.find((i) => i.id === selectedId) ?? null;
  const thread = selected?.threadId ? threads.find((t) => t.id === selected.threadId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={<InboxIcon />}
        title="Inbox"
        right={
          <Button size="xs" variant="ghost" onClick={markAllRead}>
            <CheckCheckIcon /> Mark all read
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[400px] shrink-0 flex-col border-r">
          <div className="px-3 py-2.5">
            <FilterChips value={filter} onChange={setFilter} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="px-2.5 pt-2 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/80">{g.label}</div>
                <ul className="flex flex-col gap-px">
                  {g.items.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      selected={item.id === selectedId}
                      onClick={() => {
                        setSelectedId(item.id);
                        if (item.kind !== "approval" && item.kind !== "input") markRead(item.id);
                      }}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <div className="mx-auto flex max-w-xl flex-col gap-4 px-8 py-8">
              <div className="flex items-center gap-3">
                {selected.appId ? <AppGlyph appId={selected.appId} className="size-9 text-xs" /> : <InboxKindIcon item={selected} className="size-9" />}
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">
                    {selected.appId ? appName(selected.appId) : "Chat"} · {ago(selected.minAgo)}
                  </div>
                  <div className="text-lg font-semibold">{selected.title}</div>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">{selected.detail}</p>
              {thread ? (
                <div className="rounded-xl border bg-card p-3 text-sm">
                  <div className="mb-1 text-[11px] text-muted-foreground">Last message</div>
                  {thread.messages[thread.messages.length - 1]?.text}
                </div>
              ) : null}
              <ItemActions item={selected} />
              <div>
                <Button size="sm" variant="outline" onClick={() => open(selected)}>
                  <ExternalLinkIcon /> {selected.threadId ? "Open chat" : `Open ${appName(selected.appId ?? "")}`}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">Pick something on the left</div>
          )}
        </div>
      </div>
    </div>
  );
}
