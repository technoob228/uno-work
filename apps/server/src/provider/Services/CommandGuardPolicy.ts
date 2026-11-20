/**
 * CommandGuardPolicy — chats held to the rules of the person's computer,
 * as `ProviderService` asks before it starts or resumes a session: a chat
 * started on this computer at a cloud chat's request (chatRequests/) can't
 * ssh to other machines, deploy, push, use sudo, install or read secrets —
 * whatever the chat's mode. The adapter blocks those tool calls by code
 * before they run (Claude: a PreToolUse hook); an adapter without
 * `capabilities.commandGuard` can't run such a chat at all.
 *
 * Implemented by chatRequests/commandGuardPolicy.ts; absent (tests) = no chat
 * is held.
 *
 * @module provider/Services/CommandGuardPolicy
 */
import type { ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

/** What an adapter gets for a chat held to the rules. */
export interface CommandGuardPlan {
  /** Why, for the agent and the logs: "started at the request of a cloud chat". */
  readonly why: string;
  /**
   * Folders no tool may touch, absolute: Uno Work's own data here (its
   * chats, settings and sign-ins) and the request folder.
   */
  readonly blockedRoots: ReadonlyArray<string>;
  /**
   * T51: the chat only reads (it answers a colleague's agent's question):
   * reading tools only — no edits, no commands, no MCP, no web.
   */
  readonly readOnly?: boolean;
}

export interface CommandGuardPolicyShape {
  readonly decide: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<CommandGuardPlan | null>;
  /** The same, for the uno-work tools of that chat. */
  readonly isGuarded: (threadId: string) => Effect.Effect<boolean>;
}

export class CommandGuardPolicy extends Context.Service<
  CommandGuardPolicy,
  CommandGuardPolicyShape
>()("t3/provider/Services/CommandGuardPolicy") {}

/** The sentence for a harness that can't be held to the rules. */
export function harnessNotGuardableMessage(harness: string): string {
  const name = harness.length > 0 ? harness[0]!.toUpperCase() + harness.slice(1) : "This agent";
  return `${name} can't run this chat: it was started at a cloud chat's request, and only Claude is held to the rules for such chats here. Switch the chat to Claude.`;
}
