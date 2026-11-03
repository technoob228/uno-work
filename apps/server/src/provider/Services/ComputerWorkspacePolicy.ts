/**
 * ComputerWorkspacePolicy — where a chat's project lives, as `ProviderService`
 * asks before it starts, resumes or sends a turn to a session
 * (computers lifecycle, "brain in the cloud", CONTRACT.md §3, §7.5):
 *
 * - `local`: the project is on this computer — as always;
 * - `computer`: the project is a folder on the person's own computer in full
 *   mode: the harness runs here with its own shell and file tools switched
 *   off, and the `workspace_*` tools (myComputer/workspaceTools.ts) do the
 *   work there. An adapter without `capabilities.computerWorkspace` can't;
 * - `refuse`: such a chat can't run now (the computer is a tool for agents,
 *   it was removed): the turn stops with the message.
 *
 * Implemented by myComputer/ComputerWorkspaces.ts; absent (tests) = `local`.
 *
 * @module provider/Services/ComputerWorkspacePolicy
 */
import type { ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

/** What an adapter gets for a chat whose project is on the person's computer. */
export interface ComputerWorkspacePlan {
  readonly computerId: string;
  readonly computerName: string;
  /** The project folder, absolute, on that computer. */
  readonly path: string;
}

export type ComputerWorkspaceDecision =
  | { readonly _tag: "local" }
  | { readonly _tag: "computer"; readonly plan: ComputerWorkspacePlan }
  | { readonly _tag: "refuse"; readonly message: string };

export interface ComputerWorkspacePolicyShape {
  readonly decide: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ComputerWorkspaceDecision>;
}

export class ComputerWorkspacePolicy extends Context.Service<
  ComputerWorkspacePolicy,
  ComputerWorkspacePolicyShape
>()("t3/provider/Services/ComputerWorkspacePolicy") {}

/** Same decision, same session; a changed one restarts the session before its next turn. */
export function computerWorkspaceSignature(decision: ComputerWorkspaceDecision): string {
  return decision._tag === "computer"
    ? `computer:${decision.plan.computerId}:${decision.plan.path}`
    : decision._tag;
}

/** The sentence for a harness that can't run a chat on the person's computer. */
export function harnessCantUseComputerMessage(harness: string, computerName: string): string {
  const name = harness.length > 0 ? harness[0]!.toUpperCase() + harness.slice(1) : "This agent";
  return `${name} can't work on ${computerName} yet: pick Claude or Hermes for this chat, or continue it in the cloud.`;
}
