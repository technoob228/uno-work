/**
 * The computer switcher as a sidebar trigger. Uno Work's sidebar no longer
 * shows it (27.09: switching lives in the computer menu in Home's header, next
 * to the computer's load — one place, not two); the legacy sidebar still uses
 * the `card` variant. Data and actions: `useComputerSwitcher`.
 */
import { ChevronsUpDownIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { MACHINE_KIND_LABELS } from "../plainLanguage";
import { MACHINE_KIND_ICON } from "./machineKindIcons";
import {
  ComputerSwitcherDialogs,
  ComputerSwitcherList,
} from "./computerSwitcher/ComputerSwitcherList";
import { STATUS_DOT_CLASS, useComputerSwitcher } from "./computerSwitcher/useComputerSwitcher";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";

/**
 * `card` is the two-line bordered block the legacy sidebar footer uses;
 * `compact` is a one-line ghost trigger; `header` the two-line row that used
 * to top Uno Work's sidebar.
 */
export function SidebarEnvSwitcher({
  variant = "card",
}: { variant?: "card" | "compact" | "header" } = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const switcher = useComputerSwitcher(() => setMenuOpen(false));
  const { current } = switcher;
  const CurrentIcon = MACHINE_KIND_ICON[current?.kind ?? "server"];

  return (
    <>
      <div className="flex w-full items-stretch gap-1">
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-colors",
                  variant === "compact"
                    ? "h-8 px-2 text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
                    : variant === "header"
                      ? "h-11 px-2 hover:bg-sidebar-row-hover"
                      : "border border-border bg-background px-2 py-1.5 hover:bg-accent",
                )}
                aria-label="Switch computer"
                title={
                  variant === "compact" && current
                    ? `${current.name} · ${MACHINE_KIND_LABELS[current.kind]} · ${current.meta}`
                    : undefined
                }
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    current ? STATUS_DOT_CLASS[current.connectionState] : "bg-muted-foreground/40",
                  )}
                />
                <CurrentIcon className="size-3.5 shrink-0 text-muted-foreground" />
                {variant === "compact" ? (
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {current?.name ?? "No machine"}
                  </span>
                ) : variant === "header" ? (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {current?.name ?? "No computer"}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {current
                        ? current.isPrimary && isElectron
                          ? "On this computer"
                          : MACHINE_KIND_LABELS[current.kind]
                        : "Connect a computer"}
                    </div>
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground">
                      {current?.name ?? "No machine"}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {current
                        ? `${MACHINE_KIND_LABELS[current.kind]} · ${current.meta}`
                        : "Connect a machine"}
                    </div>
                  </div>
                )}
                <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
              </button>
            }
          />
          <MenuPopup
            align="start"
            side={variant === "header" ? "bottom" : "top"}
            sideOffset={6}
            className="min-w-[16rem] p-1"
          >
            <ComputerSwitcherList switcher={switcher} />
          </MenuPopup>
        </Menu>
        {switcher.canReconnectCurrent ? (
          <button
            type="button"
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
              variant === "compact"
                ? "size-8 hover:bg-sidebar-row-hover"
                : "size-9 border border-border bg-background hover:bg-accent",
            )}
            disabled={switcher.isReconnectingCurrent}
            title="Reconnect machine"
            aria-label="Reconnect machine"
            onClick={() => void switcher.reconnectCurrentEnvironment()}
          >
            <RefreshCwIcon
              className={cn("size-3.5", switcher.isReconnectingCurrent && "animate-spin")}
            />
          </button>
        ) : null}
      </div>
      <ComputerSwitcherDialogs switcher={switcher} />
    </>
  );
}
