/**
 * The "Applies to" control at the top of Settings: answers "whose settings am
 * I editing?" and lets the user change the answer without leaving Settings.
 *
 * A dropdown that lists the app itself first — the settings that belong to
 * this copy on this device and follow the user everywhere — then every machine
 * the app can address, grouped by what the machine is (Uno boxes, your
 * computers, other machines), each with a live status dot. The closed control
 * shows the kind's icon and the label of what is selected. Switching keeps
 * the current section when the other scope has one by that name, and
 * otherwise lands on that scope's first page and says why.
 *
 * @module components/settings/SettingsScopeSwitcher
 */
import type { MachineKind } from "@t3tools/contracts";
import { CheckIcon, MonitorIcon, ServerIcon } from "lucide-react";
import { useMemo } from "react";

import { MACHINE_KIND_ORDER } from "~/machineKind";
import { MACHINE_KIND_GROUP_LABELS, type MachineStatus } from "~/plainLanguage";
import { cn } from "~/lib/utils";

import { MACHINE_KIND_ICON } from "../machineKindIcons";
import { MenuItem } from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
} from "../ui/select";
import type { SettingsMachineOption, SettingsScopeModel } from "./useSettingsScope";

export const MACHINE_STATUS_DOT: Readonly<Record<MachineStatus, string>> = {
  online: "bg-emerald-500",
  sleeping: "bg-amber-500",
  offline: "bg-muted-foreground/50",
  unknown: "bg-muted-foreground/30",
};

const APP_CHOICE_VALUE = "app";

/** What this copy of the app is called in the scope list. */
export function appScopeLabel(platform: string | undefined = navigator.platform): string {
  if (platform.startsWith("Mac")) return "Uno Work on this Mac";
  if (platform.startsWith("Win")) return "Uno Work on this PC";
  return "Uno Work on this device";
}

export function MachineStatusDot({
  status,
  className,
}: {
  readonly status: MachineStatus;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        MACHINE_STATUS_DOT[status],
        className,
      )}
    />
  );
}

/** Machines bucketed by kind, in the fixed kind order, empty kinds left out. */
export function groupSettingsMachines(
  machines: ReadonlyArray<SettingsMachineOption>,
): ReadonlyArray<{
  readonly kind: MachineKind;
  readonly label: string;
  readonly machines: ReadonlyArray<SettingsMachineOption>;
}> {
  return MACHINE_KIND_ORDER.map((kind) => ({
    kind,
    label: MACHINE_KIND_GROUP_LABELS[kind],
    machines: machines.filter((machine) => machine.kind === kind),
  })).filter((group) => group.machines.length > 0);
}

/**
 * The machine rows of a scope menu (the sidebar nav's group heading uses
 * these), so a machine is presented identically wherever it is offered.
 */
export function MachineMenuItems({
  machines,
  activeEnvironmentId,
  onPick,
}: {
  readonly machines: ReadonlyArray<SettingsMachineOption>;
  readonly activeEnvironmentId: string | null;
  readonly onPick: (machine: SettingsMachineOption) => void;
}) {
  return (
    <>
      {machines.map((machine) => {
        const KindIcon = MACHINE_KIND_ICON[machine.kind];
        const isActive = machine.environmentId === activeEnvironmentId;
        return (
          <MenuItem
            key={machine.environmentId}
            aria-label={`${machine.label}, ${machine.kindLabel}, ${machine.statusLabel}`}
            onClick={() => onPick(machine)}
          >
            <KindIcon className="size-4 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{machine.label}</span>
              <span className="truncate text-[11px] text-muted-foreground">
                {machine.kindLabel}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <MachineStatusDot status={machine.status} />
              <span className="text-[11px] text-muted-foreground">{machine.statusLabel}</span>
            </span>
            {isActive ? <CheckIcon className="size-3.5" /> : null}
          </MenuItem>
        );
      })}
    </>
  );
}

function ScopeSelect({ model }: { readonly model: SettingsScopeModel }) {
  const { location, machines, selectedMachine, unknownMachine, switchTo } = model;
  const isApp = location.kind === "app";
  const value = isApp ? APP_CHOICE_VALUE : (location.environmentId ?? APP_CHOICE_VALUE);
  const groups = useMemo(() => groupSettingsMachines(machines), [machines]);

  const triggerLabel = isApp
    ? "This app"
    : unknownMachine
      ? // A URL naming a machine this device no longer has is a real state,
        // not something to silently replace with another machine.
        "Unknown machine"
      : (selectedMachine?.label ?? "Unknown machine");
  const TriggerIcon = isApp
    ? MonitorIcon
    : selectedMachine
      ? MACHINE_KIND_ICON[selectedMachine.kind]
      : ServerIcon;

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === value) return;
        if (next === APP_CHOICE_VALUE) {
          switchTo({ kind: "app" });
          return;
        }
        const machine = machines.find((candidate) => candidate.environmentId === next);
        if (machine) switchTo({ kind: "environment", environmentId: machine.environmentId });
      }}
    >
      <SelectTrigger
        size="xs"
        className="min-w-0 max-w-72"
        aria-label="Change what these settings apply to"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <TriggerIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{triggerLabel}</span>
          {!isApp && selectedMachine ? <MachineStatusDot status={selectedMachine.status} /> : null}
        </span>
      </SelectTrigger>
      <SelectPopup className="min-w-72" alignItemWithTrigger={false}>
        <SelectItem value={APP_CHOICE_VALUE} aria-label={appScopeLabel()}>
          <span className="flex items-center gap-2">
            <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">This app</span>
              <span className="truncate text-[11px] text-muted-foreground">{appScopeLabel()}</span>
            </span>
          </span>
        </SelectItem>
        {groups.map((group) => (
          <SelectGroup key={group.kind}>
            <SelectSeparator />
            <SelectGroupLabel>{group.label}</SelectGroupLabel>
            {group.machines.map((machine) => {
              const KindIcon = MACHINE_KIND_ICON[machine.kind];
              return (
                <SelectItem
                  key={machine.environmentId}
                  value={machine.environmentId}
                  aria-label={`${machine.label}, ${machine.kindLabel}, ${machine.statusLabel}`}
                >
                  <span className="flex items-center gap-2">
                    <KindIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{machine.label}</span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {machine.kindLabel}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <MachineStatusDot status={machine.status} />
                      <span className="text-[11px] text-muted-foreground">
                        {machine.statusLabel}
                      </span>
                    </span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function SettingsScopeSwitcher({ model }: { readonly model: SettingsScopeModel }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Applies to
      </span>
      <ScopeSelect model={model} />
    </div>
  );
}
