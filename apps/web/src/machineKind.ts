/**
 * Which kind of machine an environment is, as the UI should present it.
 *
 * Every place a machine appears (sidebar switcher, My machines, Settings
 * "Applies to", chips) asks this one function, so a box is called a box
 * everywhere and never "This computer" just because it served the page.
 *
 * Precedence, strongest signal first:
 *   1. what the daemon itself reports (`descriptor.machineKind`),
 *   2. a box on the Uno account matched to this environment,
 *   3. the workspace registry's kind (written by whoever adopted the machine),
 *   4. the platform: macOS / Windows are computers, Linux and unknown are servers.
 *
 * The account match sits above the registry on purpose: a registry row says
 * what someone typed when adopting the machine; a box on the account is a
 * fact from the control plane.
 *
 * Kept free of React so it can be unit-tested with plain objects.
 *
 * @module machineKind
 */
import type {
  ExecutionEnvironmentDescriptor,
  ExecutionEnvironmentPlatformOs,
  MachineKind,
  WorkspaceMachineKind,
} from "@t3tools/contracts";

export type { MachineKind };

/** Group order wherever machines are listed by kind. */
export const MACHINE_KIND_ORDER: ReadonlyArray<MachineKind> = ["uno_box", "computer", "server"];

/**
 * The descriptor fields machine derivations read (kind, box id, and the
 * daemon's own label — which machine rows replace with the box's Uno name).
 */
export type MachineKindDescriptorHint = Pick<
  Partial<ExecutionEnvironmentDescriptor>,
  "machineKind" | "unoBoxId" | "platform" | "label"
>;

export interface DeriveMachineKindInput {
  /** The daemon's own descriptor, when this client has seen one. */
  readonly descriptor?: MachineKindDescriptorHint | null | undefined;
  /** True when a box on the Uno account has been matched to this environment. */
  readonly matchedBox?: boolean | undefined;
  /**
   * The match is by box id (recorded when the machine was connected from the
   * Uno account), not by name. That is stronger than what the daemon reports:
   * a daemon on a box that is not linked to the account yet cannot know it is
   * a box and calls itself a server.
   */
  readonly matchedBoxById?: boolean | undefined;
  /** The workspace registry's kind for this machine, when it is registered. */
  readonly registryKind?: WorkspaceMachineKind | null | undefined;
  /** Platform when known from somewhere other than the descriptor. */
  readonly platformOs?: ExecutionEnvironmentPlatformOs | string | null | undefined;
}

export function machineKindFromPlatform(
  os: ExecutionEnvironmentPlatformOs | string | null | undefined,
): MachineKind {
  return os === "darwin" || os === "windows" || os === "win32" ? "computer" : "server";
}

export function machineKindFromRegistryKind(kind: WorkspaceMachineKind): MachineKind {
  switch (kind) {
    case "uno_box":
      return "uno_box";
    case "local":
      return "computer";
    case "ssh":
      return "server";
  }
}

/** The registry kind to write for a machine whose kind the daemon reported. */
export function registryKindForMachineKind(kind: MachineKind): WorkspaceMachineKind {
  switch (kind) {
    case "uno_box":
      return "uno_box";
    case "computer":
      return "local";
    case "server":
      return "ssh";
  }
}

export function deriveMachineKind(input: DeriveMachineKindInput): MachineKind {
  if (input.matchedBoxById === true) return "uno_box";
  const reported = input.descriptor?.machineKind;
  if (reported) return reported;
  if (input.matchedBox === true) return "uno_box";
  if (input.registryKind) return machineKindFromRegistryKind(input.registryKind);
  return machineKindFromPlatform(input.descriptor?.platform?.os ?? input.platformOs);
}
