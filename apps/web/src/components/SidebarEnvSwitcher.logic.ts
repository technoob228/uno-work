/**
 * How the sidebar machine switcher orders and groups what it lists.
 *
 * Groups follow the kind of machine (Uno boxes, your computers, other
 * machines) — never the role a daemon happens to play for this page. The
 * default machine comes first: its group leads, and it leads its group.
 * Empty groups are left out. Kept free of React so it can be unit-tested.
 */
import type { EnvironmentConnectionState, EnvironmentId } from "@t3tools/contracts";

import { MACHINE_KIND_ORDER, type MachineKind } from "../machineKind";
import { MACHINE_KIND_GROUP_LABELS } from "../plainLanguage";

export interface SwitcherMachine {
  readonly id: EnvironmentId;
  readonly name: string;
  readonly meta: string;
  readonly kind: MachineKind;
  readonly connectionState: EnvironmentConnectionState;
  /** The daemon serving this page. Shown with a small "current" mark only. */
  readonly isPrimary: boolean;
  readonly isDefault: boolean;
}

export interface SwitcherGroup {
  readonly kind: MachineKind;
  readonly label: string;
  readonly items: ReadonlyArray<SwitcherMachine>;
}

export function groupSwitcherMachines(
  machines: ReadonlyArray<SwitcherMachine>,
): ReadonlyArray<SwitcherGroup> {
  const defaultKind = machines.find((machine) => machine.isDefault)?.kind ?? null;
  const kinds: ReadonlyArray<MachineKind> =
    defaultKind === null
      ? MACHINE_KIND_ORDER
      : [defaultKind, ...MACHINE_KIND_ORDER.filter((kind) => kind !== defaultKind)];

  return kinds
    .map((kind) => ({
      kind,
      label: MACHINE_KIND_GROUP_LABELS[kind],
      items: machines
        .filter((machine) => machine.kind === kind)
        .toSorted((left, right) => {
          if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
          return left.name.localeCompare(right.name);
        }),
    }))
    .filter((group) => group.items.length > 0);
}
