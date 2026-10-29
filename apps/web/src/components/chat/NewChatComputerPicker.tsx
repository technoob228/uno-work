/**
 * "on [This Mac ▾]" on a new chat — which computer it runs on. The same
 * machines, names and status dots as the computer menu in Home's header
 * (`useSwitcherMachines`), grouped the same way; a computer that isn't
 * connected right now is listed but can't be picked. Open to everyone — not a
 * Dev Mode control (upstream's "Run on" picker lives in the branch toolbar).
 *
 * `variant`: "inline" — a word in the draft screen's question; "chip" —
 * Home's composer row.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, LayoutGridIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
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
}: {
  environmentId: EnvironmentId | null;
  onPick: (environmentId: EnvironmentId) => void | Promise<void>;
  variant: "inline" | "chip";
  testId?: string;
  /** ⌘⇧H opens it (on by default; one picker per screen). */
  shortcut?: boolean;
}) {
  const navigate = useNavigate();
  const machines = useSwitcherMachines();
  const groups = useMemo(() => groupSwitcherMachines(machines), [machines]);
  const current = machines.find((machine) => machine.id === environmentId) ?? null;
  const name = current?.name ?? "This computer";
  const CurrentIcon = current ? MACHINE_KIND_ICON[current.kind] : null;
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
              const isCurrent = machine.id === environmentId;
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
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/my-uno" })}>
          <LayoutGridIcon className="size-4 shrink-0 text-muted-foreground" />
          All computers…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
