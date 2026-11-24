/**
 * "Waiting for you" (T52) in the threads projection: the stored fold
 * (`projection_threads.pending_for_you_json`) stepped by one event, or
 * rebuilt from the chat's feed after a revert. Pure; the pipeline reads and
 * writes the rows (ProjectionPipeline.ts).
 *
 * A chat with nothing stored (from before 0.0.192) starts tracking at the
 * first entry it sees, so it never lights up with its old cards.
 */
import { HTML_RENDER_ACTIVITY_KIND, readHtmlRenderReference } from "@t3tools/shared/htmlRender";
import {
  applyPendingPersonAction,
  derivePendingForYouState,
  initialPendingForYouState,
  parsePendingForYouState,
  pendingFeedOf,
  stepPendingForYou,
  type PendingFeedEntry,
  type PendingPersonAction,
} from "@t3tools/shared/pendingForYou";

type Stored = string | null | undefined;

export function initialPendingForYouJson(since: string): string {
  return JSON.stringify(initialPendingForYouState(since));
}

/** A page activity as a feed entry; null for any other activity. */
export function pendingPageEntry(activity: {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}): PendingFeedEntry | null {
  if (activity.kind !== HTML_RENDER_ACTIVITY_KIND) return null;
  const page = readHtmlRenderReference(activity.payload);
  if (page === undefined || page.source !== "card") return null;
  return { type: "page", activityId: activity.id, page, createdAt: activity.createdAt };
}

/** A finished message as a feed entry. */
export function pendingMessageEntry(message: {
  readonly messageId: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly sentByThreadId?: string | null | undefined;
  readonly createdAt: string;
}): PendingFeedEntry {
  return {
    type: "message",
    id: message.messageId,
    role: message.role,
    text: message.text,
    sentByThreadId: message.sentByThreadId ?? null,
    createdAt: message.createdAt,
  };
}

/** The stored state after one more feed entry (JSON). */
export function stepPendingForYouJson(stored: Stored, entry: PendingFeedEntry): string {
  const state = parsePendingForYouState(stored) ?? initialPendingForYouState(entry.createdAt);
  return JSON.stringify(stepPendingForYou(state, entry));
}

/** The stored state after the person hid, showed again or opened something (JSON). */
export function applyPendingActionJson(
  stored: Stored,
  action: PendingPersonAction,
  at: string,
): string {
  const state = parsePendingForYouState(stored) ?? initialPendingForYouState(at);
  return JSON.stringify(applyPendingPersonAction(state, action));
}

/** Rebuilt from what is left of the feed (a revert); what the person did stays. */
export function rebuildPendingForYouJson(
  stored: Stored,
  feed: {
    readonly messages: ReadonlyArray<{
      readonly messageId: string;
      readonly role: "user" | "assistant" | "system";
      readonly text: string;
      readonly sentByThreadId?: string | null | undefined;
      readonly isStreaming: boolean;
      readonly createdAt: string;
    }>;
    readonly activities: ReadonlyArray<{
      readonly activityId: string;
      readonly kind: string;
      readonly payload: unknown;
      readonly createdAt: string;
    }>;
  },
): string | null {
  const state = parsePendingForYouState(stored);
  if (state === null) return stored ?? null;
  const entries = pendingFeedOf({
    messages: feed.messages.map((message) => ({
      id: message.messageId,
      role: message.role,
      text: message.text,
      sentByThreadId: message.sentByThreadId ?? null,
      createdAt: message.createdAt,
      streaming: message.isStreaming,
    })),
    pages: feed.activities.flatMap((activity) => {
      const entry = pendingPageEntry({ ...activity, id: activity.activityId });
      return entry?.type === "page" ? [entry] : [];
    }),
  });
  return JSON.stringify(derivePendingForYouState(state.since, entries, state));
}
