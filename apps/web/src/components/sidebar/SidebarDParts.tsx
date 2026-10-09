/**
 * Sidebar D's pieces outside the chat list (prototype
 * reports/day_2026-10-02/sidebar/, variant D):
 * - the header: account + computer with one menu (Settings, Plan & AI,
 *   Billing, Uno console, Help, Sign out), Search ⌘K and New chat as icons;
 * - the places: Home (the start screen — Misha 08.10: "no way back to Home
 *   once you left it"), Files, Apps & sites, and "Needs you" only when an
 *   approval or a question waits (it replaces the bell — the same panel
 *   opens from it);
 * - the collapsed rail: the same places as icons (Home first), Uno and Chats slide the
 *   chats panel out (see sidebarD.hover.ts), expand and the account at the
 *   bottom;
 * - Uno's face, used on the rail, the pinned Uno row and chats Uno started.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleHelpIcon,
  CloudIcon,
  CreditCardIcon,
  FolderIcon,
  HouseIcon,
  InboxIcon,
  LaptopIcon,
  LayoutGridIcon,
  LogInIcon,
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
import { UNO_WORK_URL, accountTransport } from "../../account/unoAccount";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { isLoopbackHostname } from "../../environments/primary";
import { useInboxNeedsYouCount } from "../../inbox/inboxStore";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useStore } from "../../store";
import { cn, isMacPlatform } from "../../lib/utils";
import { useGoHome } from "../../navigation/useGoHome";
import { isWebApp } from "../../webMode";
import { useSwitchEnvironment } from "../../hooks/useSwitchEnvironment";
import { useComputerNames } from "../../proto/computerNames";
import { PROTO } from "../../proto/protoState";
import { BellPanel, InboxBell } from "../inbox/InboxBell";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarHeader, useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InboxCountBadge } from "./SidebarInboxRow";
import {
  SidebarDAccountTrigger,
  SidebarDHeaderIcon,
  openExternal,
  useAccountWho,
} from "./SidebarDAccountButton";
import { accountMenuLines, isHomePath, needsYouPlace } from "./sidebarD.logic";
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

/** The account + computer menu: one place for what used to be the footer. */
export const SidebarDAccountMenu = memo(function SidebarDAccountMenu(props: {
  computerName: string;
  /** "header": avatar, computer name, chevron; "rail": the avatar alone. */
  variant: "header" | "rail";
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const who = useAccountWho();
  const queryClient = useQueryClient();
  const lines = accountMenuLines(accountTransport(), who !== null);
  const canSignOut = isWebApp && !isLoopbackHostname(window.location.hostname);
  const signOutOfDesktop = async () => {
    try {
      await window.desktopBridge?.unoAccount?.signOut();
      // Drop the account's cached answers: the menus fall back to "Sign in with Uno".
      await queryClient.resetQueries({ queryKey: ["workspace"] });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't sign out",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const close = () => {
    if (isMobile) setOpenMobile(false);
    sidebarDPanel.closeNow();
  };
  const trigger = (
    <SidebarDAccountTrigger
      label={props.computerName}
      who={who}
      variant={props.variant}
      chevron={!PROTO}
    />
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
        {PROTO ? <SidebarDComputersGroup close={close} /> : null}
        <MenuItem
          onClick={() => {
            close();
            void navigate({ to: "/settings" });
          }}
        >
          <SettingsIcon />
          Settings
        </MenuItem>
        {lines.signInElsewhere ? (
          // This address can't reach the Uno account: say where it works.
          <MenuItem
            onClick={() => openExternal(UNO_WORK_URL)}
            data-testid="sidebar-sign-in-elsewhere"
          >
            <LogInIcon />
            <span className="flex-1">Sign in at app.uno4.work</span>
            <ArrowUpRightIcon className="opacity-60" />
          </MenuItem>
        ) : null}
        {lines.accountItems ? (
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
        {lines.desktopSignOut ? (
          <>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                close();
                void signOutOfDesktop();
              }}
              data-testid="sidebar-desktop-sign-out"
            >
              <LogOutIcon />
              Sign out of Uno
            </MenuItem>
          </>
        ) : null}
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

/**
 * Sidebar v2 (Misha 09.10): the computers live in the account menu — a click
 * opens that computer (its Home: programs, files, apps) and new chats start
 * there; the sidebar's top no longer says "you are inside X".
 */
function SidebarDComputersGroup(props: { close: () => void }) {
  const names = useComputerNames((state) => state.byId);
  const order = useComputerNames((state) => state.order);
  const activeEnvironmentId = useStore((store) => store.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const current = activeEnvironmentId ?? primaryEnvironmentId;
  const switchEnvironment = useSwitchEnvironment();
  const navigate = useNavigate();
  return (
    <>
      <MenuGroup data-testid="sidebar-account-computers">
        <MenuGroupLabel>Computers</MenuGroupLabel>
        {order.map((id) => {
          const entry = names[id]!;
          return (
            <MenuItem
              key={id}
              onClick={() => {
                props.close();
                if (id === current) void navigate({ to: "/computer" });
                else switchEnvironment(id as EnvironmentId, { landing: "computer" });
              }}
            >
              {entry.kind === "uno_box" ? <CloudIcon /> : <LaptopIcon />}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {entry.kind === "uno_box" ? "in the cloud" : "your computer"}
              </span>
              {id === current ? <CheckIcon className="text-muted-foreground" /> : null}
            </MenuItem>
          );
        })}
        <MenuItem
          onClick={() => {
            props.close();
            void navigate({ to: "/my-uno" });
          }}
        >
          <LayoutGridIcon />
          All computers
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
    </>
  );
}

/** Account and computer on top, Search ⌘K and New chat as icons. No footer. */
export const SidebarDHeader = memo(function SidebarDHeader(props: { isElectron: boolean }) {
  const machineName = useSidebarDComputerName();
  // Sidebar v2 (Misha 09.10): the top says the app, not "you are inside X";
  // the computer is a chip where a new chat starts, and in this menu.
  const computerName = PROTO ? "Uno Work" : machineName;
  const goHome = useGoHome();
  const openPalette = useCommandPaletteStore((store) => store.setOpen);
  const { isMobile, setOpen } = useSidebar();
  const row = (
    <>
      <SidebarDAccountMenu computerName={computerName} variant="header" />
      <SidebarDHeaderIcon
        label="Search"
        hint={`Search commands, projects and chats · ${searchShortcut()}`}
        onClick={() => openPalette(true)}
        testId="sidebar-search"
      >
        <SearchIcon />
      </SidebarDHeaderIcon>
      {PROTO ? (
        // The whole Inbox (finished chats, app news) — the Needs you row below
        // shows only while something waits, as in 0.0.118.
        <span className="no-drag inline-flex">
          <InboxBell />
        </span>
      ) : null}
      <SidebarDHeaderIcon label="New chat" onClick={goHome} testId="sidebar-header-new-chat">
        <SquarePenIcon />
      </SidebarDHeaderIcon>
      {isMobile ? null : (
        <SidebarDHeaderIcon
          label="Collapse sidebar"
          hint="Collapse to icons · ⌘B"
          onClick={() => setOpen(false)}
          testId="sidebar-collapse"
        >
          <PanelLeftCloseIcon />
        </SidebarDHeaderIcon>
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

/** Whether Needs you shows, and its count: approvals and questions waiting, nothing else. */
export function useNeedsYouBadge() {
  const { shown, count } = needsYouPlace(useInboxNeedsYouCount());
  return { needsYou: count, shown };
}

/** "Needs you" — the Inbox (approvals, questions, finished chats, app news) in place of the bell. */
function NeedsYouPopover(props: {
  side: "right" | "bottom";
  trigger: (badge: { needsYou: number }) => ReactNode;
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

/** Home, Files, Apps & sites, and Needs you (only when something waits for the person). */
export const SidebarDPlaces = memo(function SidebarDPlaces() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const open = useOpenPlace();
  const goHome = useGoHome();
  const { shown } = useNeedsYouBadge();
  return (
    <nav aria-label="Uno Work" className="flex flex-col gap-px" data-testid="sidebar-places">
      <PlaceRow
        icon={<HouseIcon />}
        label="Home"
        active={isHomePath(pathname)}
        onClick={() => {
          sidebarDPanel.closeNow();
          goHome();
        }}
        testId="sidebar-nav-home"
        tour="home"
      />
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
              <InboxCountBadge unread={badge.needsYou} needsYou={badge.needsYou} />
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
  const machineName = useSidebarDComputerName();
  const computerName = PROTO ? "Uno Work" : machineName;
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
          label="Home"
          active={isHomePath(pathname)}
          onClick={goHome}
          testId="sidebar-rail-home"
          tour="home"
        >
          <HouseIcon />
        </RailButton>
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
                  unread={badge.needsYou}
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
