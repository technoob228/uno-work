/**
 * Sidebar chrome shared by the chat-list sidebar and the legacy grouped one:
 * the branded header row.
 *
 * Mirrors upstream T3 Code's `sidebar/SidebarChrome.tsx` in shape, with Uno
 * Work's own wordmark instead of the T3 stage backdrop. The utility menu and
 * the footer of the old layout are gone: sidebar D keeps the account and the
 * computer at the top.
 */
import { SquarePenIcon } from "lucide-react";
import { memo } from "react";
import { Link } from "@tanstack/react-router";
import { APP_BASE_NAME, APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { useServerKeybindings } from "../../rpc/serverState";
import { sidebarToggleLabel } from "./sidebarShortcut";
import { cn } from "../../lib/utils";
import { SidebarHeader, SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InboxBell } from "../inbox/InboxBell";
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
