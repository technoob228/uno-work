/**
 * Multi-computer view (icp3 09.10, from the w0115 prototype): with computers joined (Б) the new
 * chat says which computer it starts on — "uno-product ▾" next to "Home folder ▾".
 * Picking another computer makes it the active one; the folder chip then
 * lists that computer's folders.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, CloudIcon, LaptopIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useStore } from "../store";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "../components/ui/menu";
import { useComputerNames } from "./computerNames";
import { useProtoAllMachines } from "./protoState";

function MachineIcon({ kind, className }: { kind: string; className?: string }) {
  return kind === "uno_box" ? (
    <CloudIcon className={className} />
  ) : (
    <LaptopIcon className={className} />
  );
}

export function ProtoMachineChip({
  environmentId,
  title = "Start this chat on",
}: {
  environmentId: EnvironmentId | null;
  title?: string;
}) {
  const joined = useProtoAllMachines();
  const setActive = useStore((state) => state.setActiveEnvironmentId);
  const names = useComputerNames((state) => state.byId);
  const order = useComputerNames((state) => state.order);
  if (!joined || environmentId === null || order.length < 2) return null;
  const current = names[environmentId];
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
        <MachineIcon kind={current.kind} className="size-3.5" />
        {current.label}
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>{title}</MenuGroupLabel>
          {order.map((id) => (
            <MenuItem key={id} onClick={() => setActive(id as EnvironmentId)}>
              <MachineIcon kind={names[id]!.kind} />
              <span className="min-w-0 flex-1">{names[id]!.label}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {names[id]!.kind === "uno_box" ? "in the cloud" : "your computer"}
              </span>
              {id === environmentId ? <CheckIcon className="text-foreground" /> : null}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
