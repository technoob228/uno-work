/**
 * "Uno" — the assistant as one chat, pinned on top of the sidebar and always
 * there. One click opens it (or sets it up: see `useAssistantChat`). The dot
 * says what it is doing; the paper plane says Telegram carries it too.
 */
import { SendIcon } from "lucide-react";
import { memo } from "react";
import { useParams } from "@tanstack/react-router";

import { useAssistantChannels } from "../../assistant/useAssistantChannels";
import { useAssistantChat } from "../../assistant/useAssistantChat";
import { ASSISTANT_CHAT_NAME } from "../../assistant/assistantChat.logic";
import { cn } from "../../lib/utils";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { useSidebar } from "../ui/sidebar";

const STATUS: Record<
  ReturnType<typeof resolveSidebarThreadStatus>,
  { label: string; dot: string } | null
> = {
  approval: { label: "needs approval", dot: "bg-amber-500" },
  input: { label: "asks you", dot: "bg-indigo-500" },
  working: { label: "working", dot: "animate-pulse bg-sky-500" },
  failed: { label: "failed", dot: "bg-red-500" },
  ready: null,
};

export const SidebarAssistantRow = memo(function SidebarAssistantRow() {
  const { environmentId, chat, opening, open } = useAssistantChat();
  const channels = useAssistantChannels(environmentId);
  const { isMobile, setOpenMobile } = useSidebar();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params)?.threadId ?? null,
  });
  const active = chat !== null && routeThreadId === chat.id;
  const status = chat ? STATUS[resolveSidebarThreadStatus(chat)] : null;
  const subtitle = status?.label ?? "Your assistant · always on";

  return (
    <button
      type="button"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void open();
      }}
      disabled={environmentId === null || opening}
      aria-current={active ? "page" : undefined}
      data-testid="sidebar-uno"
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-hidden ring-ring transition-colors focus-visible:ring-2 disabled:cursor-default",
        active
          ? "bg-sidebar-row-active text-foreground"
          : "text-foreground hover:bg-sidebar-row-hover",
      )}
    >
      <span className="relative grid size-7 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-bold text-primary-foreground">
        U
        <span
          aria-hidden
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar",
            status ? status.dot : "bg-success",
          )}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-semibold">{ASSISTANT_CHAT_NAME}</span>
        <span
          className={cn(
            "truncate text-[11px]",
            status ? "text-foreground/70" : "text-muted-foreground",
          )}
        >
          {subtitle}
        </span>
      </span>
      {channels.telegram === "on" ? (
        <span
          title="Also answers in Telegram"
          className="grid size-5 shrink-0 place-items-center rounded-full bg-sky-500 text-white"
        >
          <SendIcon className="size-2.5" />
        </span>
      ) : null}
    </button>
  );
});
