/**
 * The "Applies to" control at the top of Settings: answers "whose settings am
 * I editing?" and lets the user change the answer without leaving Settings.
 *
 * It lists the app itself first — the settings that belong to this copy on
 * this device and follow the user everywhere — then every machine the app
 * can address, each with its plain-language kind and a live status dot.
 * Switching keeps the current section when the other scope has one by that
 * name, and otherwise lands on that scope's first page and says why.
 *
 * With a handful of machines the control is a segmented row so every choice
 * is visible at once; past that it folds into a menu.
 *
 * @module components/settings/SettingsScopeSwitcher
 */
import type { WorkspaceMachineKind } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudIcon,
  LaptopIcon,
  MonitorIcon,
  ServerIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import type { MachineStatus } from "~/plainLanguage";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { SettingsMachineOption, SettingsScopeModel } from "./useSettingsScope";

export const MACHINE_STATUS_DOT: Readonly<Record<MachineStatus, string>> = {
  online: "bg-emerald-500",
  sleeping: "bg-amber-500",
  offline: "bg-muted-foreground/50",
  unknown: "bg-muted-foreground/30",
};

const KIND_ICON: Readonly<Record<WorkspaceMachineKind, ComponentType<{ className?: string }>>> = {
  local: LaptopIcon,
  uno_box: CloudIcon,
  ssh: ServerIcon,
};

/** Above this many choices (app + machines) the segmented row becomes a menu. */
const SEGMENTED_MAX_CHOICES = 4;

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

/**
 * The machine rows of a scope menu. Shared by the header control and the
 * sidebar group heading so a machine is presented identically in both.
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
        const KindIcon = KIND_ICON[machine.kind];
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

function ScopeSegments({ model }: { readonly model: SettingsScopeModel }) {
  const { location, machines, switchTo } = model;
  const activeValue =
    location.kind === "app" ? APP_CHOICE_VALUE : (location.environmentId ?? APP_CHOICE_VALUE);
  return (
    <ToggleGroup
      aria-label="Applies to"
      variant="outline"
      size="xs"
      value={[activeValue]}
      onValueChange={(groupValue) => {
        // Single choice: pressing the active segment again is a no-op, not a
        // deselect — settings always apply to something.
        const next = groupValue[0];
        if (typeof next !== "string" || next === activeValue) return;
        if (next === APP_CHOICE_VALUE) {
          switchTo({ kind: "app" });
          return;
        }
        const machine = machines.find((candidate) => candidate.environmentId === next);
        if (machine) switchTo({ kind: "environment", environmentId: machine.environmentId });
      }}
    >
      <Toggle
        value={APP_CHOICE_VALUE}
        className="gap-1.5 px-2 text-xs"
        aria-label={appScopeLabel()}
      >
        <MonitorIcon className="size-3.5 text-muted-foreground" />
        <span>This app</span>
      </Toggle>
      {machines.map((machine) => {
        const KindIcon = KIND_ICON[machine.kind];
        return (
          <Toggle
            key={machine.environmentId}
            value={machine.environmentId}
            className="gap-1.5 px-2 text-xs"
            aria-label={`${machine.label}, ${machine.kindLabel}, ${machine.statusLabel}`}
            title={`${machine.kindLabel} · ${machine.statusLabel}`}
          >
            <KindIcon className="size-3.5 text-muted-foreground" />
            <span className="max-w-36 truncate">{machine.label}</span>
            <span className="hidden text-[11px] font-normal text-muted-foreground sm:inline">
              {machine.kindLabel}
            </span>
            <MachineStatusDot status={machine.status} />
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
}

function ScopeMenu({ model }: { readonly model: SettingsScopeModel }) {
  const { location, machines, selectedMachine, unknownMachine, switchTo } = model;
  const isApp = location.kind === "app";
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
      ? KIND_ICON[selectedMachine.kind]
      : ServerIcon;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="outline" aria-label="Change what these settings apply to" />
        }
      >
        <TriggerIcon className="size-3.5 text-muted-foreground" />
        <span className="max-w-48 truncate">{triggerLabel}</span>
        {!isApp && selectedMachine ? <MachineStatusDot status={selectedMachine.status} /> : null}
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-72">
        <MenuGroup>
          <MenuGroupLabel>Everywhere</MenuGroupLabel>
          <MenuItem onClick={() => switchTo({ kind: "app" })}>
            <MonitorIcon className="size-4 text-muted-foreground" />
            <span className="flex-1 truncate">{appScopeLabel()}</span>
            {isApp ? <CheckIcon className="size-3.5" /> : null}
          </MenuItem>
        </MenuGroup>
        <MenuGroup>
          <MenuGroupLabel>One machine</MenuGroupLabel>
          <MachineMenuItems
            machines={machines}
            activeEnvironmentId={location.environmentId}
            onPick={(machine) =>
              switchTo({ kind: "environment", environmentId: machine.environmentId })
            }
          />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function SettingsScopeSwitcher({ model }: { readonly model: SettingsScopeModel }) {
  const segmented = model.machines.length + 1 <= SEGMENTED_MAX_CHOICES && !model.unknownMachine;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Applies to
      </span>
      {segmented ? <ScopeSegments model={model} /> : <ScopeMenu model={model} />}
    </div>
  );
}
