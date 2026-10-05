/**
 * The agent asked the person for a secret (`request_secret`) and the person
 * isn't answering — no window is open, or nobody filled the card in time.
 * The request stays open (see `publishSecretRequest` `holdMs`); here we:
 *
 * - tell the person: an Inbox item "Uno needs your bot token" that opens the
 *   chat (where the masked field waits), plus their messenger when linked;
 * - when they answer later, hand the result back to the chat as a new message,
 *   so the agent continues where it stopped (nobody waits on the call any more).
 *
 * The value itself never passes through here — only its name and file.
 */
import { CommandId, MessageId, ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import {
  ASSISTANT_BOT_CARD,
  ASSISTANT_BOT_TOKEN_NAME,
  humanSecretLabel,
  lateSecretMessage,
} from "@t3tools/shared/secretRequestCopy";
import type { BrowserBridgeRequestContext } from "@t3tools/contracts";

import { BrowserBridge, type SecretRequestOutcome } from "./browserBridge.ts";
import { InboxService } from "./inbox/InboxService.ts";
import { ConnectorNotifyService } from "./manager/Services/ConnectorNotify.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * How long the call waits while a window is open (below Hermes' 300 s HTTP
 * read limit). It was 4 min: a person who said "I'll give the token later"
 * watched a chat that stood still for all of it (validator, 0.0.106). The
 * request stays open after that and the answer comes back as a message, so a
 * shorter wait loses nothing; `wait: false` of `request_secret` skips it.
 */
export const SECRET_REQUEST_SYNC_WAIT_MS = 90_000;
/** How long an unanswered request stays open for the person. */
export const SECRET_REQUEST_HOLD_MS = 7 * 24 * 3_600_000;

/** Inbox title: "Uno needs your Telegram bot token". */
export function secretRequestTitle(name: string): string {
  if (name === ASSISTANT_BOT_TOKEN_NAME) return ASSISTANT_BOT_CARD.title;
  const label = humanSecretLabel(name);
  return label === name ? `Uno needs a secret (${name})` : `Uno needs your ${label}`;
}

// Shared with the client, which shows the late answer as one quiet line.
export { humanSecretLabel, lateSecretMessage };

const groupKeyOf = (threadId: string, name: string) => `secret:${threadId}:${name}`;

const threadShell = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    return yield* projections.getThreadShellById(threadId).pipe(
      Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()),
      Effect.map(Option.getOrNull),
    );
  });

/** Inbox "Needs you" + messenger: the person isn't answering a secret request. */
export const announceSecretRequest = (input: {
  readonly threadId: string;
  readonly name: string;
  readonly description?: string;
}): Effect.Effect<
  string | null,
  never,
  InboxService | ConnectorNotifyService | ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(input.threadId);
    const shell = yield* threadShell(threadId);
    const chatTitle = shell?.title ?? "Uno";
    const title = secretRequestTitle(input.name);
    const why = input.description?.trim();
    const ownBot = input.name === ASSISTANT_BOT_TOKEN_NAME;

    const inbox = yield* InboxService;
    const item = yield* inbox.post({
      kind: "agent.input",
      source: { kind: "agent", id: threadId, name: chatTitle, icon: null },
      title,
      body: ownBot
        ? "Make a bot in @BotFather (/newbot, a name) and paste its token in the chat. Your assistant talks to you there."
        : `${why ? `${why} ` : ""}Open the chat to paste it — it's saved privately on your computer, not in the chat.`,
      open: { kind: "thread", threadId },
      groupKey: groupKeyOf(input.threadId, input.name),
    });

    const notify = yield* ConnectorNotifyService;
    yield* notify.notify({
      text: ownBot
        ? `${title}: open “${chatTitle}” in Uno Work and paste the token from @BotFather there.`
        : `${title}. Open “${chatTitle}” in Uno Work to paste it — it stays on your computer.`,
      threadId,
      kind: "warning",
    });
    return item.id;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("secret request: announce failed", { cause }).pipe(Effect.as(null)),
    ),
  );

/** The person answered a queued request: clear the Inbox item, wake the chat. */
export const deliverLateSecretOutcome = (input: {
  readonly threadId: string;
  readonly name: string;
  readonly cwd: string;
  readonly outcome: SecretRequestOutcome;
  /** The Inbox item `announceSecretRequest` posted, to mark read. */
  readonly inboxItemId: string | null;
}): Effect.Effect<
  void,
  never,
  InboxService | OrchestrationEngineService | ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(input.threadId);
    if (input.inboxItemId !== null) {
      const inbox = yield* InboxService;
      yield* inbox.update({ action: "read", ids: [input.inboxItemId] }).pipe(Effect.ignore);
    }

    const shell = yield* threadShell(threadId);
    if (shell === null) return;
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`secret:late:${crypto.randomUUID()}`),
      threadId,
      message: {
        messageId: MessageId.make(crypto.randomUUID()),
        role: "user",
        text: lateSecretMessage(input),
        attachments: [],
      },
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      createdAt: new Date().toISOString(),
    });
  }).pipe(Effect.ignoreCause({ log: true }));

/**
 * assistant_connect: the "Create your assistant's bot" card in the asking
 * chat — the token of the assistant's own bot from @BotFather (decision
 * 05.10). Returns at once (the agent goes on preparing the assistant); the
 * card waits up to a week, the Inbox (and, with no window open, Uno's bot)
 * says so, and the answer comes back to the chat as a "(Uno Work)" message.
 * The token is saved by the result route into the assistant's Telegram
 * settings (http.ts, `purpose: "assistant-telegram-bot"`).
 */
export const openAssistantBotTokenRequest = (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly context: BrowserBridgeRequestContext | undefined;
}): Effect.Effect<
  SecretRequestOutcome,
  never,
  | BrowserBridge
  | InboxService
  | ConnectorNotifyService
  | ProjectionSnapshotQuery
  | OrchestrationEngineService
> =>
  Effect.gen(function* () {
    const browserBridge = yield* BrowserBridge;
    const hasSubscribers = yield* browserBridge.hasSubscribers;
    const announce = announceSecretRequest({
      threadId: input.threadId,
      name: ASSISTANT_BOT_TOKEN_NAME,
    });
    // Nobody looking: Inbox + messenger now. Someone looking sees the card.
    const inboxItemId = hasSubscribers ? null : yield* announce;
    const lateServices = yield* Effect.context<
      InboxService | OrchestrationEngineService | ProjectionSnapshotQuery
    >();
    return yield* browserBridge.publishSecretRequest(
      {
        name: ASSISTANT_BOT_TOKEN_NAME,
        targetFile: ".env",
        cwd: "~",
        purpose: "assistant-telegram-bot",
        projectId: input.projectId,
        timeoutMs: 0,
        holdMs: SECRET_REQUEST_HOLD_MS,
        onLateOutcome: (late) =>
          deliverLateSecretOutcome({
            threadId: input.threadId,
            name: ASSISTANT_BOT_TOKEN_NAME,
            cwd: "~",
            outcome: late,
            inboxItemId,
          }).pipe(Effect.provideContext(lateServices)),
      },
      input.context,
    );
  });
