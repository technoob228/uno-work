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

import type { SecretRequestOutcome } from "./browserBridge.ts";
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

const KNOWN_WORDS: Readonly<Record<string, string>> = {
  API: "API",
  AI: "AI",
  ID: "ID",
  URL: "URL",
  OPENAI: "OpenAI",
  OPENROUTER: "OpenRouter",
  ANTHROPIC: "Anthropic",
  TELEGRAM: "Telegram",
  TG: "Telegram",
  GITHUB: "GitHub",
  STRIPE: "Stripe",
  SLACK: "Slack",
  DISCORD: "Discord",
  GOOGLE: "Google",
  NOTION: "Notion",
  WHATSAPP: "WhatsApp",
};

/**
 * Plain words for an env name: `TELEGRAM_BOT_TOKEN` → "Telegram bot token",
 * `OPENAI_API_KEY` → "OpenAI API key". Unknown shapes keep the name.
 */
export function humanSecretLabel(name: string): string {
  const parts = name
    .split("_")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return name;
  const tail = parts[parts.length - 1]!.toUpperCase();
  if (!["TOKEN", "KEY", "SECRET", "PASSWORD", "PASS", "PWD"].includes(tail)) return name;
  return parts
    .map((part) => KNOWN_WORDS[part.toUpperCase()] ?? part.toLowerCase())
    .map((word) => (word === "pwd" || word === "pass" ? "password" : word))
    .join(" ");
}

/** Inbox title: "Uno needs your Telegram bot token". */
export function secretRequestTitle(name: string): string {
  const label = humanSecretLabel(name);
  return label === name ? `Uno needs a secret (${name})` : `Uno needs your ${label}`;
}

/** The message the chat gets when the person answers a queued request. */
export function lateSecretMessage(input: {
  readonly name: string;
  readonly cwd: string;
  readonly outcome: SecretRequestOutcome;
}): string {
  if (input.outcome.ok) {
    const file = input.outcome.file ?? ".env";
    return `(Uno Work) The person entered ${input.name} — it is saved in ${input.cwd}/${file}. Read it from there (never print it) and continue where you stopped.`;
  }
  return `(Uno Work) The person didn't give ${input.name} (${input.outcome.error ?? "declined"}). Don't ask again right away — tell them what it is needed for and how to add it later.`;
}

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

    const inbox = yield* InboxService;
    const item = yield* inbox.post({
      kind: "agent.input",
      source: { kind: "agent", id: threadId, name: chatTitle, icon: null },
      title,
      body: `${why ? `${why} ` : ""}Open the chat to paste it — it's saved privately on your computer, not in the chat.`,
      open: { kind: "thread", threadId },
      groupKey: groupKeyOf(input.threadId, input.name),
    });

    const notify = yield* ConnectorNotifyService;
    yield* notify.notify({
      text: `${title}. Open “${chatTitle}” in Uno Work to paste it — it stays on your computer.`,
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
