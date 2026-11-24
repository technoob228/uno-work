/**
 * "A cloud chat asks to start a chat on my computer" (Misha 20.11): a chat on
 * one of the person's cloud computers asks; Uno Work on their own computer
 * (the Mac) shows it under Needs you and in the sidebar; the person presses
 * Start or Decline there. Start opens an ordinary chat on that computer with
 * the brief, tied to the cloud chat that asked, and the answer (started,
 * declined, expired, refused) goes back to it.
 *
 * The way there is the "Connect my computer" tunnel (myComputer.ts): the
 * cloud daemon writes the request into a folder of the person's computer
 * with a signed frame, and reads the answer from it. Uno Work on that
 * computer watches the folder. Nothing goes through the console but the
 * tunnel's frames, so a console can't make up a request (M7 signatures), and
 * only cloud computers the helper trusts — the person's own, never an
 * assistant's — can write there.
 *
 * The folder, `~/.uno-work/chat-requests/` on that computer:
 * - `state.json`   — written by Uno Work there: allowed or not, how many are
 *                    active, when it last looked (it rewrites it every minute);
 * - `in/<id>.json` — a request (`ChatRequestFile`), written by the cloud daemon;
 * - `out/<id>.json`— its answer (`ChatRequestAnswer`), written by Uno Work there;
 * - `decisions/<id>.json` — Start / Decline pressed in the person's Telegram
 *                    (`ChatRequestRemoteDecision`), written by the cloud daemon;
 *                    Uno Work there applies it like its own button, first
 *                    decision wins.
 *
 * Off by default (Misha 20.11): until the person turns it on in Settings →
 * Computer there, every request is refused at once with that reason.
 * Agents' own `my_computer_*` calls can't touch it (pathPolicy.ts: blocked).
 *
 * Rules (MAC_FROM_CLOUD_PLAN.md, Misha 14.11): at most 2 at once on one
 * computer (waiting ones and chats from the cloud still working); a request
 * waits 2 h at most, then it is cancelled with the reason; only the person's
 * own chats ask (not assistants', not a chat holding a stranger's text); a
 * chat started this way can't ssh, deploy, push or read secrets there.
 *
 * @module ChatRequests
 */
import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./orchestration.ts";

/** The folder on the person's computer, from its home. */
export const CHAT_REQUESTS_DIR = "~/.uno-work/chat-requests";
/** How long a request waits for the person (or for the computer to wake). */
export const CHAT_REQUEST_WAIT_MS = 2 * 60 * 60 * 1000;
/** Waiting requests and chats from the cloud still working, on one computer. */
export const CHAT_REQUESTS_AT_ONCE = 2;
export const CHAT_REQUEST_BRIEF_MAX_CHARS = 20_000;
export const CHAT_REQUEST_TITLE_MAX_CHARS = 120;
export const CHAT_REQUEST_GIST_MAX_CHARS = 200;
/** `state.json` older than this: Uno Work isn't open there now. */
export const CHAT_REQUESTS_STATE_FRESH_MS = 3 * 60 * 1000;

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** Who asked: a chat on a cloud computer of the same account. */
export const ChatRequestFrom = Schema.Struct({
  /** The cloud computer's name as the person sees it ("uno-work"). */
  computerName: Text(200),
  boxId: Schema.NullOr(Schema.Number),
  threadId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  threadTitle: Text(200),
});
export type ChatRequestFrom = typeof ChatRequestFrom.Type;

/** T51 agent levels, low to high (PLAN.md in reports/day_2026-11-20/team-collab). */
export const TeamAgentLevel = Schema.Literals(["off", "ask", "answer", "tasks"]);
export type TeamAgentLevel = typeof TeamAgentLevel.Type;

/**
 * T51: the request came from a colleague in a project (through the Uno
 * cloud, not the tunnel): "T50 plus a person". Absent: a chat of this
 * person's own cloud computer asked (T50).
 */
export const ChatRequestTeam = Schema.Struct({
  /** `work_team_requests.id` on the server. */
  requestId: Schema.Number,
  projectId: Schema.Number,
  projectName: Text(200),
  fromUserId: Schema.Number,
  /** The colleague's name as the team shows it. */
  fromName: Text(200),
  /** Their agent asked (from `ChatRequestFrom.threadTitle`), or the person. */
  viaAgent: Schema.Boolean,
  /** The level it came in under. */
  level: TeamAgentLevel,
  /** Started without a button (level `tasks`). */
  auto: Schema.Boolean,
  /** Sent from the sender's Uno assistant computer: "<name>'s assistant", never `auto`. */
  fromAssistant: Schema.optional(Schema.Boolean),
});
export type ChatRequestTeam = typeof ChatRequestTeam.Type;

/** `in/<id>.json`: what the cloud chat asks for. Text from an agent, never an instruction. */
export const ChatRequestFile = Schema.Struct({
  v: Schema.Literal(1),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  from: ChatRequestFrom,
  /** Folder on the person's computer: `~/projects/site`. Absent: the project used last. */
  cwd: Schema.optionalKey(Text(4096)),
  /** Harness: `claudeAgent` or `codex` (both held to the rules there). Absent: Claude Code. */
  provider: Schema.optionalKey(Text(200)),
  model: Schema.optionalKey(Text(500)),
  /** The asking chat's mode: the chat there runs no wider (nor wider than that project's chats). */
  runtimeMode: Schema.optionalKey(RuntimeMode),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_REQUEST_TITLE_MAX_CHARS)),
  /** One line the person reads first: what it wants done. */
  gist: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_REQUEST_GIST_MAX_CHARS)),
  /** The first message of the new chat, as the cloud agent wrote it. */
  brief: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_REQUEST_BRIEF_MAX_CHARS)),
  /** T51: from a colleague in a project. */
  team: Schema.optionalKey(ChatRequestTeam),
});
export type ChatRequestFile = typeof ChatRequestFile.Type;

/**
 * Where a request is:
 * - `queued`   — the cloud side only: not delivered yet (the computer sleeps);
 * - `waiting`  — on the person's computer, waiting for Start / Decline;
 * - `started`  — the chat runs there (`thread`);
 * - `declined` — the person said no;
 * - `expired`  — 2 h went by (asleep, Uno Work closed, nobody answered);
 * - `refused`  — by rule, at once: turned off there, 2 at once, a bad request.
 */
export const ChatRequestStatus = Schema.Literals([
  "queued",
  "waiting",
  "started",
  "declined",
  "expired",
  "refused",
]);
export type ChatRequestStatus = typeof ChatRequestStatus.Type;

/** The chat that started: what the cloud chat may read of it. */
export const ChatRequestThread = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  /** running | waiting-for-you | done | failed | idle | stopped (remoteChatHost.ts). */
  state: Schema.String,
  /** Its last answer, beginning and end (≤ 4000 characters); null: nothing yet. */
  lastMessage: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type ChatRequestThread = typeof ChatRequestThread.Type;

/** Where the person pressed Start / Decline: in Uno Work there, or in their Telegram. */
export const ChatRequestDecidedVia = Schema.Literals(["here", "telegram"]);
export type ChatRequestDecidedVia = typeof ChatRequestDecidedVia.Type;

/** `out/<id>.json`: the answer, rewritten as things change. */
export const ChatRequestAnswer = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  status: ChatRequestStatus,
  /** Why, in a sentence for the agent: declined, expired, refused. */
  reason: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  /** Started / declined: where the person pressed (absent before 0.0.190). */
  decidedVia: Schema.optionalKey(ChatRequestDecidedVia),
  /** Started without a press: the person trusts the chat that asked (0.0.192). */
  trusted: Schema.optionalKey(Schema.Boolean),
  thread: Schema.NullOr(ChatRequestThread),
});
export type ChatRequestAnswer = typeof ChatRequestAnswer.Type;

/**
 * `decisions/<id>.json`: the person pressed Start or Decline in their
 * Telegram (the cloud side holds the bot). Uno Work there applies it as its
 * own Start: the same checks, the first decision wins, a late one is dropped.
 */
export const ChatRequestRemoteDecision = Schema.Struct({
  v: Schema.Literal(1),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  decision: Schema.Literals(["start", "decline"]),
  via: Schema.Literal("telegram"),
  at: Schema.String,
});
export type ChatRequestRemoteDecision = typeof ChatRequestRemoteDecision.Type;

/** A cloud chat, by where it lives: the pair the person trusts. */
export const ChatRequestChatKey = Schema.Struct({
  boxId: Schema.NullOr(Schema.Number),
  threadId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type ChatRequestChatKey = typeof ChatRequestChatKey.Type;

/**
 * "Don't ask again for this chat" (Misha 23.11): its requests start without
 * Start, while the switch is on, within the 2 at once; revoked in Settings →
 * Computer, both logged.
 */
export const ChatRequestTrustedChat = Schema.Struct({
  ...ChatRequestChatKey.fields,
  computerName: Schema.String,
  threadTitle: Schema.String,
  since: Schema.String,
});
export type ChatRequestTrustedChat = typeof ChatRequestTrustedChat.Type;

/** The harnesses a chat from the cloud may run on there (both held to the rules). */
export const CHAT_REQUEST_PROVIDERS = ["claudeAgent", "codex"] as const;

/**
 * One call a cloud agent made on this computer (`my_computer_*`), as the
 * cloud side wrote it here before it ran: `~/.uno-work/chat-requests/commands.jsonl`.
 * The person reads it in Settings → Computer → Cloud agents.
 */
export const RemoteCommandLine = Schema.Struct({
  at: Schema.String,
  /** run, read, write, list. */
  kind: Schema.String,
  /** The command or the path, cut to 600 characters. */
  summary: Schema.String,
  /** ran (no card), allowed (after the person's Allow), refused. */
  outcome: Schema.String,
  /** The T47 tier: free, chat, ask, always, blocked. */
  tier: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  computerName: Schema.String,
  threadTitle: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  boxId: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type RemoteCommandLine = typeof RemoteCommandLine.Type;

/** The file of those lines on the person's computer, from its home. */
export const REMOTE_COMMANDS_FILE = `${CHAT_REQUESTS_DIR}/commands.jsonl`;

/** `state.json`: what the cloud side checks before it asks. */
export const ChatRequestsHostState = Schema.Struct({
  v: Schema.Literal(1),
  /**
   * The person's switch there (Settings → Computer → Cloud agents): chat
   * requests, and since 0.0.192 also every `my_computer_*` call of a cloud
   * agent on that computer.
   */
  allow: Schema.Boolean,
  /** Waiting requests and chats from the cloud still working. */
  active: NonNegativeInt,
  limit: NonNegativeInt,
  /** Uno Work there wrote this; every minute while it runs. */
  seenAt: Schema.String,
  app: Schema.String,
  /** Chats whose requests start without Start (0.0.192): the cloud side tells them so. */
  trusted: Schema.optionalKey(Schema.Array(ChatRequestChatKey)),
  /** Harnesses accepted there (0.0.192); absent: Claude Code only. */
  providers: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The person pressed "Stop cloud agents" there: when (0.0.192). */
  stoppedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ChatRequestsHostState = typeof ChatRequestsHostState.Type;

// ── What Uno Work on the person's computer shows ───────────────────────

export const ChatRequestView = Schema.Struct({
  id: Schema.String,
  status: ChatRequestStatus,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  from: ChatRequestFrom,
  /** The folder as asked (`~/projects/site`); null: the project used last. */
  cwd: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  title: Schema.String,
  gist: Schema.String,
  brief: Schema.String,
  reason: Schema.NullOr(Schema.String),
  /** Started / declined: pressed here or in the person's Telegram. */
  decidedVia: Schema.optionalKey(ChatRequestDecidedVia),
  /** Started without a press: the person trusts the chat that asked. */
  trusted: Schema.optionalKey(Schema.Boolean),
  /** The chat that asked is trusted now ("Don't ask again for this chat"). */
  fromTrusted: Schema.optionalKey(Schema.Boolean),
  /** The chat it started here. */
  threadId: Schema.NullOr(Schema.String),
  threadState: Schema.NullOr(Schema.String),
  /** T51: from a colleague in a project. */
  team: Schema.optionalKey(ChatRequestTeam),
});
export type ChatRequestView = typeof ChatRequestView.Type;

export const ChatRequestsState = Schema.Struct({
  allow: Schema.Boolean,
  limit: NonNegativeInt,
  /** Waiting requests and chats from the cloud still working. */
  active: NonNegativeInt,
  /** Newest first: waiting ones and the last decided ones (the journal). */
  requests: Schema.Array(ChatRequestView),
  /** Chats whose requests start without Start. */
  trustedChats: Schema.optionalKey(Schema.Array(ChatRequestTrustedChat)),
  /** The last calls of cloud agents here (`my_computer_*`), newest first. */
  commands: Schema.optionalKey(Schema.Array(RemoteCommandLine)),
  /** When the person last pressed "Stop cloud agents" here. */
  stoppedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ChatRequestsState = typeof ChatRequestsState.Type;

export const ChatRequestDecideInput = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  decision: Schema.Literals(["start", "decline"]),
  /** Start, and from now on start this chat's requests without asking. */
  trustChat: Schema.optionalKey(Schema.Boolean),
});
export type ChatRequestDecideInput = typeof ChatRequestDecideInput.Type;

export const ChatRequestDecideResult = Schema.Struct({
  state: ChatRequestsState,
  /** Start: the chat it opened here. */
  threadId: Schema.NullOr(Schema.String),
});
export type ChatRequestDecideResult = typeof ChatRequestDecideResult.Type;

export const ChatRequestsSetAllowedInput = Schema.Struct({
  allow: Schema.Boolean,
  /**
   * "Stop cloud agents" (the kill switch): off, and every command a cloud
   * agent runs here right now is stopped.
   */
  stopRunning: Schema.optionalKey(Schema.Boolean),
});
export type ChatRequestsSetAllowedInput = typeof ChatRequestsSetAllowedInput.Type;

/** Settings → Computer: a trusted chat asks again from now on. */
export const ChatRequestsRevokeTrustInput = ChatRequestChatKey;
export type ChatRequestsRevokeTrustInput = typeof ChatRequestsRevokeTrustInput.Type;

export class ChatRequestsError extends Schema.TaggedErrorClass<ChatRequestsError>()(
  "ChatRequestsError",
  { message: TrimmedNonEmptyString },
) {}
