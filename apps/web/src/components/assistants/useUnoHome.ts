/**
 * Variant A (28.10): one Uno for the whole account. It lives on one computer
 * — its home, the cloud computer that doesn't sleep on Plus — and uses the
 * others as its hands. This says where that is, whether it stays awake, and
 * which of Uno's conversations are its channels.
 *
 * "Always on" is the account's plan (`/box-subscription`): on Free the cloud
 * computer sleeps when nobody uses it, so Uno can't write first.
 */
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { subscriptionQuery } from "../myuno/myUnoQueries";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import type { SidebarThreadSummary } from "../../types";
import { type TeamMember, useAssistantTeam } from "./useAssistantTeam";

export interface UnoHome {
  /** Uno itself (null until its computer answered). */
  readonly uno: TeamMember | null;
  /** The computer it lives on ("uno-work"). */
  readonly label: string;
  /** Plus keeps its home awake; Free lets it sleep. Null: not known yet. */
  readonly alwaysOn: boolean | null;
  /** "on uno-work · always on" / "on uno-work · wakes when you open Work". */
  readonly line: string;
}

export function useUnoHome(): UnoHome {
  const team = useAssistantTeam();
  const uno =
    team.find((member) => member.isUno && member.projectId === ASSISTANT_PROJECT_ID) ?? null;
  const subscription = useQuery(subscriptionQuery());
  const plan = subscription.data?.plan ?? null;
  const alwaysOn = plan === null ? null : plan !== "free";
  const label = uno?.computerLabel || "your cloud computer";
  const line =
    alwaysOn === false ? `on ${label} · wakes when you open Work` : `on ${label} · always on`;
  return { uno, label, alwaysOn, line };
}

/** The main conversation is "Everything"; the others are channels, by name. */
export function channelName(thread: Pick<SidebarThreadSummary, "assistantRole" | "title">): string {
  if (thread.assistantRole === "chat") return "Everything";
  const title = thread.title.trim().replace(/^#\s*/, "");
  return title.length > 0 ? title : "channel";
}

/** Everything first, then the channels by last activity (as given). */
export function orderChannels<T extends Pick<SidebarThreadSummary, "assistantRole">>(
  conversations: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const main = conversations.filter((thread) => thread.assistantRole === "chat");
  const rest = conversations.filter((thread) => thread.assistantRole !== "chat");
  return [...main, ...rest];
}

/** How many channels show before "Show N more". */
export const CHANNELS_PREVIEW = 5;

/** A channel name people can read in a sidebar: lowercase words joined by "-". */
export function cleanChannelName(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return name.length > 0 ? name : null;
}

/**
 * A chat its computer just made reached this window (the route opens only
 * chats it knows; opened too early it falls back to Home).
 */
export async function waitForThread(environmentId: string, threadId: string): Promise<void> {
  const here = () =>
    selectSidebarThreadsAcrossEnvironments(useStore.getState()).some(
      (thread) => thread.environmentId === environmentId && thread.id === threadId,
    );
  for (let tries = 0; tries < 60 && !here(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
