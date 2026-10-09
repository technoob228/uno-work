/**
 * Sidebar D's account button and header icons, alone in a light module (no
 * store, no inbox, no environments) so web lite's sidebar — which has no
 * computer — uses the very same pieces as the full app (see lite/LiteShell).
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { accountTransport } from "../../account/unoAccount";
import { cn } from "../../lib/utils";
import { isWebApp } from "../../webMode";
import { balanceQuery } from "../myuno/myUnoQueries";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Opens a console/download link: a new tab on the web, the system browser on desktop. */
export function openExternal(url: string) {
  if (isWebApp) window.open(url, "_blank", "noopener,noreferrer");
  else openInstallDocs(url);
}

export function initialsOf(who: string | null): string {
  if (!who) return "";
  const name = who.split("@")[0] ?? who;
  const parts = name.split(/[._\-\s]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

export function useAccountWho(): string | null {
  const hasAccount = accountTransport() !== "none";
  const balance = useQuery({ ...balanceQuery(), enabled: hasAccount });
  return balance.data?.email ?? balance.data?.username ?? null;
}

export function SidebarDAvatar({ who, className }: { who: string | null; className?: string }) {
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

/**
 * The account button of sidebar D — avatar, a name and a chevron (header) or
 * the avatar alone (rail). Shared with web lite's sidebar so both look alike.
 * Render inside a <Menu>.
 */
export function SidebarDAccountTrigger(props: {
  label: string;
  who: string | null;
  variant: "header" | "rail";
  /** Sidebar v2: "Uno Work" next to five icons fits without the chevron. */
  chevron?: boolean;
}) {
  return props.variant === "header" ? (
    <MenuTrigger
      className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover no-drag"
      data-testid="sidebar-account"
      aria-label={`${props.label}: account and settings`}
    >
      <SidebarDAvatar who={props.who} />
      <span className="min-w-0 truncate text-sm font-semibold text-foreground">{props.label}</span>
      {props.chevron === false ? null : (
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </MenuTrigger>
  ) : (
    <MenuTrigger
      className="grid size-9 cursor-pointer place-items-center rounded-lg outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-sidebar-row-hover"
      data-testid="sidebar-rail-account"
      aria-label={`${props.label}: account and settings`}
    >
      <SidebarDAvatar who={props.who} className="size-7" />
    </MenuTrigger>
  );
}

/** An icon button in sidebar D's header (Search, New chat, Collapse). */
export function SidebarDHeaderIcon(props: {
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
