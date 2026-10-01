/**
 * Sidebar chrome shared by the chat-list sidebar and the legacy grouped one:
 * the branded header row and the utility footer.
 *
 * Mirrors upstream T3 Code's `sidebar/SidebarChrome.tsx` in shape (header,
 * utility menu of icon buttons, footer), with Uno Work's own wordmark instead
 * of the T3 stage backdrop, and the machine switcher folded into the footer
 * row next to the utility icons.
 */
import {
  ArrowUpRightIcon,
  BotIcon,
  ChevronUpIcon,
  CircleUserIcon,
  CreditCardIcon,
  SettingsIcon,
  SparklesIcon,
  SquarePenIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { CONSOLE_URL, consoleLinks } from "../../account/accountOverview";
import { accountTransport } from "../../account/unoAccount";
import { APP_BASE_NAME, APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { isElectron as runningInElectron } from "../../env";
import { useServerKeybindings } from "../../rpc/serverState";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { sidebarToggleLabel } from "./sidebarShortcut";
import { cn } from "../../lib/utils";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { SidebarWorkspaceSwitcher } from "../SidebarWorkspaceSwitcher";
import { SidebarFooter, SidebarHeader, SidebarTrigger, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { InboxBell } from "../inbox/InboxBell";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { useGoHome } from "../../navigation/useGoHome";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  showBell = false,
  showNewChat = false,
}: {
  isElectron: boolean;
  /** The Inbox bell next to the logo (the chat-list sidebar; not settings). */
  showBell?: boolean;
  /** "New chat" next to the logo: the start screen, where the composer is. */
  showNewChat?: boolean;
}) {
  const shortcut = sidebarToggleLabel(useServerKeybindings());
  const wordmark = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {/* With "New chat" the row has no room for the hide button in the
          browser: ⌘B and the sidebar's edge hide it, the Menu button brings
          it back. The desktop app keeps it (New chat is an icon there). */}
      {showNewChat && !isElectron ? null : (
        <Tooltip>
          <TooltipTrigger render={<SidebarTrigger className="size-7 shrink-0" />} />
          <TooltipPopup side="bottom">
            Hide sidebar{shortcut ? ` · ${shortcut}` : ""}. The Menu button brings it back.
          </TooltipPopup>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Home"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
              to="/computer"
            >
              <span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center rounded-md bg-primary font-bold text-[11px] text-primary-foreground"
              >
                U
              </span>
              <span className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">
                {APP_BASE_NAME}
              </span>
              {showNewChat ? null : (
                <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-primary">
                  {APP_STAGE_LABEL}
                </span>
              )}
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Start screen · version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return isElectron ? (
    <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 overflow-hidden px-4 py-0 pl-[78px] fullscreen:pl-4 wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)]">
      {wordmark}
      {showNewChat ? <SidebarNewChatButton iconOnly /> : null}
      {showBell ? <InboxBell /> : null}
    </SidebarHeader>
  ) : (
    <SidebarHeader
      className={cn(
        "flex-row items-center px-3 py-2 sm:py-3",
        showNewChat ? "gap-1.5" : "gap-3 sm:gap-2.5 sm:px-4",
      )}
    >
      {wordmark}
      {showNewChat ? <SidebarNewChatButton /> : null}
      {showBell ? <InboxBell /> : null}
    </SidebarHeader>
  );
});

/**
 * "New chat" — the start screen: one field "What should we do?", and the
 * chat starts when the person sends it. Same place as the logo, on purpose:
 * there is one way in.
 */
function SidebarNewChatButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const goHome = useGoHome();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={goHome}
            aria-label="New chat"
            data-testid="sidebar-header-new-chat"
            className={cn(
              "no-drag inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-primary text-xs font-semibold whitespace-nowrap text-primary-foreground shadow-xs outline-hidden transition-colors hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring",
              iconOnly ? "w-7 justify-center" : "px-2",
            )}
          />
        }
      >
        <SquarePenIcon className="size-3.5" />
        {iconOnly ? null : "New chat"}
      </TooltipTrigger>
      <TooltipPopup side="bottom">Start a new chat</TooltipPopup>
    </Tooltip>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Upstream's footer is a row of icon buttons. Ours keeps Settings and adds
 * Helper (the assistant's home, which the chat list keeps out of the main
 * list), then spends the rest of the row on the machine switcher — Uno Work's
 * sidebar spans machines, so "which machine" stays one click away.
 */
export const SidebarUtilityMenu = memo(function SidebarUtilityMenu(props: {
  showHelper?: boolean;
}) {
  const navigate = useNavigate();
  const allMachinesSidebar = useFeatureFlag("allMachinesSidebar");
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);
  const handleHelperClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/assistant" });
  }, [closeMobileSidebar, navigate]);

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <SidebarUtilityItem icon={<SettingsIcon />} label="Settings" onClick={handleSettingsClick} />
      <ConsoleExitItem />
      {props.showHelper ? (
        <SidebarUtilityItem icon={<BotIcon />} label="Helper" onClick={handleHelperClick} />
      ) : null}
      <div className="ml-1 min-w-0 flex-1">
        {/* The computer switcher lives at the top of the sidebar now. */}
        {allMachinesSidebar ? <SidebarWorkspaceSwitcher variant="compact" /> : null}
      </div>
    </div>
  );
});

/**
 * The way out to the Uno console (Rama 26.09: he came from the console and
 * couldn't "close" Uno Work to get back). In the browser it leaves in the same
 * tab, like a back link; the desktop app opens the console in the browser.
 */
function ConsoleExitItem() {
  if (accountTransport() === "none") return null;
  return (
    <SidebarUtilityItem
      icon={<ArrowUpRightIcon />}
      label={runningInElectron ? "Open Uno console" : "Back to Uno console"}
      onClick={() => {
        if (runningInElectron) openInstallDocs(CONSOLE_URL);
        else window.location.assign(CONSOLE_URL);
      }}
    />
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter(props: {
  showHelper?: boolean;
  /** The simple footer (01.10): Settings and the account menu, with words. */
  simple?: boolean;
}) {
  return (
    <SidebarFooter className="gap-1 px-[var(--sidebar-content-inset)] py-1.5">
      <SidebarUpdatePill />
      {props.simple ? (
        <SidebarSimpleFooterRow />
      ) : (
        <SidebarUtilityMenu showHelper={props.showHelper ?? false} />
      )}
    </SidebarFooter>
  );
});

const FOOTER_ROW_CLASS =
  "flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0";

/** Settings, and — where the account is reachable — the account menu. */
function SidebarSimpleFooterRow() {
  const navigate = useNavigate();
  const allMachinesSidebar = useFeatureFlag("allMachinesSidebar");
  const { isMobile, setOpenMobile } = useSidebar();
  const go = (to: "/settings" | "/my-uno", search?: { tab: "billing" }) => {
    if (isMobile) setOpenMobile(false);
    void navigate(search ? { to, search } : { to });
  };
  const openConsole = (url: string) => {
    if (runningInElectron) openInstallDocs(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  const hasAccount = accountTransport() !== "none";
  return (
    <div className="flex min-w-0 items-center gap-0.5" data-testid="sidebar-footer">
      <button
        type="button"
        onClick={() => go("/settings")}
        className={FOOTER_ROW_CLASS}
        data-testid="sidebar-settings"
      >
        <SettingsIcon />
        Settings
      </button>
      {hasAccount ? (
        <Menu>
          <MenuTrigger
            className={`${FOOTER_ROW_CLASS} ml-auto data-[popup-open]:bg-sidebar-row-hover`}
            data-testid="sidebar-account"
          >
            <CircleUserIcon />
            Account
            <ChevronUpIcon className="size-3.5! opacity-60" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" className="min-w-56">
            <MenuItem onClick={() => go("/my-uno", { tab: "billing" })}>
              <SparklesIcon />
              Plan &amp; AI
            </MenuItem>
            <MenuItem onClick={() => openConsole(consoleLinks.plans)}>
              <CreditCardIcon />
              <span className="flex-1">Billing</span>
              <ArrowUpRightIcon className="opacity-60" />
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={() => openConsole(CONSOLE_URL)}>
              <ArrowUpRightIcon />
              Open console
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
      {allMachinesSidebar ? (
        <div className="ml-1 min-w-0 flex-1">
          <SidebarWorkspaceSwitcher variant="compact" />
        </div>
      ) : null}
    </div>
  );
}
