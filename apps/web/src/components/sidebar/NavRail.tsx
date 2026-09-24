/**
 * Layout "Rail + panel" (Labs → Layout options → Rail): a narrow rail of
 * icons — Home, Inbox with its count, Chats, Files, Apps, the pins, New chat
 * and Settings — and, next to it, the panel of the chosen section (the same
 * sidebar the standard layout uses, one section at a time). A click on the
 * section that is already open folds the panel away; pins and everything
 * else are shared with the standard layout.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  FolderTreeIcon,
  HouseIcon,
  InboxIcon,
  LayoutGridIcon,
  MessagesSquareIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";
import { memo, type ComponentType, type ReactNode } from "react";

import { APP_VERSION } from "../../branding";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useMachineRows } from "../../hooks/useMachineRows";
import { useInboxNeedsYouCount, useInboxUnreadCount } from "../../inbox/inboxStore";
import { cn } from "../../lib/utils";
import { type SidebarMode, useNavStore } from "../../navigation/navStore";
import { useGoHome } from "../../navigation/useGoHome";
import { usePins } from "../../navigation/usePins";
import { SidebarHeader, SidebarTrigger, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PinIcon, useOpenPin, usePinActive } from "./SidebarPinned";
import { InboxCountBadge } from "./SidebarInboxRow";

export const RAIL_WIDTH = "4rem";

const SECTION_TITLE: Record<SidebarMode, string> = {
  home: "Home",
  inbox: "Inbox",
  chats: "Chats",
  files: "Files",
  apps: "Apps",
};

const SECTIONS: ReadonlyArray<{
  mode: Exclude<SidebarMode, "home">;
  Icon: ComponentType<{ className?: string }>;
}> = [
  { mode: "inbox", Icon: InboxIcon },
  { mode: "chats", Icon: MessagesSquareIcon },
  { mode: "files", Icon: FolderTreeIcon },
  { mode: "apps", Icon: LayoutGridIcon },
];

function RailButton(props: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  badge?: ReactNode;
  caption?: boolean;
  testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-pressed={props.active}
            onClick={props.onClick}
            data-testid={props.testId}
            className={cn(
              "relative flex w-12 cursor-pointer flex-col items-center gap-0.5 rounded-xl py-1.5 text-muted-foreground outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              props.active
                ? "bg-sidebar-row-active text-foreground"
                : "hover:bg-sidebar-row-hover hover:text-foreground",
            )}
          />
        }
      >
        <span className="flex size-6 items-center justify-center [&_svg]:size-[18px]">
          {props.children}
        </span>
        {props.caption !== false ? (
          <span className="text-[10px] leading-3 font-medium">{props.label}</span>
        ) : null}
        {props.badge ? <span className="absolute top-0.5 right-1">{props.badge}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function RailPin({ item }: { item: Parameters<typeof PinIcon>[0]["item"] }) {
  const open = useOpenPin();
  const active = usePinActive(item);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={item.title}
            onClick={() => open(item)}
            className={cn(
              "flex size-10 cursor-pointer items-center justify-center rounded-xl border border-border/70 bg-background text-muted-foreground shadow-xs outline-hidden transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              active && "ring-2 ring-primary/50",
            )}
          />
        }
      >
        <PinIcon item={item} />
      </TooltipTrigger>
      <TooltipPopup side="right">{item.title}</TooltipPopup>
    </Tooltip>
  );
}

function useActiveMachineLabel(): string | null {
  const machine = useActiveMachine();
  const rows = useMachineRows();
  const row = rows.find((entry) => entry.environmentId === machine.environmentId);
  return row?.label ?? null;
}

export const NavRail = memo(function NavRail({ isElectron }: { isElectron: boolean }) {
  const mode = useNavStore((state) => state.sidebarMode);
  const setMode = useNavStore((state) => state.setSidebarMode);
  const { open, setOpen } = useSidebar();
  const goHome = useGoHome();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const unread = useInboxUnreadCount();
  const needsYou = useInboxNeedsYouCount();
  const { pins } = usePins();
  const requestNewChat = useNavStore((state) => state.requestNewChat);
  const machineLabel = useActiveMachineLabel();
  const letter = (machineLabel ?? "U").trim().charAt(0).toUpperCase() || "U";

  const choose = (next: SidebarMode) => {
    if (next === mode && open) {
      setOpen(false);
      return;
    }
    setMode(next);
    if (!open) setOpen(true);
  };

  return (
    <nav
      aria-label="Sections"
      data-testid="nav-rail"
      className="sticky top-0 z-30 hidden h-dvh w-(--nav-rail-width) shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar pb-2 md:flex"
      style={{ ["--nav-rail-width" as string]: RAIL_WIDTH }}
    >
      {/* The window's traffic lights sit here in the desktop app. */}
      <div className={cn("w-full shrink-0", isElectron ? "drag-region h-[52px]" : "h-2")} />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="This computer"
              onClick={() => choose("home")}
              className="relative mb-1 flex size-10 cursor-pointer items-center justify-center rounded-xl bg-primary/12 text-sm font-semibold text-primary outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          {letter}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {machineLabel ?? "This computer"} · version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
      <RailButton
        label="Home"
        active={pathname === "/computer" && mode === "home"}
        onClick={() => {
          goHome();
          choose("home");
        }}
        testId="rail-home"
      >
        <HouseIcon />
      </RailButton>
      {SECTIONS.map(({ mode: section, Icon }) => (
        <RailButton
          key={section}
          label={SECTION_TITLE[section]}
          active={mode === section && open}
          onClick={() => choose(section)}
          testId={`rail-${section}`}
          {...(section === "inbox"
            ? { badge: <InboxCountBadge unread={unread} needsYou={needsYou} /> }
            : {})}
        >
          <Icon />
        </RailButton>
      ))}
      {pins.length > 0 ? (
        <div className="mt-1 flex min-h-0 flex-col items-center gap-1.5 overflow-y-auto border-t border-border/60 pt-2">
          {pins.map((item) => (
            <RailPin key={item.id} item={item} />
          ))}
        </div>
      ) : null}
      <div className="mt-auto flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="New chat"
                onClick={() => {
                  if (mode !== "chats") setMode("chats");
                  if (!open) setOpen(true);
                  requestNewChat();
                }}
                className="flex size-10 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm outline-hidden hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          >
            <SquarePenIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="right">New chat</TooltipPopup>
        </Tooltip>
        <RailButton
          label="Settings"
          caption={false}
          active={pathname.startsWith("/settings")}
          onClick={() => void navigate({ to: "/settings" })}
        >
          <SettingsIcon />
        </RailButton>
      </div>
    </nav>
  );
});

/** Title bar of the panel next to the rail. */
export const RailPanelHeader = memo(function RailPanelHeader(props: {
  mode: SidebarMode;
  isElectron: boolean;
}) {
  return (
    <SidebarHeader
      className={cn(
        "flex-row items-center gap-2 px-4",
        props.isElectron ? "drag-region h-[52px] py-0" : "py-3",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
        {SECTION_TITLE[props.mode]}
      </span>
      <Tooltip>
        <TooltipTrigger render={<SidebarTrigger className="size-7 shrink-0" />} />
        <TooltipPopup side="bottom">Hide panel</TooltipPopup>
      </Tooltip>
    </SidebarHeader>
  );
});
