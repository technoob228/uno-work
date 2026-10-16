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

/** The latest step in the dock's top row: short; the full text is one chevron away. */
export const CHAT_DOCK_STEP_CHARS = 60;

export function chatDockStepPreview(text: string): string {
  return chatDockFirstLine(text, CHAT_DOCK_STEP_CHARS);
}

type ApprovalKind = "command" | "file-read" | "file-change" | "other";

const APPROVAL_PHRASE: Readonly<Record<ApprovalKind, string>> = {
  command: "The agent wants to run a command.",
  "file-change": "The agent wants to change files.",
  "file-read": "The agent wants to read files.",
  other: "The agent asks for your OK to go on.",
};

/**
 * The human line of an approval: what the agent said right before asking
 * (its last message after the person's last one), else a plain phrase by the
 * kind of request. The command itself goes under "Show command".
 */
export function chatDockApprovalPhrase(input: {
  readonly requestKind: ApprovalKind;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}): string {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (message.role === "user") break;
    if (message.role === "assistant") {
      const line = chatDockFirstLine(message.text, 140);
      if (line) return line;
    }
  }
  return APPROVAL_PHRASE[input.requestKind];
}

/** What pops up over the mini window. */
export type ChatDockNotice =
  | {
      readonly kind: "approval";
      readonly id: string;
      /** The human line. */
      readonly text: string;
      /** The whole command (or path), shown on demand. */
      readonly command: string | null;
    }
  | { readonly kind: "reply"; readonly id: string; readonly text: string };

/**
 * While the chat is folded: an approval the agent waits for always shows (and
 * stays); otherwise, once the agent has handed the turn back, its last reply —
 * if the person hasn't seen it yet — shows once. Messages in the middle of a
 * turn ("running the tests…") don't pop up.
 */
export function nextChatDockNotice(input: {
  readonly pendingApproval: {
    readonly requestId: string;
    readonly requestKind: ApprovalKind;
    readonly detail?: string | undefined;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
  }>;
  readonly isWorking: boolean;
  /** The latest reply the person has already seen (or got as a hint). */
  readonly seenReplyId: string | null;
}): ChatDockNotice | null {
  if (input.pendingApproval) {
    const command = input.pendingApproval.detail?.trim() || null;
    return {
      kind: "approval",
      id: input.pendingApproval.requestId,
      text: chatDockApprovalPhrase({
        requestKind: input.pendingApproval.requestKind,
        messages: input.messages,
      }),
      command,
    };
  }
  if (input.isWorking) return null;
  const reply = chatDockLatestReply(input.messages);
  if (!reply || reply.streaming || reply.id === input.seenReplyId) return null;
  const text = chatDockFirstLine(reply.text);
  if (!text) return null;
  return { kind: "reply", id: reply.id, text };
}

export function chatDockLatestReply<T extends { readonly role: string }>(
  messages: ReadonlyArray<T>,
): T | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "assistant") return messages[index]!;
  }
  return null;
}
