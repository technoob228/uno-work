/**
 * The pure parts of the Connect Telegram wizard (0.0.85): which step the
 * person is on, where each linked chat's messages go, and how a bot token is
 * checked before it is sent. No React, no I/O.
 */
import type {
  ManagerConnectorBindingView,
  ManagerTelegramConnectorStatus,
  ThreadId,
} from "@t3tools/contracts";

export type TelegramWizardStep = "bot" | "link" | "done";

/**
 * - `bot`: no bot yet — make one with @BotFather and paste its token.
 * - `link`: the bot is there, no chat is linked (or the person asked to link
 *   another one) — press Start on the link.
 * - `done`: at least one chat talks to Uno.
 */
export function telegramWizardStep(
  telegram: Pick<
    ManagerTelegramConnectorStatus,
    "configured" | "allowedChatIds" | "botUsername" | "health"
  >,
  input: { readonly linkingAnother: boolean },
): TelegramWizardStep {
  if (!telegram.configured || isBotTokenRejected(telegram)) return "bot";
  if (telegram.allowedChatIds.length === 0 || input.linkingAnother) return "link";
  return "done";
}

/** Telegram refused the saved token (never answered getMe): paste it again. */
export function isBotTokenRejected(
  telegram: Pick<ManagerTelegramConnectorStatus, "configured" | "botUsername" | "health">,
): boolean {
  return (
    telegram.configured &&
    telegram.botUsername === null &&
    telegram.health?.status === "auth_expired"
  );
}

const BOT_TOKEN_PATTERN = /^\d+:[\w-]{20,}$/;

/** Null when it looks like a BotFather token, else what to tell the person. */
export function checkBotToken(raw: string): string | null {
  return BOT_TOKEN_PATTERN.test(raw.trim())
    ? null
    : "A bot token looks like 123456789:AAE… — copy the whole line BotFather sent.";
}

/** The bot's deep link that carries the one-time code. */
export function telegramStartLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`;
}

export type TelegramChatDestination =
  | { readonly kind: "main" }
  | { readonly kind: "own" }
  | { readonly kind: "other"; readonly label: string };

/**
 * Where a linked chat's messages land: the main conversation (bound to it),
 * a conversation of its own with Uno (no binding — the connector keeps one
 * per chat, it shows under Uno too), or something else the person picked on
 * the advanced page (a project or another chat).
 */
export function telegramChatDestination(
  binding: Pick<ManagerConnectorBindingView, "target" | "targetLabel"> | undefined,
  mainThreadId: ThreadId | string | null,
): TelegramChatDestination {
  if (!binding || binding.target.kind === "assistant") return { kind: "own" };
  if (binding.target.kind === "thread" && binding.target.threadId === mainThreadId) {
    return { kind: "main" };
  }
  return {
    kind: "other",
    label:
      binding.targetLabel ?? (binding.target.kind === "project" ? "a project" : "another chat"),
  };
}

export function describeTelegramChatDestination(destination: TelegramChatDestination): string {
  switch (destination.kind) {
    case "main":
      return "Uno, main conversation";
    case "own":
      return "Uno, its own conversation";
    case "other":
      return destination.label;
  }
}

/** One line for the test-message result. */
export function describeTestResults(
  results: ReadonlyArray<{ readonly ok: boolean; readonly error: string | null }>,
): { readonly ok: boolean; readonly text: string } {
  if (results.length === 0) return { ok: false, text: "No chat is linked yet." };
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    return {
      ok: true,
      text:
        results.length === 1
          ? "Sent. Check Telegram."
          : `Sent to ${results.length} chats. Check Telegram.`,
    };
  }
  return {
    ok: false,
    text: `Telegram didn't take it: ${failed[0]?.error ?? "unknown error"}`,
  };
}
