/**
 * "Waiting for you" (T52) for the open chat: what waits (from the feed and
 * what the person did here), where the strip sends the feed, and the opened
 * links — a click on an own link anywhere in this chat's feed counts.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePageMessagesStore } from "../../htmlRenderPageMessages";
import { chatLinkTarget } from "../../lib/externalLinks";
import type { TimelineEntry } from "../../session-logic";
import { usePreviewPane } from "../preview/PreviewPaneContext";
import {
  derivePendingForYou,
  type PendingForYouItem,
  type PendingForYouLink,
} from "./pendingForYou.logic";
import { usePendingForYouStore } from "./pendingForYouStore";

const EMPTY: ReadonlyArray<string> = [];

const isOwnLink = (href: string) => chatLinkTarget(href) === "own";

function narrowScreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
}

/** Off with `?tray=off` (the demo's "before"); on everywhere else. */
export function pendingForYouEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return new URLSearchParams(window.location.search).get("tray") !== "off";
}

export function usePendingForYou(input: {
  readonly environmentId: EnvironmentId;
  readonly chatKey: string;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly enabled: boolean;
}) {
  const { environmentId, chatKey, entries } = input;
  const enabled = input.enabled && pendingForYouEnabled();
  const dismissed = usePendingForYouStore((state) => state.dismissedByChat[chatKey] ?? EMPTY);
  const opened = usePendingForYouStore((state) => state.openedByChat[chatKey] ?? EMPTY);
  // Folded to one line until opened on a phone (the feed is short there), open elsewhere.
  const folded = usePendingForYouStore((state) => state.foldedByChat[chatKey] ?? narrowScreen());
  const sentByPage = usePageMessagesStore((state) => state.sentByPage);
  const { openUrl } = usePreviewPane();

  const pending = useMemo(() => {
    const answered = new Set<string>();
    for (const [attachmentId, sent] of Object.entries(sentByPage)) {
      if (sent.some((entry) => !entry.draft)) answered.add(attachmentId);
    }
    return derivePendingForYou({
      entries,
      openedLinks: new Set(opened),
      dismissedIds: new Set(dismissed),
      answeredAttachmentIds: answered,
      isOwnLink,
    });
  }, [entries, opened, dismissed, sentByPage]);

  const [jumpTo, setJumpTo] = useState<{ entryId: string; navigationId: number } | null>(null);
  const onShow = useCallback((item: PendingForYouItem) => {
    setJumpTo((current) => ({
      entryId: item.entryId,
      navigationId: (current?.navigationId ?? 0) + 1,
    }));
  }, []);
  const onOpenLink = useCallback(
    (item: PendingForYouItem, link: PendingForYouLink) => {
      usePendingForYouStore.getState().markOpened(chatKey, link.href);
      openUrl(link.href);
      onShow(item);
    },
    [chatKey, openUrl, onShow],
  );
  const onDismiss = useCallback(
    (item: PendingForYouItem) => usePendingForYouStore.getState().dismiss(chatKey, item.id),
    [chatKey],
  );
  const onRestoreHidden = useCallback(
    () =>
      usePendingForYouStore.getState().restore(
        chatKey,
        pending.hidden.map((item) => item.id),
      ),
    [chatKey, pending.hidden],
  );
  const onFoldedChange = useCallback(
    (next: boolean) => usePendingForYouStore.getState().setFolded(chatKey, next),
    [chatKey],
  );

  // An own link opened from the feed itself counts as seen.
  useEffect(() => {
    if (!enabled) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (!anchor || !anchor.closest("[data-timeline-root]")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (isOwnLink(href)) usePendingForYouStore.getState().markOpened(chatKey, href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [chatKey, enabled]);

  return {
    enabled,
    marks: enabled ? pending.marks : null,
    jumpTo: enabled ? jumpTo : null,
    strip: {
      environmentId,
      items: enabled ? pending.items : [],
      hidden: pending.hidden,
      folded,
      onFoldedChange,
      onShow,
      onOpenLink,
      onDismiss,
      onRestoreHidden,
    },
  };
}
