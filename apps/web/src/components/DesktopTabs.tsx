/**
 * Tabs on top of the main area (layout "Desktop tabs", desktop app, Labs):
 * Home first, then every chat, app and file you opened, in the order you
 * opened them. A click goes back there; × closes the tab (the chat, app or
 * file itself stays where it was). The strip doubles as the window's drag
 * area in the desktop app.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  AppWindowIcon,
  FileIcon,
  FolderTreeIcon,
  HouseIcon,
  MessageSquareIcon,
  XIcon,
} from "lucide-react";
import { memo, useEffect, useRef } from "react";

import { useThreadTitle } from "../hooks/useThreadTitle";
import { cn } from "../lib/utils";
import {
  type DesktopTab,
  closeTab,
  tabForLocation,
  upsertTab,
  useDesktopTabsStore,
} from "../navigation/desktopTabs";
import { useGoHome } from "../navigation/useGoHome";

export const DesktopTabs = memo(function DesktopTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const goHome = useGoHome();
  const tabs = useDesktopTabsStore((state) => state.tabs);
  const setTabs = useDesktopTabsStore((state) => state.setTabs);
  const current = tabForLocation(location);
  const activeKey = current?.key ?? null;
  const lastActive = useRef<string | null>(activeKey);

  // Opening a place opens (or refreshes) its tab, right after the tab you came from.
  useEffect(() => {
    if (!current) return;
    const next = upsertTab(useDesktopTabsStore.getState().tabs, current, lastActive.current);
    lastActive.current = current.key;
    const same =
      next.length === tabs.length &&
      next.every((tab, index) => tab.key === tabs[index]?.key && tab.href === tabs[index]?.href);
    if (!same) setTabs(next);
    // `current` is derived from the location; re-run only when the place changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.href]);

  const onHome = location.pathname === "/computer";

  const close = (tab: DesktopTab) => {
    const { tabs: rest, neighbour } = closeTab(tabs, tab.key);
    setTabs(rest);
    if (tab.key !== activeKey) return;
    if (neighbour) void navigate({ href: neighbour.href });
    else goHome();
  };

  return (
    <div
      role="tablist"
      aria-label="Open tabs"
      data-testid="desktop-tabs"
      className="drag-region flex h-10 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-border bg-sidebar px-1.5 pt-1.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={onHome}
        onClick={goHome}
        className={cn(
          "[-webkit-app-region:no-drag] flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-3 text-xs font-medium outline-hidden",
          onHome
            ? "bg-background text-foreground shadow-[0_-1px_0_var(--border)]"
            : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
        )}
      >
        <HouseIcon className="size-3.5" />
        Home
      </button>
      {tabs.map((tab) => (
        <TabButton
          key={tab.key}
          tab={tab}
          active={tab.key === activeKey}
          onSelect={() => void navigate({ href: tab.href })}
          onClose={() => close(tab)}
        />
      ))}
    </div>
  );
});

const KIND_ICON = {
  thread: MessageSquareIcon,
  app: AppWindowIcon,
  file: FileIcon,
  files: FolderTreeIcon,
} as const;

function TabButton(props: {
  tab: DesktopTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { tab } = props;
  const liveTitle = useThreadTitle(
    tab.environmentId as EnvironmentId | null,
    tab.threadId as ThreadId | null,
  );
  const title = liveTitle ?? tab.title;
  const Icon = KIND_ICON[tab.kind];
  return (
    <div
      role="tab"
      aria-selected={props.active}
      title={title}
      className={cn(
        "[-webkit-app-region:no-drag] group/tab flex h-8 max-w-52 min-w-28 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg pr-1 pl-3 text-xs outline-hidden",
        props.active
          ? "bg-background font-medium text-foreground shadow-[0_-1px_0_var(--border)]"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      onClick={props.onSelect}
      onAuxClick={(event) => {
        if (event.button === 1) props.onClose();
      }}
    >
      {tab.icon ? (
        <span className="shrink-0 text-[13px] leading-none">{tab.icon}</span>
      ) : (
        <Icon className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose();
        }}
        className={cn(
          "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
          !props.active && "opacity-0 group-hover/tab:opacity-100",
        )}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
