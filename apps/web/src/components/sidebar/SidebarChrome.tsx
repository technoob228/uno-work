/**
 * Sidebar chrome shared by the chat-list sidebar and the legacy grouped one:
 * the branded header row and the utility footer.
 *
 * Mirrors upstream T3 Code's `sidebar/SidebarChrome.tsx` in shape (header,
 * utility menu of icon buttons, footer), with Uno Work's own wordmark instead
 * of the T3 stage backdrop, and the machine switcher folded into the footer
 * row next to the utility icons.
 */
import { BotIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { APP_BASE_NAME, APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { SidebarWorkspaceSwitcher } from "../SidebarWorkspaceSwitcher";
import { SidebarFooter, SidebarHeader, SidebarTrigger, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const wordmark = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Tooltip>
        <TooltipTrigger render={<SidebarTrigger className="size-7 shrink-0" />} />
        <TooltipPopup side="bottom">Hide sidebar</TooltipPopup>
      </Tooltip>
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
              <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-primary">
                {APP_STAGE_LABEL}
              </span>
            </Link>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Home · version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  return isElectron ? (
    <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 overflow-hidden px-4 py-0 pl-[78px] fullscreen:pl-4 wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)]">
      {wordmark}
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">{wordmark}</SidebarHeader>
  );
});

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

export const SidebarChromeFooter = memo(function SidebarChromeFooter(props: {
  showHelper?: boolean;
}) {
  return (
    <SidebarFooter className="gap-1 px-[var(--sidebar-content-inset)] py-1.5">
      <SidebarUpdatePill />
      <SidebarUtilityMenu showHelper={props.showHelper ?? false} />
    </SidebarFooter>
  );
});
