/**
 * T51 (a): "Shared with you" at the top of the sidebar — chats people in my
 * projects shared with me, asked every 30 s (team/teamStore.ts). A row opens
 * the chat's live copy (`/shared/$chatId`). Nothing while sharing is off or
 * nothing is shared.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { firstName } from "../../team/team.logic";
import { useSharedWithMe, useTeamParts } from "../../team/teamStore";
import { TeamAvatar } from "./TeamAvatar";

export const SidebarSharedWithMe = memo(function SidebarSharedWithMe() {
  const parts = useTeamParts();
  const chats = useSharedWithMe();
  const navigate = useNavigate();
  const path = useLocation({ select: (location) => location.pathname });
  if (!parts.share || chats.length === 0) return null;
  return (
    <section className="shrink-0 pb-1.5" data-testid="sidebar-shared-with-me">
      <div className="flex h-6 items-center px-1 text-[11px] font-medium tracking-wide text-sidebar-muted-foreground uppercase">
        Shared with you
      </div>
      <ul role="list" className="flex flex-col gap-0.5">
        {chats.map((chat) => {
          const active = path === `/shared/${chat.id}`;
          return (
            <li key={chat.id} className="list-none">
              <button
                type="button"
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-sidebar-accent",
                  active && "bg-sidebar-accent",
                )}
                title={`${chat.title} · ${chat.projectName}`}
                onClick={() =>
                  void navigate({ to: "/shared/$chatId", params: { chatId: String(chat.id) } })
                }
                data-testid={`sidebar-shared-chat-${chat.id}`}
              >
                <TeamAvatar person={chat.owner} className="size-5" />
                <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">
                  {chat.title || "Shared chat"}
                </span>
                <span className="shrink-0 text-[11px] text-sidebar-muted-foreground">
                  {firstName(chat.owner)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
});
