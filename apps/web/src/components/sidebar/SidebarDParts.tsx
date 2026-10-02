/**
 * Sidebar D's pieces outside the chat list (prototype
 * reports/day_2026-10-02/sidebar/, variant D):
 * - the header: account + computer with one menu (Settings, Plan & AI,
 *   Billing, Uno console, Help, Sign out), Search ⌘K and New chat as icons;
 * - the places: Files, Apps & sites, and "Needs you" only when something
 *   waits (it replaces the bell — the same panel opens from it);
 * - the collapsed rail: the same places as icons, Uno and Chats slide the
 *   chats panel out (see sidebarD.hover.ts), expand and the account at the
 *   bottom;
 * - Uno's face, used on the rail, the pinned Uno row and chats Uno started.
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  CreditCardIcon,
  FolderIcon,
  InboxIcon,
  LayoutGridIcon,
  LogOutIcon,
  MessagesSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  SquarePenIcon,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { CONSOLE_URL, consoleLinks } from "../../account/accountOverview";
import { accountTransport } from "../../account/unoAccount";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { isLoopbackHostname } from "../../environments/primary";
import { useInboxNeedsYouCount, useInboxUnreadCount } from "../../inbox/inboxStore";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useStore } from "../../store";
import { cn, isMacPlatform } from "../../lib/utils";
import { useGoHome } from "../../navigation/useGoHome";
import { isWebApp } from "../../webMode";
import { BellPanel } from "../inbox/InboxBell";
import { balanceQuery } from "../myuno/myUnoQueries";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarHeader, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InboxCountBadge } from "./SidebarInboxRow";
import { sidebarDPanel } from "./sidebarDState";
import { useSidebarEnvironmentLabelResolver } from "./useSidebarMachineIdentities";

/** The computer this window works on, by the name the person knows it by. */
export function useSidebarDComputerName(): string {
  const activeEnvironmentId = useStore((store) => store.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const resolve = useSidebarEnvironmentLabelResolver();
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  return (environmentId ? resolve(environmentId) : null) ?? "This computer";
}

/** Uno's face: a calm smile on the brand colour, with an online dot when asked. */
export function UnoFace({
  className,
  online,
  title,
}: {
  className?: string;
  online?: boolean;
  title?: string;
}) {
  return (
    <span
      className={cn("relative inline-flex shrink-0", className ?? "size-5")}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-testid="uno-face"
    >
      <svg viewBox="0 0 20 20" className="size-full" aria-hidden>
        <circle cx="10" cy="10" r="10" className="fill-primary" />
        <circle cx="7" cy="8.3" r="1.25" className="fill-primary-foreground" />
        <circle cx="13" cy="8.3" r="1.25" className="fill-primary-foreground" />
        <path
          d="M6.4 11.6c.9 1.5 2.1 2.2 3.6 2.2s2.7-.7 3.6-2.2"
          fill="none"
          strokeWidth="1.5"
          strokeLinecap="round"
          className="stroke-primary-foreground"
        />
      </svg>
      {online ? (
        <span
          aria-hidden
          className="absolute -right-px -bottom-px size-[42%] rounded-full border-[1.5px] border-sidebar bg-success"
        />
      ) : null}
    </span>
  );
}

const searchShortcut = () =>
  typeof navigator !== "undefined" && isMacPlatform(navigator.platform) ? "⌘K" : "Ctrl+K";

function openExternal(url: string) {
  if (isWebApp) window.open(url, "_blank", "noopener,noreferrer");
  else openInstallDocs(url);
}

function initialsOf(who: string | null): string {
  if (!who) return "";
  const name = who.split("@")[0] ?? who;
  const parts = name.split(/[._\-\s]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

function useAccountWho(): string | null {
  const hasAccount = accountTransport() !== "none";
  const balance = useQuery({ ...balanceQuery(), enabled: hasAccount });
  return balance.data?.email ?? balance.data?.username ?? null;
}

function Avatar({ who, className }: { who: string | null; className?: string }) {
  const initials = initialsOf(who);
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full bg-primary/85 text-[10px] font-semibold text-primary-foreground",
        className,
      )}
    >
      {initials || "U"}
    </span>
  );
}

/** The account + computer menu: one place for what used to be the footer. */
export const SidebarDAccountMenu = memo(function SidebarDAccountMenu(props: {
  computerName: string;
  /** "header": avatar, computer name, chevron; "rail": the avatar alone. */
  variant: "header" | "rail";
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const who = useAccountWho();
  const hasAccount = accountTransport() !== "none";
  const canSignOut = isWebApp && !isLoopbackHostname(window.location.hostname);
  const close = () => {
    if (isMobile) setOpenMobile(false);
    sidebarDPanel.closeNow();
  };
  const trigger =
    props.variant === "header" ? (
      <MenuTrigger
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover no-drag"
        data-testid="sidebar-account"
        aria-label={`${props.computerName}: account and settings`}
      >
        <Avatar who={who} />
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
          {props.computerName}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
    ) : (
      <MenuTrigger
        className="grid size-9 cursor-pointer place-items-center rounded-lg outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover"
        data-testid="sidebar-rail-account"
        aria-label={`${props.computerName}: account and settings`}
      >
        <Avatar who={who} className="size-7" />
      </MenuTrigger>
    );
  return (
    <Menu>
      {trigger}
      <MenuPopup
        align="start"
        side={props.variant === "rail" ? "right" : "bottom"}
        className="min-w-60"
        data-testid="sidebar-account-menu"
      >
        <div className="px-2 py-1.5 leading-tight">
          <p className="truncate text-sm font-medium">{props.computerName}</p>
          {who ? <p className="truncate text-xs text-muted-foreground">{who}</p> : null}
        </div>
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            close();
            void navigate({ to: "/settings" });
          }}
        >
          <SettingsIcon />
          Settings
        </MenuItem>
        {hasAccount ? (
          <>
            <MenuItem
              onClick={() => {
                close();
                void navigate({ to: "/my-uno", search: { tab: "billing" } });
              }}
            >
              <SparklesIcon />
              Plan &amp; AI
            </MenuItem>
            <MenuItem onClick={() => openExternal(consoleLinks.plans)}>
              <CreditCardIcon />
              <span className="flex-1">Billing</span>
              <ArrowUpRightIcon className="opacity-60" />
            </MenuItem>
            <MenuItem onClick={() => openExternal(CONSOLE_URL)}>
              <ArrowUpRightIcon />
              Uno console
            </MenuItem>
          </>
        ) : null}
        <MenuItem onClick={() => openExternal(`${CONSOLE_URL}/docs`)}>
          <CircleHelpIcon />
          <span className="flex-1">Help</span>
          <ArrowUpRightIcon className="opacity-60" />
        </MenuItem>
        {canSignOut ? (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                window.location.href = "/logout";
              }}
              data-testid="sidebar-sign-out"
            >
              <LogOutIcon />
              Sign out
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

function HeaderIcon(props: {
  label: string;
  hint?: string;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            onClick={props.onClick}
            data-testid={props.testId}
            className="no-drag inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.hint ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Account and computer on top, Search ⌘K and New chat as icons. No footer. */
export const SidebarDHeader = memo(function SidebarDHeader(props: { isElectron: boolean }) {
  const computerName = useSidebarDComputerName();
  const goHome = useGoHome();
  const openPalette = useCommandPaletteStore((store) => store.setOpen);
  const { isMobile, setOpen } = useSidebar();
  const row = (
    <>
      <SidebarDAccountMenu computerName={computerName} variant="header" />
      <HeaderIcon
        label="Search"
        hint={`Search chats, files and apps · ${searchShortcut()}`}
        onClick={() => openPalette(true)}
        testId="sidebar-search"
      >
        <SearchIcon />
      </HeaderIcon>
      <HeaderIcon label="New chat" onClick={goHome} testId="sidebar-header-new-chat">
        <SquarePenIcon />
      </HeaderIcon>
      {isMobile ? null : (
        <HeaderIcon
          label="Collapse sidebar"
          hint="Collapse to icons · ⌘B"
          onClick={() => setOpen(false)}
          testId="sidebar-collapse"
        >
          <PanelLeftCloseIcon />
        </HeaderIcon>
      )}
    </>
  );
  return props.isElectron ? (
    <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-0.5 overflow-hidden px-2 py-0 pl-[78px] fullscreen:pl-2 wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)]">
      {row}
    </SidebarHeader>
  ) : (
    <SidebarHeader className="flex-row items-center gap-0.5 px-2 py-2 sm:py-2.5">
      {row}
    </SidebarHeader>
  );
});

function PlaceRow(props: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick?: () => void;
  testId: string;
  tour?: string;
  trailing?: ReactNode;
  render?: (className: string, children: ReactNode) => ReactNode;
}) {
  const className = cn(
    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-hidden ring-ring transition-colors focus-visible:ring-2 [&_svg]:size-4 [&_svg]:shrink-0",
    props.active
      ? "bg-sidebar-row-active font-medium text-foreground"
      : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-foreground",
  );
  const children = (
    <>
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.trailing}
    </>
  );
  if (props.render) return <>{props.render(className, children)}</>;
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={className}
      data-testid={props.testId}
      data-tour={props.tour}
      aria-current={props.active ? "page" : undefined}
    >
      {children}
    </button>
  );
}

function useOpenPlace() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return (to: "/files" | "/sites") => {
    if (isMobile) setOpenMobile(false);
    sidebarDPanel.closeNow();
    void navigate({ to });
  };
}

/** Whether Needs you shows, and its count (what needs the person, else unread news). */
export function useNeedsYouBadge() {
  const unread = useInboxUnreadCount();
  const needsYou = useInboxNeedsYouCount();
  return { unread, needsYou, shown: unread > 0 || needsYou > 0 };
}

/** "Needs you" — the Inbox (approvals, questions, finished chats, app news) in place of the bell. */
function NeedsYouPopover(props: {
  side: "right" | "bottom";
  trigger: (badge: { unread: number; needsYou: number }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const badge = useNeedsYouBadge();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {props.trigger(badge)}
      <PopoverPopup
        side={props.side}
        align="start"
        className="w-[min(26rem,calc(100vw-1.5rem))] [--viewport-inline-padding:0px]"
        data-testid="inbox-popover"
      >
        <BellPanel
          onClose={() => {
            setOpen(false);
            sidebarDPanel.closeNow();
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** Files, Apps & sites, and Needs you (only when something waits). */
export const SidebarDPlaces = memo(function SidebarDPlaces() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const open = useOpenPlace();
  const { shown } = useNeedsYouBadge();
  return (
    <nav aria-label="Uno Work" className="flex flex-col gap-px" data-testid="sidebar-places">
      <PlaceRow
        icon={<FolderIcon />}
        label="Files"
        active={pathname.startsWith("/files")}
        onClick={() => open("/files")}
        testId="sidebar-nav-files"
        tour="files"
      />
      <PlaceRow
        icon={<LayoutGridIcon />}
        label="Apps & sites"
        active={pathname.startsWith("/sites")}
        onClick={() => open("/sites")}
        testId="sidebar-nav-apps"
        tour="apps"
      />
      {shown ? (
        <NeedsYouPopover
          side="right"
          trigger={(badge) => (
            <PopoverTrigger
              className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm text-sidebar-foreground/85 outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 data-[popup-open]:bg-sidebar-row-hover [&_svg]:size-4 [&_svg]:shrink-0"
              data-testid="sidebar-needs-you"
            >
              <InboxIcon />
              <span className="min-w-0 flex-1 truncate">Needs you</span>
              <InboxCountBadge
                unread={Math.max(badge.unread, badge.needsYou)}
                needsYou={badge.needsYou}
              />
            </PopoverTrigger>
          )}
        />
      ) : null}
    </nav>
  );
});

function RailButton(props: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  testId: string;
  tour?: string;
  children: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            onClick={props.onClick}
            onPointerEnter={props.onPointerEnter}
            onPointerLeave={props.onPointerLeave}
            data-testid={props.testId}
            data-tour={props.tour}
            aria-current={props.active ? "page" : undefined}
            className={cn(
              "relative grid size-9 cursor-pointer place-items-center rounded-lg outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-[18px]",
              props.active
                ? "bg-sidebar-row-active text-foreground"
                : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
            )}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export const SIDEBAR_D_RAIL_WIDTH = "56px";

/**
 * The collapsed sidebar: a rail of icons that never hides, so the page
 * doesn't jump. Files, Apps & sites and Needs you just open (tooltip on
 * hover); Uno and Chats slide the chats panel out over the page.
 */
export const SidebarDRail = memo(function SidebarDRail(props: { isElectron: boolean }) {
  const computerName = useSidebarDComputerName();
  const pathname = useLocation({ select: (location) => location.pathname });
  const goHome = useGoHome();
  const openPalette = useCommandPaletteStore((store) => store.setOpen);
  const open = useOpenPlace();
  const { setOpen } = useSidebar();
  const { shown } = useNeedsYouBadge();
  const hover = {
    onPointerEnter: () => sidebarDPanel.enterTrigger(),
    onPointerLeave: () => sidebarDPanel.leave(),
    onClick: () => sidebarDPanel.openNow(),
  };
  return (
    <aside
      aria-label="Uno Work"
      data-testid="sidebar-rail"
      style={{ width: SIDEBAR_D_RAIL_WIDTH }}
      className={cn(
        "relative z-20 flex h-dvh shrink-0 flex-col items-center gap-1 border-r border-border bg-card pb-2",
        props.isElectron ? "drag-region pt-[52px] fullscreen:pt-2" : "pt-2",
      )}
    >
      <div className="no-drag flex flex-col items-center gap-1">
        <RailButton label="New chat" onClick={goHome} testId="sidebar-rail-new-chat">
          <SquarePenIcon />
        </RailButton>
        <RailButton
          label={`Search · ${searchShortcut()}`}
          onClick={() => openPalette(true)}
          testId="sidebar-rail-search"
        >
          <SearchIcon />
        </RailButton>
        <span aria-hidden className="my-1 h-px w-6 bg-border" />
        <RailButton
          label="Files"
          active={pathname.startsWith("/files")}
          onClick={() => open("/files")}
          testId="sidebar-rail-files"
          tour="files"
        >
          <FolderIcon />
        </RailButton>
        <RailButton
          label="Apps & sites"
          active={pathname.startsWith("/sites")}
          onClick={() => open("/sites")}
          testId="sidebar-rail-apps"
          tour="apps"
        >
          <LayoutGridIcon />
        </RailButton>
        {shown ? (
          <NeedsYouPopover
            side="right"
            trigger={(badge) => (
              <PopoverTrigger
                aria-label="Needs you"
                data-testid="sidebar-rail-needs-you"
                className="relative grid size-9 cursor-pointer place-items-center rounded-lg text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover [&_svg]:size-[18px]"
              >
                <InboxIcon />
                <InboxCountBadge
                  unread={Math.max(badge.unread, badge.needsYou)}
                  needsYou={badge.needsYou}
                  className="absolute -top-0.5 -right-0.5 min-w-4 px-0.5 text-[9px] leading-4"
                />
              </PopoverTrigger>
            )}
          />
        ) : null}
        <span aria-hidden className="my-1 h-px w-6 bg-border" />
        <RailButton label="Uno and its chats" testId="sidebar-rail-uno" {...hover}>
          <UnoFace className="size-6" online />
        </RailButton>
        <RailButton label="Chats" testId="sidebar-rail-chats" {...hover}>
          <MessagesSquareIcon />
        </RailButton>
      </div>
      <div className="no-drag mt-auto flex flex-col items-center gap-1">
        <RailButton
          label="Expand sidebar · ⌘B"
          onClick={() => setOpen(true)}
          testId="sidebar-expand"
        >
          <PanelLeftIcon />
        </RailButton>
        <SidebarDAccountMenu computerName={computerName} variant="rail" />
      </div>
    </aside>
  );
});
