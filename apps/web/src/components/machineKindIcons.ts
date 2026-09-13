/**
 * One icon per machine kind, shared by every surface that lists machines so a
 * box looks like a box in the sidebar, in Settings and in My machines alike.
 */
import type { MachineKind } from "@t3tools/contracts";
import { CloudIcon, LaptopIcon, ServerIcon } from "lucide-react";
import type { ComponentType } from "react";

export const MACHINE_KIND_ICON: Readonly<
  Record<MachineKind, ComponentType<{ readonly className?: string | undefined }>>
> = {
  uno_box: CloudIcon,
  computer: LaptopIcon,
  server: ServerIcon,
};
