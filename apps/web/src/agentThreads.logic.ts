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

/** Wording of the "Don't let agents write here" switch, one place for the menu and the bar. */
export const AGENTS_ACCESS_COPY = {
  close: "Don't let agents write here",
  open: "Let agents write here",
  closedStatus: "Agents can't write here",
  closedToast: "Agents can't write in this chat now",
  openedToast: "Agents can write in this chat again",
  failed: "Could not change who can write here",
} as const;

export type ThreadControlBarAction =
  /** Toggle "Don't let agents write here" (thread.meta.update agentsClosedAt). */
  | { readonly kind: "agents-access"; readonly label: string; readonly nextClosed: boolean }
  /** Older daemons (no `agentsCloseChat`): the old handoff, so no chat stays locked. */
  | { readonly kind: "handoff"; readonly label: string; readonly nextController: ThreadController };

export interface ThreadControlBarState {
  readonly controller: ThreadController;
  readonly closedToAgents: boolean;
  /** Text before the parent link. */
  readonly leadText: string;
  /** Quoted parent title rendered as a link; null when there is no (loaded) parent. */
  readonly parentLinkText: string | null;
  /** Text after the parent link (or the whole sentence tail without a parent). */
  readonly trailText: string;
  /** Accessible sentence for the whole bar. */
  readonly summary: string;
  /** null: nothing to do from the bar. */
  readonly action: ThreadControlBarAction | null;
}

function sentence(
  lead: string,
  parentLinkText: string | null,
  trail: string,
): Pick<ThreadControlBarState, "leadText" | "parentLinkText" | "trailText" | "summary"> {
  return {
    leadText: lead,
    parentLinkText,
    trailText: trail,
    summary: `${lead}${parentLinkText ?? ""}${trail}`.trim(),
  };
}

/**
 * The slim strip above the composer (0.0.115):
 * - a chat the person closed to agents — any chat — says so and offers
 *   "Let agents write here";
 * - a chat another chat's agent started says who started it / drives it and
 *   offers "Don't let agents write here" (a human message already takes it
 *   over; there is no "Hand back to agent" any more — agents may write into
 *   any free chat unless it is closed);
 * - any other chat: no strip (null).
 * `supportsAgentsAccess` false (an older daemon): the old take-over /
 * hand-back pair, which is the only way such a daemon unlocks a chat.
 */
export function resolveThreadControlBarState(input: {
  readonly spawnedByThreadId: string | null | undefined;
  readonly controller: ThreadController | null | undefined;
  readonly parentTitle: string | null | undefined;
  readonly agentsClosedAt?: string | null | undefined;
  readonly supportsAgentsAccess?: boolean | undefined;
}): ThreadControlBarState | null {
  const controller = normalizeThreadController(input.controller);
  const spawned = Boolean(input.spawnedByThreadId);
  const title = cleanTitle(input.parentTitle);
  const parentLinkText = spawned && title ? quoteTitle(title) : null;

  if (input.supportsAgentsAccess !== true) {
    return spawned ? resolveLegacyControlBarState(controller, parentLinkText) : null;
  }

  const closedToAgents = (input.agentsClosedAt ?? null) !== null;
  if (closedToAgents) {
    return {
      controller,
      closedToAgents,
      ...(spawned
        ? parentLinkText
          ? sentence(
              `${AGENTS_ACCESS_COPY.closedStatus} · started by the agent in `,
              parentLinkText,
              "",
            )
          : sentence("", null, `${AGENTS_ACCESS_COPY.closedStatus} · started by an agent`)
        : sentence("", null, AGENTS_ACCESS_COPY.closedStatus)),
      action: { kind: "agents-access", label: AGENTS_ACCESS_COPY.open, nextClosed: false },
    };
  }
  if (!spawned) return null;

  const closeAction = {
    kind: "agents-access",
    label: AGENTS_ACCESS_COPY.close,
    nextClosed: true,
  } as const;
  if (controller === "agent") {
    return {
      controller,
      closedToAgents,
      ...(parentLinkText
        ? sentence("An agent from ", parentLinkText, " is driving this chat")
        : sentence("", null, "An agent is driving this chat")),
      action: closeAction,
    };
  }
  return {
    controller,
    closedToAgents,
    ...(parentLinkText
      ? sentence("Started by the agent in ", parentLinkText, "")
      : sentence("", null, "Started by an agent")),
    action: closeAction,
  };
}

function resolveLegacyControlBarState(
  controller: ThreadController,
  parentLinkText: string | null,
): ThreadControlBarState {
  if (controller === "agent") {
    return {
      controller,
      closedToAgents: false,
      ...(parentLinkText
        ? sentence("An agent from ", parentLinkText, " is driving this chat")
        : sentence("", null, "An agent is driving this chat")),
      action: { kind: "handoff", label: "Take over", nextController: "human" },
    };
  }
  return {
    controller,
    closedToAgents: false,
    ...(parentLinkText
      ? sentence("You're in control · started by the agent in ", parentLinkText, "")
      : sentence("", null, "You're in control · started by an agent")),
    action: { kind: "handoff", label: "Hand back to agent", nextController: "agent" },
  };
}
