/**
 * The Inbox as the window sees it: one snapshot per connected computer
 * (the daemon keeps the list and pushes it whole on every change — see
 * `InboxListener`), merged newest first. Actions go back to the daemon of
 * the item's computer, which answers with the new list.
 */
import {
  INBOX_NEEDS_YOU_KINDS,
  type EnvironmentId,
  type InboxItem,
  type InboxSnapshot,
  type InboxUpdateInput,
} from "@t3tools/contracts";
import { useMemo } from "react";
import { create } from "zustand";

import { readEnvironmentConnection } from "../environments/runtime";

export interface InboxEntry extends InboxItem {
  readonly environmentId: EnvironmentId;
}

interface InboxState {
  readonly byEnvironment: Readonly<Record<string, InboxSnapshot>>;
  readonly setSnapshot: (environmentId: EnvironmentId, snapshot: InboxSnapshot) => void;
  readonly forget: (environmentId: EnvironmentId) => void;
}

export const useInboxStore = create<InboxState>((set) => ({
  byEnvironment: {},
  setSnapshot: (environmentId, snapshot) =>
    set((state) => ({ byEnvironment: { ...state.byEnvironment, [environmentId]: snapshot } })),
  forget: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.byEnvironment)) return state;
      const { [environmentId]: _gone, ...rest } = state.byEnvironment;
      return { byEnvironment: rest };
    }),
}));

export function isSnoozed(item: InboxItem, nowMs: number = Date.now()): boolean {
  return item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > nowMs;
}

export function isNeedsYou(item: InboxItem): boolean {
  return INBOX_NEEDS_YOU_KINDS.has(item.kind);
}

export function mergeInbox(
  byEnvironment: Readonly<Record<string, InboxSnapshot>>,
): ReadonlyArray<InboxEntry> {
  const out: InboxEntry[] = [];
  for (const [environmentId, snapshot] of Object.entries(byEnvironment)) {
    for (const item of snapshot.items) {
      out.push({ ...item, environmentId: environmentId as EnvironmentId });
    }
  }
  return out.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function useInboxEntries(): ReadonlyArray<InboxEntry> {
  const byEnvironment = useInboxStore((state) => state.byEnvironment);
  return useMemo(() => mergeInbox(byEnvironment), [byEnvironment]);
}

/** Unread and not snoozed, on every connected computer. */
export function useInboxUnreadCount(): number {
  return useInboxStore((state) =>
    Object.values(state.byEnvironment).reduce((sum, snapshot) => sum + snapshot.unread, 0),
  );
}

/** Unread items that wait for the person (approvals, questions). */
export function useInboxNeedsYouCount(): number {
  const entries = useInboxEntries();
  return useMemo(
    () =>
      entries.filter((item) => item.readAt === null && !isSnoozed(item) && isNeedsYou(item)).length,
    [entries],
  );
}

/** Ask the item's computer to change its Inbox; the new list replaces the old. */
export async function updateInbox(
  environmentId: EnvironmentId,
  input: InboxUpdateInput,
): Promise<void> {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) return;
  const snapshot = await connection.client.inbox.update(input);
  useInboxStore.getState().setSnapshot(environmentId, snapshot);
}

/** Every connected computer at once ("Mark all read", "Clear read"). */
export async function updateInboxEverywhere(
  input: Pick<InboxUpdateInput, "action">,
): Promise<void> {
  const ids = Object.keys(useInboxStore.getState().byEnvironment) as EnvironmentId[];
  await Promise.all(ids.map((environmentId) => updateInbox(environmentId, input)));
}
