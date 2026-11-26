/**
 * "Hand to…" (T63): the chats the person handed to a chat, one quiet line
 * each right under that chat's row — "↳ Pricing page · handled". A click
 * opens it; right-click is the chat's own menu (Take back is there). A
 * handed chat that itself handles others shows them one step further in
 * (chains are at most three deep).
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CornerDownRightIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { SidebarThreadSummary } from "../../types";

export function HandedChatLines(props: {
  readonly chats: ReadonlyArray<SidebarThreadSummary>;
  readonly nestedOf: (thread: SidebarThreadSummary) => ReadonlyArray<SidebarThreadSummary>;
  readonly isActive: (thread: SidebarThreadSummary) => boolean;
  readonly onOpen: (ref: ScopedThreadRef) => void;
  readonly onContextMenu: (ref: ScopedThreadRef, position: { x: number; y: number }) => void;
  readonly depth?: number;
}) {
  const depth = props.depth ?? 1;
  return (
    <>
      {props.chats.map((thread) => {
        const ref = scopeThreadRef(thread.environmentId, thread.id);
        const active = props.isActive(thread);
        const inner = depth < 3 ? props.nestedOf(thread) : [];
        return (
          <li
            key={`handed:${thread.environmentId}:${thread.id}`}
            className="list-none"
            data-testid="sidebar-handed-chat"
          >
            <button
              type="button"
              title={`${thread.title} — handled by the chat above`}
              aria-current={active ? "page" : undefined}
              onClick={() => props.onOpen(ref)}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(ref, { x: event.clientX, y: event.clientY });
              }}
              style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
              className={cn(
                "flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-[13px] outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                active
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-row-hover",
              )}
            >
              <CornerDownRightIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">handled</span>
            </button>
            {inner.length > 0 ? (
              <ul className="m-0 p-0">
                <HandedChatLines {...props} chats={inner} depth={depth + 1} />
              </ul>
            ) : null}
          </li>
        );
      })}
    </>
  );
}
