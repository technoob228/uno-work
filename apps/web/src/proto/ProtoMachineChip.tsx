/**
 * Sidebar prototype (w0115, NOT FOR MERGE): with computers joined (Б) the new
 * chat says which computer it starts on — "Cloud ▾" next to "Home folder ▾".
 * Picking another computer makes it the active one; the folder chip then
 * lists that computer's folders.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, CloudIcon, LaptopIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useStore } from "../store";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { MACHINES } from "./fixtures";
import { useProtoAllMachines } from "./protoState";

function MachineIcon({ kind, className }: { kind: string; className?: string }) {
  return kind === "uno_box" ? (
    <CloudIcon className={className} />
  ) : (
    <LaptopIcon className={className} />
  );
}

export function ProtoMachineChip({ environmentId }: { environmentId: EnvironmentId | null }) {
  const joined = useProtoAllMachines();
  const setActive = useStore((state) => state.setActiveEnvironmentId);
  if (!joined || environmentId === null) return null;
  const current = MACHINES[environmentId];
  if (!current) return null;
  return (
    <Menu>
      <MenuTrigger
        className={cn(
          "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground outline-hidden transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent",
        )}
        data-testid="proto-machine-chip"
        aria-label="Computer for this chat"
      >
        <MachineIcon kind={current.machineKind} className="size-3.5" />
        {current.label}
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        <MenuGroup>
        <MenuGroupLabel>Start this chat on</MenuGroupLabel>
        {Object.values(MACHINES).map((machine) => (
          <MenuItem key={machine.environmentId} onClick={() => setActive(machine.environmentId)}>
            <MachineIcon kind={machine.machineKind} />
            <span className="min-w-0 flex-1">{machine.label}</span>
            <span className="ml-2 text-xs text-muted-foreground">
              {machine.machineKind === "uno_box" ? "always on" : "your laptop"}
            </span>
            {machine.environmentId === environmentId ? (
              <CheckIcon className="text-foreground" />
            ) : null}
          </MenuItem>
        ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
