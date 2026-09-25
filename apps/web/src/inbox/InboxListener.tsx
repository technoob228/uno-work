/**
 * Invisible: keeps the Inbox of every connected computer in `inboxStore`,
 * shows new items as system notifications (see systemNotifications.ts for
 * which ones, and when), and marks a chat's items read while the person is
 * looking at that chat.
 */
import type { EnvironmentId, InboxSnapshot } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { type InboxEntry, updateInbox, useInboxStore } from "./inboxStore";
import {
  askForPermissionOnFirstGesture,
  showSystemNotification,
  windowIsInFront,
} from "./systemNotifications";
import { useOpenInboxItem } from "./useOpenInboxItem";

/** Items that are new or changed since the last snapshot, still unread. */
export function freshItems(
  previous: InboxSnapshot | undefined,
  next: InboxSnapshot,
): InboxSnapshot["items"] {
  if (!previous) return [];
  const seen = new Map(previous.items.map((item) => [item.id, item.updatedAt]));
  return next.items.filter(
    (item) =>
      item.readAt === null && item.snoozedUntil === null && seen.get(item.id) !== item.updatedAt,
  );
}

export function InboxListener() {
  const openItem = useOpenInboxItem();
  const openItemRef = useRef(openItem);
  openItemRef.current = openItem;

  // The chat on screen: its own news doesn't need a pop-up while in front.
  const params = useParams({ strict: false }) as {
    environmentId?: string;
    threadId?: string;
  };
  const viewingRef = useRef(params);
  viewingRef.current = params;

  // Notifications are on by default; a browser still has to be allowed once.
  useEffect(() => askForPermissionOnFirstGesture(), []);

  const [connectionsVersion, setConnectionsVersion] = useState(0);
  useEffect(
    () => subscribeEnvironmentConnections(() => setConnectionsVersion((value) => value + 1)),
    [],
  );

  useEffect(() => {
    const connections = listEnvironmentConnections();
    const live = new Set<string>(connections.map((connection) => connection.environmentId));
    for (const environmentId of Object.keys(useInboxStore.getState().byEnvironment)) {
      if (!live.has(environmentId)) useInboxStore.getState().forget(environmentId as EnvironmentId);
    }
    const unsubscribers = connections.map((connection) => {
      const environmentId = connection.environmentId;
      return connection.client.inbox.subscribe((snapshot) => {
        const previous = useInboxStore.getState().byEnvironment[environmentId];
        useInboxStore.getState().setSnapshot(environmentId, snapshot);
        for (const item of freshItems(previous, snapshot)) {
          const entry: InboxEntry = { ...item, environmentId };
          const viewing = viewingRef.current;
          showSystemNotification({
            tag: `${environmentId}:${item.id}`,
            kind: item.kind,
            viewingItsChat:
              item.open?.kind === "thread" &&
              viewing.environmentId === environmentId &&
              viewing.threadId === item.open.threadId,
            title: item.title,
            body: item.body,
            onClick: () => void openItemRef.current(entry),
          });
        }
      });
    });
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [connectionsVersion]);

  // Looking at a chat reads its news.
  const byEnvironment = useInboxStore((state) => state.byEnvironment);
  useEffect(() => {
    const { environmentId, threadId } = params;
    if (!environmentId || !threadId) return;
    const snapshot = byEnvironment[environmentId];
    if (!snapshot) return;
    // "Finished" and "failed" are news you have now seen. An approval or a
    // question stays in "Needs you" until it is answered (the daemon reads it then).
    const seen = snapshot.items
      .filter(
        (item) =>
          item.readAt === null &&
          (item.kind === "agent.done" || item.kind === "agent.error") &&
          item.open?.kind === "thread" &&
          item.open.threadId === threadId,
      )
      .map((item) => item.id);
    if (seen.length === 0) return;
    const markRead = () => {
      if (!windowIsInFront()) return;
      void updateInbox(environmentId as EnvironmentId, { action: "read", ids: seen }).catch(
        () => undefined,
      );
    };
    markRead();
    window.addEventListener("focus", markRead);
    return () => window.removeEventListener("focus", markRead);
  }, [byEnvironment, params.environmentId, params.threadId]);

  return null;
}
