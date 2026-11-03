/**
 * "on [This Mac ▾]" on a new chat — which computer it runs on. The same
 * machines, names and status dots as the computer menu in Home's header
 * (`useSwitcherMachines`), grouped the same way; a computer that isn't
 * connected right now is listed but can't be picked. Open to everyone — not a
 * Dev Mode control (upstream's "Run on" picker lives in the branch toolbar).
 *
 * `variant`: "inline" — a word in the draft screen's question; "chip" —
 * Home's composer row.
 *
 * Computers lifecycle: with `onPickOwnComputer`, the person's own computers
 * used as full computers are listed too ("on MacBook": the chat runs in the
 * cloud, its commands and files there). In the desktop app with "Where agents
 * run: In your cloud", this Mac is offered that way instead of as the app's
 * own Work; with "On this Mac", the other way round.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, LaptopIcon, LayoutGridIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useComputersLifecycleOn } from "../../computersLifecycle/flag";
import { useLifecycle } from "../../computersLifecycle/store";
import { type OwnComputer, useOwnComputers } from "../../computersLifecycle/useComputers";
import { isElectron } from "../../env";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useThisMacComputerId } from "../computersLifecycle/WhereAgentsRun";
import { groupSwitcherMachines } from "../SidebarEnvSwitcher.logic";
import { STATUS_DOT_CLASS, useSwitcherMachines } from "../computerSwitcher/useComputerSwitcher";
import { MACHINE_KIND_ICON } from "../machineKindIcons";
import { Button, InlineButton } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { DraftProjectName } from "./DraftProjectName";
import { usePickerShortcut, withShortcutHint } from "./usePickerShortcut";

const NOT_CONNECTED_LABEL = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  disconnected: "Offline",
  error: "Can't connect",
} as const;

/** The name of the computer a new chat would run on ("This Mac" when unknown yet). */
export function useNewChatComputerName(environmentId: EnvironmentId | null): string {
  const machines = useSwitcherMachines();
  return machines.find((machine) => machine.id === environmentId)?.name ?? "This computer";
}

export function NewChatComputerPicker({
  environmentId,
  onPick,
  variant,
  testId = "new-chat-computer-picker",
  shortcut = true,
  ownComputerId = null,
  onPickOwnComputer,
}: {
  environmentId: EnvironmentId | null;
  onPick: (environmentId: EnvironmentId) => void | Promise<void>;
  variant: "inline" | "chip";
  testId?: string;
  /** ⌘⇧H opens it (on by default; one picker per screen). */
  shortcut?: boolean;
  /** The own computer picked (its id), when the chat goes "on" one. */
  ownComputerId?: string | null;
  onPickOwnComputer?: (computer: OwnComputer) => void | Promise<void>;
}) {
  const navigate = useNavigate();
  const allMachines = useSwitcherMachines();
  const lifecycleOn = useComputersLifecycleOn();
  const { computers: own } = useOwnComputers();
  const thisMac = useThisMacComputerId();
  const where = useLifecycle((state) => state.whereAgentsRun);
  const primaryId = usePrimaryEnvironmentId();
  const ownOffered =
    lifecycleOn && onPickOwnComputer
      ? own.filter(
          (computer) =>
            computer.purpose === "full" && !(computer.id === thisMac && where === "here"),
        )
      : [];
  // Desktop app, agents in the cloud: this Mac is offered as one of the computers, not twice.
  const hideLocal =
    isElectron && thisMac !== null && where === "cloud" && ownOffered.some((c) => c.id === thisMac);
  const machines = useMemo(
    () => (hideLocal ? allMachines.filter((machine) => machine.id !== primaryId) : allMachines),
    [allMachines, hideLocal, primaryId],
  );
  const groups = useMemo(() => groupSwitcherMachines(machines), [machines]);
  const ownCurrent = ownOffered.find((computer) => computer.id === ownComputerId) ?? null;
  const current = ownCurrent
    ? null
    : (machines.find((machine) => machine.id === environmentId) ?? null);
  const name = ownCurrent?.name ?? current?.name ?? "This computer";
  const CurrentIcon = ownCurrent ? LaptopIcon : current ? MACHINE_KIND_ICON[current.kind] : null;
  const [open, setOpen] = useState(false);
  const shortcutLabel = usePickerShortcut("composer.host", shortcut, () =>
    setOpen((value) => !value),
  );
  const title = withShortcutHint("The computer this chat runs on", shortcutLabel);

  return (
    <Menu open={open} onOpenChange={setOpen}>
      {variant === "inline" ? (
        <MenuTrigger
          render={<InlineButton tone="picker" />}
          className="pointer-events-auto min-w-0 max-w-full align-baseline"
          data-testid={testId}
          title={title}
        >
          <DraftProjectName value={name} singleLine />
          <ChevronDownIcon className="size-4 shrink-0 self-center opacity-50" />
        </MenuTrigger>
      ) : (
        <MenuTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              className="min-w-0 shrink text-muted-foreground"
              data-testid={testId}
              title={title}
            />
          }
        >
          {CurrentIcon ? <CurrentIcon /> : null}
          <span className="min-w-0 max-w-36 truncate">{name}</span>
          <ChevronDownIcon className="opacity-60" />
        </MenuTrigger>
      )}
      <MenuPopup align={variant === "inline" ? "center" : "start"} className="min-w-64">
        {groups.map((group) => (
          <MenuGroup key={group.kind}>
            <MenuGroupLabel>{group.label}</MenuGroupLabel>
            {group.items.map((machine) => {
              const Icon = MACHINE_KIND_ICON[machine.kind];
              const isCurrent = ownCurrent === null && machine.id === environmentId;
              const connected = machine.connectionState === "connected";
              return (
                <MenuItem
                  key={machine.id}
                  disabled={!connected && !isCurrent}
                  onClick={() => {
                    if (!isCurrent) void onPick(machine.id);
                  }}
                  data-testid="new-chat-computer-option"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      STATUS_DOT_CLASS[machine.connectionState],
                    )}
                  />
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                  {connected ? null : (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {NOT_CONNECTED_LABEL[machine.connectionState]}
                    </span>
                  )}
                  {isCurrent ? <CheckIcon className="size-4 shrink-0" /> : null}
                </MenuItem>
              );
            })}
          </MenuGroup>
        ))}
        {ownOffered.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Your computers</MenuGroupLabel>
            {ownOffered.map((computer) => {
              const isCurrent = computer.id === ownCurrent?.id;
              return (
                <MenuItem
                  key={`own:${computer.id}`}
                  onClick={() => {
                    if (!isCurrent) void onPickOwnComputer?.(computer);
                  }}
                  data-testid="new-chat-own-computer-option"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      computer.online ? "bg-success" : "bg-muted-foreground/50",
                    )}
                  />
                  <LaptopIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{computer.name}</span>
                  {computer.online ? null : (
                    <span className="shrink-0 text-xs text-muted-foreground">Asleep</span>
                  )}
                  {isCurrent ? <CheckIcon className="size-4 shrink-0" /> : null}
                </MenuItem>
              );
            })}
          </MenuGroup>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/my-uno" })}>
          <LayoutGridIcon className="size-4 shrink-0 text-muted-foreground" />
          All computers…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
