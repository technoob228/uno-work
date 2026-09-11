/**
 * Chat commands of a connector (`/use`, `/thread`, `/assistant`, `/where`,
 * `/threads`, `/approve`, `/deny`): the parser and the pure decisions. The
 * executor that reads bindings and dispatches lives in
 * `connectorCommandHandler.ts`.
 *
 * Commands are recognised before addressing / wake logic and only from
 * allowlisted chats; anything that is not one of these commands is ordinary
 * message text for the bound target (so `/start` or `/help` from Telegram's
 * menu still reach the assistant as text).
 */
import type {
  ApprovalRequestId,
  ManagerConnectorBindingTarget,
  ProviderApprovalDecision,
  ThreadId,
} from "@t3tools/contracts";

export type ConnectorCommand =
  | { readonly name: "use"; readonly query: string }
  | { readonly name: "thread"; readonly query: string }
  | { readonly name: "assistant" }
  | { readonly name: "where" }
  | { readonly name: "threads" }
  | { readonly name: "approve" }
  | { readonly name: "deny" };

export const CONNECTOR_COMMAND_NAMES: ReadonlyArray<ConnectorCommand["name"]> = [
  "use",
  "thread",
  "assistant",
  "where",
  "threads",
  "approve",
  "deny",
];

export const CONNECTOR_COMMANDS_HELP = [
  "/use <project title or id> - send this chat's messages to a project",
  "/thread <thread id or title> - send them into one specific thread",
  "/assistant - talk to the assistant again (default)",
  "/where - show what this chat is bound to",
  "/threads - list live threads of the bound project",
  "/approve, /deny - resolve the oldest pending approval of the bound thread",
].join("\n");

const COMMAND_PATTERN = /^\/([a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i;

/**
 * Parse a message as a connector command. Returns null for anything that is
 * not one of ours, including `/name@otherbot` addressed to a different bot
 * in a group (Telegram appends `@botname` to commands picked from the menu).
 */
export const parseConnectorCommand = (
  text: string,
  botUsername: string | null,
): ConnectorCommand | null => {
  const match = COMMAND_PATTERN.exec(text.trim());
  if (match === null) {
    return null;
  }
  const [, rawName, mentionedBot, rawArgument] = match;
  if (
    mentionedBot !== undefined &&
    botUsername !== null &&
    mentionedBot.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return null;
  }
  const name = rawName!.toLowerCase();
  const argument = rawArgument?.trim() ?? "";
  switch (name) {
    case "use":
      return { name: "use", query: argument };
    case "thread":
      return { name: "thread", query: argument };
    case "assistant":
      return { name: "assistant" };
    case "where":
      return { name: "where" };
    case "threads":
      return { name: "threads" };
    case "approve":
      return { name: "approve" };
    case "deny":
      return { name: "deny" };
    default:
      return null;
  }
};

export const approvalDecisionForCommand = (
  command: Extract<ConnectorCommand, { name: "approve" | "deny" }>,
): ProviderApprovalDecision => (command.name === "approve" ? "accept" : "decline");

// ---------------------------------------------------------------------------
// /approve, /deny
// ---------------------------------------------------------------------------

export interface PendingApprovalCandidate {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  /** Pending request ids, oldest first. */
  readonly requestIds: ReadonlyArray<ApprovalRequestId>;
}

export type ApprovalAction =
  | {
      readonly kind: "respond";
      readonly threadId: ThreadId;
      readonly threadTitle: string;
      readonly requestId: ApprovalRequestId;
    }
  | { readonly kind: "nothing-pending" }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<PendingApprovalCandidate> }
  | { readonly kind: "unsupported-target" };

/**
 * Which approval a chat-level `/approve` or `/deny` resolves: the oldest one
 * of the bound thread, or — for a project binding — of the single thread
 * that has something pending. Several threads pending is ambiguous; the
 * assistant target is not supported (its threads run without approvals).
 */
export const decideApprovalAction = (
  target: ManagerConnectorBindingTarget,
  candidates: ReadonlyArray<PendingApprovalCandidate>,
): ApprovalAction => {
  if (target.kind === "assistant") {
    return { kind: "unsupported-target" };
  }
  const pending = candidates.filter(
    (candidate) =>
      candidate.requestIds.length > 0 &&
      (target.kind === "project" || candidate.threadId === target.threadId),
  );
  if (pending.length === 0) {
    return { kind: "nothing-pending" };
  }
  if (pending.length > 1) {
    return { kind: "ambiguous", candidates: pending };
  }
  const [candidate] = pending;
  return {
    kind: "respond",
    threadId: candidate!.threadId,
    threadTitle: candidate!.threadTitle,
    requestId: candidate!.requestIds[0]!,
  };
};
