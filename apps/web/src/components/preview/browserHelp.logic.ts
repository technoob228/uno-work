/**
 * Which page of the computer's browser waits on the person for this chat
 * (`requestHelp`), for the card above the composer (`BrowserHelpCard.tsx`).
 */
import type { BrowserLivePage } from "@t3tools/contracts";

export function pageAskingForHelp(
  pages: ReadonlyArray<BrowserLivePage>,
  threadId: string,
): BrowserLivePage | null {
  // The latest ask first: a chat has one page on the computer, but be sure.
  const asking = pages
    .filter((page) => page.help !== null && page.context?.threadId === threadId)
    .toSorted((a, b) => (b.help?.requestedAt ?? "").localeCompare(a.help?.requestedAt ?? ""));
  return asking[0] ?? null;
}
