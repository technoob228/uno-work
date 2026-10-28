/**
 * Who started the chats the scripts make (assistants D, 28.10): what each fake
 * daemon answers on `GET /api/manager/started-by`. A chat an assistant starts
 * on another computer (`elsewhere`) is listed on that computer with
 * `local: false` and the assistant's computer, as the real daemon does for
 * `POST /api/manager/remote-chats`.
 */
import type { ManagerStartedByEntry } from "@t3tools/contracts";

import type { MachineKey } from "../heavyFixtures";

const byMachine = new Map<MachineKey, ManagerStartedByEntry[]>();

export function recordStartedBy(machine: MachineKey, entry: ManagerStartedByEntry): void {
  const list = byMachine.get(machine) ?? [];
  list.push(entry);
  byMachine.set(machine, list);
}

export function startedByOn(machine: MachineKey): ReadonlyArray<ManagerStartedByEntry> {
  return byMachine.get(machine) ?? [];
}
