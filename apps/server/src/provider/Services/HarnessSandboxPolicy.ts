/**
 * HarnessSandboxPolicy — whether a chat's harness runs in the assistant
 * sandbox (sandbox/harnessSandbox.ts), as `ProviderService` asks before it
 * starts or resumes any session:
 *
 * - `none`: as always (the person's own chats, assistants on All projects);
 * - `sandbox`: a restricted assistant's chat on a computer that can hold it
 *   to its projects — the adapter spawns the harness inside bwrap;
 * - `refuse`: a restricted assistant's chat that can't be held to them
 *   (a Mac, no bwrap) — the turn stops with the message, never runs open.
 *
 * Implemented by the assistants layer (assistants/assistantSandboxPolicy.ts);
 * without it (tests) every chat is `none`.
 *
 * @module provider/Services/HarnessSandboxPolicy
 */
import type { ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { HarnessSandboxPlan } from "../../sandbox/harnessSandbox.ts";

export type HarnessSandboxDecision =
  | { readonly _tag: "none" }
  | { readonly _tag: "sandbox"; readonly plan: HarnessSandboxPlan }
  | { readonly _tag: "refuse"; readonly message: string };

export interface HarnessSandboxPolicyShape {
  readonly decide: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string | undefined;
  }) => Effect.Effect<HarnessSandboxDecision>;
}

export class HarnessSandboxPolicy extends Context.Service<
  HarnessSandboxPolicy,
  HarnessSandboxPolicyShape
>()("t3/provider/Services/HarnessSandboxPolicy") {}

/** Same decision, same process: a session whose signature changed is restarted. */
export function harnessSandboxSignature(decision: HarnessSandboxDecision): string {
  switch (decision._tag) {
    case "none":
      return "none";
    case "refuse":
      return "refuse";
    case "sandbox":
      return `sandbox:${JSON.stringify(decision.plan)}`;
  }
}
