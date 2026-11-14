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

/** The handoff, one wording for the strip, the bar above the composer and the menu. */
export const HANDLER_COPY = {
  join: "Join",
  joinHint: "Join: it becomes your chat, in your sidebar",
  handToAgent: "Hand to agent",
  handToAgentHint: "Hand to the agent: it leaves your sidebar, under Agents' chats",
  joinedToast: "You're on this chat now: it's in your sidebar",
  handedToast: "Handed to the agent: it's under Agents' chats in the sidebar",
  failed: "Could not change who handles this chat",
} as const;

export type ThreadControlBarAction =
  /** Toggle "Don't let agents write here" (thread.meta.update agentsClosedAt). */
  | { readonly kind: "agents-access"; readonly label: string; readonly nextClosed: boolean }
  /** Who handles the chat (thread.control.set): Join / Hand to agent (14.11), or an older daemon's pair. */
  | {
      readonly kind: "handoff";
      readonly label: string;
      readonly nextController: ThreadController;
      readonly hint?: string;
    };

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
  /** A quieter second button ("Don't let agents write here" next to Join / Hand to agent). */
  readonly secondaryAction: ThreadControlBarAction | null;
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

const JOIN_ACTION = {
  kind: "handoff",
  label: HANDLER_COPY.join,
  hint: HANDLER_COPY.joinHint,
  nextController: "human",
} as const;
const HAND_TO_AGENT_ACTION = {
  kind: "handoff",
  label: HANDLER_COPY.handToAgent,
  hint: HANDLER_COPY.handToAgentHint,
  nextController: "agent",
} as const;

/**
 * The slim strip above the composer (0.0.115, handler 14.11):
 * - a chat the person closed to agents — any chat — says so and offers
 *   "Let agents write here";
 * - a chat another chat's agent started says who started it and who handles
 *   it: an agent ("Join") or the person ("Hand to agent"), with "Don't let
 *   agents write here" beside;
 * - a chat the person handed to its agent says so and offers "Join";
 * - a chat the person started where agents talk now (`agentLed`, see
 *   Sidebar.owner: the last word is another chat's agent's and nobody
 *   called the person) says so, with the switch (Misha 13.11);
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
  /** An agent drives the chat now (Sidebar.owner's threadOwner is "agent"). */
  readonly agentLed?: boolean | undefined;
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
      secondaryAction: null,
    };
  }
  const closeAction = {
    kind: "agents-access",
    label: AGENTS_ACCESS_COPY.close,
    nextClosed: true,
  } as const;
  if (!spawned) {
    if (controller === "agent") {
      return {
        controller,
        closedToAgents,
        ...sentence("", null, "You handed this chat to its agent · it's out of your sidebar"),
        action: JOIN_ACTION,
        secondaryAction: closeAction,
      };
    }
    if (input.agentLed !== true) return null;
    return {
      controller: "agent",
      closedToAgents,
      ...sentence(
        "",
        null,
        "Agents are talking here · you'll see Ready or Needs you when it's your turn",
      ),
      action: closeAction,
      secondaryAction: null,
    };
  }

  if (controller === "agent") {
    return {
      controller,
      closedToAgents,
      ...(parentLinkText
        ? sentence("The agent in ", parentLinkText, " handles this chat")
        : sentence("", null, "An agent handles this chat")),
      action: JOIN_ACTION,
      secondaryAction: closeAction,
    };
  }
  return {
    controller,
    closedToAgents,
    ...(parentLinkText
      ? sentence("Started by the agent in ", parentLinkText, " · you're on it")
      : sentence("", null, "Started by an agent · you're on it")),
    action: HAND_TO_AGENT_ACTION,
    secondaryAction: closeAction,
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
      secondaryAction: null,
    };
  }
  return {
    controller,
    closedToAgents: false,
    ...(parentLinkText
      ? sentence("You're in control · started by the agent in ", parentLinkText, "")
      : sentence("", null, "You're in control · started by an agent")),
    action: { kind: "handoff", label: "Hand back to agent", nextController: "agent" },
    secondaryAction: null,
  };
}
