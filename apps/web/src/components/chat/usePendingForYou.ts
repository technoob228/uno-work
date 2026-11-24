/**
 * "Waiting for you" (T52) for the open chat. The computer keeps the list
 * (`thread.pendingForYou`, @t3tools/shared/pendingForYou) — the same one the
 * sidebar's count and the Inbox read; this hook shows it, sends the person's
 * "Not needed" / "Show again" / opened links back (applied here at once,
 * until the computer's copy arrives), and points the feed at a row.
 */
import {
  type EnvironmentId,
  type ThreadId,
  type ThreadPendingForYou,
  type ThreadPendingItem,
  type ThreadPendingLink,
} from "@t3tools/contracts";
import { isOwnSiteLink, normalizePendingLink } from "@t3tools/shared/pendingForYou";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { usePageMessagesStore } from "../../htmlRenderPageMessages";
import { newCommandId } from "../../lib/utils";
import { usePreviewPane } from "../preview/PreviewPaneContext";
import { usePendingForYouStore } from "./pendingForYouStore";

function narrowScreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
}

/** The feed row of an item: a card's page row, or the agent's message. */
export function pendingEntryId(item: ThreadPendingItem): string | null {
  if (item.kind === "card") return item.activityId ? `html-render:${item.activityId}` : null;
  return item.messageId;
}

interface Optimistic {
  readonly dismiss: ReadonlySet<string>;
  readonly restore: ReadonlySet<string>;
  readonly opened: ReadonlySet<string>;
}

const NO_OPTIMISTIC: Optimistic = { dismiss: new Set(), restore: new Set(), opened: new Set() };

/** The computer's list with what the person just did on top. */
export function applyOptimistic(
  pending: ThreadPendingForYou,
  optimistic: Optimistic,
  answeredPages: ReadonlySet<string>,
): { items: ThreadPendingItem[]; hidden: ThreadPendingItem[] } {
  const withOpened = (item: ThreadPendingItem): ThreadPendingItem =>
    item.kind !== "links" || optimistic.opened.size === 0
      ? item
      : {
          ...item,
          links: item.links.map((link) =>
            link.opened || !optimistic.opened.has(normalizePendingLink(link.href))
              ? link
              : { ...link, opened: true },
          ),
        };
  const waits = (item: ThreadPendingItem) =>
    (item.kind !== "links" || item.links.some((link) => !link.opened)) &&
    (item.kind !== "card" || item.attachmentId === null || !answeredPages.has(item.attachmentId));
  const all = [
    ...pending.items.map((item) => ({ item, hidden: false })),
    ...pending.hidden.map((item) => ({ item, hidden: true })),
  ];
  const items: ThreadPendingItem[] = [];
  const hidden: ThreadPendingItem[] = [];
  for (const entry of all) {
    const item = withOpened(entry.item);
    if (!waits(item)) continue;
    const isHidden =
      (entry.hidden && !optimistic.restore.has(item.id)) || optimistic.dismiss.has(item.id);
    (isHidden ? hidden : items).push(item);
  }
  // Same order as the computer's: answers to the person first, then oldest first.
  items.sort(
    (a, b) => Number(b.answersYou) - Number(a.answersYou) || a.createdAt.localeCompare(b.createdAt),
  );
  return { items, hidden };
}

export function usePendingForYou(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly chatKey: string;
  readonly pending: ThreadPendingForYou | null | undefined;
  readonly enabled: boolean;
}) {
  const { environmentId, threadId, chatKey, pending } = input;
  // An older computer keeps no list: no strip.
  const enabled = input.enabled && threadId !== null && pending != null;
  // Folded to one line until opened on a phone (the feed is short there), open elsewhere.
  const folded = usePendingForYouStore((state) => state.foldedByChat[chatKey] ?? narrowScreen());
  const sentByPage = usePageMessagesStore((state) => state.sentByPage);
  const { openUrl } = usePreviewPane();

  // What the person just did, until the computer's copy of the list changes.
  const [optimisticState, setOptimisticState] = useState<{
    readonly base: ThreadPendingForYou | null | undefined;
    readonly value: Optimistic;
  }>({ base: pending, value: NO_OPTIMISTIC });
  const optimistic = optimisticState.base === pending ? optimisticState.value : NO_OPTIMISTIC;

  const send = useCallback(
    (change: { dismiss?: string[]; restore?: string[]; opened?: string[] }) => {
      if (threadId === null) return;
      setOptimisticState((state) => {
        const current = state.base === pending ? state.value : NO_OPTIMISTIC;
        return {
          base: pending,
          value: {
            dismiss: new Set([
              ...[...current.dismiss].filter((id) => !change.restore?.includes(id)),
              ...(change.dismiss ?? []),
            ]),
            restore: new Set([
              ...[...current.restore].filter((id) => !change.dismiss?.includes(id)),
              ...(change.restore ?? []),
            ]),
            opened: new Set([
              ...current.opened,
              ...(change.opened ?? []).map(normalizePendingLink),
            ]),
          },
        };
      });
      const api = readEnvironmentApi(environmentId);
      void api?.orchestration
        .dispatchCommand({
          type: "thread.pending-for-you.update",
          commandId: newCommandId(),
          threadId,
          ...change,
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    },
    [environmentId, threadId, pending],
  );

  const view = useMemo(() => {
    if (!pending) return { items: [], hidden: [] };
    const answered = new Set<string>();
    for (const [attachmentId, sent] of Object.entries(sentByPage)) {
      if (sent.some((entry) => !entry.draft)) answered.add(attachmentId);
    }
    return applyOptimistic(pending, optimistic, answered);
  }, [pending, optimistic, sentByPage]);

  const marks = useMemo(() => {
    const map = new Map<string, "waiting" | "replaced">();
    for (const activityId of pending?.replacedActivityIds ?? []) {
      map.set(`html-render:${activityId}`, "replaced");
    }
    for (const item of view.items) {
      const entryId = pendingEntryId(item);
      if (entryId) map.set(entryId, "waiting");
    }
    return map as ReadonlyMap<string, "waiting" | "replaced">;
  }, [pending, view.items]);

  const [jumpTo, setJumpTo] = useState<{ entryId: string; navigationId: number } | null>(null);
  const onShow = useCallback((item: ThreadPendingItem) => {
    const entryId = pendingEntryId(item);
    if (!entryId) return;
    setJumpTo((current) => ({ entryId, navigationId: (current?.navigationId ?? 0) + 1 }));
  }, []);
  const onOpenLink = useCallback(
    (item: ThreadPendingItem, link: ThreadPendingLink) => {
      send({ opened: [link.href] });
      openUrl(link.href);
      onShow(item);
    },
    [send, openUrl, onShow],
  );
  const onDismiss = useCallback((item: ThreadPendingItem) => send({ dismiss: [item.id] }), [send]);
  const onRestoreHidden = useCallback(
    () => send({ restore: view.hidden.map((item) => item.id) }),
    [send, view.hidden],
  );
  const onFoldedChange = useCallback(
    (next: boolean) => usePendingForYouStore.getState().setFolded(chatKey, next),
    [chatKey],
  );

  // A site link opened from the feed itself counts as seen.
  const waitingHrefs = useMemo(
    () =>
      new Set(
        view.items.flatMap((item) =>
          item.links.filter((link) => !link.opened).map((link) => normalizePendingLink(link.href)),
        ),
      ),
    [view.items],
  );
  useEffect(() => {
    if (!enabled || waitingHrefs.size === 0) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (!anchor || !anchor.closest("[data-timeline-root]")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (isOwnSiteLink(href) && waitingHrefs.has(normalizePendingLink(href))) {
        send({ opened: [href] });
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [enabled, waitingHrefs, send]);

  return {
    enabled,
    marks: enabled ? marks : null,
    jumpTo: enabled ? jumpTo : null,
    strip: {
      environmentId,
      items: enabled ? view.items : [],
      hidden: view.hidden,
      folded,
      onFoldedChange,
      onShow,
      onOpenLink,
      onDismiss,
      onRestoreHidden,
    },
  };
}
