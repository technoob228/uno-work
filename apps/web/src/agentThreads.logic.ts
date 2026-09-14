import type { ThreadController } from "@t3tools/contracts";

/**
 * Copy and state for threads another chat's agent created (plan 21).
 * Pure so the sidebar badge, the control bar above the composer and the
 * message label all say the same thing, and so it is testable without React.
 */

/** Absent on the wire means "human". */
export function normalizeThreadController(
  controller: ThreadController | null | undefined,
): ThreadController {
  return controller === "agent" ? "agent" : "human";
}

function quoteTitle(title: string): string {
  return `“${title}”`;
}

function cleanTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Tooltip / aria-label for the bot badge on an agent-spawned sidebar row. */
export function describeSpawnedThreadOrigin(parentTitle: string | null | undefined): string {
  const title = cleanTitle(parentTitle);
  return title ? `Created by the agent in ${quoteTitle(title)}` : "Created by an agent";
}

/** Small label above a user-role message another thread's agent sent. */
export function describeAgentSentMessage(senderTitle: string | null | undefined): string {
  const title = cleanTitle(senderTitle);
  return title ? `From the agent in ${quoteTitle(title)}` : "From an agent";
}

export interface ThreadControlBarState {
  readonly controller: ThreadController;
  /** Text before the parent link. */
  readonly leadText: string;
  /** Quoted parent title rendered as a link; null when the parent is not loaded. */
  readonly parentLinkText: string | null;
  /** Text after the parent link (or the whole sentence tail without a parent). */
  readonly trailText: string;
  /** Accessible sentence for the whole bar. */
  readonly summary: string;
  readonly actionLabel: string;
  /** Controller the action button dispatches. */
  readonly nextController: ThreadController;
}

/**
 * Control bar for an agent-spawned thread; null for threads a human created
 * (nothing to hand over).
 */
export function resolveThreadControlBarState(input: {
  readonly spawnedByThreadId: string | null | undefined;
  readonly controller: ThreadController | null | undefined;
  readonly parentTitle: string | null | undefined;
}): ThreadControlBarState | null {
  if (!input.spawnedByThreadId) {
    return null;
  }
  const controller = normalizeThreadController(input.controller);
  const title = cleanTitle(input.parentTitle);
  const parentLinkText = title ? quoteTitle(title) : null;

  if (controller === "agent") {
    return parentLinkText
      ? {
          controller,
          leadText: "An agent from ",
          parentLinkText,
          trailText: " is driving this chat",
          summary: `An agent from ${parentLinkText} is driving this chat`,
          actionLabel: "Take over",
          nextController: "human",
        }
      : {
          controller,
          leadText: "",
          parentLinkText: null,
          trailText: "An agent is driving this chat",
          summary: "An agent is driving this chat",
          actionLabel: "Take over",
          nextController: "human",
        };
  }

  return parentLinkText
    ? {
        controller,
        leadText: "You're in control · started by the agent in ",
        parentLinkText,
        trailText: "",
        summary: `You're in control. Started by the agent in ${parentLinkText}`,
        actionLabel: "Hand back to agent",
        nextController: "agent",
      }
    : {
        controller,
        leadText: "",
        parentLinkText: null,
        trailText: "You're in control · started by an agent",
        summary: "You're in control. Started by an agent",
        actionLabel: "Hand back to agent",
        nextController: "agent",
      };
}
