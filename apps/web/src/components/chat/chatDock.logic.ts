/**
 * The chat over a full-screen panel tab (w0138 p3): one dense block at the
 * bottom (latest step + composer) that folds into a mini window — or a narrow
 * column — while the person looks at the tab. Pure parts live here.
 */

/** Where the chat is while a panel tab has the whole window. */
export type ChatDockMode = "peek" | "expanded" | "minimized";

/** What the folded chat says about itself (status dot + a word). */
export type ChatDockStatus = "working" | "needs-approval" | "needs-answer" | "your-turn";

export function chatDockStatus(input: {
  readonly isWorking: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
}): ChatDockStatus {
  // A question to the person beats "working": the agent is stuck until they answer.
  if (input.hasPendingApproval) return "needs-approval";
  if (input.hasPendingUserInput) return "needs-answer";
  if (input.isWorking) return "working";
  return "your-turn";
}

export const CHAT_DOCK_STATUS_LABEL: Readonly<Record<ChatDockStatus, string>> = {
  working: "Working…",
  "needs-approval": "Needs your OK",
  "needs-answer": "Needs your answer",
  "your-turn": "Your turn",
};

/** Tailwind classes of the status dot. */
export const CHAT_DOCK_STATUS_DOT: Readonly<Record<ChatDockStatus, string>> = {
  working: "bg-sky-500",
  "needs-approval": "bg-amber-500",
  "needs-answer": "bg-amber-500",
  "your-turn": "bg-emerald-500",
};

/** How long a reply hint stays over the mini window before it hides itself. */
export const CHAT_DOCK_HINT_MS = 6_000;

/**
 * The first readable line of a message, for a one-line preview: markdown
 * marks and extra spaces dropped, cut with an ellipsis.
 */
export function chatDockFirstLine(text: string, max = 160): string {
  const line =
    text
      .split("\n")
      .map((part) =>
        part
          .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, "")
          .replace(/[*_`]+/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((part) => part.length > 0) ?? "";
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).trimEnd()}…`;
}

/** What pops up over the mini window. */
export type ChatDockNotice =
  | { readonly kind: "approval"; readonly id: string; readonly text: string }
  | { readonly kind: "reply"; readonly id: string; readonly text: string };

/**
 * While the chat is folded: an approval the agent waits for always shows (and
 * stays); otherwise a new finished reply of the agent — one the person hasn't
 * seen yet — shows once.
 */
export function nextChatDockNotice(input: {
  readonly pendingApproval: {
    readonly requestId: string;
    readonly detail?: string | undefined;
  } | null;
  readonly latestReply: {
    readonly id: string;
    readonly text: string;
    readonly streaming: boolean;
  } | null;
  /** The latest reply the person has already seen (or got as a hint). */
  readonly seenReplyId: string | null;
}): ChatDockNotice | null {
  if (input.pendingApproval) {
    const detail = input.pendingApproval.detail?.trim();
    return {
      kind: "approval",
      id: input.pendingApproval.requestId,
      text: detail ? chatDockFirstLine(detail) : "The agent asks for your OK to go on.",
    };
  }
  const reply = input.latestReply;
  if (!reply || reply.streaming || reply.id === input.seenReplyId) return null;
  const text = chatDockFirstLine(reply.text);
  if (!text) return null;
  return { kind: "reply", id: reply.id, text };
}
