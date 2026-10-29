import type { OrchestrationEvent } from "@t3tools/contracts";

/**
 * Folds runs of streaming `thread.message-sent` deltas for the same message
 * into one event that carries the accumulated text and the last delta's
 * sequence. Applying the folded list leaves a client in exactly the state the
 * individual deltas would.
 *
 * Shared by the web client (one store write per burst) and the server's
 * subscription resume (a reconnecting client gets one event per message
 * instead of every delta it missed).
 */
export function coalesceOrchestrationMessageDeltas(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}
