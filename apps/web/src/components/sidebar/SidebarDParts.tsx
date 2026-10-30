/**
 * Sidebar D's pieces outside the chat list (prototype
 * reports/day_2026-10-02/sidebar/, variant D):
 * - the header: account + computer with one menu (Settings, Plan & AI,
 *   Billing, Uno console, Help, Sign out), Search ⌘K and New chat as icons;
 * - the places: Home (the start screen — Misha 08.10: "no way back to Home
 *   once you left it"), Files, Apps & sites, and "Needs you" only when an
 *   approval or a question waits (it replaces the bell — the same panel
 *   opens from it); since 28.10 they are icons in one row, named on hover;
 * - the collapsed rail: the same places as icons (Home first), Uno and Chats slide the
 *   chats panel out (see sidebarD.hover.ts), expand and the account at the
 *   bottom;
 * - Uno's face, used on the rail, the pinned Uno row and chats Uno started.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CircleHelpIcon,
  CodeXmlIcon,
  CreditCardIcon,
  FolderIcon,
  HouseIcon,
  InboxIcon,
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
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";

import { CONSOLE_URL, consoleLinks } from "../../account/accountOverview";
import { UNO_WORK_URL, accountTransport } from "../../account/unoAccount";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { isLoopbackHostname } from "../../environments/primary";
import { useInboxNeedsYouCount } from "../../inbox/inboxStore";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useStore } from "../../store";
import { cn, isMacPlatform } from "../../lib/utils";
import { useGoHome } from "../../navigation/useGoHome";
import { toggleDevMode, useDevMode } from "../../devMode";
import { FixWorkDialog } from "../../fixWork/FixWorkDialog";
import { FIX_WORK_COPY } from "../../fixWork/fixWork";
import { SidebarPinRow } from "./SidebarPinRow";
import { isWebApp } from "../../webMode";
import { BellPanel } from "../inbox/InboxBell";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarHeader, useSidebar } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useTeamShown } from "../assistants/useAssistantTeam";
import { useAutomationsShown } from "../automations/useAutomations";
import { InboxCountBadge } from "./SidebarInboxRow";
import {
  SidebarDAccountTrigger,
  SidebarDHeaderIcon,
  openExternal,
  useAccountWho,
} from "./SidebarDAccountButton";
import { accountMenuLines, isHomePath, needsYouPlace, placeNamesThatFit } from "./sidebarD.logic";
import { sidebarDPanel } from "./sidebarDState";
import { useOpenFilesInPanel } from "../files/filesPanelTab";
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
    <SidebarDAccountTrigger label={props.computerName} who={who} variant={props.variant} />
  );
  const [fixWorkOpen, setFixWorkOpen] = useState(false);
  return (
    <>
      {fixWorkOpen ? <FixWorkDialog open onOpenChange={setFixWorkOpen} /> : null}
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
        <MenuItem
          data-testid="sidebar-fix-work"
          onClick={() => {
            close();
            setFixWorkOpen(true);
          }}
        >
          <WrenchIcon />
          {FIX_WORK_COPY.menu}
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
    </>
  );
});

/**
 * Account and computer on top, Search ⌘K as an icon. No footer. New chat is Home
 * right below (15.10: a second New chat icon up here squeezed the account name).
 */
export const SidebarDHeader = memo(function SidebarDHeader(props: { isElectron: boolean }) {
  const computerName = useSidebarDComputerName();
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

/**
 * A place as an icon in the one row on top (Misha 28.10: "Home / Files / Apps
 * & sites — icons in one line, the name on hover; they shouldn't get in the
 * way"). The active one is lit. On hover (or keyboard focus) its name grows
 * out of the icon and the icons to its right move over (Misha 29.10, the
 * prototype's "expand") — when the row has room for it; when it hasn't
 * (Automations, Dev mode beside Needs you), a tooltip names it instead of a
 * cut "Fil…".
 */
function PlaceIcon(props: {
  icon: ReactNode;
  /** For the screen reader and the tooltip, and shown when `name` isn't given. */
  label: string;
  /** The name on hover, when the row has no room for `label` ("Apps"). */
  name?: string;
  /** The row has room for the name (`usePlaceNamesFit`); else a tooltip. */
  nameFits: boolean;
  active: boolean;
  onClick: () => void;
  testId: string;
  tour?: string;
  /** A switch (Dev mode): lit while on, `aria-pressed`. */
  pressed?: boolean;
  className?: string;
}) {
  const lit = props.pressed
    ? PLACE_ICON_PRESSED
    : props.active
      ? PLACE_ICON_ACTIVE
      : PLACE_ICON_IDLE;
  return (
    <Tooltip disabled={props.nameFits}>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-pressed={props.pressed}
            onClick={props.onClick}
            data-testid={props.testId}
            data-tour={props.tour}
            data-name-fits={props.nameFits ? "true" : "false"}
            aria-current={props.active ? "page" : undefined}
            className={cn(PLACE_PILL_CLASS, lit, props.className)}
          />
        }
      >
        {props.icon}
        <span
          aria-hidden
          data-place-name=""
          className={cn(PLACE_NAME_CLASS, props.nameFits && PLACE_NAME_GROWS)}
        >
          <span className="overflow-hidden">
            <span className="block overflow-hidden pr-0.5 pl-1 text-[13px] font-medium whitespace-nowrap">
              {props.name ?? props.label}
            </span>
          </span>
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Which names in the row fit (`placeNamesThatFit`), by test id: measured
 * before paint and again when the sidebar is resized, a place comes or goes
 * (`items`) or the font arrives — known before the pointer gets there, so the
 * tooltip of a name that doesn't fit is ready on the first hover.
 */
function usePlaceNamesFit(
  row: RefObject<HTMLElement | null>,
  items: string,
): (testId: string) => boolean {
  const [fitting, setFitting] = useState<string>("");
  useLayoutEffect(() => {
    const nav = row.current;
    if (!nav) return;
    let live = true;
    const update = () => {
      if (live) setFitting(placeNamesFittingIn(nav));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    void document.fonts?.ready.then(update);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [row, items]);
  return (testId) => fitting.split(" ").includes(testId);
}

/** The row's test ids whose names fit, space-separated (a string: no new state when nothing changed). */
function placeNamesFittingIn(nav: HTMLElement): string {
  const style = getComputedStyle(nav);
  const width =
    nav.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  const children = [...nav.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );
  const items = children.map((child) => {
    const name = child.querySelector<HTMLElement>("[data-place-name]");
    const full = child.getBoundingClientRect().width;
    if (!name) return { rest: full, name: null };
    // At rest without the name, whether or not it shows right now; the name's own width.
    const text = name.firstElementChild?.firstElementChild;
    return {
      rest: full - name.getBoundingClientRect().width,
      name: text instanceof HTMLElement ? text.scrollWidth : null,
    };
  });
  const fits = placeNamesThatFit({ width, gap: parseFloat(style.columnGap) || 0, items });
  return children
    .filter((child, index) => fits[index] && child.dataset.testid)
    .map((child) => child.dataset.testid)
    .join(" ");
}

/**
 * Dev mode as a switch at the end of the row (Misha 29.10): the terminal,
 * Revert and the context meter in chats. Lit while on; Settings keeps its
 * own switch.
 */
function DevModePlace(props: { nameFits: boolean }) {
  const devMode = useDevMode();
  return (
    <PlaceIcon
      icon={<CodeXmlIcon />}
      label="Dev mode"
      nameFits={props.nameFits}
      active={false}
      pressed={devMode}
      onClick={toggleDevMode}
      testId="sidebar-nav-dev-mode"
      className="ml-auto"
    />
  );
}

function PlaceRow(props: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick?: () => void;
  testId: string;
  tour?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-hidden ring-ring transition-colors focus-visible:ring-2 [&_svg]:size-4 [&_svg]:shrink-0",
        props.active
          ? "bg-sidebar-row-active font-medium text-foreground"
          : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      data-testid={props.testId}
      data-tour={props.tour}
      aria-current={props.active ? "page" : undefined}
    >
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
    </button>
  );
}

/** Needs you in the row: 28 px wide like the places at rest. */
const PLACE_ICON_CLASS =
  "relative grid h-8 w-7 shrink-0 cursor-pointer place-items-center rounded-lg outline-hidden ring-ring transition-colors focus-visible:ring-2 [&_svg]:size-4 [&_svg]:shrink-0";
/** `PlaceIcon`: an icon that grows its name — 28 px wide until then (Misha 29.10: denser). */
const PLACE_PILL_CLASS =
  "group/place relative inline-flex h-8 min-w-7 shrink cursor-pointer items-center justify-center rounded-lg px-1.5 outline-hidden ring-ring transition-colors focus-visible:ring-2 [&_svg]:size-4 [&_svg]:shrink-0";
/** The name in it: no width until hover or focus, then its own — only when it fits (`PLACE_NAME_GROWS`). */
const PLACE_NAME_CLASS =
  "grid min-w-0 grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none";
const PLACE_NAME_GROWS =
  "group-hover/place:grid-cols-[1fr] group-focus-visible/place:grid-cols-[1fr]";
const PLACE_ICON_ACTIVE = "bg-sidebar-row-active text-foreground";
const PLACE_ICON_PRESSED = "bg-primary/12 text-primary hover:bg-primary/18";
const PLACE_ICON_IDLE =
  "text-sidebar-foreground/70 hover:bg-sidebar-row-hover hover:text-foreground data-[popup-open]:bg-sidebar-row-hover";

function useOpenPlace() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const openFilesInPanel = useOpenFilesInPanel(isMobile);
  return (to: "/files" | "/sites" | "/automations") => {
    if (isMobile) setOpenMobile(false);
    sidebarDPanel.closeNow();
    // In a chat, Files opens on the right, beside it (Misha 18.10).
    if (to === "/files" && openFilesInPanel()) return;
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

/**
 * Home, Files, Apps & sites, Automations (with the assistants, 28.10) — and
 * Needs you only when something waits for the person — as icons in one row,
 * the name on hover; Dev mode's switch at the end.
 */
const SidebarDPlaceIcons = memo(function SidebarDPlaceIcons() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const open = useOpenPlace();
  const goHome = useGoHome();
  const { shown } = useNeedsYouBadge();
  const automations = useAutomationsShown();
  const row = useRef<HTMLElement>(null);
  const nameFits = usePlaceNamesFit(row, `${automations} ${shown}`);
  return (
    <nav
      ref={row}
      aria-label="Uno Work"
      // The sidebar's width, not its icons': the names are measured against it.
      className="flex w-full min-w-0 items-center gap-0.5 px-0.5"
      data-testid="sidebar-places"
    >
      <PlaceIcon
        icon={<HouseIcon />}
        label="Home"
        active={isHomePath(pathname)}
        onClick={() => {
          sidebarDPanel.closeNow();
          goHome();
        }}
        testId="sidebar-nav-home"
        nameFits={nameFits("sidebar-nav-home")}
        tour="home"
      />
      <PlaceIcon
        icon={<FolderIcon />}
        label="Files"
        active={pathname.startsWith("/files")}
        onClick={() => open("/files")}
        testId="sidebar-nav-files"
        nameFits={nameFits("sidebar-nav-files")}
        tour="files"
      />
      <PlaceIcon
        icon={<LayoutGridIcon />}
        label="Apps & sites"
        name="Apps"
        active={pathname.startsWith("/sites")}
        onClick={() => open("/sites")}
        testId="sidebar-nav-apps"
        nameFits={nameFits("sidebar-nav-apps")}
        tour="apps"
      />
      {automations ? (
        <PlaceIcon
          icon={<WorkflowIcon />}
          label="Automations"
          active={pathname.startsWith("/automations")}
          onClick={() => open("/automations")}
          testId="sidebar-nav-automations"
          nameFits={nameFits("sidebar-nav-automations")}
        />
      ) : null}
      {shown ? (
        <NeedsYouPopover
          side="bottom"
          trigger={(badge) => (
            <Tooltip>
              <TooltipTrigger
                render={
                  <PopoverTrigger
                    aria-label="Needs you"
                    className={cn(PLACE_ICON_CLASS, PLACE_ICON_IDLE)}
                    data-testid="sidebar-needs-you"
                  />
                }
              >
                <InboxIcon />
                <InboxCountBadge
                  unread={badge.needsYou}
                  needsYou={badge.needsYou}
                  className="absolute -top-0.5 -right-0.5 min-w-4 px-0.5 text-[9px] leading-4"
                />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Needs you</TooltipPopup>
            </Tooltip>
          )}
        />
      ) : null}
      <DevModePlace nameFits={nameFits("sidebar-nav-dev-mode")} />
    </nav>
  );
});

/**
 * The places as rows (v0.0.156): what an account without the assistants
 * update (`assistants_mvp`) keeps seeing — Home, Files, Apps & sites, and
 * Needs you only when something waits.
 */
const SidebarDPlaceRows = memo(function SidebarDPlaceRows() {
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

/**
 * Home, Files, Apps & sites (+ Needs you): icons in one row with the
 * assistants update (28.10), else the v0.0.156 rows.
 */
export const SidebarDPlaces = memo(function SidebarDPlaces() {
  return useTeamShown() ? (
    <>
      <SidebarDPlaceIcons />
      <SidebarPinRow />
    </>
  ) : (
    <SidebarDPlaceRows />
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
  const automations = useAutomationsShown();
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
        {automations ? (
          <RailButton
            label="Automations"
            active={pathname.startsWith("/automations")}
            onClick={() => open("/automations")}
            testId="sidebar-rail-automations"
          >
            <WorkflowIcon />
          </RailButton>
        ) : null}
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
