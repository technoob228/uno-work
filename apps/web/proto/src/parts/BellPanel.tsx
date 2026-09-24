/**
 * C2: the bell's popover. Opens over whatever is on screen; approving,
 * answering and Done happen right here, a click on the row opens the chat or
 * the app and closes the popover. Nothing in the sidebar changes.
 */
import { CheckCheckIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import { useProto } from "../store";
import { FilterChips, InboxRow, filterItems, groupItems, useOpenItem, type InboxFilter } from "./InboxList";

export function BellPanel({ onNavigate }: { onNavigate: () => void }) {
  const inbox = useProto((s) => s.inbox);
  const markAllRead = useProto((s) => s.markAllRead);
  const toast = useProto((s) => s.toast);
  const open = useOpenItem();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const groups = groupItems(filterItems(inbox, filter));
  return (
    <div className="flex max-h-[min(640px,80vh)] flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <span className="text-sm font-semibold">Notifications</span>
        <button
          type="button"
          onClick={markAllRead}
          className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <CheckCheckIcon className="size-3.5" /> Mark all read
        </button>
        <button
          type="button"
          aria-label="Notification settings"
          onClick={() => toast("Notification settings are not part of this prototype")}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <SettingsIcon className="size-3.5" />
        </button>
      </div>
      <div className="px-3 pt-2 pb-1">
        <FilterChips value={filter} onChange={setFilter} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {groups.length === 0 ? <p className="py-10 text-center text-xs text-muted-foreground">You're all caught up</p> : null}
        {groups.map((g) => (
          <div key={g.label}>
            <div className="px-2.5 pt-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/80">{g.label}</div>
            <ul className="flex flex-col gap-px">
              {g.items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  withActions
                  onClick={() => {
                    open(item);
                    onNavigate();
                  }}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
