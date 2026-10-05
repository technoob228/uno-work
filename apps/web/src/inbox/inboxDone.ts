/**
 * "Done" means the same thing on Home (Continue cards) and in the Inbox:
 *
 * - a chat: it is settled (the sidebar's Settle, server-backed) and its Inbox
 *   items are dismissed — so it leaves Continue, the sidebar's active list and
 *   the Inbox together;
 * - an app notification (or any other Inbox item): it is dismissed.
 *
 * A chat that waits for the person (approval, question) is never settled by
 * this — it would come straight back anyway.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { readEnvironmentSupportsThreadSettlement } from "../environments/threadSettlementSupport";
import { newCommandId } from "../lib/utils";
import { selectEnvironmentState, useStore } from "../store";
import { type InboxEntry, updateInbox, useInboxStore } from "./inboxStore";
import { chatOpenRequests, inboxIdsClearedByChatDone } from "./openRequests.logic";

/** Inbox item kinds whose chat is settled when the item is dismissed. */
const SETTLE_ON_DISMISS = new Set(["agent.done", "agent.error"]);

export async function settleChat(environmentId: EnvironmentId, threadId: string): Promise<void> {
  if (!readEnvironmentSupportsThreadSettlement(environmentId)) return;
  const api = readEnvironmentApi(environmentId);
  if (!api) return;
  await api.orchestration.dispatchCommand({
    type: "thread.settle",
    commandId: newCommandId(),
    threadId: threadId as ThreadId,
  });
}

/**
 * Done on a chat card: settle it and clear its Inbox items — but never an
 * open Allow / question (the chat would keep waiting with nothing in the Inbox).
 */
export async function markChatDone(environmentId: EnvironmentId, threadId: string): Promise<void> {
  const items = useInboxStore.getState().byEnvironment[environmentId]?.items ?? [];
  const summary = selectEnvironmentState(useStore.getState(), environmentId)
    .sidebarThreadSummaryById[threadId as ThreadId];
  const ids = inboxIdsClearedByChatDone(items, threadId, chatOpenRequests(summary));
  await Promise.all([
    settleChat(environmentId, threadId),
    ids.length > 0 ? updateInbox(environmentId, { action: "dismiss", ids }) : Promise.resolve(),
  ]);
}

/** Done / Dismiss on an Inbox item; a finished or failed chat's item settles the chat too. */
export async function markInboxItemDone(item: InboxEntry): Promise<void> {
  const threadId =
    SETTLE_ON_DISMISS.has(item.kind) && item.open?.kind === "thread" ? item.open.threadId : null;
  await Promise.all([
    updateInbox(item.environmentId, { action: "dismiss", ids: [item.id] }),
    threadId ? settleChat(item.environmentId, threadId) : Promise.resolve(),
  ]);
}
