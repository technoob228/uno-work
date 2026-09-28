/**
 * The list of computers to switch between — the body of the computer menu:
 * the machines this app knows (current one checked, star = default), the
 * account's cloud computers not connected yet, "Use this computer", "All
 * computers, sites and plan" and "Add computer". Plain buttons: Tab / Enter
 * work inside whatever popup holds it.
 */
import {
  CheckIcon,
  LaptopIcon,
  LayoutGridIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
} from "lucide-react";

import { accountTransport } from "../../account/unoAccount";
import { cn } from "../../lib/utils";
import { MACHINE_KIND_GROUP_LABELS } from "../../plainLanguage";
import { AddEnvModal } from "../AddEnvModal";
import { MACHINE_KIND_ICON } from "../machineKindIcons";
import { STATUS_DOT_CLASS, type ComputerSwitcher } from "./useComputerSwitcher";

export function ComputerSwitcherList({ switcher }: { switcher: ComputerSwitcher }) {
  const {
    groups,
    currentId,
    accountBoxes,
    connecting,
    openMachine,
    openAccountBox,
    toggleDefault,
    unlinkedLocalDaemon,
    useThisComputer,
    openAddComputer,
  } = switcher;
  return (
    <div className="flex flex-col" data-testid="computer-switcher-list">
      {groups.map((group) => (
        <div key={group.kind} className="flex flex-col">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {group.label}
          </div>
          {group.items.map((env) => {
            const Icon = MACHINE_KIND_ICON[env.kind];
            const isActive = env.id === currentId;
            return (
              <div
                key={env.id}
                className={cn(
                  "group/machine flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent",
                  isActive && "bg-accent/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => openMachine(env.id, env.kind)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      STATUS_DOT_CLASS[env.connectionState],
                    )}
                  />
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{env.name}</span>
                      {env.isDefault ? (
                        <span className="shrink-0 text-[10px] font-normal text-primary">
                          Default
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">{env.meta}</div>
                  </div>
                  {isActive ? (
                    <CheckIcon className="size-3.5 shrink-0 text-primary" />
                  ) : env.isPrimary ? (
                    <span
                      className="shrink-0 text-[10px] text-muted-foreground"
                      title="The machine serving this page"
                    >
                      current
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => toggleDefault(env.id)}
                  aria-pressed={env.isDefault}
                  aria-label={
                    env.isDefault
                      ? `Stop using ${env.name} as the default machine`
                      : `Make ${env.name} the default machine`
                  }
                  title={env.isDefault ? "Default machine" : "Make this the default machine"}
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:text-foreground",
                    env.isDefault
                      ? "text-primary opacity-100"
                      : "opacity-0 focus-visible:opacity-100 group-hover/machine:opacity-100",
                  )}
                >
                  <StarIcon
                    className={cn("size-3.5", env.isDefault && "fill-current")}
                    aria-hidden="true"
                  />
                </button>
              </div>
            );
          })}
        </div>
      ))}
      {accountBoxes.length > 0 ? (
        <div className="flex flex-col">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            {groups.some((group) => group.kind === "uno_box")
              ? "More on your account"
              : MACHINE_KIND_GROUP_LABELS.uno_box}
          </div>
          {accountBoxes.map((row) => {
            const Icon = MACHINE_KIND_ICON.uno_box;
            const busy = connecting?.boxId === row.box?.id;
            return (
              <button
                key={row.key}
                type="button"
                disabled={connecting !== null}
                onClick={() => void openAccountBox(row)}
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-70"
              >
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
                />
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{row.label}</div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {busy && connecting ? connecting.label : row.detail || "Click to open"}
                  </div>
                </div>
                {busy ? (
                  <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {groups.length === 0 && accountBoxes.length === 0 ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">No computers connected yet</div>
      ) : null}
      <div className="my-1 h-px bg-border" />
      {unlinkedLocalDaemon ? (
        <button
          type="button"
          disabled={useThisComputer.isBusy}
          onClick={() => void useThisComputer.run(unlinkedLocalDaemon)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/8 disabled:cursor-wait disabled:opacity-60"
        >
          <LaptopIcon className="size-3.5" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">
              {useThisComputer.phase.kind === "waiting-for-approval"
                ? "Waiting for Allow on this computer…"
                : useThisComputer.phase.kind === "linking"
                  ? "Connecting this computer…"
                  : "Use this computer"}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {unlinkedLocalDaemon.label} · Uno Work is running here
            </div>
          </div>
        </button>
      ) : null}
      {accountTransport() !== "none" ? (
        <button
          type="button"
          onClick={switcher.goAllComputers}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
        >
          <LayoutGridIcon className="size-3.5 text-muted-foreground" />
          <span>All computers, sites and plan</span>
        </button>
      ) : null}
      <button
        type="button"
        onClick={openAddComputer}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/8"
      >
        <PlusIcon className="size-3.5" />
        <span>Add computer</span>
      </button>
      {switcher.canReconnectCurrent ? (
        <button
          type="button"
          disabled={switcher.isReconnectingCurrent}
          onClick={() => void switcher.reconnectCurrentEnvironment()}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-60"
        >
          <RefreshCwIcon
            className={cn(
              "size-3.5 text-muted-foreground",
              switcher.isReconnectingCurrent && "animate-spin",
            )}
          />
          <span>Reconnect this computer</span>
        </button>
      ) : null}
    </div>
  );
}

/** "Add computer" opens a dialog that outlives the menu: render it next to the trigger. */
export function ComputerSwitcherDialogs({ switcher }: { switcher: ComputerSwitcher }) {
  return <AddEnvModal open={switcher.addEnvOpen} onOpenChange={switcher.setAddEnvOpen} />;
}
