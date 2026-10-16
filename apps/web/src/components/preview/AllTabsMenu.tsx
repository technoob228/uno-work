/**
 * "All tabs ▾" at the end of the panel's tab row (w0138, point 4): every tab
 * this chat can see — its own, the project's pins, the ones pinned everywhere
 * — plus documents open in other chats of the project. A click opens the
 * document here; "Go to chat" jumps to the chat that has it. That is how the
 * person glances at a document of another chat without moving it anywhere.
 */
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { BotIcon, ChevronDownIcon, CornerUpRightIcon, LayersIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  isBrowserTab,
  isTasksTab,
  type PreviewFile,
  type PreviewFileKind,
  usePreviewPane,
} from "./PreviewPaneContext";
import { collectAllTabs, type OtherChatTab, type PanelTabsLayout } from "./panelTabs.logic";
import { usePanelChatDirectory } from "./usePanelChats";

type KindIcon = React.ComponentType<{ className?: string }>;

export function AllTabsMenu({
  kindIcon,
  projectName,
  layout,
  open,
  onOpenChange,
}: {
  kindIcon: Record<PreviewFileKind, KindIcon>;
  projectName: string | null;
  layout: PanelTabsLayout;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const {
    statesByScopeKey,
    currentProjectKey,
    currentChatThreadId,
    setActiveFile,
    setOpen,
    openFile,
    openUrl,
    openAppTab,
  } = usePreviewPane();
  const navigate = useNavigate();
  const chatDirectory = usePanelChatDirectory();
  const [query, setQuery] = useState("");

  const sections = useMemo(
    () =>
      open
        ? collectAllTabs({
            states: statesByScopeKey,
            target: { projectKey: currentProjectKey, threadId: currentChatThreadId },
            chatInfo: chatDirectory(),
            query,
          })
        : null,
    [open, statesByScopeKey, currentProjectKey, currentChatThreadId, chatDirectory, query],
  );

  const close = () => {
    onOpenChange(false);
    setQuery("");
  };
  const showHere = (file: PreviewFile) => {
    setOpen(true);
    setActiveFile(file.id);
    close();
  };
  const openHere = (entry: OtherChatTab) => {
    const { file } = entry;
    // A page gets its own new tab (its id belongs to the other chat's webview).
    if (isBrowserTab(file)) openUrl(file.url);
    else if (file.kind === "app") openAppTab(file);
    else {
      const { openedBy: _agentMark, ...copy } = file;
      openFile(copy);
    }
    close();
  };
  const goToChat = (entry: OtherChatTab) => {
    close();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({
        environmentId: entry.chat.environmentId as EnvironmentId,
        threadId: entry.threadId as ThreadId,
      }),
    });
  };

  const total = sections
    ? sections.thisChat.length +
      sections.project.length +
      sections.everywhere.length +
      sections.otherChats.length
    : 0;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <PopoverTrigger
        data-testid="panel-all-tabs"
        title="All tabs — this chat, pinned, and documents open in other chats"
        className={cn(
          "relative inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
        )}
      >
        <LayersIcon className="size-3.5 @[28rem]/panelhead:hidden" />
        <span className="hidden @[28rem]/panelhead:inline">All tabs</span>
        <ChevronDownIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        side="bottom"
        className="w-[22rem] [--viewport-inline-padding:0]"
        data-testid="panel-all-tabs-popup"
      >
        <div className="-mt-4 flex flex-col">
          <label className="flex h-9 items-center gap-2 border-b border-border px-3">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the menu is for finding a tab
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a tab or a document"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </label>
          <div className="max-h-[min(26rem,var(--available-height))] overflow-y-auto py-1">
            {sections ? (
              <>
                <Section
                  title={layout === "project" ? "Only in this chat" : "This chat"}
                  empty={
                    currentChatThreadId && layout === "pins" ? "Nothing open in this chat" : null
                  }
                >
                  {currentChatThreadId
                    ? sections.thisChat.map((file) => (
                        <Row
                          key={file.id}
                          file={file}
                          icon={kindIcon[file.kind]}
                          onClick={() => showHere(file)}
                        />
                      ))
                    : null}
                </Section>
                {currentChatThreadId ? (
                  <Section
                    title={
                      layout === "project"
                        ? `Project · ${projectName ?? "this project"}`
                        : `Pinned · ${projectName ?? "this project"}`
                    }
                    empty={
                      layout === "project"
                        ? null
                        : "Drag a tab left of the line to pin it to the project"
                    }
                  >
                    {sections.project.map((file) => (
                      <Row
                        key={file.id}
                        file={file}
                        icon={kindIcon[file.kind]}
                        onClick={() => showHere(file)}
                      />
                    ))}
                  </Section>
                ) : null}
                <Section title="Everywhere" empty={null}>
                  {sections.everywhere.map((file) => (
                    <Row
                      key={file.id}
                      file={file}
                      icon={kindIcon[file.kind]}
                      onClick={() => showHere(file)}
                    />
                  ))}
                </Section>
                <Section title="In other chats" empty={null}>
                  {sections.otherChats.map((entry) => (
                    <Row
                      key={`${entry.threadId}:${entry.file.id}`}
                      file={entry.file}
                      icon={kindIcon[entry.file.kind]}
                      detail={`chat “${entry.chat.title}”`}
                      onClick={() => openHere(entry)}
                      action={
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            goToChat(entry);
                          }}
                          title={`Go to chat “${entry.chat.title}”`}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100"
                        >
                          <CornerUpRightIcon className="size-3" />
                          Go to chat
                        </button>
                      }
                    />
                  ))}
                </Section>
                {total === 0 && query ? (
                  <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                    No tab or document called “{query}”
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  /** Shown when nothing is in it; null — the section is hidden then. */
  empty: string | null;
  children: ReactNode;
}) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  if (items.length === 0 && empty === null) return null;
  return (
    <div className="px-1 pt-1 pb-0.5">
      <div className="px-2 pt-1 pb-0.5 text-[11px] font-medium text-muted-foreground">{title}</div>
      {items.length > 0 ? (
        items
      ) : (
        <div className="px-2 pb-1 text-[11px] text-muted-foreground/70">{empty}</div>
      )}
    </div>
  );
}

function Row({
  file,
  icon: Icon,
  detail,
  onClick,
  action,
}: {
  file: PreviewFile;
  icon: KindIcon;
  detail?: string;
  onClick: () => void;
  action?: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter") onClick();
      }}
      className={cn(
        "group/row flex cursor-pointer items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:bg-accent",
        detail ? "py-1" : "h-8",
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{isTasksTab(file) ? "Tasks" : file.name}</span>
        {detail ? (
          <span className="truncate text-[11px] leading-tight text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {file.openedBy === "agent" ? (
        <BotIcon
          className="size-3 shrink-0 text-muted-foreground/70"
          aria-label="Opened by the agent"
        />
      ) : null}
      {action}
    </div>
  );
}
