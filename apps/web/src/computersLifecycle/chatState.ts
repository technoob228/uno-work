/**
 * Computers lifecycle: can a chat on one of the person's own computers go on
 * there right now (pure; WaitingForComputer.tsx shows the answer).
 */
import type { ProjectComputer, ThreadComputerWait } from "@t3tools/contracts";

/** Why a chat on an own computer can't go on right now (null: it can). */
export type OwnComputerChatState =
  | { readonly kind: "waiting"; readonly name: string; readonly since: string }
  | { readonly kind: "tool"; readonly name: string }
  | { readonly kind: "removed"; readonly name: string }
  | null;

export function ownComputerChatState(input: {
  readonly computer: ProjectComputer | null | undefined;
  readonly wait: ThreadComputerWait | null | undefined;
  /** The person's own computers as the cloud computer knows them (null: not known yet). */
  readonly own: ReadonlyArray<{ readonly id: string; readonly purpose: "tool" | "full" }> | null;
}): OwnComputerChatState {
  const { computer, wait, own } = input;
  if (wait) return { kind: "waiting", name: wait.computerName, since: wait.since };
  if (!computer || own === null) return null;
  const found = own.find((one) => one.id === computer.computerId);
  if (!found) return { kind: "removed", name: computer.computerName };
  if (found.purpose !== "full") return { kind: "tool", name: computer.computerName };
  return null;
}
