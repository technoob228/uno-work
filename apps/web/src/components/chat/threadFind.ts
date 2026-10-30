import type { MessageId, OrchestrationThreadFindEntry } from "@t3tools/contracts";

export interface ThreadFindMatch {
  readonly messageId: MessageId;
  /** Which match in the message, from its start. */
  readonly occurrence: number;
}

export function stepThreadFindIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  return (((index + delta) % total) + total) % total;
}

export function formatThreadFindCount(index: number, total: number): string {
  return total <= 0 ? "0/0" : `${Math.min(index, total - 1) + 1}/${total}`;
}

export function matchAtIndex(
  entries: ReadonlyArray<OrchestrationThreadFindEntry>,
  index: number,
): ThreadFindMatch | null {
  for (const entry of entries) {
    if (index < entry.startIndex + entry.count) {
      return { messageId: entry.messageId, occurrence: Math.max(0, index - entry.startIndex) };
    }
  }
  return null;
}

/**
 * Where a search starts: the message asked for, else the newest match on
 * screen, else the newest match. A chat is read from its end, so that is where
 * the person is, and each next match goes back in time.
 */
export function startingFindIndex(
  entries: ReadonlyArray<OrchestrationThreadFindEntry>,
  input: { readonly messageId?: string | null; readonly visible?: ReadonlySet<string> },
): number {
  const asked = entries.find((entry) => entry.messageId === input.messageId);
  if (asked) return asked.startIndex;
  const visible = entries.findLast((entry) => input.visible?.has(entry.messageId));
  const entry = visible ?? entries.at(-1);
  return entry ? entry.startIndex + entry.count - 1 : 0;
}

/**
 * The chat's ChatView catches shortcuts before anything else on the page, so
 * ⌘F has to step aside itself: with the keyboard in the right panel it belongs
 * to what is open there. Files has its own search, an open page the browser's.
 */
export function threadFindOwnsShortcut(focused: Element | null): boolean {
  return focused?.closest("[data-preview-pane-body]") == null;
}
